// Every GitApi method that only needs the `git` CLI and the filesystem.
// No Electron imports here, so this module is testable in plain Node.
import { existsSync } from 'fs'
import { mkdir, realpath, stat } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'path'
import type { Commit, CommitDetails, DiffRequest, GitApi, Ref, Remote, ResetMode, Status } from '@shared/types'
import { assertPaths, assertRef, git, runGit, tryGit } from './exec'
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

export type CoreGitApi = Omit<GitApi, 'pickDirectory' | 'reveal' | 'openInTerminal'>

type InProgress = Status['inProgress']

// --- per-repo write serialisation ------------------------------------------------
// Two concurrent index writers make git fail with "index.lock: File exists"
// (e.g. the user staging several files in quick succession), so mutating
// operations on the same repo run one after another. Reads are not queued.

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

/** Wraps a mutating method so calls for the same repo are serialised. */
function mut<A extends [string, ...any[]]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return (...args: A) => withLock(args[0], () => fn(...args))
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
  await mkdir(parentDir, { recursive: true })
  await git(parentDir, ['clone', '--', source, target])
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

  if (req.commit) {
    assertRef(req.commit, 'commit')
    const commitDiff = (rev: string, files: string[]): Promise<string> =>
      git(repo, ['diff-tree', '-p', '--root', '--no-commit-id', ...DIFF_FLAGS, '--diff-merges=first-parent', rev, '--', ...files], LITERAL)
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
  if (req.staged) return git(repo, ['diff', '--cached', ...DIFF_FLAGS, '--', ...paths], LITERAL)

  const out = await git(repo, ['diff', ...DIFF_FLAGS, '--', ...paths], LITERAL)
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

  const untracked = st.unstaged.filter((f) => f.status === 'untracked' && isWanted(f.path)).map((f) => f.path)
  // Worktree differs from the index: restore from the index. This is right
  // for staged-new files too (they are not in HEAD, only in the index).
  const tracked = st.unstaged.filter((f) => f.status !== 'untracked' && isWanted(f.path)).map((f) => f.path)
  const conflicted = st.conflicted.filter((f) => isWanted(f.path)).map((f) => f.path)

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
  const hasHead = (await tryGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'])) !== null
  if (hasHead) await git(repo, ['reset', '--hard', 'HEAD', '--'])
  else await git(repo, ['rm', '-r', '-f', '-q', '--cached', '--ignore-unmatch', '--', '.'])
  await git(repo, ['clean', '-f', '-d', '-q'])
}

async function applyPatch(repo: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<void> {
  if (typeof patch !== 'string' || !patch.trim()) throw new Error('Empty patch')
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
  assertRef(ref)
  const isLocal = await refExists(repo, `refs/heads/${ref}`)
  if (!isLocal && (await refExists(repo, `refs/remotes/${ref}`))) {
    // `origin/foo` -> local `foo`. Remote names may contain slashes: take the longest match.
    const remote = (await remoteNames(repo))
      .filter((r) => ref.startsWith(`${r}/`))
      .sort((a, b) => b.length - a.length)[0]
    const local = remote ? ref.slice(remote.length + 1) : ref.slice(ref.indexOf('/') + 1)
    if (local && local !== 'HEAD') {
      assertRef(local, 'branch name')
      if (await refExists(repo, `refs/heads/${local}`)) await git(repo, ['checkout', local, '--'])
      else await git(repo, ['checkout', '-b', local, '--track', `refs/remotes/${ref}`])
      return
    }
  }
  // Local branch, or tag / commit hash (detached HEAD).
  await git(repo, ['checkout', ref, '--'])
}

async function createBranch(repo: string, name: string, startPoint?: string, doCheckout?: boolean): Promise<void> {
  assertRef(name, 'branch name')
  const start = startPoint ? [assertRef(startPoint, 'start point')] : []
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
  assertRef(newName, 'branch name')
  await git(repo, ['branch', '-m', '--', oldName, newName])
}

async function merge(repo: string, ref: string): Promise<void> {
  assertRef(ref)
  await git(repo, ['merge', '--no-edit', ref])
}

async function rebase(repo: string, onto: string): Promise<void> {
  assertRef(onto)
  await git(repo, ['rebase', onto])
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
  if (op === 'merge') await git(repo, ['commit', '--no-edit'])
  else if (op === 'rebase') await git(repo, ['rebase', '--continue'])
  else if (op === 'cherry-pick') await git(repo, ['cherry-pick', '--continue'])
  else if (op === 'revert') await git(repo, ['revert', '--continue'])
  else throw new Error('No merge, rebase, cherry-pick or revert in progress')
}

async function createTag(repo: string, name: string, hash: string, message?: string): Promise<void> {
  assertRef(name, 'tag name')
  assertRef(hash, 'commit')
  const annotate = message && message.trim() ? ['-a', `--message=${message}`] : []
  await git(repo, ['tag', ...annotate, '--', name, hash])
}

async function deleteTag(repo: string, name: string): Promise<void> {
  assertRef(name, 'tag name')
  await git(repo, ['tag', '-d', '--', name])
}

// --- remotes -------------------------------------------------------------------------------------

async function fetch(repo: string): Promise<void> {
  await git(repo, ['fetch', '--all', '--prune'])
}

async function pull(repo: string, opts?: { rebase?: boolean }): Promise<void> {
  const args = ['pull', '--no-edit']
  if (opts?.rebase === true) args.push('--rebase')
  else if (opts?.rebase === false) args.push('--no-rebase')
  else {
    // Unspecified: honour the user's pull.rebase, else merge. Without an
    // explicit choice git refuses to reconcile divergent branches.
    const configured = await tryGit(repo, ['config', '--get', 'pull.rebase'])
    if (!configured?.trim()) args.push('--no-rebase')
  }
  await git(repo, args)
}

async function push(repo: string, opts?: { branch?: string; force?: boolean }): Promise<void> {
  const branch = opts?.branch ? assertRef(opts.branch, 'branch name') : await currentBranch(repo)
  if (!branch) throw new Error('Cannot push: HEAD is detached. Check out a branch first.')
  if (!(await refExists(repo, `refs/heads/${branch}`))) throw new Error(`Branch not found: ${branch}`)

  const info = await git(repo, ['for-each-ref', '--format=%(upstream:remotename)%00%(upstream:remoteref)', `refs/heads/${branch}`])
  const [upRemote = '', upRef = ''] = info.replace(/\n$/, '').split('\0')

  const args = ['push']
  if (opts?.force) args.push('--force-with-lease')

  if (upRemote && upRemote !== '.' && upRef) {
    args.push('--', upRemote, `refs/heads/${branch}:${upRef}`)
  } else {
    const names = await remoteNames(repo)
    const remote = names.includes('origin') ? 'origin' : names[0]
    if (!remote) throw new Error('Cannot push: this repository has no remote. Add one first.')
    // A branch tracking another local branch (remote ".") keeps that setup.
    if (upRemote !== '.') args.push('-u')
    args.push('--', remote, `refs/heads/${branch}:refs/heads/${branch}`)
  }
  await git(repo, args)
}

async function deleteRemoteBranch(repo: string, remote: string, branch: string): Promise<void> {
  assertRef(remote, 'remote name')
  assertRef(branch, 'branch name')
  await git(repo, ['push', '--', remote, `:refs/heads/${branch}`])
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
  const args = ['stash', 'push', '--include-untracked']
  if (message && message.trim()) args.push(`--message=${message.trim()}`)
  const res = await runGit(repo, args)
  // git exits 0 without creating anything when the tree is clean.
  if (/^No local changes to save/m.test(res.stdout + res.stderr)) throw new Error('No local changes to save')
}

async function stashPop(repo: string, index: number): Promise<void> {
  await git(repo, ['stash', 'pop', assertStashIndex(index)])
}

async function stashApply(repo: string, index: number): Promise<void> {
  await git(repo, ['stash', 'apply', assertStashIndex(index)])
}

async function stashDrop(repo: string, index: number): Promise<void> {
  await git(repo, ['stash', 'drop', assertStashIndex(index)])
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
