// Submodules, linked worktrees and Git LFS. No Electron imports: testable in plain Node.
import { existsSync } from 'fs'
import { readFile, readdir, realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, join, resolve } from 'path'
import type { GitApi, LfsInfo, Submodule, Worktree } from '@shared/types'
import { GitError, git, runGit, tryGit } from './exec'
import { netGit as runNetGit } from './net'

type ExtrasApi = Pick<
  GitApi,
  | 'submodules'
  | 'submoduleUpdate'
  | 'submoduleAdd'
  | 'worktrees'
  | 'worktreeAdd'
  | 'worktreeRemove'
  | 'lfsInfo'
  | 'lfsInstall'
  | 'lfsTrack'
  | 'lfsUntrack'
  | 'lfsPull'
>

// --- write serialisation -------------------------------------------------------
// Same contract as the queue in core.ts (writes on one repo run one after
// another, reads are never queued). core.ts does not export its `withLock`, so
// this is a second queue with identical semantics: it serialises the writes of
// this module among themselves, but not against the ones in core.ts. Once
// core.ts exports `withLock`, import it here and delete this copy.

const queues = new Map<string, Promise<unknown>>()

function withLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(repo) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(repo, tail)
  void tail.then(() => {
    if (queues.get(repo) === tail) queues.delete(repo)
  })
  return run
}

function mut<A extends [string, ...any[]]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return (...args: A) => withLock(args[0], () => fn(...args))
}

/**
 * Runner for the operations of this module that talk to a remote (submodule
 * clone / fetch, `lfs pull`): the same one fetch / pull / push use, so
 * credential prompts reach the user, a dead server cannot hang them forever
 * and `cancel(repo)` kills them. `repo` is the cancel key even when the
 * command runs in another folder (a nested submodule's parent).
 */
async function netGit(repo: string, args: readonly string[], opts?: { cwd?: string; env?: Record<string, string> }): Promise<string> {
  return (await runNetGit(opts?.cwd ?? repo, args, { key: repo, env: opts?.env })).stdout
}

// --- validation -------------------------------------------------------------------

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

// eslint-disable-next-line no-control-regex
const CONTROL = /[\x00-\x1f\x7f]/

/** A value that ends up in argv: non-empty, no leading `-` (option injection), no control characters. */
function argText(value: unknown, what: string): string {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`Missing ${what}`)
  const text = value.trim()
  if (text.startsWith('-')) throw new Error(`Invalid ${what}: it must not start with "-"`)
  if (CONTROL.test(text)) throw new Error(`Invalid ${what}: control characters are not allowed`)
  return text
}

/** A path relative to the repository root that stays inside it. */
function relPath(value: unknown, what: string): string {
  const text = argText(value, what)
    .replace(/\\/g, '/')
    .replace(/^(\.\/)+/, '')
    .replace(/\/+$/, '')
  if (text === '' || text === '.') throw new Error(`Missing ${what}`)
  if (isAbsolute(text) || /^[a-zA-Z]:/.test(text)) {
    throw new Error(`Invalid ${what}: it must be relative to the repository root`)
  }
  const parts = text.split('/')
  if (parts.some((p) => p === '..' || p === '' || p === '.')) {
    throw new Error(`Invalid ${what}: it must not contain "..", "." or empty segments`)
  }
  if (parts.some((p) => p.toLowerCase() === '.git')) throw new Error(`Invalid ${what}: it must not contain ".git"`)
  if (text.startsWith(':')) throw new Error(`Invalid ${what}: it must not start with ":"`)
  return text
}

/** Follows symlinks when the path exists, so two spellings of one folder compare equal. */
async function canonical(path: string): Promise<string> {
  const abs = resolve(path)
  return realpath(abs).catch(() => abs)
}

// --- submodules ---------------------------------------------------------------------

export interface SubmoduleStatusEntry {
  /** ' ' in sync, '-' not initialised, '+' checked-out commit differs from the recorded one, 'U' merge conflict */
  flag: ' ' | '-' | '+' | 'U'
  /** As printed: the checked-out commit for '+', zeros for 'U', the recorded commit otherwise */
  hash: string
  /** Relative to the superproject root, also for nested submodules */
  path: string
}

/** Parses `git submodule status [--recursive]`. */
export function parseSubmoduleStatus(out: string): SubmoduleStatusEntry[] {
  const entries: SubmoduleStatusEntry[] = []
  for (const line of out.split(/\r?\n/)) {
    const m = /^([ +\-U])([0-9a-f]{40,64}) (.+)$/.exec(line)
    if (!m) continue
    const flag = m[1] as SubmoduleStatusEntry['flag']
    let path = m[3]!
    // Only ' ' and '+' carry a trailing " (<git describe>)".
    if ((flag === ' ' || flag === '+') && path.endsWith(')')) {
      const at = path.lastIndexOf(' (')
      if (at > 0) path = path.slice(0, at)
    }
    entries.push({ flag, hash: m[2]!, path })
  }
  return entries
}

const STATE: Record<SubmoduleStatusEntry['flag'], Submodule['status']> = {
  ' ': 'ok',
  '-': 'uninitialized',
  '+': 'modified',
  U: 'conflict'
}

/** path -> url of the `.gitmodules` in `dir` (paths relative to `dir`). */
async function gitmodulesUrls(dir: string): Promise<Map<string, string>> {
  const out = await tryGit(dir, ['config', '-f', '.gitmodules', '-z', '--get-regexp', '^submodule\\..*\\.(path|url)$'])
  const byName = new Map<string, { path?: string; url?: string }>()
  for (const record of (out ?? '').split('\0')) {
    if (!record) continue
    // `-z` prints "<key>\n<value>\0"
    const nl = record.indexOf('\n')
    const key = nl < 0 ? record : record.slice(0, nl)
    const value = nl < 0 ? '' : record.slice(nl + 1)
    const m = /^submodule\.(.*)\.(path|url)$/i.exec(key)
    if (!m) continue
    const entry = byName.get(m[1]!) ?? {}
    if (m[2]!.toLowerCase() === 'path') entry.path = value
    else entry.url = value
    byName.set(m[1]!, entry)
  }
  const urls = new Map<string, string>()
  for (const entry of byName.values()) if (entry.path) urls.set(entry.path.replace(/\/+$/, ''), entry.url ?? '')
  return urls
}

/** The commit the index of `dir` records for the gitlink at `rel` ("ours" while it is in conflict). */
async function recordedHash(dir: string, rel: string): Promise<string | null> {
  const out = await tryGit(dir, ['ls-files', '--stage', '-z', '--', rel], { literal: true })
  let fallback: string | null = null
  for (const record of (out ?? '').split('\0')) {
    const m = /^160000 ([0-9a-f]{40,64}) ([0-3])\t/.exec(record)
    if (!m) continue
    if (m[2] === '0' || m[2] === '2') return m[1]!
    fallback ??= m[1]!
  }
  return fallback
}

/**
 * Branch checked out in the work tree at `dir`, or undefined when detached.
 * Reads HEAD straight from disk: this runs for every submodule on every
 * refresh, and a file read is far cheaper than a git process.
 */
async function checkedOutBranch(dir: string): Promise<string | undefined> {
  try {
    let gitDir = join(dir, '.git')
    if ((await stat(gitDir)).isFile()) {
      const pointer = /^gitdir: (.+)$/m.exec(await readFile(gitDir, 'utf8'))
      if (!pointer) return undefined
      gitDir = resolve(dir, pointer[1]!.trim())
    }
    const head = (await readFile(join(gitDir, 'HEAD'), 'utf8')).trim()
    const m = /^ref: refs\/heads\/(.+)$/.exec(head)
    if (!m) return undefined
    if (m[1] !== '.invalid') return m[1]
    // reftable repositories keep a placeholder in HEAD: ask git.
    const res = await runGit(dir, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })
    return res.stdout.trim() || undefined
  } catch {
    return undefined
  }
}

async function submodules(repo: string): Promise<Submodule[]> {
  if (typeof repo !== 'string' || !repo) throw new Error('Missing repository path')
  // Nearly every repository has none: answer without starting a process.
  if (!existsSync(join(repo, '.gitmodules'))) return []
  const entries = parseSubmoduleStatus(await git(repo, ['submodule', 'status', '--recursive']))
  if (entries.length === 0) return []

  const paths = entries.map((e) => e.path)
  /** Path of the submodule that contains `path` ('' = the repository itself) */
  const parentOf = (path: string): string => {
    let best = ''
    for (const p of paths) if (p.length > best.length && path.startsWith(`${p}/`)) best = p
    return best
  }
  const urlCache = new Map<string, Promise<Map<string, string>>>()
  const urlsOf = (dir: string): Promise<Map<string, string>> => {
    let cached = urlCache.get(dir)
    if (!cached) urlCache.set(dir, (cached = gitmodulesUrls(dir)))
    return cached
  }

  return Promise.all(
    entries.map(async (e): Promise<Submodule> => {
      const parent = parentOf(e.path)
      const parentDir = parent ? join(repo, parent) : repo
      const rel = parent ? e.path.slice(parent.length + 1) : e.path
      const [urls, recorded, branch] = await Promise.all([
        urlsOf(parentDir),
        // For these two states the printed hash is not the recorded one.
        e.flag === '+' || e.flag === 'U' ? recordedHash(parentDir, rel) : null,
        e.flag === '-' ? undefined : checkedOutBranch(join(repo, e.path))
      ])
      const sub: Submodule = { path: e.path, url: urls.get(rel) ?? '', hash: recorded ?? e.hash, status: STATE[e.flag] }
      if (branch) sub.branch = branch
      return sub
    })
  )
}

/** git >= 2.38.1 refuses to clone submodules over the `file` transport unless the user allows it. */
function explainSubmoduleError(e: unknown): never {
  const message = errMessage(e)
  if (/transport 'file' not allowed/.test(message)) {
    throw new Error(
      'Git refuses, for security, to clone submodules from a local path (protocol.file.allow). ' +
        'Use an https or ssh URL; if you trust that local repository, allow the "file" protocol in your Git configuration.\n' +
        message
    )
  }
  throw e
}

/**
 * A nested submodule is not a pathspec of the top repository: it has to be
 * updated from the repository that directly contains it.
 */
function containingRepo(repo: string, rel: string): { dir: string; rel: string } {
  const parts = rel.split('/')
  for (let i = parts.length - 1; i > 0; i--) {
    const dir = join(repo, ...parts.slice(0, i))
    if (existsSync(join(dir, '.git'))) return { dir, rel: parts.slice(i).join('/') }
  }
  return { dir: repo, rel }
}

async function submoduleUpdate(repo: string, path?: string): Promise<void> {
  // --progress: without a terminal git is silent while cloning, and the network
  // runner takes a long silence for a dead connection.
  const base = ['submodule', 'update', '--init', '--recursive', '--progress']
  try {
    if (path === undefined || path === null || path === '') {
      await netGit(repo, base)
      return
    }
    const target = containingRepo(repo, relPath(path, 'submodule path'))
    // `:(literal)` — the path is a name, never a glob.
    await netGit(repo, [...base, '--', `:(literal)${target.rel}`], { cwd: target.dir })
  } catch (e) {
    explainSubmoduleError(e)
  }
}

async function submoduleAdd(repo: string, url: string, path: string): Promise<void> {
  const source = argText(url, 'submodule URL')
  const target = relPath(path, 'submodule path')
  try {
    await netGit(repo, ['submodule', 'add', '--progress', '--', source, target])
  } catch (e) {
    explainSubmoduleError(e)
  }
}

// --- worktrees ------------------------------------------------------------------------

/** Parses `git worktree list --porcelain` (with or without `-z`). The first entry is the main worktree. */
export function parseWorktreeList(out: string): Worktree[] {
  const lines = out.includes('\0') ? out.split('\0') : out.split(/\r?\n/)
  const list: Worktree[] = []
  let current: Worktree | null = null
  for (const line of lines) {
    const space = line.indexOf(' ')
    const key = space < 0 ? line : line.slice(0, space)
    const value = space < 0 ? '' : line.slice(space + 1)
    if (key === 'worktree') {
      current = { path: value, head: '', branch: null, isMain: list.length === 0, locked: false, prunable: false }
      list.push(current)
    } else if (!current) {
      continue
    } else if (key === 'HEAD') {
      current.head = value
    } else if (key === 'branch') {
      // `detached` and `bare` entries have no branch line: branch stays null.
      current.branch = value.replace(/^refs\/heads\//, '')
    } else if (key === 'locked') {
      current.locked = true
    } else if (key === 'prunable') {
      current.prunable = true
    }
  }
  return list
}

async function worktrees(repo: string): Promise<Worktree[]> {
  // `-z` (git >= 2.36) survives any path; older gits only have the line format.
  const out =
    (await tryGit(repo, ['worktree', 'list', '--porcelain', '-z'])) ?? (await git(repo, ['worktree', 'list', '--porcelain']))
  return parseWorktreeList(out)
}

/** The destination of a new worktree: absolute, and either missing or an empty folder. */
async function worktreeTarget(path: unknown): Promise<string> {
  const target = argText(path, 'destination folder')
  if (!isAbsolute(target)) throw new Error('The worktree destination folder must be an absolute path')
  const info = await stat(target).catch(() => null)
  if (!info) {
    // git creates the folder; make sure it is not being asked to create it below a file.
    const parent = await stat(dirname(target)).catch(() => null)
    if (parent && !parent.isDirectory()) throw new Error(`Cannot create the worktree at "${target}": the parent path is not a folder`)
    return target
  }
  if (!info.isDirectory()) throw new Error(`Cannot create the worktree at "${target}": it already exists and is not a folder`)
  if ((await readdir(target)).length > 0) {
    throw new Error(
      `Cannot create the worktree at "${target}": the folder already exists and is not empty. ` +
        'Choose an empty folder or a path that does not exist yet.'
    )
  }
  return target
}

async function worktreeAdd(repo: string, path: string, ref: string, newBranch?: string): Promise<void> {
  const target = await worktreeTarget(path)
  const start = argText(ref, 'branch or ref')
  const branch = typeof newBranch === 'string' && newBranch.trim() !== '' ? argText(newBranch, 'new branch name') : null
  // --no-track, as createBranch does: a branch made from `origin/main` must not
  // silently get `origin/main` as its push target.
  const args = branch
    ? ['worktree', 'add', '--no-track', '-b', branch, '--', target, start]
    : ['worktree', 'add', '--', target, start]
  try {
    await git(repo, args)
  } catch (e) {
    const message = errMessage(e)
    // "'x' is already checked out at '/p'" (git < 2.42), "'x' is already used by worktree at '/p'" (newer)
    const busy = /'([^']+)' is already (?:checked out|used by worktree) at '([^']+)'/.exec(message)
    if (busy) {
      throw new Error(
        `Branch "${busy[1]}" is already checked out in the worktree "${busy[2]}". ` +
          'A branch can only be checked out in one worktree at a time: choose another branch or enter a new branch name.'
      )
    }
    const exists = /a branch named '([^']+)' already exists/i.exec(message)
    if (exists) throw new Error(`A branch named "${exists[1]}" already exists. Choose another name for the new branch.`)
    throw e
  }
}

async function worktreeRemove(repo: string, path: string, force?: boolean): Promise<void> {
  const wanted = await canonical(argText(path, 'worktree path'))
  let found: Worktree | undefined
  for (const wt of await worktrees(repo)) {
    if ((await canonical(wt.path)) === wanted) {
      found = wt
      break
    }
  }
  if (!found) throw new Error(`"${path}" is not a worktree of this repository`)
  if (found.isMain) throw new Error('The main worktree of the repository cannot be removed')
  if ((await canonical(repo)) === wanted) {
    throw new Error('This worktree is the open repository. Remove it from the main repository or another worktree.')
  }
  // Without --force git refuses when the worktree has modified or untracked
  // files; that refusal is kept as is (the UI asks before retrying with force).
  await git(repo, ['worktree', 'remove', ...(force ? ['--force'] : []), '--', found.path])
}

// --- Git LFS ----------------------------------------------------------------------------

function lfsMissingMessage(): string {
  const how =
    process.platform === 'darwin'
      ? 'On macOS: "brew install git-lfs".'
      : process.platform === 'win32'
        ? 'On Windows it ships with Git for Windows; you can also use "winget install GitHub.GitLFS".'
        : 'On Linux: install the "git-lfs" package with your distribution package manager.'
  return `Git LFS is not installed on this computer. ${how} More information at https://git-lfs.com. Then try again.`
}

const NOT_A_COMMAND = /'lfs' is not a git command/

/** How long a "not installed" answer is trusted by `lfsInfo` (it runs on every refresh) */
const LFS_RECHECK_MS = 30_000
let lfsProbe: { path: string; available: boolean; at: number } | null = null

/**
 * Whether `git lfs` works. A positive answer is cached; a negative one only
 * for a short while (or not at all with `fresh`), so installing git-lfs while
 * the app is open is picked up.
 */
async function lfsAvailable(repo: string, fresh = false): Promise<boolean> {
  const path = process.env['PATH'] ?? ''
  if (lfsProbe && lfsProbe.path === path) {
    if (lfsProbe.available) return true
    if (!fresh && Date.now() - lfsProbe.at < LFS_RECHECK_MS) return false
  }
  try {
    await runGit(repo, ['lfs', 'version'])
    lfsProbe = { path, available: true, at: Date.now() }
    return true
  } catch (e) {
    // A missing folder / missing git is not "LFS is not installed".
    if (e instanceof GitError && e.code === null) throw e
    lfsProbe = { path, available: false, at: Date.now() }
    return false
  }
}

/** Runs `git lfs <args>`, rejecting with install instructions when the binary is missing. */
async function lfs(repo: string, args: readonly string[], run: (repo: string, args: readonly string[]) => Promise<string> = git): Promise<string> {
  if (!(await lfsAvailable(repo, true))) throw new Error(lfsMissingMessage())
  try {
    return await run(repo, ['lfs', ...args])
  } catch (e) {
    if (NOT_A_COMMAND.test(errMessage(e))) {
      // Uninstalled since the last probe.
      lfsProbe = null
      throw new Error(lfsMissingMessage())
    }
    throw e
  }
}

/** Patterns with `filter=lfs` in the text of a `.gitattributes` file, as `git lfs track` shows them. */
export function parseLfsPatterns(text: string): string[] {
  const patterns: string[] = []
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim()
    if (!line || line.startsWith('#')) continue
    let pattern: string
    let rest: string
    if (line.startsWith('"')) {
      // C-style quoted pattern
      let i = 1
      let value = ''
      while (i < line.length && line[i] !== '"') {
        if (line[i] === '\\' && i + 1 < line.length) i++
        value += line[i]
        i++
      }
      pattern = value
      rest = line.slice(i + 1)
    } else {
      const m = /^(\S+)(.*)$/.exec(line)!
      pattern = m[1]!
      rest = m[2]!
    }
    // Macro definitions are not paths.
    if (pattern.startsWith('[attr]')) continue
    if (!rest.split(/\s+/).includes('filter=lfs')) continue
    // git-lfs escapes these two when it writes the file.
    pattern = pattern.replace(/\[\[:space:\]\]/g, ' ').replace(/\\#/g, '#')
    if (!patterns.includes(pattern)) patterns.push(pattern)
  }
  return patterns
}

/**
 * Tracked patterns of the `.gitattributes` at the repository root — the file
 * `lfsTrack` / `lfsUntrack` edit. Read from the work tree, so a pattern that
 * was just added shows up before it is committed, and it works without git-lfs.
 */
async function lfsPatterns(repo: string): Promise<string[]> {
  const text = await readFile(join(repo, '.gitattributes'), 'utf8').catch(() => '')
  return text ? parseLfsPatterns(text) : []
}

/** Filters configured and the git-lfs pre-push hook in place: what `git lfs install` sets up. */
async function lfsEnabled(repo: string): Promise<boolean> {
  const [clean, hookPath] = await Promise.all([
    tryGit(repo, ['config', '--get', 'filter.lfs.clean']),
    // honours core.hooksPath and linked worktrees
    tryGit(repo, ['rev-parse', '--git-path', 'hooks/pre-push'])
  ])
  if (!clean?.trim() || !hookPath?.trim()) return false
  const hook = await readFile(resolve(repo, hookPath.trim()), 'utf8').catch(() => '')
  return /git[- ]lfs/.test(hook)
}

async function lfsFiles(repo: string, installed: boolean): Promise<string[]> {
  if (installed) {
    const out = await tryGit(repo, ['lfs', 'ls-files', '-n'])
    if (out !== null) return out.split(/\r?\n/).filter(Boolean)
  }
  // Without the binary (or when it fails, e.g. before the first commit): the
  // tracked files that carry the lfs filter attribute.
  const out = await tryGit(repo, ['ls-files', '-z', '--', ':(attr:filter=lfs)'])
  return out ? out.split('\0').filter(Boolean) : []
}

async function lfsInfo(repo: string): Promise<LfsInfo> {
  if (typeof repo !== 'string' || !repo) throw new Error('Missing repository path')
  const [installed, patterns] = await Promise.all([lfsAvailable(repo), lfsPatterns(repo)])
  // No binary and no patterns: LFS is not in play, do not start any process.
  if (!installed && patterns.length === 0) return { installed, enabled: false, patterns, files: [] }
  const enabled = await lfsEnabled(repo)
  const files = enabled || patterns.length > 0 ? await lfsFiles(repo, installed) : []
  return { installed, enabled, patterns, files }
}

async function lfsInstall(repo: string): Promise<void> {
  // --local: hooks and filters of this repository only; never the user's global config.
  await lfs(repo, ['install', '--local'])
}

function lfsPattern(value: unknown): string {
  const pattern = argText(value, 'pattern')
  if (pattern.startsWith('"') || pattern.includes('\\')) {
    throw new Error('Invalid pattern: use "/" as the separator and do not quote it (for example *.psd)')
  }
  return pattern
}

async function lfsTrack(repo: string, pattern: string): Promise<void> {
  // git-lfs appends the pattern to .gitattributes and does not stage it.
  await lfs(repo, ['track', lfsPattern(pattern)])
}

async function lfsUntrack(repo: string, pattern: string): Promise<void> {
  const wanted = lfsPattern(pattern)
  if (!(await lfsAvailable(repo, true))) throw new Error(lfsMissingMessage())
  // git-lfs exits 0 without doing anything when the pattern is not there.
  if (!(await lfsPatterns(repo)).includes(wanted)) {
    throw new Error(`The pattern "${wanted}" is not in the .gitattributes at the repository root`)
  }
  await lfs(repo, ['untrack', wanted])
}

async function lfsPull(repo: string): Promise<void> {
  // git-lfs only reports progress to a terminal unless told otherwise (see `netGit`).
  await lfs(repo, ['pull'], (cwd, args) => netGit(cwd, args, { env: { GIT_LFS_FORCE_PROGRESS: '1' } }))
}

// --- the API object ------------------------------------------------------------------------

export const extrasApi: ExtrasApi = {
  // reads: never queued
  submodules,
  worktrees,
  lfsInfo,

  submoduleUpdate: mut(submoduleUpdate),
  submoduleAdd: mut(submoduleAdd),
  worktreeAdd: mut(worktreeAdd),
  worktreeRemove: mut(worktreeRemove),
  lfsInstall: mut(lfsInstall),
  lfsTrack: mut(lfsTrack),
  lfsUntrack: mut(lfsUntrack),
  lfsPull: mut(lfsPull)
}
