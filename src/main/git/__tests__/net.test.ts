// Network layer: askpass channel, cancellation, watchdog, clone clean-up.
// Everything runs against real git processes; nothing touches a real remote.
import { execFile, execFileSync, spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import type { CredentialRequest } from '@shared/types'

const hosting = vi.hoisted(() => ({
  creds: vi.fn<(host: string) => { username: string; password: string } | null>(() => null)
}))
vi.mock('../hosting', () => ({
  credentialsForHost: (host: string) => hosting.creds(host),
  activeIdentity: () => null
}))

import { coreApi as api } from '../core'
import { GitError, runGit } from '../exec'
import { CANCELLED_MESSAGE, netApi, netGit, netSettings, onCredentialRequest, parseCredentialPrompt } from '../net'
import { cleanupAll, seededRepo, setupGitEnv, sh, tmpDir } from './helpers'

const DEFAULT_IDLE = netSettings.idleTimeoutMs

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

let off: (() => void) | null = null
const seen: CredentialRequest[] = []
/** Answers every credential request with `answer(req)`; null cancels, undefined leaves it unanswered. */
function answerWith(answer: (req: CredentialRequest) => string | null | undefined | Promise<string | null | undefined>): void {
  off?.()
  off = onCredentialRequest((req) => {
    seen.push(req)
    void Promise.resolve(answer(req)).then((value) => {
      if (value !== undefined) void netApi.answerCredential(req.id, value)
    })
  })
}

beforeEach(() => {
  seen.length = 0
  hosting.creds.mockReset()
  hosting.creds.mockReturnValue(null)
})
afterEach(() => {
  off?.()
  off = null
  netSettings.idleTimeoutMs = DEFAULT_IDLE
})

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

async function waitFor<T>(probe: () => T | undefined | null | false, what: string, timeout = 8000): Promise<T> {
  const started = Date.now()
  for (;;) {
    const value = probe()
    if (value) return value
    if (Date.now() - started > timeout) throw new Error(`Timed out waiting for ${what}`)
    await sleep(20)
  }
}

const alive = (pid: number): boolean => {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

/** A fake transport that records its pid and then never answers. */
function hangingTransport(opts: { ignoreTerm?: boolean } = {}): { script: string; pid: () => number | null } {
  const dir = tmpDir('gitkroken-hang-')
  const pidFile = join(dir, 'pid')
  const script = join(dir, 'transport.sh')
  writeFileSync(script, `#!/bin/sh\necho $$ > '${pidFile}'\n${opts.ignoreTerm ? "trap '' TERM\n" : ''}exec sleep 600\n`)
  chmodSync(script, 0o755)
  return {
    script,
    pid: () => (existsSync(pidFile) ? Number(readFileSync(pidFile, 'utf8').trim()) || null : null)
  }
}

/** A repo whose only remote goes through `transport` instead of ssh. */
function repoWithTransport(script: string): string {
  const { repo } = seededRepo()
  sh(repo, 'remote', 'add', 'origin', 'ssh://git@example.invalid/acme/project.git')
  sh(repo, 'config', 'core.sshCommand', script)
  return repo
}

/** `git credential fill` asks exactly what a real HTTPS remote would ask. */
const fill = (repo: string, protocol = 'https', host = 'example.com'): Promise<string> =>
  netGit(repo, ['-c', 'credential.helper=', 'credential', 'fill'], { input: `protocol=${protocol}\nhost=${host}\n\n` }).then(
    (res) => res.stdout
  )

describe('parseCredentialPrompt', () => {
  it('classifies git and ssh prompts and extracts host and user', () => {
    expect(parseCredentialPrompt("Username for 'https://github.com': ")).toEqual({ kind: 'username', host: 'github.com', scheme: 'https' })
    expect(parseCredentialPrompt("Password for 'https://octo%40cat@GitHub.com:8443/acme/x.git': ")).toEqual({
      kind: 'password',
      host: 'github.com:8443',
      username: 'octo@cat',
      scheme: 'https'
    })
    expect(parseCredentialPrompt("Password for 'https://ana@corp.example@dev.azure.com': ")).toEqual({
      kind: 'password',
      host: 'dev.azure.com',
      username: 'ana@corp.example',
      scheme: 'https'
    })
    expect(parseCredentialPrompt("Password for 'http://me@intranet': ")).toMatchObject({ kind: 'password', host: 'intranet', scheme: 'http' })
    expect(parseCredentialPrompt("Enter passphrase for key '/Users/me/.ssh/id_ed25519': ")).toEqual({ kind: 'passphrase' })
    expect(parseCredentialPrompt('Bad passphrase, try again for /Users/me/.ssh/id_rsa: ')).toEqual({ kind: 'passphrase' })
    expect(parseCredentialPrompt("git@gitlab.example.com's password: ")).toEqual({ kind: 'password', username: 'git', host: 'gitlab.example.com' })
    expect(parseCredentialPrompt('(me@host.example) Verification code: ')).toEqual({ kind: 'other', username: 'me', host: 'host.example' })
    expect(parseCredentialPrompt('(me@host.example) Password: ')).toEqual({ kind: 'password', username: 'me', host: 'host.example' })
    const hostKey =
      "The authenticity of host 'github.com (140.82.121.4)' can't be established.\n" +
      'ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n' +
      'This key is not known by any other names.\n' +
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
    expect(parseCredentialPrompt(hostKey)).toEqual({ kind: 'other', host: 'github.com' })
    expect(parseCredentialPrompt('Something unexpected: ')).toEqual({ kind: 'other' })
  })
})

describe('askpass channel', () => {
  it('git is pointed at a private helper that exists outside the source tree', async () => {
    const { repo } = seededRepo()
    const out = (
      await netGit(repo, [
        '-c',
        'alias.env=!echo "$GIT_ASKPASS|$SSH_ASKPASS|$SSH_ASKPASS_REQUIRE|$GIT_TERMINAL_PROMPT|$GITKROKEN_ASKPASS_SOCK|${#GITKROKEN_ASKPASS_TOKEN}"',
        'env'
      ])
    ).stdout.trim()
    const [gitAskpass, sshAskpass, require, terminal, socket, tokenLength] = out.split('|')
    expect(sshAskpass).toBe(gitAskpass)
    expect(require).toBe('force')
    expect(terminal).toBe('0')
    expect(Number(tokenLength)).toBeGreaterThanOrEqual(64)
    expect(gitAskpass).not.toContain(join('src', 'main'))
    const dir = dirname(gitAskpass!)
    expect(dirname(socket!)).toBe(dir)
    if (process.platform !== 'win32') {
      // Only the owner can reach the socket or replace the helper.
      expect(statSync(dir).mode & 0o777).toBe(0o700)
      expect(statSync(gitAskpass!).mode & 0o077).toBe(0)
      expect(statSync(socket!).isSocket()).toBe(true)
    }
  })

  it('relays a prompt the way git invokes the helper: prompt in argv, answer on stdout', async () => {
    const { repo } = seededRepo()
    answerWith((req) => (req.kind === 'password' ? 'hunter2 with spaces' : null))
    const res = await netGit(repo, ['-c', `alias.ask=!"$GIT_ASKPASS" "Password for 'https://me@example.com': "`, 'ask'])
    expect(res.stdout).toBe('hunter2 with spaces\n')
    expect(seen).toHaveLength(1)
    expect(seen[0]).toMatchObject({ kind: 'password', host: 'example.com', username: 'me', prompt: "Password for 'https://me@example.com': " })
    expect(typeof seen[0]!.id).toBe('string')
  })

  it('end to end through git itself: username, then password', async () => {
    const { repo } = seededRepo()
    const secret = 'tok_3x4mpl3-S3cr3t'
    answerWith((req) => (req.kind === 'username' ? 'alice' : secret))
    const out = await fill(repo)
    expect(out).toContain('username=alice\n')
    expect(out).toContain(`password=${secret}\n`)
    expect(seen.map((r) => [r.kind, r.host, r.username, r.prompt])).toEqual([
      ['username', 'example.com', undefined, "Username for 'https://example.com': "],
      ['password', 'example.com', 'alice', "Password for 'https://alice@example.com': "]
    ])

    // The secret went through memory only: nothing in the helper's folder holds it.
    const env = (await netGit(repo, ['-c', 'alias.env=!echo "$GIT_ASKPASS"', 'env'])).stdout.trim()
    for (const name of readdirSync(dirname(env))) {
      const file = join(dirname(env), name)
      if (statSync(file).isFile()) expect(readFileSync(file, 'utf8')).not.toContain(secret)
    }
  })

  it('uses a stored account for an HTTPS host silently, and never over plain http', async () => {
    const { repo } = seededRepo()
    hosting.creds.mockImplementation((host) => (host === 'example.com' ? { username: 'bot', password: 'stored-token' } : null))
    answerWith(() => 'typed')

    const out = await fill(repo)
    expect(out).toContain('username=bot\n')
    expect(out).toContain('password=stored-token\n')
    expect(seen).toEqual([])
    expect(hosting.creds).toHaveBeenCalledWith('example.com')

    hosting.creds.mockClear()
    const plain = await fill(repo, 'http')
    expect(plain).toContain('username=typed\n')
    expect(plain).toContain('password=typed\n')
    expect(hosting.creds).not.toHaveBeenCalled()
    expect(seen.map((r) => r.kind)).toEqual(['username', 'password'])

    // No account for that host: the user is asked.
    seen.length = 0
    expect(await fill(repo, 'https', 'other.example')).toContain('password=typed\n')
    expect(seen).toHaveLength(2)
  })

  it('cancelling the dialog fails git promptly with a clear error (and no secret in it)', async () => {
    const { repo } = seededRepo()
    answerWith((req) => (req.kind === 'username' ? 'alice' : null))
    const started = Date.now()
    const err = await fill(repo).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    expect((err as GitError).message).toBe(CANCELLED_MESSAGE)
    expect((err as GitError).aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    // The password prompt was the last thing git did: no further prompts after the cancel.
    expect(seen.map((r) => r.kind)).toEqual(['username', 'password'])
  })

  it('without anyone to ask, git fails as it does without a terminal', async () => {
    const { repo } = seededRepo()
    const err = (await fill(repo).catch((e: unknown) => e)) as GitError
    expect(err).toBeInstanceOf(GitError)
    expect(err.aborted).toBe(false)
    expect(err.message).toMatch(/could not read Username|terminal prompts disabled/i)
  })

  it('rejects a wrong token, and a token stops working when its operation ends', async () => {
    const { repo } = seededRepo()
    answerWith(() => 'should-never-be-asked')
    const res = await netGit(repo, [
      '-c',
      'alias.probe=!echo "$GIT_ASKPASS|$GITKROKEN_ASKPASS_SOCK|$GITKROKEN_ASKPASS_TOKEN"; GITKROKEN_ASKPASS_TOKEN=wrong "$GIT_ASKPASS" "Password: "; echo "exit=$?"',
      'probe'
    ])
    const [first, second] = res.stdout.trim().split('\n')
    expect(second).toBe('exit=1')
    expect(seen).toEqual([])

    // Replay the (now finished) operation's token by hand.
    const [script, socket, token] = first!.split('|')
    // (Asynchronously: the server lives in this very process.)
    const replay = await new Promise<{ status: number | null; stdout: string }>((done) => {
      execFile(
        script!,
        ["Password for 'https://example.com': "],
        { env: { ...process.env, GITKROKEN_ASKPASS_SOCK: socket, GITKROKEN_ASKPASS_TOKEN: token }, encoding: 'utf8' },
        (error, stdout) => done({ status: error ? (typeof error.code === 'number' ? error.code : null) : 0, stdout })
      )
    })
    expect(replay.status).toBe(1)
    expect(replay.stdout).toBe('')
    expect(seen).toEqual([])
  })

  it('routes concurrent prompts to the operation that asked', async () => {
    const a = seededRepo().repo
    const b = seededRepo().repo
    answerWith(async (req) => {
      // Answer out of order: the later request first.
      await sleep(req.host === 'a.example' ? 150 : 20)
      return `${req.kind}@${req.host}`
    })
    const [outA, outB] = await Promise.all([fill(a, 'https', 'a.example'), fill(b, 'https', 'b.example')])
    expect(outA).toContain('username=username@a.example\n')
    expect(outA).toContain('password=password@a.example\n')
    expect(outB).toContain('username=username@b.example\n')
    expect(outB).toContain('password=password@b.example\n')
    expect(seen).toHaveLength(4)
    expect(new Set(seen.map((r) => r.id)).size).toBe(4)
  })

  it('answering an unknown or already answered request is harmless', async () => {
    await expect(netApi.answerCredential('nope', 'x')).resolves.toBeUndefined()
    await expect(netApi.answerCredential('nope', null)).resolves.toBeUndefined()
  })

  const hasSshKeygen = spawnSync('ssh-keygen', ['-?'], { stdio: 'ignore' }).error === undefined
  it.skipIf(!hasSshKeygen)('OpenSSH asks for a key passphrase through the same helper (SSH_ASKPASS)', async () => {
    const { repo } = seededRepo()
    const key = join(tmpDir('gitkroken-key-'), 'id_test')
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', 'open sesame', '-C', 'test', '-f', key], { stdio: 'ignore' })
    answerWith((req) => (req.kind === 'passphrase' ? 'open sesame' : null))
    // ssh-keygen reads the passphrase exactly like ssh does (read_passphrase -> SSH_ASKPASS).
    const res = await netGit(repo, ['-c', `alias.pub=!ssh-keygen -y -f '${key}'`, 'pub'])
    expect(res.stdout).toMatch(/^ssh-ed25519 /)
    expect(seen).toHaveLength(1)
    expect(seen[0]!.kind).toBe('passphrase')
    expect(seen[0]!.prompt).toMatch(/passphrase/i)
  })
})

describe('transport defaults', () => {
  const show = '!echo "ssh=$GIT_SSH_COMMAND"; echo "limit=$(git config http.lowSpeedLimit)"; echo "time=$(git config http.lowSpeedTime)"'

  it('adds an ssh connect timeout and an http low-speed limit when the user set none', async () => {
    const { repo } = seededRepo()
    const out = (await netGit(repo, ['-c', `alias.tdefaults=${show}`, 'tdefaults'])).stdout
    expect(out).toMatch(/^ssh=ssh .*-o ConnectTimeout=30\b/m)
    expect(out).toContain(`limit=${netSettings.httpLowSpeedLimit}\n`)
    expect(out).toContain(`time=${netSettings.httpLowSpeedTimeS}\n`)
  })

  it("does not override the user's own ssh command or http limits", async () => {
    const { repo } = seededRepo()
    sh(repo, 'config', 'core.sshCommand', 'my-ssh -i ~/.ssh/work')
    sh(repo, 'config', 'http.lowSpeedLimit', '5000')
    const out = (await netGit(repo, ['-c', `alias.tdefaults=${show}`, 'tdefaults'])).stdout
    expect(out).toContain('ssh=\n')
    expect(out).toContain('limit=5000\n')
    expect(out).toContain('time=\n')

    const { repo: other } = seededRepo()
    const saved = process.env['GIT_SSH_COMMAND']
    process.env['GIT_SSH_COMMAND'] = 'custom-ssh -v'
    try {
      expect((await netGit(other, ['-c', `alias.tdefaults=${show}`, 'tdefaults'])).stdout).toContain('ssh=custom-ssh -v\n')
    } finally {
      if (saved === undefined) delete process.env['GIT_SSH_COMMAND']
      else process.env['GIT_SSH_COMMAND'] = saved
    }
  })
})

describe('cancel', () => {
  it('kills a hanging fetch, including the transport process, and rejects with "Operation cancelled"', async () => {
    const transport = hangingTransport()
    const repo = repoWithTransport(transport.script)
    expect(await netApi.cancel(repo)).toBe(false)

    const pending = api.fetch(repo).catch((e: unknown) => e)
    const pid = await waitFor(transport.pid, 'the transport to start')
    expect(alive(pid)).toBe(true)
    // Another repository's cancel does not touch it.
    expect(await netApi.cancel(seededRepo().repo)).toBe(false)

    const started = Date.now()
    expect(await netApi.cancel(`${repo}/`)).toBe(true)
    const err = (await pending) as GitError
    expect(err).toBeInstanceOf(GitError)
    expect(err.message).toBe(CANCELLED_MESSAGE)
    expect(err.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(3000)
    await waitFor(() => !alive(pid), 'the transport to die', 3000)
    expect(await netApi.cancel(repo)).toBe(false)
    // The repository is still usable.
    expect((await api.status(repo)).branch).toBe('main')
  })

  it('does not wait for a helper that ignores SIGTERM', async () => {
    const transport = hangingTransport({ ignoreTerm: true })
    const repo = repoWithTransport(transport.script)
    const pending = api.push(repo).catch((e: unknown) => e)
    const pid = await waitFor(transport.pid, 'the transport to start')
    const started = Date.now()
    expect(await netApi.cancel(repo)).toBe(true)
    expect(((await pending) as Error).message).toBe(CANCELLED_MESSAGE)
    expect(Date.now() - started).toBeLessThan(4000)
    await waitFor(() => !alive(pid), 'the stubborn transport to die', 3000)
  })

  it('cancels a pull during the download and leaves the work tree alone', async () => {
    const transport = hangingTransport()
    const repo = repoWithTransport(transport.script)
    sh(repo, 'update-ref', 'refs/remotes/origin/main', 'HEAD')
    sh(repo, 'branch', '--set-upstream-to=origin/main', 'main')
    const pending = api.pull(repo).catch((e: unknown) => e)
    await waitFor(transport.pid, 'the transport to start')
    expect(await netApi.cancel(repo)).toBe(true)
    expect(((await pending) as Error).message).toBe(CANCELLED_MESSAGE)
    const st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    expect([...st.staged, ...st.unstaged]).toEqual([])
    // The repo's write queue is free again.
    await api.createBranch(repo, 'after-cancel')
  })

  it('runGit rejects at once when the signal is already aborted', async () => {
    const { repo } = seededRepo()
    const controller = new AbortController()
    controller.abort(new Error('ya no'))
    const err = (await runGit(repo, ['status'], { signal: controller.signal }).catch((e: unknown) => e)) as GitError
    expect(err.message).toBe('ya no')
    expect(err.aborted).toBe(true)
  })
})

describe('stall watchdog', () => {
  it('kills an operation that stays silent and says why', async () => {
    netSettings.idleTimeoutMs = 400
    const transport = hangingTransport()
    const repo = repoWithTransport(transport.script)
    const started = Date.now()
    const err = (await api.fetch(repo).catch((e: unknown) => e)) as GitError
    expect(err).toBeInstanceOf(GitError)
    expect(err.message).toMatch(/^Timed out: no response from the remote/)
    expect(err.aborted).toBe(true)
    expect(Date.now() - started).toBeLessThan(5000)
    const pid = transport.pid()
    if (pid) await waitFor(() => !alive(pid), 'the transport to die', 3000)
  })

  it('is suspended while a credential dialog waits for the user', async () => {
    netSettings.idleTimeoutMs = 300
    const { repo } = seededRepo()
    answerWith(async (req) => {
      // The "user" takes four times the idle limit to type each answer.
      await sleep(1200)
      return req.kind
    })
    const out = await fill(repo)
    expect(out).toContain('username=username\n')
    expect(out).toContain('password=password\n')
  })

  it('output counts as activity', async () => {
    netSettings.idleTimeoutMs = 400
    const { repo } = seededRepo()
    // 1.2 s in total, but never silent for more than 150 ms.
    const res = await netGit(repo, ['-c', 'alias.chatty=!for i in 1 2 3 4 5 6 7 8; do echo tick; sleep 0.15; done', 'chatty'])
    expect(res.stdout.match(/tick/g)).toHaveLength(8)
  })
})

describe('clone clean-up', () => {
  let savedSsh: string | undefined
  beforeEach(() => {
    savedSsh = process.env['GIT_SSH_COMMAND']
  })
  afterEach(() => {
    if (savedSsh === undefined) delete process.env['GIT_SSH_COMMAND']
    else process.env['GIT_SSH_COMMAND'] = savedSsh
  })

  const URL = 'ssh://git@example.invalid/acme/project.git'

  async function cancelledClone(parent: string): Promise<unknown> {
    const transport = hangingTransport()
    process.env['GIT_SSH_COMMAND'] = transport.script
    const pending = api.clone(URL, parent).catch((e: unknown) => e)
    await waitFor(transport.pid, 'the transport to start')
    expect(await netApi.cancel(parent)).toBe(true)
    return pending
  }

  it('a cancelled clone removes the folder it created, and nothing else', async () => {
    const parent = tmpDir()
    writeFileSync(join(parent, 'keep.txt'), 'mine')
    const err = (await cancelledClone(parent)) as GitError
    expect(err.message).toBe(CANCELLED_MESSAGE)
    expect(existsSync(join(parent, 'project'))).toBe(false)
    expect(readdirSync(parent)).toEqual(['keep.txt'])
  })

  it('also removes the parent folders that were created for it', async () => {
    const root = tmpDir()
    const parent = join(root, 'new', 'deeper')
    const err = (await cancelledClone(parent)) as GitError
    expect(err.message).toBe(CANCELLED_MESSAGE)
    expect(existsSync(join(root, 'new'))).toBe(false)
    expect(existsSync(root)).toBe(true)
  })

  it('keeps a destination folder that already existed empty', async () => {
    const parent = tmpDir()
    mkdirSync(join(parent, 'project'))
    const err = (await cancelledClone(parent)) as GitError
    expect(err.message).toBe(CANCELLED_MESSAGE)
    expect(readdirSync(parent)).toEqual(['project'])
    expect(readdirSync(join(parent, 'project'))).toEqual([])
  })

  it('never touches a destination that already had content', async () => {
    const parent = tmpDir()
    mkdirSync(join(parent, 'project'))
    writeFileSync(join(parent, 'project', 'precious.txt'), 'do not delete')
    const err = (await api.clone(URL, parent).catch((e: unknown) => e)) as Error
    expect(err.message).toMatch(/already exists and is not an empty directory/)
    expect(readFileSync(join(parent, 'project', 'precious.txt'), 'utf8')).toBe('do not delete')
  })

  it('a clone that fails on its own leaves nothing behind either', async () => {
    const root = tmpDir()
    const parent = join(root, 'fresh')
    await expect(api.clone(join(tmpDir(), 'nope.git'), parent)).rejects.toThrow(/does not exist/i)
    expect(existsSync(parent)).toBe(false)
  })
})
