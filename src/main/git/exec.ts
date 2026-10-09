// Low-level `git` process runner. No Electron imports: safe to load in plain Node.
import { spawn, type ChildProcess } from 'child_process'
import { stat } from 'fs/promises'

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

  constructor(message: string, info: { code: number | null; stdout: string; stderr: string; args: readonly string[] }) {
    super(message)
    // `name` deliberately stays "Error": Electron serialises a rejected IPC
    // call as "Error invoking remote method '...': <name>: <message>", and the
    // renderer strips exactly the "Error: " prefix before showing a toast.
    this.code = info.code
    this.stdout = info.stdout
    this.stderr = info.stderr
    this.args = info.args
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
  '-c', 'log.showSignature=false'
]

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
  const env: NodeJS.ProcessEnv = {
    ...process.env,
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
    ...extra
  }
  if (literal) env['GIT_LITERAL_PATHSPECS'] = '1'
  const path = extraPath()
  if (path && !extra?.['PATH']) env['PATH'] = path
  return env
}

/** Turns git's stdout/stderr into a short human-readable message. */
export function cleanGitMessage(stderr: string, stdout: string, fallback: string): string {
  const tidy = (text: string): string[] =>
    text
      .replace(/\r/g, '\n')
      .split('\n')
      .map((l) => l.trimEnd())
      .filter((l) => l.trim() !== '' && !/^hint:/.test(l))
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
    const text = (chunks: Buffer[]): string => Buffer.concat(chunks).toString('utf8')
    const collect = (into: Buffer[]) => (chunk: Buffer): void => {
      if (overflow) return
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

    child.once('error', (cause: NodeJS.ErrnoException) => {
      if (settled) return
      settled = true
      // Spawn-level failure: git missing, cwd missing...
      void describeSpawnFailure(cwd, cause).then((message) =>
        reject(new GitError(message, { code: null, stdout: '', stderr: '', args }))
      )
    })
    child.once('close', (code, signal) => {
      if (settled) return
      settled = true
      if (overflow) {
        reject(new GitError('Git produced too much output', { code: null, stdout: '', stderr: '', args }))
        return
      }
      const stdout = text(out)
      const stderr = text(err)
      if (code !== null && okCodes.includes(code)) {
        resolve({ stdout, stderr, code })
        return
      }
      const fallback = code === null ? `Git was terminated (${signal ?? 'unknown signal'})` : `git ${args[0] ?? ''} failed (exit code ${code})`
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
