// Every GitApi method that only needs the `git` CLI and the filesystem.
// No Electron imports here, so this module is testable in plain Node.
import { existsSync } from 'fs'
import { mkdir, realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { Commit, CommitDetails, DiffRequest, GitApi, Ref, Remote, ResetMode, Status } from '@shared/types'
import { cloneWithCleanup, netGit, type netApi } from './net'
import type { conflictsApi } from './conflicts'
import type { rebaseApi } from './rebase'
import type { historyApi } from './history'
import type { extrasApi } from './extras'
import type { hostingApi } from './hosting'
import { GitError, assertPaths, assertRef, git, runGit, tryGit } from './exec'
import {
  LOG_FORMAT,
  REF_FORMAT,
  STASH_FORMAT,
  parseLog,
  parseNameStatus,
  parseRefs,
  parseRemotes,
  parseStashList,
  parseStatus,
  type StashEntry
} from './parse'
import { unwatch, watch } from './watcher'

type ElsewhereApi = typeof netApi & typeof conflictsApi & typeof rebaseApi & typeof historyApi & typeof extrasApi & typeof hostingApi
/** The methods implemented in this file; the rest live in the sibling modules */
export type CoreGitApi = Omit<GitApi, 'pickDirectory' | 'reveal' | 'openInTerminal' | keyof ElsewhereApi>

type InProgress = Status['inProgress']

// --- per-repo write serialisation ------------------------------------------------
// Two concurrent index writers make git fail with "index.lock: File exists"
// (e.g. the user staging several files in quick succession), so mutating
// operations on the same repo run one after another. Reads are not queued.

const queues = new Map<string, Promise<unknown>>()

export function withLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(repo) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(repo, tail)
  void tail.then(() => {
    if (queues.get(repo) === tail) queues.delete(repo)
  })
  return run
}

/** Wraps a mutating method so calls for the same repo are serialised. */
function mut<A extends [string, ...any[]]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return (...args: A) =>
    withLock(args[0], async () => {
      await assertRepoRoot(args[0])
      return fn(...args)
    })
}

/**
 * Every write runs with `cwd = repo`. If that folder stopped being a repository
 * (its `.git` was removed) git silently walks up and acts on a parent repo, so
 * refuse unless `repo` is still the top level it was opened as.
 */
export async function assertRepoRoot(repo: string): Promise<void> {
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).trim()
  const same = async (): Promise<boolean> => {
    try {
      return (await realpath(top)) === (await realpath(repo))
    } catch {
      return false
    }
  }
  if (resolve(top) !== resolve(repo) && !(await same())) {
    throw new Error(`"${repo}" is not the root of a Git repository (git would act on "${top}"). Nothing was changed.`)
  }
}

/** Refuses actions that would silently throw away an in-progress merge / rebase / cherry-pick / revert */
async function assertIdle(repo: string, action: string): Promise<void> {
  const op = await detectInProgress(repo)
  if (op) throw new Error(`Cannot ${action} while a ${op} is in progress. Continue or abort the ${op} first.`)
}

type RefKind = 'head' | 'remote' | 'tag' | 'other'
interface ResolvedRef {
  kind: RefKind
  /** Unambiguous name to hand to git: `refs/...` for refs, the input itself for hashes / expressions */
  full: string
  /** Name without the `refs/<kind>/` prefix */
  short: string
}

const REF_PREFIX: Array<[RefKind, string]> = [
  ['head', 'refs/heads/'],
  ['remote', 'refs/remotes/'],
  ['tag', 'refs/tags/']
]

/**
 * A short name such as `v1` may be a branch and a tag at once, and git then
 * picks one by its own rules (not always the same one for checkout and merge).
 * Accepts fully qualified names; a short name that matches several refs is an error.
 */
async function resolveRef(repo: string, ref: string, what = 'ref'): Promise<ResolvedRef> {
  assertRef(ref, what)
  for (const [kind, prefix] of REF_PREFIX) {
    if (ref.startsWith(prefix)) return { kind, full: ref, short: ref.slice(prefix.length) }
  }
  const found: ResolvedRef[] = []
  for (const [kind, prefix] of REF_PREFIX) {
    if (await refExists(repo, prefix + ref)) found.push({ kind, full: prefix + ref, short: ref })
  }
  if (found.length > 1) {
    const names = found.map((f) => (f.kind === 'head' ? 'a local branch' : f.kind === 'tag' ? 'a tag' : 'a remote branch'))
    throw new Error(`"${ref}" is ambiguous: it is ${names.join(' and ')}. Rename one of them, or use the full name (${found.map((f) => f.full).join(', ')}).`)
  }
  return found[0] ?? { kind: 'other', full: ref, short: ref }
}

/**
 * The name to put on a git command line: the short one when it can only mean
 * this ref (git writes it into merge messages and conflict markers), else the full one.
 */
async function refArg(repo: string, ref: string, what = 'ref'): Promise<string> {
  const target = await resolveRef(repo, ref, what)
  if (target.kind === 'other') return target.full
  let matches = 0
  for (const [, prefix] of REF_PREFIX) if (await refExists(repo, prefix + target.short)) matches++
  return matches === 1 ? target.short : target.full
}

/** New branch / tag names: nothing that would shadow or be confused with an existing ref */
async function assertNewName(repo: string, name: string, kind: 'branch' | 'tag'): Promise<void> {
  assertRef(name, `${kind} name`)
  if (/^(refs|heads|tags|remotes)\//.test(name) || name === 'HEAD') throw new Error(`Invalid ${kind} name: "${name}"`)
  const clash = kind === 'tag' ? 'refs/heads/' : 'refs/tags/'
  if (await refExists(repo, clash + name)) {
    throw new Error(`A ${kind === 'tag' ? 'branch' : 'tag'} named "${name}" already exists. Using the same name for a ${kind} makes "${name}" ambiguous.`)
  }
}

// --- helpers -----------------------------------------------------------------------

async function gitDir(repo: string): Promise<string> {
  return (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim()
}

async function detectInProgress(repo: string): Promise<InProgress> {
  const dir = await gitDir(repo)
  const has = (name: string): boolean => existsSync(join(dir, name))
  // A rebase stopped on a conflict also leaves CHERRY_PICK_HEAD / REVERT_HEAD
  // behind, so rebase must be checked first.
  if (has('rebase-merge')) return 'rebase'
  if (has('rebase-apply') && !has('rebase-apply/applying')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return null
}

async function listStashes(repo: string): Promise<StashEntry[]> {
  return parseStashList(await git(repo, ['stash', 'list', '-z', `--format=${STASH_FORMAT}`]))
}

/** Full parent hashes of a commit (empty for a root commit). */
async function parentsOf(repo: string, rev: string): Promise<string[]> {
  const out = await git(repo, ['rev-list', '--no-walk', '--parents', rev, '--'])
  return out.trim().split(/\s+/).slice(1)
}

/** Short name of the checked-out branch, or null when detached. */
async function currentBranch(repo: string): Promise<string | null> {
  const res = await runGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD'], { okCodes: [0, 1] })
  return res.stdout.trim() || null
}

async function refExists(repo: string, fullName: string): Promise<boolean> {
  const res = await runGit(repo, ['show-ref', '--verify', '--quiet', fullName], { okCodes: [0, 1] })
  return res.code === 0
}

async function remoteNames(repo: string): Promise<string[]> {
  return (await git(repo, ['remote'])).split('\n').filter(Boolean)
}

function assertInsideRepo(repo: string, path: string): void {
  const rel = relative(resolve(repo), resolve(repo, path))
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path is outside the repository: ${path}`)
}

function assertStashIndex(index: unknown): string {
  if (typeof index !== 'number' || !Number.isInteger(index) || index < 0) throw new Error('Invalid stash index')
  return `stash@{${index}}`
}

function toCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

/** `https://host/a/b.git` / `git@host:a/b.git` / `/path/to/b` -> `b` */
export function repoNameFromUrl(url: string): string {
  const cleaned = url
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\.(git|bundle)$/i, '')
    .replace(/[\\/]+$/, '')
  const name = /([^\\/:]+)$/.exec(cleaned)?.[1] ?? ''
  if (!name || name === '.' || name === '..' || name.startsWith('-')) {
    throw new Error(`Cannot work out a folder name from "${url}"`)
  }
  return name
}

/** Paths from the UI are file names, never globs or magic pathspecs. */
const LITERAL = { literal: true } as const

/**
 * Runs a path-taking command with the paths on stdin (NUL separated) instead
 * of argv, so a huge selection cannot exceed the OS argument-length limit.
 */
function gitWithPaths(repo: string, args: string[], paths: Iterable<string>): Promise<string> {
  return git(repo, [...args, '--pathspec-from-file=-', '--pathspec-file-nul'], {
    literal: true,
    input: [...paths].join('\0')
  })
}

/** Diff flags that keep the output a plain, appliable unified diff. */
const DIFF_FLAGS = ['--no-color', '--no-ext-diff', '--no-textconv', '--find-renames']
/** More context lines than any file has: the diff then carries the whole file */
const FULL_CONTEXT = '--unified=10000000'

// --- repositories --------------------------------------------------------------------

async function resolveRepo(path: string): Promise<string | null> {
  if (typeof path !== 'string' || !path) return null
  let dir = path
  try {
    const info = await stat(dir)
    if (!info.isDirectory()) dir = dirname(dir)
  } catch {
    return null
  }
  const out = await tryGit(dir, ['rev-parse', '--show-toplevel'])
  const top = out?.replace(/\r?\n$/, '')
  return top ? top : null
}

async function init(path: string): Promise<string> {
  if (typeof path !== 'string' || !path) throw new Error('Missing folder')
  await mkdir(path, { recursive: true })
  await git(path, ['init'])
  return (await resolveRepo(path)) ?? path
}

async function clone(url: string, parentDir: string): Promise<string> {
  if (typeof url !== 'string' || !url.trim()) throw new Error('Missing repository URL')
  if (typeof parentDir !== 'string' || !parentDir) throw new Error('Missing destination folder')
  const source = url.trim()
  if (source.startsWith('-')) throw new Error('Invalid repository URL')
  const target = join(parentDir, repoNameFromUrl(source))
  // Cancellable with `cancel(parentDir)`; a failed or cancelled clone leaves nothing behind.
  await cloneWithCleanup(parentDir, target, () => netGit(parentDir, ['clone', '--progress', '--', source, target]))
  return (await resolveRepo(target)) ?? (await realpath(target).catch(() => target))
}

// --- reading -----------------------------------------------------------------------------

async function log(repo: string, opts?: { limit?: number; skip?: number }): Promise<Commit[]> {
  const limit = toCount(opts?.limit)
  const skip = toCount(opts?.skip) ?? 0
  const stashes = await listStashes(repo)

  // A stash is a merge commit: parents[0] is the commit it was made on,
  // parents[1] holds the index state and parents[2] (optional) the untracked
  // files. The helpers are hidden so each stash is a single node.
  const stashHashes = new Set(stashes.map((s) => s.hash))
  const helpers = new Set<string>()
  for (const s of stashes) for (const p of s.parents.slice(1)) if (!stashHashes.has(p)) helpers.add(p)

  const args = ['log', '--date-order', '-z', `--format=${LOG_FORMAT}`]
  if (helpers.size === 0) {
    if (skip > 0) args.push(`--skip=${skip}`)
    if (limit !== undefined) args.push(`--max-count=${limit}`)
  } else if (limit !== undefined) {
    // Helper commits are filtered out below, so git's own --skip would be off
    // by however many helpers precede the page: fetch from the top instead.
    args.push(`--max-count=${skip + limit + helpers.size}`)
  }
  args.push(
    // Like --all, minus bookkeeping refs that are not history the user made.
    '--exclude=refs/notes/*',
    '--exclude=refs/replace/*',
    '--exclude=refs/original/*',
    '--exclude=refs/bisect/*',
    '--exclude=refs/prefetch/*',
    '--all',
    // `--all` only reaches stash@{0}; older stashes live in the reflog.
    ...stashes.map((s) => s.hash),
    '--'
  )

  let commits = parseLog(await git(repo, args))
  if (stashes.length === 0) return commits

  commits = commits.filter((c) => !helpers.has(c.hash))
  for (const c of commits) {
    if (stashHashes.has(c.hash)) {
      c.isStash = true
      c.parents = c.parents.slice(0, 1)
    }
  }
  if (helpers.size === 0) return commits
  return limit === undefined ? commits.slice(skip) : commits.slice(skip, skip + limit)
}

async function refs(repo: string): Promise<Ref[]> {
  const [refOut, stashes] = await Promise.all([
    git(repo, ['for-each-ref', `--format=${REF_FORMAT}`, 'refs/heads', 'refs/remotes', 'refs/tags']),
    listStashes(repo)
  ])
  const stashRefs: Ref[] = stashes.map((s) => ({
    name: `stash@{${s.index}}`,
    type: 'stash',
    hash: s.hash,
    isCurrent: false,
    message: s.message
  }))
  return [...parseRefs(refOut), ...stashRefs]
}

async function status(repo: string): Promise<Status> {
  const [out, inProgress] = await Promise.all([
    git(repo, ['status', '--porcelain=v2', '-z', '--branch', '--untracked-files=all', '--find-renames', '--no-ahead-behind']),
    detectInProgress(repo)
  ])
  return { ...parseStatus(out), inProgress }
}

async function commitDetails(repo: string, hash: string): Promise<CommitDetails> {
  assertRef(hash, 'commit')
  const [commit] = parseLog(await git(repo, ['log', '-1', '-z', `--format=${LOG_FORMAT}`, hash, '--']))
  if (!commit) throw new Error(`Commit not found: ${hash}`)

  // --root: a root commit is diffed against the empty tree.
  // --diff-merges=first-parent: a merge is diffed against its first parent.
  const nameStatus = (rev: string): Promise<string> =>
    git(repo, ['diff-tree', '-r', '--root', '--no-commit-id', '--name-status', '-z', '--find-renames', '--diff-merges=first-parent', rev, '--'])

  let files = parseNameStatus(await nameStatus(commit.hash))

  if (commit.parents.length >= 2) {
    const stash = (await listStashes(repo)).find((s) => s.hash === commit.hash)
    if (stash) {
      commit.isStash = true
      const untrackedCommit = commit.parents[2]
      commit.parents = commit.parents.slice(0, 1)
      if (untrackedCommit) {
        // Files that were untracked when the stash was made.
        const known = new Set(files.map((f) => f.path))
        const extra = parseNameStatus(await nameStatus(untrackedCommit)).filter((f) => !known.has(f.path))
        files = [...files, ...extra]
      }
    }
  }
  return { commit, files }
}

async function untrackedDiff(repo: string, path: string): Promise<string> {
  assertInsideRepo(repo, path)
  // --no-index exits 1 when the files differ, which is the normal case here.
  const res = await runGit(repo, ['diff', ...DIFF_FLAGS, '--no-index', '--', '/dev/null', path], { okCodes: [0, 1] })
  return res.stdout
}

async function diff(repo: string, req: DiffRequest): Promise<string> {
  if (!req || typeof req.path !== 'string' || !req.path) throw new Error('Missing file path')
  const paths = req.oldPath && req.oldPath !== req.path ? [req.oldPath, req.path] : [req.path]
  assertPaths(paths)
  const flags = req.fullContext ? [...DIFF_FLAGS, FULL_CONTEXT] : DIFF_FLAGS

  if (req.commit) {
    assertRef(req.commit, 'commit')
    const commitDiff = (rev: string, files: string[]): Promise<string> =>
      git(repo, ['diff-tree', '-p', '--root', '--no-commit-id', ...flags, '--diff-merges=first-parent', rev, '--', ...files], LITERAL)
    const out = await commitDiff(req.commit, paths)
    if (out) return out
    // Stash with untracked files: those live in the third parent, a root commit.
    const parents = await parentsOf(repo, req.commit)
    if (parents.length === 3 && (await parentsOf(repo, parents[2]!)).length === 0) {
      return commitDiff(parents[2]!, [req.path])
    }
    return out
  }

  if (req.untracked) return untrackedDiff(repo, req.path)
  if (req.staged) return git(repo, ['diff', '--cached', ...flags, '--', ...paths], LITERAL)

  const out = await git(repo, ['diff', ...flags, '--', ...paths], LITERAL)
  if (out) return out
  // Nothing vs the index: maybe the caller did not flag an untracked file.
  const others = await git(repo, ['ls-files', '--others', '--exclude-standard', '-z', '--', req.path], LITERAL)
  if (others.split('\0').includes(req.path)) return untrackedDiff(repo, req.path)
  return out
}

async function remotes(repo: string): Promise<Remote[]> {
  return parseRemotes(await git(repo, ['remote', '-v']))
}

// --- staging & committing ------------------------------------------------------------------

async function stage(repo: string, paths: string[]): Promise<void> {
  if (assertPaths(paths).length === 0) return
  // -A so that deletions are staged too.
  await gitWithPaths(repo, ['add', '-A'], paths)
}

async function unstage(repo: string, paths: string[]): Promise<void> {
  if (assertPaths(paths).length === 0) return
  // Unstaging the new name of a staged rename must also restore the old name,
  // otherwise its deletion stays staged.
  const staged = parseNameStatus(await git(repo, ['diff', '--cached', '--name-status', '-z', '--find-renames']))
  const all = new Set(paths)
  for (const f of staged) if (f.status === 'renamed' && f.oldPath && all.has(f.path)) all.add(f.oldPath)
  // Path-limited reset also works before the first commit.
  await gitWithPaths(repo, ['reset', '-q'], all)
}

async function stageAll(repo: string): Promise<void> {
  // `git add -A` would mark every conflicted file as resolved, markers and all
  const unmerged = (await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
  if (unmerged.length > 0) {
    throw new Error(
      `${unmerged.length} file${unmerged.length === 1 ? ' has' : 's have'} unresolved conflicts (${unmerged.slice(0, 3).join(', ')}${unmerged.length > 3 ? ', …' : ''}). ` +
        'Resolve them, or mark them as resolved one by one, before staging everything.'
    )
  }
  await git(repo, ['add', '-A'])
}

async function unstageAll(repo: string): Promise<void> {
  // Not a bare `git reset`: that would drop MERGE_HEAD. And not `reset -- .`:
  // that would also wipe the conflict state of unmerged files. So: exactly
  // the staged, non-conflicted paths (both sides of renames).
  const out = await git(repo, ['diff', '--cached', '--name-only', '-z', '--no-renames', '--diff-filter=u'])
  const staged = out.split('\0').filter(Boolean)
  if (staged.length === 0) return
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')
  await gitWithPaths(top || repo, ['reset', '-q'], staged)
}

async function discard(repo: string, paths: string[]): Promise<void> {
  if (assertPaths(paths).length === 0) return
  const wanted = new Set(paths.map((p) => p.replace(/\/+$/, '')))
  /** True for a requested file, or a file inside a requested folder. */
  const isWanted = (file: string): boolean => {
    if (wanted.has(file)) return true
    for (let i = file.lastIndexOf('/'); i > 0; i = file.lastIndexOf('/', i - 1)) {
      if (wanted.has(file.slice(0, i))) return true
    }
    return false
  }

  const statusArgs = ['status', '--porcelain=v2', '-z', '--untracked-files=all', '--no-renames']
  // A long selection is filtered here rather than passed in argv.
  const narrowed = paths.length <= 50 ? [...statusArgs, '--', ...paths] : statusArgs
  const st = parseStatus(await git(repo, narrowed, LITERAL))

  // A requested path that is itself a changed file is a file, not a folder: if a
  // directory now sits where that tracked file was, the untracked files inside
  // it were never part of what the user asked to discard.
  for (const f of [...st.unstaged, ...st.conflicted]) {
    if (f.status !== 'untracked' && wanted.has(f.path)) wanted.delete(f.path)
  }
  const exact = new Set(paths.map((p) => p.replace(/\/+$/, '')))
  const isTracked = (file: string): boolean => exact.has(file) || isWanted(file)

  const untracked = st.unstaged.filter((f) => f.status === 'untracked' && (exact.has(f.path) || isWanted(f.path))).map((f) => f.path)
  // Worktree differs from the index: restore from the index. This is right
  // for staged-new files too (they are not in HEAD, only in the index).
  const tracked = st.unstaged.filter((f) => f.status !== 'untracked' && isTracked(f.path)).map((f) => f.path)
  const conflicted = st.conflicted.filter((f) => isTracked(f.path)).map((f) => f.path)

  // `git checkout -- <file>` deletes a directory standing where the file was,
  // together with everything in it. Never let that happen implicitly.
  for (const path of [...tracked, ...conflicted]) {
    const st = await stat(join(repo, path)).catch(() => null)
    if (st?.isDirectory()) {
      throw new Error(`Cannot restore "${path}": a folder with the same name is in the way. Move or delete that folder first; nothing was changed.`)
    }
  }
  if (tracked.length) await gitWithPaths(repo, ['checkout'], tracked)
  for (const path of conflicted) {
    // Unmerged: go back to our side (HEAD). If HEAD has no such file, drop it.
    const restored = await tryGit(repo, ['checkout', 'HEAD', '--', path], LITERAL)
    if (restored === null) await git(repo, ['rm', '-f', '-q', '--', path], LITERAL)
  }
  // git clean only ever removes untracked files, and refuses paths outside
  // the repo. It has no stdin mode, hence the batches.
  for (let i = 0; i < untracked.length; i += 200) {
    await git(repo, ['clean', '-f', '-q', '--', ...untracked.slice(i, i + 200)], LITERAL)
  }
}

async function discardAll(repo: string): Promise<void> {
  await assertIdle(repo, 'discard all changes')
  const hasHead = (await tryGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) !== null
  if (hasHead) await git(repo, ['reset', '--hard', 'HEAD', '--'])
  else await git(repo, ['rm', '-r', '-f', '-q', '--cached', '--ignore-unmatch', '--', '.'])
  await git(repo, ['clean', '-f', '-d', '-q'])
}

async function applyPatch(repo: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<void> {
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('Empty patch')
  if (patch.includes('\uFFFD')) {
    throw new Error('This file is not valid UTF-8, so single hunks cannot be applied safely. Stage or discard the whole file instead.')
  }
  const args = ['apply', '--whitespace=nowarn', '--recount']
  if (opts?.cached) args.push('--cached')
  if (opts?.reverse) args.push('--reverse')
  args.push('-')
  await git(repo, args, { input: patch.endsWith('\n') ? patch : `${patch}\n` })
}

async function commit(repo: string, message: string, opts?: { amend?: boolean }): Promise<void> {
  const text = typeof message === 'string' ? message : ''
  if (opts?.amend) {
    // Amending with an empty message keeps the existing one.
    if (!text.trim()) await git(repo, ['commit', '--amend', '--no-edit'])
    else await git(repo, ['commit', '--amend', '-F', '-'], { input: text })
    return
  }
  if (!text.trim()) throw new Error('Commit message is empty')
  await git(repo, ['commit', '-F', '-'], { input: text })
}

// --- branches & history -----------------------------------------------------------------------

async function checkout(repo: string, ref: string): Promise<void> {
  const target = await resolveRef(repo, ref)
  await assertIdle(repo, 'check out another commit')
  await assertNoOrphans(repo)

  if (target.kind === 'head') {
    await git(repo, ['checkout', target.short, '--'])
    return
  }
  if (target.kind === 'remote') {
    // `origin/foo` -> local `foo`. Remote names may contain slashes: take the longest match.
    const remote = (await remoteNames(repo))
      .filter((r) => target.short.startsWith(`${r}/`))
      .sort((x, y) => y.length - x.length)[0]
    const local = remote ? target.short.slice(remote.length + 1) : target.short.slice(target.short.indexOf('/') + 1)
    if (local && local !== 'HEAD') {
      assertRef(local, 'branch name')
      if (!(await refExists(repo, `refs/heads/${local}`))) {
        await assertNewName(repo, local, 'branch')
        await git(repo, ['checkout', '-b', local, '--track', target.full])
        return
      }
      // A local branch of that name exists. Behind the remote: fast-forward it.
      // Ahead of it: it already contains the remote commit. Diverged: the two
      // are different lines of work, so do not pretend one is the other.
      const localTip = (await git(repo, ['rev-parse', `refs/heads/${local}`])).trim()
      const remoteTip = (await git(repo, ['rev-parse', target.full])).trim()
      const isAncestor = async (a: string, b: string): Promise<boolean> =>
        (await runGit(repo, ['merge-base', '--is-ancestor', a, b], { okCodes: [0, 1] })).code === 0
      const canFastForward = localTip !== remoteTip && (await isAncestor(localTip, remoteTip))
      if (localTip !== remoteTip && !canFastForward && !(await isAncestor(remoteTip, localTip))) {
        throw new Error(
          `The local branch "${local}" already exists and has diverged from ${target.short}. ` +
            `Check out "${local}" and pull or merge ${target.short} instead.`
        )
      }
      await git(repo, ['checkout', local, '--'])
      if (canFastForward) await git(repo, ['merge', '--ff-only', target.full])
      return
    }
  }
  // Tag or commit hash: detached HEAD.
  await git(repo, ['checkout', '--detach', target.full, '--'])
}

/** Leaving a detached HEAD whose commits are on no branch or tag would make them unreachable */
async function assertNoOrphans(repo: string): Promise<void> {
  if (await currentBranch(repo)) return
  const head = await tryGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])
  if (head === null) return
  const orphans = (await git(repo, ['rev-list', '--count', 'HEAD', '--not', '--branches', '--tags', '--remotes'])).trim()
  if (orphans !== '0') {
    throw new Error(
      `HEAD is detached and has ${orphans} commit${orphans === '1' ? '' : 's'} that ${orphans === '1' ? 'is' : 'are'} not on any branch. ` +
        'Create a branch here first, or those commits will be lost.'
    )
  }
}

async function createBranch(repo: string, name: string, startPoint?: string, doCheckout?: boolean): Promise<void> {
  await assertNewName(repo, name, 'branch')
  const start = startPoint ? [(await resolveRef(repo, startPoint, 'start point')).full] : []
  if (doCheckout) await assertIdle(repo, 'create and check out a branch')
  // --no-track: a branch created from `origin/main` must not silently get
  // `origin/main` as its push target.
  if (doCheckout) await git(repo, ['checkout', '--no-track', '-b', name, ...start])
  else await git(repo, ['branch', '--no-track', '--', name, ...start])
}

async function deleteBranch(repo: string, name: string, force?: boolean): Promise<void> {
  assertRef(name, 'branch name')
  await git(repo, ['branch', force ? '-D' : '-d', '--', name])
}

async function renameBranch(repo: string, oldName: string, newName: string): Promise<void> {
  assertRef(oldName, 'branch name')
  await assertNewName(repo, newName, 'branch')
  await git(repo, ['branch', '-m', '--', oldName, newName])
}

async function merge(repo: string, ref: string): Promise<void> {
  await git(repo, ['merge', '--no-edit', await refArg(repo, ref)])
}

async function rebase(repo: string, onto: string): Promise<void> {
  await git(repo, ['rebase', await refArg(repo, onto)])
}

/** `-m 1` when the commit is a merge: replay it relative to its first parent. */
async function mainlineArgs(repo: string, hash: string): Promise<string[]> {
  return (await parentsOf(repo, hash)).length > 1 ? ['-m', '1'] : []
}

async function cherryPick(repo: string, hash: string): Promise<void> {
  assertRef(hash, 'commit')
  await git(repo, ['cherry-pick', ...(await mainlineArgs(repo, hash)), hash])
}

async function revert(repo: string, hash: string): Promise<void> {
  assertRef(hash, 'commit')
  await git(repo, ['revert', '--no-edit', ...(await mainlineArgs(repo, hash)), hash])
}

async function reset(repo: string, hash: string, mode: ResetMode): Promise<void> {
  assertRef(hash, 'commit')
  if (mode !== 'soft' && mode !== 'mixed' && mode !== 'hard') throw new Error(`Invalid reset mode: ${String(mode)}`)
  await assertIdle(repo, 'reset')
  await git(repo, ['reset', `--${mode}`, hash, '--'])
}

async function abort(repo: string): Promise<void> {
  const op = await detectInProgress(repo)
  if (op === 'merge') await git(repo, ['merge', '--abort'])
  else if (op === 'rebase') await git(repo, ['rebase', '--abort'])
  else if (op === 'cherry-pick') await git(repo, ['cherry-pick', '--abort'])
  else if (op === 'revert') await git(repo, ['revert', '--abort'])
  else throw new Error('No merge, rebase, cherry-pick or revert in progress')
}

async function continueOp(repo: string): Promise<void> {
  // GIT_EDITOR=true is set for every command (see exec.ts): none of these can open an editor.
  const op = await detectInProgress(repo)
  // --cleanup=strip: drop the `# Conflicts:` comment block git leaves in MERGE_MSG
  if (op === 'merge') await git(repo, ['commit', '--no-edit', '--cleanup=strip'])
  else if (op === 'rebase') await git(repo, ['rebase', '--continue'])
  else if (op === 'cherry-pick') await git(repo, ['cherry-pick', '--continue'])
  else if (op === 'revert') await git(repo, ['revert', '--continue'])
  else throw new Error('No merge, rebase, cherry-pick or revert in progress')
}

async function createTag(repo: string, name: string, hash: string, message?: string): Promise<void> {
  await assertNewName(repo, name, 'tag')
  assertRef(hash, 'commit')
  const annotate = message && message.trim() ? ['-a', `--message=${message}`] : []
  await git(repo, ['tag', ...annotate, '--', name, hash])
}

async function deleteTag(repo: string, name: string): Promise<void> {
  assertRef(name, 'tag name')
  await git(repo, ['tag', '-d', '--', name])
}

// --- remotes -------------------------------------------------------------------------------------

// fetch / pull / push / clone go through `netGit`: credential prompts, cancel
// and stall protection (see net.ts). `--progress` keeps output flowing during
// long transfers, which is what tells a slow operation from a dead one.

async function fetch(repo: string): Promise<void> {
  await netGit(repo, ['fetch', '--all', '--prune', '--progress'])
}

async function pull(repo: string, opts?: { rebase?: boolean }): Promise<void> {
  const args = ['pull', '--no-edit']
  const branch = await currentBranch(repo)
  if (opts?.rebase === true) args.push('--rebase')
  else if (opts?.rebase === false) args.push('--no-rebase')
  else {
    // Unspecified: honour the user's pull.rebase / branch.<name>.rebase, else
    // merge. Without an explicit choice git refuses to reconcile divergent branches.
    const configured =
      (branch ? await tryGit(repo, ['config', '--get', `branch.${branch}.rebase`]) : null) ??
      (await tryGit(repo, ['config', '--get', 'pull.rebase']))
    if (!configured?.trim()) args.push('--no-rebase')
  }

  const info = branch
    ? await git(repo, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream)', `refs/heads/${branch}`])
    : ''
  const [upRemote = '', upTracking = ''] = info.replace(/\n$/, '').split('\0')
  if (!upRemote || upRemote === '.' || !upTracking) {
    // No (remote) upstream: git explains what is missing, or merges the local upstream.
    await netGit(repo, [...args, '--progress'])
    return
  }
  // Two steps, so that Cancel and the stall watchdog can only ever interrupt
  // the download, never a merge or rebase that is rewriting the work tree.
  await netGit(repo, ['fetch', '--progress', '--', upRemote])
  if (!(await refExists(repo, upTracking))) {
    throw new Error(`Cannot pull: the remote branch "${upTracking.replace(/^refs\/remotes\//, '')}" no longer exists.`)
  }
  await git(repo, [...args, '.', upTracking])
}

interface PushTarget {
  remote: string
  /** Full ref name on the remote, e.g. `refs/heads/main` */
  dest: string
  /** Remote-tracking ref that mirrors `dest` locally */
  tracking: string
  /** Record the destination as upstream (the branch has none yet) */
  setUpstream: boolean
}

/**
 * Where `git push` would send `branch`: branch.<name>.pushRemote, then
 * remote.pushDefault, then the upstream's remote, then `origin`; on that
 * remote, the upstream branch when it lives there, else a branch of the same
 * name. A destination with a different name than the local branch is refused:
 * the app never pushes onto another branch implicitly.
 */
async function pushTarget(repo: string, branch: string): Promise<PushTarget> {
  const format = ['%(upstream:remotename)', '%(upstream:remoteref)', '%(upstream)', '%(push:remotename)', '%(push:remoteref)'].join('%00')
  const info = await git(repo, ['for-each-ref', `--format=${format}`, `refs/heads/${branch}`])
  const [upRemote = '', upRef = '', upTracking = '', pushRemote = '', pushRef = ''] = info.replace(/\n$/, '').split('\0')

  const names = await remoteNames(repo)
  const remote = names.includes(pushRemote) ? pushRemote : names.includes('origin') ? 'origin' : names[0]
  if (!remote) throw new Error('Cannot push: this repository has no remote. Add one first.')

  const sameName = `refs/heads/${branch}`
  const upstreamHere = upRemote === remote && upRef !== ''
  // pushRef is only set when the remote has push refspecs (remote.<name>.push).
  const dest = pushRef || (upstreamHere ? upRef : sameName)
  if (dest !== sameName && dest.startsWith('refs/heads/')) {
    const destName = dest.slice('refs/heads/'.length)
    throw new Error(
      `Push refused: the local branch "${branch}" is set up to push to "${destName}" on remote "${remote}", ` +
        `a branch with a different name, and pushing would write onto it.\n` +
        `To publish "${branch}" under its own name, remove that tracking (git branch --unset-upstream ${branch}) and push again.`
    )
  }
  const tracking = upstreamHere && upRef === dest && upTracking ? upTracking : `refs/remotes/${remote}/${dest.replace(/^refs\/heads\//, '')}`
  // A branch tracking another local branch (remote ".") keeps that setup.
  return { remote, dest, tracking, setUpstream: upRemote === '' && dest === sameName }
}

/**
 * `lease` (not part of the public contract yet) is the commit the user saw on
 * the remote branch when confirming a force push; '' means "it must not exist".
 */
async function push(repo: string, opts?: { branch?: string; force?: boolean; lease?: string }): Promise<void> {
  const branch = opts?.branch ? assertRef(opts.branch, 'branch name') : await currentBranch(repo)
  if (!branch) throw new Error('Cannot push: HEAD is detached. Check out a branch first.')
  if (!(await refExists(repo, `refs/heads/${branch}`))) throw new Error(`Branch not found: ${branch}`)

  const target = await pushTarget(repo, branch)
  const args = ['push', '--progress']
  if (opts?.force) {
    // An explicit lease: the push only goes through if the remote branch is
    // still at the commit the user was shown. A bare --force-with-lease would
    // trust the remote-tracking ref, which a background fetch moves silently.
    let expected: string
    if (typeof opts.lease === 'string') {
      if (opts.lease !== '' && !/^[0-9a-f]{40,64}$/i.test(opts.lease)) throw new Error('Invalid lease')
      expected = opts.lease
    } else {
      expected = ((await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${target.tracking}^{commit}`])) ?? '').trim()
    }
    args.push(`--force-with-lease=${target.dest}:${expected}`)
  }
  if (target.setUpstream) args.push('-u')
  args.push('--', target.remote, `refs/heads/${branch}:${target.dest}`)

  try {
    await netGit(repo, args)
  } catch (err) {
    if (!(err instanceof GitError) || err.aborted) throw err
    const explain = (message: string): GitError =>
      new GitError(message, { code: err.code, stdout: err.stdout, stderr: err.stderr, args: err.args })
    if (/^\s*! \[rejected\].*\(stale info\)/m.test(err.stderr)) {
      throw explain(
        `Force push rejected (stale info): "${branch}" on "${target.remote}" is no longer at the commit you were shown, ` +
          `so forcing now would discard work you have not seen.\n` +
          `Fetch, review the remote commits, and force push again if that is still what you want.`
      )
    }
    if (/^\s*! \[rejected\].*\((non-fast-forward|fetch first)\)/m.test(err.stderr)) {
      throw explain(
        `Push of "${branch}" was rejected by "${target.remote}" (non-fast-forward): the remote has commits your local branch does not.\n` +
          `Pull to integrate them, then push again. If you rewrote history on purpose (amend, rebase, reset), use "Force Push (with lease)".`
      )
    }
    throw err
  }
}

async function deleteRemoteBranch(repo: string, remote: string, branch: string): Promise<void> {
  assertRef(remote, 'remote name')
  assertRef(branch, 'branch name')
  await netGit(repo, ['push', '--progress', '--', remote, `:refs/heads/${branch}`])
}

async function addRemote(repo: string, name: string, url: string): Promise<void> {
  assertRef(name, 'remote name')
  assertRef(url, 'remote URL')
  await git(repo, ['remote', 'add', '--', name, url.trim()])
}

async function removeRemote(repo: string, name: string): Promise<void> {
  assertRef(name, 'remote name')
  await git(repo, ['remote', 'remove', '--', name])
}

// --- stashes ----------------------------------------------------------------------------------------

async function stashSave(repo: string, message?: string): Promise<void> {
  await assertIdle(repo, 'stash')
  const args = ['stash', 'push', '--include-untracked']
  if (message && message.trim()) args.push(`--message=${message.trim()}`)
  const res = await runGit(repo, args)
  // git exits 0 without creating anything when the tree is clean.
  if (/^No local changes to save/m.test(res.stdout + res.stderr)) throw new Error('No local changes to save')
}

/**
 * `stash@{N}` shifts whenever a stash is created or dropped elsewhere. When the
 * caller says which stash commit it means, refuse if N now names another one.
 */
async function stashArg(repo: string, index: number, hash?: string): Promise<string> {
  const name = assertStashIndex(index)
  if (hash !== undefined) {
    assertRef(hash, 'stash')
    const actual = await tryGit(repo, ['rev-parse', '--verify', '--quiet', name])
    if (actual === null || actual.trim() !== hash) {
      throw new Error('The stash list changed since it was shown. Nothing was done: refresh and try again.')
    }
  }
  return name
}

async function stashPop(repo: string, index: number, hash?: string): Promise<void> {
  await git(repo, ['stash', 'pop', await stashArg(repo, index, hash)])
}

async function stashApply(repo: string, index: number, hash?: string): Promise<void> {
  await git(repo, ['stash', 'apply', await stashArg(repo, index, hash)])
}

async function stashDrop(repo: string, index: number, hash?: string): Promise<void> {
  await git(repo, ['stash', 'drop', await stashArg(repo, index, hash)])
}

// --- the API object ------------------------------------------------------------------------------------

export const coreApi: CoreGitApi = {
  resolveRepo,
  init,
  clone,
  watch,
  unwatch,

  log,
  refs,
  status,
  commitDetails,
  diff,
  remotes,

  stage: mut(stage),
  unstage: mut(unstage),
  stageAll: mut(stageAll),
  unstageAll: mut(unstageAll),
  discard: mut(discard),
  discardAll: mut(discardAll),
  applyPatch: mut(applyPatch),
  commit: mut(commit),

  checkout: mut(checkout),
  createBranch: mut(createBranch),
  deleteBranch: mut(deleteBranch),
  renameBranch: mut(renameBranch),
  merge: mut(merge),
  rebase: mut(rebase),
  cherryPick: mut(cherryPick),
  revert: mut(revert),
  reset: mut(reset),
  abort: mut(abort),
  continueOp: mut(continueOp),
  createTag: mut(createTag),
  deleteTag: mut(deleteTag),

  // fetch / push never touch the index or worktree, so they are not queued:
  // a slow network must not block staging.
  fetch,
  pull: mut(pull),
  push,
  deleteRemoteBranch,
  addRemote: mut(addRemote),
  removeRemote: mut(removeRemote),

  stashSave: mut(stashSave),
  stashPop: mut(stashPop),
  stashApply: mut(stashApply),
  stashDrop: mut(stashDrop)
}
