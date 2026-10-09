// Merge-conflict backend: the three index stages of an unmerged file, the
// human names of the two sides for whatever operation is in progress, and the
// two ways of resolving (write a merged text / take one side wholesale).
// No Electron imports: testable in plain Node.
import { createHash } from 'crypto'
import { existsSync } from 'fs'
import { chmod, lstat, mkdir, readFile, realpath, rm, writeFile } from 'fs/promises'
import { dirname, isAbsolute, join, relative, resolve, sep } from 'path'
import type { ConflictFile, GitApi } from '@shared/types'
import { coreApi } from './core'
import { assertPaths, git, tryGit } from './exec'

type Side = 'ours' | 'theirs'

/** Paths from the UI are file names, never globs or magic pathspecs. */
const LITERAL = { literal: true } as const

const MODE_SYMLINK = '120000'
const MODE_GITLINK = '160000'
const MODE_EXEC = '100755'

interface StageEntry {
  mode: string
  sha: string
}
/** Index stages of one unmerged path: 1 = base, 2 = ours, 3 = theirs */
type Stages = Partial<Record<1 | 2 | 3, StageEntry>>

// --- serialisation ---------------------------------------------------------------------
// The only command here that writes the index is `git add`, and it goes
// through `coreApi.stage`, i.e. through the per-repo mutation queue of core.ts,
// so it can never collide with another index writer ("index.lock: File
// exists"). That queue is private to core.ts, so the worktree half of a
// resolution (write / checkout-index / unlink, none of which lock the index)
// is serialised by this second, local queue: two resolutions of the same repo
// never interleave.

const queues = new Map<string, Promise<unknown>>()

function serial<T>(repo: string, fn: () => Promise<T>): Promise<T> {
  const prev = queues.get(repo) ?? Promise.resolve()
  const run = prev.then(fn, fn)
  const tail = run.catch(() => {})
  queues.set(repo, tail)
  void tail.then(() => {
    if (queues.get(repo) === tail) queues.delete(repo)
  })
  return run
}

// --- helpers ---------------------------------------------------------------------------

function assertPath(path: unknown): string {
  return assertPaths([path])[0]!
}

/**
 * Absolute location of a repo-relative path, refusing anything that would
 * land outside the repository: `..` segments, absolute paths, or a parent
 * folder that is a symlink pointing elsewhere.
 */
async function worktreeTarget(repo: string, path: string): Promise<string> {
  const root = resolve(repo)
  const full = resolve(root, path)
  const rel = relative(root, full)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`Path is outside the repository: ${path}`)
  // Deepest folder that already exists must really be inside the repo.
  let dir = dirname(full)
  while (!existsSync(dir) && dir !== dirname(dir)) dir = dirname(dir)
  const [realRoot, realDir] = await Promise.all([realpath(root), realpath(dir)])
  if (realDir !== realRoot && !realDir.startsWith(realRoot + sep)) {
    throw new Error(`Path is outside the repository: ${path}`)
  }
  return full
}

async function readStages(repo: string, path: string): Promise<Stages> {
  const out = await git(repo, ['ls-files', '--unmerged', '-z', '--', path], LITERAL)
  const stages: Stages = {}
  for (const record of out.split('\0')) {
    // "<mode> <sha> <stage>\t<path>"
    const tab = record.indexOf('\t')
    if (tab < 0 || record.slice(tab + 1) !== path) continue
    const [mode, sha, stage] = record.slice(0, tab).split(' ')
    const n = Number(stage)
    if (mode && sha && (n === 1 || n === 2 || n === 3)) stages[n] = { mode, sha }
  }
  return stages
}

async function requireStages(repo: string, path: string): Promise<Stages> {
  const stages = await readStages(repo, path)
  if (!stages[1] && !stages[2] && !stages[3]) throw new Error(`Not a conflicted file: ${path}`)
  return stages
}

const isBlob = (e: StageEntry): boolean => e.mode !== MODE_GITLINK
/** Regular file content (not a symlink target, not a submodule commit) */
const isFile = (e: StageEntry): boolean => e.mode !== MODE_GITLINK && e.mode !== MODE_SYMLINK

/** Git's own heuristic: a NUL byte near the start means binary. */
const looksBinary = (text: string): boolean => text.slice(0, 8000).includes('\0')

/**
 * True when `text` (git's output decoded as UTF-8) encodes back to exactly the
 * blob `sha`. False for Latin-1, UTF-16... content: editing such a file as
 * text would silently corrupt it.
 */
function isLossless(text: string, sha: string): boolean {
  const bytes = Buffer.from(text, 'utf8')
  const hash = createHash(sha.length === 64 ? 'sha256' : 'sha1')
  hash.update(`blob ${bytes.length}\0`)
  hash.update(bytes)
  return hash.digest('hex') === sha
}

function decodeUtf8(bytes: Buffer): string | null {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
  } catch {
    return null
  }
}

/** Reads the worktree file. `text` is null when it is not valid UTF-8 text. */
async function readWorktree(full: string): Promise<{ exists: boolean; regular: boolean; text: string | null }> {
  const info = await lstat(full).catch(() => null)
  if (!info) return { exists: false, regular: false, text: '' }
  if (!info.isFile()) return { exists: true, regular: false, text: '' }
  const bytes = await readFile(full)
  return { exists: true, regular: true, text: decodeUtf8(bytes) }
}

/** `\r\n` when most line breaks of `text` are CRLF */
export function dominantEol(text: string): '\n' | '\r\n' {
  let crlf = 0
  let lf = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++
    else lf++
  }
  return crlf > lf ? '\r\n' : '\n'
}

/** Rewrites bare LF line breaks as CRLF (existing CRLF stay as they are). */
export function toCrlf(text: string): string {
  return text.replace(/\r?\n/g, '\r\n')
}

// --- labels ----------------------------------------------------------------------------

type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null

interface OpState {
  op: Operation
  gitDir: string
}

async function opState(repo: string): Promise<OpState> {
  const gitDir = (await git(repo, ['rev-parse', '--absolute-git-dir'])).trim()
  const has = (name: string): boolean => existsSync(join(gitDir, name))
  // Same order as core.ts: a stopped rebase also leaves CHERRY_PICK_HEAD behind.
  let op: Operation = null
  if (has('rebase-merge')) op = 'rebase'
  else if (has('rebase-apply') && !has('rebase-apply/applying')) op = 'rebase'
  else if (has('MERGE_HEAD')) op = 'merge'
  else if (has('CHERRY_PICK_HEAD')) op = 'cherry-pick'
  else if (has('REVERT_HEAD')) op = 'revert'
  return { op, gitDir }
}

async function readState(gitDir: string, ...names: string[]): Promise<string | null> {
  for (const name of names) {
    const text = await readFile(join(gitDir, name), 'utf8').catch(() => null)
    if (text !== null && text.trim()) return text.trim()
  }
  return null
}

async function revParse(repo: string, rev: string): Promise<string | null> {
  const out = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`])
  return out?.trim() || null
}

const clip = (text: string, max = 60): string => (text.length > max ? `${text.slice(0, max - 1)}…` : text)

/** `abc1234 Subject of the commit` */
async function commitLabel(repo: string, rev: string): Promise<string> {
  const out = await tryGit(repo, ['log', '-1', '--format=%h%x00%s', rev, '--'])
  const [short = '', subject = ''] = (out ?? '').replace(/\n$/, '').split('\0')
  if (!short) return rev.slice(0, 7)
  return subject ? `${short} ${clip(subject)}` : short
}

/** A branch (local first, then remote, then tag) pointing exactly at `hash` */
async function refNameAt(repo: string, hash: string, exclude?: string | null): Promise<string | null> {
  const out = await tryGit(repo, [
    'for-each-ref',
    `--points-at=${hash}`,
    '--format=%(refname)%00%(refname:short)',
    'refs/heads',
    'refs/remotes',
    'refs/tags'
  ])
  const refs = (out ?? '')
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const [full = '', short = ''] = line.split('\0')
      return { full, short }
    })
    .filter((r) => r.short && !r.full.endsWith('/HEAD') && r.full !== `refs/heads/${exclude ?? ''}`)
  const rank = (full: string): number => (full.startsWith('refs/heads/') ? 0 : full.startsWith('refs/remotes/') ? 1 : 2)
  refs.sort((a, b) => rank(a.full) - rank(b.full))
  return refs[0]?.short ?? null
}

/** The checked-out branch, or `abc1234 (detached HEAD)` */
async function headLabel(repo: string): Promise<{ label: string; branch: string | null }> {
  const branch = (await tryGit(repo, ['symbolic-ref', '--short', '-q', 'HEAD']))?.trim() || null
  if (branch) return { label: branch, branch }
  const short = (await tryGit(repo, ['rev-parse', '--short', 'HEAD']))?.trim()
  return { label: short ? `${short} (detached HEAD)` : 'HEAD', branch: null }
}

async function mergeTheirs(repo: string, gitDir: string, current: string | null): Promise<string> {
  const mergeHead = await revParse(repo, 'MERGE_HEAD')
  if (!mergeHead) return 'Incoming changes'
  // "Merge branch 'x'", "Merge remote-tracking branch 'origin/x'", "Merge tag 'v1' into y"
  const msg = (await readState(gitDir, 'MERGE_MSG')) ?? ''
  const named = /^Merge (?:remote-tracking branch|branch|tag) '([^']+)'/.exec(msg)?.[1]
  // The ref may have been given in full (`refs/heads/x`): show the short name.
  const short = named?.replace(/^refs\/(?:heads|remotes|tags)\//, '')
  // `git pull` writes the remote's branch name, which may be another commit here: verify.
  if (named && short && short !== current && !named.startsWith('-') && (await revParse(repo, named)) === mergeHead) return short
  return (await refNameAt(repo, mergeHead, current)) ?? (await commitLabel(repo, mergeHead))
}

async function stashTheirs(repo: string, path: string, theirs: StageEntry | undefined, merged: string | null): Promise<string> {
  // A stash that did not apply cleanly stays in the list: find the one whose
  // version of the file is our stage 3.
  if (theirs) {
    const list = await tryGit(repo, ['stash', 'list', '-z', '--max-count=20', '--format=%gd%x1f%gs'])
    for (const record of (list ?? '').split('\0')) {
      const [name, message] = record.replace(/^\n/, '').split('\x1f')
      if (!name) continue
      const blob = (await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${name}:${path}`]))?.trim()
      if (blob === theirs.sha) return message ? `${name} (${clip(message)})` : name
    }
  }
  return merged && /^>{7} Stashed changes\r?$/m.test(merged) ? 'Stashed changes' : 'Incoming changes'
}

/**
 * Names of the two sides, by what they really are. Stage 2 ("ours") is always
 * what HEAD had when the operation stopped and stage 3 ("theirs") what is being
 * brought in, which in a rebase is the opposite of what people expect: there
 * HEAD is the branch being rebased onto, and "theirs" is your own commit.
 */
async function sideLabels(
  repo: string,
  path: string,
  stages: Stages,
  merged: string | null
): Promise<{ oursLabel: string; theirsLabel: string }> {
  const { op, gitDir } = await opState(repo)

  if (op === 'rebase') {
    const onto = await readState(gitDir, 'rebase-merge/onto', 'rebase-apply/onto')
    const ontoName = onto ? ((await refNameAt(repo, onto)) ?? (await commitLabel(repo, onto))) : 'HEAD'
    const replayed =
      (await revParse(repo, 'REBASE_HEAD')) ??
      (await readState(gitDir, 'rebase-merge/stopped-sha', 'rebase-apply/original-commit'))
    const branch = (await readState(gitDir, 'rebase-merge/head-name', 'rebase-apply/head-name'))?.replace(/^refs\/heads\//, '')
    const from = branch && branch !== 'detached HEAD' ? ` (from ${branch})` : ''
    return {
      oursLabel: `${ontoName} (rebasing onto)`,
      theirsLabel: replayed ? `${await commitLabel(repo, replayed)}${from}` : `Commit being rebased${from}`
    }
  }

  const head = await headLabel(repo)
  if (op === 'merge') return { oursLabel: head.label, theirsLabel: await mergeTheirs(repo, gitDir, head.branch) }
  if (op === 'cherry-pick') {
    const picked = await revParse(repo, 'CHERRY_PICK_HEAD')
    return { oursLabel: head.label, theirsLabel: picked ? `${await commitLabel(repo, picked)} (cherry-pick)` : 'Cherry-picked commit' }
  }
  if (op === 'revert') {
    // Stage 3 of a revert is the tree *before* the reverted commit.
    const reverted = await revParse(repo, 'REVERT_HEAD')
    return { oursLabel: head.label, theirsLabel: reverted ? `Before ${await commitLabel(repo, reverted)} (revert)` : 'State before the reverted commit' }
  }
  // No operation in progress: `stash pop` / `stash apply` (or `checkout -m`).
  return { oursLabel: head.label, theirsLabel: await stashTheirs(repo, path, stages[3], merged) }
}

// --- the API ---------------------------------------------------------------------------

async function conflictFile(repo: string, path: string): Promise<ConflictFile> {
  assertPath(path)
  const [stages, full] = await Promise.all([requireStages(repo, path), worktreeTarget(repo, path)])

  const read = async (entry: StageEntry | undefined): Promise<{ text: string | null; binary: boolean }> => {
    if (!entry) return { text: null, binary: false }
    // A submodule commit or a symlink target is not editable text.
    if (!isFile(entry)) return { text: '', binary: true }
    const text = await git(repo, ['cat-file', 'blob', entry.sha])
    if (looksBinary(text) || !isLossless(text, entry.sha)) return { text: '', binary: true }
    return { text, binary: false }
  }

  const [base, ours, theirs, worktree] = await Promise.all([read(stages[1]), read(stages[2]), read(stages[3]), readWorktree(full)])
  const worktreeBinary = worktree.exists && (!worktree.regular || worktree.text === null || looksBinary(worktree.text))
  const binary = base.binary || ours.binary || theirs.binary || worktreeBinary
  const merged = binary ? '' : (worktree.text ?? '')
  const labels = await sideLabels(repo, path, stages, binary ? null : merged)

  // Binary content never travels to the renderer: only whether each side exists.
  const side = (s: { text: string | null }): string | null => (s.text === null ? null : binary ? '' : s.text)
  return { path, base: side(base), ours: side(ours), theirs: side(theirs), merged, binary, ...labels }
}

async function resolveConflict(repo: string, path: string, content: string): Promise<void> {
  assertPath(path)
  if (typeof content !== 'string') throw new Error('Missing file content')
  const [stages, full] = await Promise.all([requireStages(repo, path), worktreeTarget(repo, path)])

  const info = await lstat(full).catch(() => null)
  if (info?.isSymbolicLink()) throw new Error(`Cannot write a resolution over a symbolic link: ${path}`)
  if (info && !info.isFile()) throw new Error(`Not a regular file: ${path}`)

  // Line endings: follow the file on disk (the one the user has been looking
  // at, already converted by core.autocrlf / .gitattributes), else a side.
  let reference: string | null = null
  if (info) reference = decodeUtf8(await readFile(full))
  if (!reference || !reference.includes('\n')) {
    const entry = [stages[2], stages[3], stages[1]].find((e) => e && isFile(e))
    if (entry) reference = await git(repo, ['cat-file', 'blob', entry.sha])
  }
  const text = reference && dominantEol(reference) === '\r\n' ? toCrlf(content) : content

  await mkdir(dirname(full), { recursive: true })
  // Writing over an existing file keeps its mode (and so its executable bit).
  await writeFile(full, text)
  if (!info) {
    // The file was missing on disk (deleted by one side): take the mode of a side.
    const exec = (stages[2] ?? stages[3] ?? stages[1])?.mode === MODE_EXEC
    if (exec) await chmod(full, 0o755)
  }
  await coreApi.stage(repo, [path])
}

async function resolveWith(repo: string, path: string, side: Side): Promise<void> {
  assertPath(path)
  if (side !== 'ours' && side !== 'theirs') throw new Error(`Invalid side: ${String(side)}`)
  const [stages, full] = await Promise.all([requireStages(repo, path), worktreeTarget(repo, path)])
  const stage = side === 'ours' ? 2 : 3
  const entry = stages[stage]

  if (entry && !isBlob(entry)) {
    throw new Error(`Submodule conflicts cannot be resolved here: check out the wanted commit inside "${path}" and stage it`)
  }
  if (entry) {
    // Writes that stage to the worktree (through the smudge filters, with its
    // mode) without touching the index.
    await git(repo, ['checkout-index', '--force', `--stage=${stage}`, '--', path])
  } else {
    // That side deleted the file (or never had it): the resolution is its
    // removal. `git add -A` below records it, exactly like `git rm` would.
    const info = await lstat(full).catch(() => null)
    if (info?.isDirectory()) throw new Error(`Cannot remove "${path}": it is a folder on disk`)
    if (info) await rm(full, { force: true })
  }
  await coreApi.stage(repo, [path])
}

export const conflictsApi: Pick<GitApi, 'conflictFile' | 'resolveConflict' | 'resolveWith'> = {
  conflictFile,
  resolveConflict: (repo, path, content) => serial(repo, () => resolveConflict(repo, path, content)),
  resolveWith: (repo, path, side) => serial(repo, () => resolveWith(repo, path, side))
}
