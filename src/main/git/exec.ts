// Low-level `git` process runner. No Electron imports: safe to load in plain Node.
import { spawn, type ChildProcess } from 'child_process'
import { stat } from 'fs/promises'
// Import cycle (hosting.ts uses this runner): only ever call it inside a function.
import { activeIdentity } from './hosting'

/**
 * Output cap. `git log` / `git diff` on big repos can be very large; the
 * ceiling is what V8 can still hold in a single string (~512 MiB).
 */
const MAX_BUFFER = 400 * 1024 * 1024

export class GitError extends Error {
  readonly code: number | null
  readonly stdout: string
  readonly stderr: string
  readonly args: readonly string[]
  /** True when the process was killed through `RunOptions.signal` (cancel / watchdog) */
  readonly aborted: boolean

  constructor(
    message: string,
    info: { code: number | null; stdout: string; stderr: string; args: readonly string[]; aborted?: boolean }
  ) {
    super(message)
    // `name` deliberately stays "Error": Electron serialises a rejected IPC
    // call as "Error invoking remote method '...': <name>: <message>", and the
    // renderer strips exactly the "Error: " prefix before showing a toast.
    this.code = info.code
    this.stdout = info.stdout
    this.stderr = info.stderr
    this.args = info.args
    this.aborted = info.aborted === true
  }
}

export interface RunOptions {
  /** Text written to the child's stdin (stdin is always closed afterwards) */
  input?: string
  /** Exit codes treated as success. Default `[0]` */
  okCodes?: readonly number[]
  /** Extra environment variables */
  env?: Record<string, string>
  /**
   * Treat pathspecs literally (no globbing, no `:(magic)`). Set for every
   * command that receives file paths from the UI. Deliberately not global:
   * porcelain such as `git stash -u` breaks when it inherits the setting.
   */
  literal?: boolean
  /**
   * Aborting kills git and everything it started (ssh, remote helpers, hooks)
   * and rejects with a GitError whose message is the abort reason's message.
   */
  signal?: AbortSignal
  /** Called for every chunk of output (stdout or stderr): liveness for watchdogs */
  onActivity?: () => void
}

export interface RunResult {
  stdout: string
  stderr: string
  code: number
}

/**
 * Config forced on every invocation so output is machine-parseable no matter
 * what the user has in their gitconfig.
 */
const BASE_CONFIG = [
  '-c', 'color.ui=false',
  '-c', 'core.quotepath=false',
  '-c', 'diff.noprefix=false',
  '-c', 'diff.mnemonicPrefix=false',
  '-c', 'log.showSignature=false',
  // A read-only `git diff` must not rewrite .git/index to refresh stat data:
  // that races with staging on index.lock and re-triggers the file watcher.
  '-c', 'diff.autoRefreshIndex=false'
]

/**
 * Variables that point git at a repository other than the one in `cwd`. When
 * the app inherits them (started from a git hook, an IDE terminal, a script)
 * every command would silently act on that other repository.
 */
const REPO_LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX'
]

/** Commit identity of the active profile, as environment variables (empty when there is none). */
function identityEnv(): Record<string, string> {
  try {
    const id = activeIdentity()
    if (!id) return {}
    const env: Record<string, string> = {}
    if (id.name) env['GIT_AUTHOR_NAME'] = env['GIT_COMMITTER_NAME'] = id.name
    if (id.email) env['GIT_AUTHOR_EMAIL'] = env['GIT_COMMITTER_EMAIL'] = id.email
    return env
  } catch {
    // A broken profile store must never stop git from running.
    return {}
  }
}

function extraPath(): string | undefined {
  // GUI apps on macOS start with a minimal PATH; make Homebrew helpers
  // (git-lfs, credential managers, gpg) reachable.
  if (process.platform !== 'darwin') return undefined
  const current = (process.env['PATH'] ?? '').split(':').filter(Boolean)
  const wanted = ['/usr/local/bin', '/opt/homebrew/bin']
  const missing = wanted.filter((p) => !current.includes(p))
  return missing.length ? [...current, ...missing].join(':') : undefined
}

function buildEnv(extra?: Record<string, string>, literal?: boolean): NodeJS.ProcessEnv {
  const inherited: NodeJS.ProcessEnv = { ...process.env }
  for (const name of REPO_LOCATION_VARS) delete inherited[name]
  const env: NodeJS.ProcessEnv = {
    ...inherited,
    // Never hang waiting for credentials or an editor.
    GIT_TERMINAL_PROMPT: '0',
    GIT_EDITOR: 'true',
    GIT_SEQUENCE_EDITOR: 'true',
    GIT_MERGE_AUTOEDIT: 'no',
    GIT_PAGER: 'cat',
    // Stable, untranslated output.
    LC_ALL: 'C',
    LANG: 'C',
    // Read-only commands (status) must not rewrite the index: that would
    // re-trigger our own file watcher in a loop.
    GIT_OPTIONAL_LOCKS: '0',
    // Commits made by the app use the active profile (the user's config is untouched).
    ...identityEnv(),
    ...extra
  }
  if (literal) env['GIT_LITERAL_PATHSPECS'] = '1'
  const path = extraPath()
  if (path && !extra?.['PATH']) env['PATH'] = path
  return env
}

/** Transfer progress (`--progress`), which is noise in an error message */
const PROGRESS_LINE =
  /^(remote: )?(Enumerating objects|Counting objects|Compressing objects|Receiving objects|Resolving deltas|Writing objects|Unpacking objects|Updating files|Checking out files|Checking connectivity|Filtering content|Delta compression using|Total \d+ \(delta)/

/** Turns git's stdout/stderr into a short human-readable message. */
export function cleanGitMessage(stderr: string, stdout: string, fallback: string): string {
  const tidy = (text: string): string[] =>
    text
      .replace(/\r/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '' && !/^hint:/.test(l) && !PROGRESS_LINE.test(l))
      .map((l) => l.replace(/^(fatal|error|warning): /, ''))

  const errLines = tidy(stderr)
  const outLines = tidy(stdout)
  // Conflicts are reported on stdout ("CONFLICT (content): Merge conflict in x").
  const conflicts = outLines.filter((l) => /^CONFLICT /.test(l))
  let lines: string[]
  if (errLines.length) lines = [...conflicts.filter((c) => !errLines.includes(c)), ...errLines]
  else lines = outLines
  // De-duplicate while keeping order; cap the size for toasts.
  const seen = new Set<string>()
  lines = lines.filter((l) => (seen.has(l) ? false : (seen.add(l), true)))
  if (lines.length > 30) lines = [...lines.slice(0, 30), `... (${lines.length - 30} more lines)`]
  const msg = lines.join('\n').trim()
  return msg || fallback
}

/** First argument that is not a `-c key=value` pair: the subcommand, for messages. */
function subcommand(args: readonly string[]): string {
  let i = 0
  while (args[i] === '-c') i += 2
  return args[i] ?? ''
}

/**
 * Signals git and every process it started. On POSIX the child is the leader
 * of its own process group (it is spawned detached), so signalling `-pid`
 * reaches ssh, git-remote-https, hooks and the askpass helper too.
 */
function killTree(child: ChildProcess, signal: NodeJS.Signals): void {
  const pid = child.pid
  if (pid === undefined) return
  if (process.platform === 'win32') {
    try {
      const killer = spawn('taskkill', ['/pid', String(pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
      killer.once('error', () => child.kill())
    } catch {
      child.kill()
    }
    return
  }
  try {
    process.kill(-pid, signal)
  } catch {
    try {
      child.kill(signal)
    } catch {
      // already gone
    }
  }
}

/** How long a cancelled git gets to clean up after SIGTERM before SIGKILL */
const KILL_GRACE_MS = 1500
/** How long to wait for stragglers holding the pipes once git itself has exited */
const DRAIN_GRACE_MS = 500

function abortMessage(signal: AbortSignal): string {
  const reason: unknown = signal.reason
  if (reason instanceof Error && reason.name !== 'AbortError' && reason.message) return reason.message
  if (typeof reason === 'string' && reason) return reason
  return 'Operation cancelled'
}

/**
 * Runs `git <args>` in `cwd`. Arguments are passed as an argv array (no shell).
 * Rejects with a GitError carrying a clean message when the exit code is not
 * in `okCodes`.
 */
export function runGit(cwd: string, args: readonly string[], opts: RunOptions = {}): Promise<RunResult> {
  return new Promise<RunResult>((resolve, reject) => {
    if (typeof cwd !== 'string' || cwd === '') {
      reject(new GitError('No repository path given', { code: null, stdout: '', stderr: '', args }))
      return
    }
    for (const a of args) {
      if (typeof a !== 'string' || a.includes('\0')) {
        reject(new GitError('Invalid argument', { code: null, stdout: '', stderr: '', args: [] }))
        return
      }
    }
    const signal = opts.signal
    const aborted = (): GitError =>
      new GitError(signal ? abortMessage(signal) : 'Operation cancelled', { code: null, stdout: '', stderr: '', args, aborted: true })
    if (signal?.aborted) {
      reject(aborted())
      return
    }
    const okCodes = opts.okCodes ?? [0]
    let child: ChildProcess
    try {
      child = spawn('git', [...BASE_CONFIG, ...args], {
        cwd,
        env: buildEnv(opts.env, opts.literal),
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
        // Own session => no controlling terminal. When the app is started
        // from a shell, ssh / gpg would otherwise prompt on that terminal,
        // invisibly, and the operation would hang forever.
        detached: process.platform !== 'win32'
      })
    } catch (err) {
      void describeSpawnFailure(cwd, err as NodeJS.ErrnoException).then((message) =>
        reject(new GitError(message, { code: null, stdout: '', stderr: '', args }))
      )
      return
    }

    const out: Buffer[] = []
    const err: Buffer[] = []
    let size = 0
    let overflow = false
    let settled = false
    let killing = false
    let killTimer: NodeJS.Timeout | undefined
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')
    const collect = (into: Buffer[]) => (chunk: Buffer): void => {
      if (overflow) return
      opts.onActivity?.()
      size += chunk.length
      if (size > MAX_BUFFER) {
        overflow = true
        child.kill()
        return
      }
      into.push(chunk)
    }
    child.stdout?.on('data', collect(out))
    child.stderr?.on('data', collect(err))

    const onAbort = (): void => {
      if (settled || killing) return
      killing = true
      killTree(child, 'SIGTERM')
      killTimer = setTimeout(() => killTree(child, 'SIGKILL'), KILL_GRACE_MS)
    }
    /** Returns false when the promise was already settled. */
    const settle = (): boolean => {
      if (settled) return false
      settled = true
      signal?.removeEventListener('abort', onAbort)
      return true
    }
    signal?.addEventListener('abort', onAbort, { once: true })

    child.once('error', (cause: NodeJS.ErrnoException) => {
      clearTimeout(killTimer)
      if (!settle()) return
      // Spawn-level failure: git missing, cwd missing...
      void describeSpawnFailure(cwd, cause).then((message) =>
        reject(new GitError(message, { code: null, stdout: '', stderr: '', args }))
      )
    })
    child.once('exit', () => {
      clearTimeout(killTimer)
      if (!killing) return
      // Git is gone, but something it started may have ignored SIGTERM, and may
      // be holding the pipes open (in which case 'close' never comes). Give the
      // rest of the group a moment to clean up, then make sure and stop waiting.
      setTimeout(() => {
        killTree(child, 'SIGKILL')
        if (settled) return
        child.stdout?.destroy()
        child.stderr?.destroy()
        if (settle()) reject(aborted())
      }, DRAIN_GRACE_MS)
    })
    child.once('close', (code, sig) => {
      if (!settle()) return
      const succeeded = code !== null && okCodes.includes(code)
      // Cancelled a moment too late: git finished its work, so say so.
      if (killing && !succeeded) {
        reject(aborted())
        return
      }
      if (overflow) {
        reject(new GitError('Git produced too much output', { code: null, stdout: '', stderr: '', args }))
        return
      }
      const stdout = text(out)
      const stderr = text(err)
      if (succeeded) {
        resolve({ stdout, stderr, code })
        return
      }
      const fallback =
        code === null ? `Git was terminated (${sig ?? 'unknown signal'})` : `git ${subcommand(args)} failed (exit code ${code})`
      reject(new GitError(cleanGitMessage(stderr, stdout, fallback), { code, stdout, stderr, args }))
    })

    // Always close stdin so git can never sit waiting for input.
    child.stdin?.on('error', () => {})
    child.stdin?.end(opts.input ?? '')
  })
}

async function describeSpawnFailure(cwd: string, err: NodeJS.ErrnoException): Promise<string> {
  if (err.code === 'ENOENT' || err.code === 'ENOTDIR') {
    // Node reports a missing cwd as ENOENT on the executable.
    const isDir = await stat(cwd).then((s) => s.isDirectory(), () => false)
    if (!isDir) return `Folder not found: ${cwd}`
    return 'Git executable not found. Install Git and make sure it is on your PATH.'
  }
  return err.message || 'Failed to run git'
}

/** stdout of a git command */
export async function git(cwd: string, args: readonly string[], opts?: RunOptions): Promise<string> {
  return (await runGit(cwd, args, opts)).stdout
}

/** Like `git`, but resolves null instead of rejecting when git exits non-zero. */
export async function tryGit(cwd: string, args: readonly string[], opts?: RunOptions): Promise<string | null> {
  try {
    return (await runGit(cwd, args, opts)).stdout
  } catch {
    return null
  }
}

// --- argument validation -----------------------------------------------------

/**
 * Validates a user-supplied revision / ref / branch / remote name before it is
 * placed in argv. The important part is refusing a leading `-`, which git
 * would parse as an option.
 */
export function assertRef(value: unknown, what = 'ref'): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${what}`)
  if (value.startsWith('-')) throw new Error(`Invalid ${what}: "${value}" must not start with "-"`)
  // eslint-disable-next-line no-control-regex
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error(`Invalid ${what}: control characters are not allowed`)
  return value
}

/** Validates a list of repo-relative paths (they are always passed after `--`). */
export function assertPaths(paths: unknown): string[] {
  if (!Array.isArray(paths)) throw new Error('Expected a list of paths')
  for (const p of paths) {
    if (typeof p !== 'string' || p === '' || p.includes('\0')) throw new Error('Invalid path')
  }
  return paths as string[]
}
