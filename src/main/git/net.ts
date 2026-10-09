// Network operations: credential prompts (askpass), cancellation and stall
// protection. Plain Node only (no Electron import): testable under vitest.
//
// How a credential travels
//   git / ssh need a secret and have no terminal, so they run $GIT_ASKPASS /
//   $SSH_ASKPASS "<prompt>". That is a tiny script generated at runtime in a
//   private temp dir; it starts the app's own binary as plain Node
//   (ELECTRON_RUN_AS_NODE=1) on a helper that connects to a unix socket in the
//   same 0700 dir, sends `{ token, prompt }` and prints the answer on stdout.
//   The token is random per operation and only exists in the environment of
//   that operation's git process tree; it is forgotten when the operation ends.
//   The answer is never logged, never written to disk, never placed in argv
//   and never copied into an error message.
import { randomBytes, randomUUID, timingSafeEqual } from 'crypto'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { lstat, mkdir, readdir, rm, rmdir } from 'fs/promises'
import { createServer, type Server, type Socket } from 'net'
import { tmpdir } from 'os'
import { dirname, join, resolve } from 'path'
import type { CredentialRequest, GitApi } from '@shared/types'
import { runGit, type RunOptions, type RunResult } from './exec'
import { credentialsForHost } from './hosting'

export const CANCELLED_MESSAGE = 'Operation cancelled'

/** Tunables (tests shorten them) */
export const netSettings = {
  /**
   * A network operation that prints nothing for this long is killed. Generous
   * on purpose: it is the last line of defence (hooks and credential helpers
   * may legitimately be silent for a while); the transport-level limits below
   * catch a dead server much sooner. Time spent waiting for the user to answer
   * a credential dialog does not count.
   */
  idleTimeoutMs: 5 * 60_000,
  /** ssh: give up connecting after this many seconds */
  sshConnectTimeoutS: 30,
  /** http(s): abort when less than `httpLowSpeedLimit` bytes/s flow for this many seconds */
  httpLowSpeedTimeS: 120,
  /**
   * 1 byte/s, i.e. "nothing at all": while a server is busy building a pack
   * it only sends 5-byte keep-alives, which any higher limit would mistake
   * for a stalled connection.
   */
  httpLowSpeedLimit: 1
}

// --- prompt parsing ----------------------------------------------------------------------------

export interface ParsedPrompt {
  kind: CredentialRequest['kind']
  host?: string
  username?: string
  /** URL scheme of a git credential prompt (`https`, `http`...) */
  scheme?: string
}

const decode = (text: string): string => {
  try {
    return decodeURIComponent(text)
  } catch {
    return text
  }
}

/** Classifies a prompt printed by git or ssh and extracts the host / user it talks about. */
export function parseCredentialPrompt(prompt: string): ParsedPrompt {
  const text = typeof prompt === 'string' ? prompt.trim() : ''

  // git: "Username for 'https://github.com': " / "Password for 'https://user@github.com': "
  const git = /^(Username|Password) for '([^']*)'\s*:?$/i.exec(text)
  if (git) {
    const out: ParsedPrompt = { kind: git[1]!.toLowerCase() === 'username' ? 'username' : 'password' }
    const url = /^([a-z][a-z0-9+.-]*):\/\/([^/?#]+)/i.exec(git[2]!)
    if (url) {
      out.scheme = url[1]!.toLowerCase()
      // The user name may itself contain an "@" (e-mail logins): the host starts after the last one.
      const authority = url[2]!
      const at = authority.lastIndexOf('@')
      if (at > 0) out.username = decode(authority.slice(0, at).split(':')[0]!)
      out.host = authority.slice(at + 1).toLowerCase()
    } else if (git[2]) {
      out.host = git[2]
    }
    return out
  }

  // ssh: "Enter passphrase for key '/home/me/.ssh/id_ed25519': ", "Bad passphrase, try again for ...: ",
  // "Enter PIN for ED25519-SK key ...: "
  if (/^(Enter passphrase for|Bad passphrase, try again for|Enter PIN for) /i.test(text)) return { kind: 'passphrase' }

  // ssh host key confirmation (several lines, ending in the yes/no question)
  if (/\(yes\/no(\/\[fingerprint\])?\)\??$/i.test(text)) {
    const host = /authenticity of host '([^'\s]+)/i.exec(text)?.[1]
    return host ? { kind: 'other', host } : { kind: 'other' }
  }

  // ssh password authentication: "user@host's password: "
  const pw = /^(.+)@([^@\s]+)'s password:$/i.exec(text)
  if (pw) return { kind: 'password', username: pw[1]!, host: pw[2]! }

  // ssh keyboard-interactive: "(user@host) Password: ", "(user@host) Verification code: "
  const kbd = /^\(([^@()\s]+)@([^()\s]+)\)\s*([\s\S]*)$/.exec(text)
  if (kbd) return { kind: /pass(word|phrase)/i.test(kbd[3]!) ? 'password' : 'other', username: kbd[1]!, host: kbd[2]! }

  if (/passphrase/i.test(text)) return { kind: 'passphrase' }
  if (/password/i.test(text)) return { kind: 'password' }
  if (/^username\b/i.test(text)) return { kind: 'username' }
  return { kind: 'other' }
}

// --- operations --------------------------------------------------------------------------------

interface NetOp {
  /** What `cancel()` is called with: the repo, or the parent folder of a clone */
  key: string
  token: string
  controller: AbortController
  /** Ids of the credential requests waiting for the user */
  waiting: Set<string>
  lastActivity: number
}

interface PendingRequest {
  op: NetOp
  socket: Socket
}

/** Running operations by token */
const ops = new Map<string, NetOp>()
const pending = new Map<string, PendingRequest>()
const listeners = new Set<(req: CredentialRequest) => void>()

const keyOf = (path: string): string => resolve(path)

function findOp(token: unknown): NetOp | null {
  if (typeof token !== 'string' || token === '') return null
  const given = Buffer.from(token)
  for (const op of ops.values()) {
    const own = Buffer.from(op.token)
    if (own.length === given.length && timingSafeEqual(own, given)) return op
  }
  return null
}

/**
 * Registers the function that shows a credential request to the user (the main
 * process forwards it to the renderer). Returns an unsubscribe function.
 * With no listener, prompts are refused and git fails as it would without a terminal.
 */
export function onCredentialRequest(cb: (req: CredentialRequest) => void): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

// --- askpass channel ------------------------------------------------------------------------------

interface Askpass {
  script: string
  socket: string
}

const ENV_SOCKET = 'GITKROKEN_ASKPASS_SOCK'
const ENV_TOKEN = 'GITKROKEN_ASKPASS_TOKEN'
/** A request is one short JSON line; anything bigger is not ours */
const MAX_REQUEST = 64 * 1024

/** The program git / ssh end up running. CommonJS, no dependencies, no secrets inside. */
const HELPER_SOURCE = [
  "'use strict'",
  "const net = require('net')",
  `const path = process.env.${ENV_SOCKET}`,
  `const token = process.env.${ENV_TOKEN}`,
  'if (!path || !token) process.exit(1)',
  'let reply = ""',
  'const socket = net.connect(path)',
  "socket.setEncoding('utf8')",
  "socket.on('connect', () => {",
  "  socket.write(JSON.stringify({ token, prompt: process.argv[2] || '' }) + '\\n')",
  '})',
  "socket.on('data', (chunk) => { reply += chunk })",
  "socket.on('error', () => process.exit(1))",
  "socket.on('close', () => {",
  '  let answer = null',
  '  try { answer = JSON.parse(reply) } catch (e) { process.exit(1) }',
  "  if (!answer || answer.ok !== true || typeof answer.value !== 'string') process.exit(1)",
  "  process.stdout.write(answer.value + '\\n', () => process.exit(0))",
  '})',
  ''
].join('\n')

const shQuote = (text: string): string => `'${text.replace(/'/g, `'\\''`)}'`

let askpass: Promise<Askpass | null> | null = null

function startAskpass(): Promise<Askpass | null> {
  return new Promise((done) => {
    let dir: string
    let server: Server
    try {
      // A unix socket path is limited to ~104 bytes: fall back to /tmp when
      // the regular temp dir is too deep.
      const base = tmpdir().length > 60 && process.platform !== 'win32' ? '/tmp' : tmpdir()
      dir = mkdtempSync(join(base, 'gitkroken-askpass-'))
      chmodSync(dir, 0o700)
      const main = join(dir, 'askpass.js')
      const script = join(dir, 'askpass.sh')
      writeFileSync(main, HELPER_SOURCE, { mode: 0o600 })
      // process.execPath is the Electron binary in the app (dev and packaged)
      // and node under vitest; ELECTRON_RUN_AS_NODE makes the former behave
      // like the latter. Nothing here depends on files of the source tree.
      writeFileSync(script, `#!/bin/sh\nELECTRON_RUN_AS_NODE=1 exec ${shQuote(process.execPath)} ${shQuote(main)} "$@"\n`, { mode: 0o700 })
      chmodSync(script, 0o700)
      const socket =
        process.platform === 'win32' ? `\\\\.\\pipe\\gitkroken-askpass-${randomBytes(12).toString('hex')}` : join(dir, 's')

      server = createServer(onConnection)
      server.once('error', () => {
        rmSync(dir, { recursive: true, force: true })
        done(null)
      })
      server.listen(socket, () => {
        // Later errors must neither crash the app nor keep it alive.
        server.removeAllListeners('error')
        server.on('error', () => {})
        server.unref()
        process.once('exit', () => {
          try {
            rmSync(dir, { recursive: true, force: true })
          } catch {
            // best effort
          }
        })
        done({ script, socket })
      })
    } catch {
      done(null)
    }
  })
}

/** Starts the askpass channel once. Resolves null when it cannot be set up (git then fails instead of prompting). */
function ensureAskpass(): Promise<Askpass | null> {
  if (!askpass) {
    askpass = startAskpass().then((result) => {
      if (!result) askpass = null
      return result
    })
  }
  return askpass
}

const reply = (socket: Socket, value: string): void => {
  // One line only: the helper prints it followed by a newline.
  socket.end(`${JSON.stringify({ ok: true, value: value.split(/[\r\n]/)[0] ?? '' })}\n`)
}
const refuse = (socket: Socket): void => {
  socket.end('{"ok":false}\n')
}

function onConnection(socket: Socket): void {
  let buffer = ''
  let handled = false
  // A helper sends its line at once; whoever dawdles is not a helper.
  const timer = setTimeout(() => socket.destroy(), 10_000)
  socket.setEncoding('utf8')
  socket.on('error', () => {})
  socket.on('close', () => clearTimeout(timer))
  socket.on('data', (chunk: string) => {
    if (handled) return
    buffer += chunk
    if (buffer.length > MAX_REQUEST) {
      socket.destroy()
      return
    }
    const end = buffer.indexOf('\n')
    if (end < 0) return
    handled = true
    clearTimeout(timer)
    handleRequest(socket, buffer.slice(0, end))
  })
}

function handleRequest(socket: Socket, line: string): void {
  let message: { token?: unknown; prompt?: unknown } | null = null
  try {
    message = JSON.parse(line) as { token?: unknown; prompt?: unknown }
  } catch {
    message = null
  }
  const op = findOp(message?.token)
  if (!op || op.controller.signal.aborted || typeof message?.prompt !== 'string') {
    socket.destroy()
    return
  }
  const prompt = message.prompt
  const parsed = parseCredentialPrompt(prompt)
  op.lastActivity = Date.now()

  // A stored account for this HTTPS host answers without bothering the user.
  // (Never over plain http, and never for ssh prompts.)
  if (parsed.scheme === 'https' && parsed.host && (parsed.kind === 'username' || parsed.kind === 'password')) {
    let stored: { username: string; password: string } | null = null
    try {
      stored = credentialsForHost(parsed.host)
    } catch {
      stored = null
    }
    if (stored) {
      reply(socket, parsed.kind === 'username' ? stored.username : stored.password)
      return
    }
  }

  if (listeners.size === 0) {
    refuse(socket)
    return
  }

  const id = randomUUID()
  pending.set(id, { op, socket })
  op.waiting.add(id)
  socket.once('close', () => {
    // Git went away (finished, failed or was cancelled) before the answer came.
    if (pending.delete(id)) {
      op.waiting.delete(id)
      op.lastActivity = Date.now()
    }
  })
  const request: CredentialRequest = { id, kind: parsed.kind, prompt }
  if (parsed.host) request.host = parsed.host
  if (parsed.username) request.username = parsed.username
  for (const cb of listeners) {
    try {
      cb(request)
    } catch {
      // a broken listener must not take the channel down
    }
  }
}

// --- running -------------------------------------------------------------------------------------

export interface NetOptions extends Omit<RunOptions, 'signal' | 'onActivity'> {
  /** What `cancel()` will be called with. Default: `cwd` */
  key?: string
}

/** What the user already decided about transports: we only fill the gaps. */
async function transportDefaults(cwd: string, extraEnv?: Record<string, string>): Promise<{ args: string[]; env: Record<string, string> }> {
  const out = await runGit(cwd, ['config', '--get-regexp', '^(core\\.sshcommand|http\\.(.*\\.)?lowspeed(limit|time))$'], {
    okCodes: [0, 1]
  }).then(
    (res) => res.stdout,
    () => ''
  )
  const args: string[] = []
  const env: Record<string, string> = {}
  if (!/^http\..*lowspeed/im.test(out)) {
    args.push('-c', `http.lowSpeedLimit=${netSettings.httpLowSpeedLimit}`, '-c', `http.lowSpeedTime=${netSettings.httpLowSpeedTimeS}`)
  }
  // GIT_SSH_COMMAND beats core.sshCommand, and both replace plain `ssh`: only
  // add our timeouts when the user configured neither (nor GIT_SSH).
  const userSsh =
    /^core\.sshcommand /im.test(out) ||
    !!process.env['GIT_SSH_COMMAND'] ||
    !!process.env['GIT_SSH'] ||
    !!extraEnv?.['GIT_SSH_COMMAND'] ||
    !!extraEnv?.['GIT_SSH']
  if (!userSsh) {
    env['GIT_SSH_COMMAND'] =
      `ssh -o ConnectTimeout=${netSettings.sshConnectTimeoutS} -o ServerAliveInterval=20 -o ServerAliveCountMax=3`
  }
  return { args, env }
}

let exitHooked = false

/**
 * Git runs in its own process group (see exec.ts), so it would outlive the
 * app: a transfer nobody can see, cancel or answer prompts for. Take the
 * running operations down with us.
 */
function killOnExit(): void {
  if (exitHooked) return
  exitHooked = true
  process.once('exit', () => {
    for (const op of ops.values()) op.controller.abort(new Error(CANCELLED_MESSAGE))
  })
}

/**
 * Runs a git command that talks to a remote: credential prompts reach the
 * user, `cancel(key)` kills it, and a server that stops answering cannot hang
 * it forever. Same contract as `runGit` otherwise.
 */
export async function netGit(cwd: string, args: readonly string[], opts: NetOptions = {}): Promise<RunResult> {
  const { key, ...runOpts } = opts
  const controller = new AbortController()
  const op: NetOp = {
    key: keyOf(key ?? cwd),
    token: randomBytes(32).toString('hex'),
    controller,
    waiting: new Set(),
    lastActivity: Date.now()
  }
  // Registered before anything asynchronous, so an early cancel is not lost.
  ops.set(op.token, op)
  killOnExit()
  let watchdog: NodeJS.Timeout | undefined
  try {
    const [helper, defaults] = await Promise.all([ensureAskpass(), transportDefaults(cwd, runOpts.env)])
    const env: Record<string, string> = { ...defaults.env }
    if (helper) {
      env['GIT_ASKPASS'] = helper.script
      env['SSH_ASKPASS'] = helper.script
      // Use the helper even though there is no X display (OpenSSH >= 8.4).
      env['SSH_ASKPASS_REQUIRE'] = 'force'
      env[ENV_SOCKET] = helper.socket
      env[ENV_TOKEN] = op.token
    }

    const idle = netSettings.idleTimeoutMs
    op.lastActivity = Date.now()
    if (idle > 0) {
      watchdog = setInterval(
        () => {
          // The clock stands still while the user is looking at a credential dialog.
          if (op.waiting.size > 0) op.lastActivity = Date.now()
          else if (Date.now() - op.lastActivity >= idle) {
            const seconds = Math.max(1, Math.round(idle / 1000))
            controller.abort(
              new Error(`Timed out: no response from the remote for ${seconds} s. Check your connection and try again.`)
            )
          }
        },
        Math.min(5000, Math.max(25, Math.floor(idle / 4)))
      )
      watchdog.unref()
    }

    return await runGit(cwd, [...defaults.args, ...args], {
      ...runOpts,
      env: { ...env, ...runOpts.env },
      signal: controller.signal,
      onActivity: () => {
        op.lastActivity = Date.now()
      }
    })
  } finally {
    clearInterval(watchdog)
    ops.delete(op.token)
    // Requests nobody answered die with the operation.
    for (const id of op.waiting) {
      const entry = pending.get(id)
      pending.delete(id)
      entry?.socket.destroy()
    }
    op.waiting.clear()
  }
}

// --- clone clean-up ----------------------------------------------------------------------------------

/**
 * Runs a clone into `target` and, when it fails or is cancelled, removes what
 * the clone created, and only that: a folder that already existed is kept
 * (emptied again if it was empty, untouched if it had content).
 */
export async function cloneWithCleanup<T>(parentDir: string, target: string, run: () => Promise<T>): Promise<T> {
  const before = await lstat(target).then(
    async (info) => (info.isDirectory() && (await readdir(target)).length === 0 ? 'empty' : 'occupied'),
    () => 'absent'
  )
  // The first folder that had to be created, if any
  const createdFrom = await mkdir(parentDir, { recursive: true })
  try {
    return await run()
  } catch (err) {
    const retry = { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }
    try {
      if (before === 'absent') {
        await rm(target, retry)
      } else if (before === 'empty') {
        for (const name of await readdir(target)) await rm(join(target, name), retry)
      }
      if (createdFrom) {
        // Folders made for this clone, innermost first; rmdir refuses non-empty ones.
        const stop = dirname(resolve(createdFrom))
        for (let dir = resolve(parentDir); dir !== stop && dir !== dirname(dir); dir = dirname(dir)) await rmdir(dir)
      }
    } catch {
      // best effort: the original error is the one worth reporting
    }
    throw err
  }
}

// --- API ----------------------------------------------------------------------------------------------

async function cancel(repo: string): Promise<boolean> {
  if (typeof repo !== 'string' || repo === '') return false
  const key = keyOf(repo)
  let found = false
  for (const op of ops.values()) {
    if (op.key !== key || op.controller.signal.aborted) continue
    op.controller.abort(new Error(CANCELLED_MESSAGE))
    found = true
  }
  return found
}

async function answerCredential(id: string, value: string | null): Promise<void> {
  const entry = typeof id === 'string' ? pending.get(id) : undefined
  // Unknown or stale id: the operation is gone, there is nobody to answer.
  if (!entry) return
  pending.delete(id)
  entry.op.waiting.delete(id)
  entry.op.lastActivity = Date.now()
  if (typeof value === 'string') {
    reply(entry.socket, value)
    return
  }
  // The user said no. Failing only this prompt would make ssh move on to the
  // next key or method and ask again, so the whole operation ends here.
  refuse(entry.socket)
  entry.op.controller.abort(new Error(CANCELLED_MESSAGE))
}

export const netApi: Pick<GitApi, 'cancel' | 'answerCredential'> = { cancel, answerCredential }
