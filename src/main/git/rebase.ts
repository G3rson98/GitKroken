// Interactive rebase and Undo / Redo. No Electron imports: testable in plain Node.
//
// Both features rewrite where a branch points, so the rule of this file is:
// validate everything first, never overwrite uncommitted work, and always
// leave a way back (a backup ref for the rebase, the reflog for undo).
import { existsSync } from 'fs'
import { copyFile, lstat, mkdir, mkdtemp, open, readFile, readdir, rename, rm, rmdir, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { basename, dirname, join, resolve } from 'path'
import type { Commit, GitApi, RebaseAction, RebaseStep, UndoState } from '@shared/types'
import { GitError, assertRef, git, runGit, tryGit } from './exec'
import { LOG_FORMAT, parseLog } from './parse'

// --- per-repo serialisation ----------------------------------------------------
// core.ts keeps its queue private, so the mutations of this module are
// serialised among themselves. Against the rest git's own index.lock applies.

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

// --- small helpers ---------------------------------------------------------------

const short = (sha: string): string => sha.slice(0, 7)
const isZero = (sha: string): boolean => /^0+$/.test(sha)
const isSha = (text: string): boolean => /^[0-9a-f]{40,64}$/.test(text)

function clip(text: string, max = 60): string {
  const t = text.trim()
  return t.length > max ? `${t.slice(0, max - 1).trimEnd()}…` : t
}

const errMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e))

interface Dirs {
  /** Git dir of this worktree (HEAD, its reflog, rebase state) */
  gitDir: string
  /** Shared git dir (branch reflogs). Same as gitDir outside linked worktrees */
  commonDir: string
}

async function locate(repo: string): Promise<Dirs> {
  const out = await git(repo, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])
  const [gitDir = '', common = ''] = out.replace(/\r?\n$/, '').split(/\r?\n/)
  if (!gitDir) throw new Error('Not a Git repository')
  return { gitDir, commonDir: resolve(repo, common || gitDir) }
}

type Operation = 'merge' | 'rebase' | 'cherry-pick' | 'revert'

/** Same detection order as core.ts (a stopped rebase also leaves CHERRY_PICK_HEAD). */
function operationInProgress(gitDir: string): Operation | null {
  const has = (name: string): boolean => existsSync(join(gitDir, name))
  if (has('rebase-merge')) return 'rebase'
  if (has('rebase-apply') && !has('rebase-apply/applying')) return 'rebase'
  if (has('MERGE_HEAD')) return 'merge'
  if (has('CHERRY_PICK_HEAD')) return 'cherry-pick'
  if (has('REVERT_HEAD')) return 'revert'
  return null
}

interface Head {
  /** null before the first commit */
  sha: string | null
  /** Short branch name; null when HEAD is detached */
  branch: string | null
}

async function headState(repo: string): Promise<Head> {
  const [sha, ref] = await Promise.all([
    runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { okCodes: [0, 1] }),
    // Full name on purpose: --short would print `heads/x` when a tag is also called x.
    runGit(repo, ['symbolic-ref', '-q', 'HEAD'], { okCodes: [0, 1] })
  ])
  const full = ref.stdout.trim()
  return {
    sha: sha.stdout.trim() || null,
    branch: full.startsWith('refs/heads/') ? full.slice('refs/heads/'.length) : null
  }
}

async function commitExists(repo: string, sha: string): Promise<boolean> {
  const res = await runGit(repo, ['cat-file', '-e', `${sha}^{commit}`], { okCodes: [0, 1, 128] })
  return res.code === 0
}

async function branchTip(repo: string, branch: string): Promise<string | null> {
  const res = await runGit(repo, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}^{commit}`], { okCodes: [0, 1] })
  return res.stdout.trim() || null
}

async function isAncestor(repo: string, ancestor: string, descendant: string): Promise<boolean> {
  const res = await runGit(repo, ['merge-base', '--is-ancestor', ancestor, descendant], { okCodes: [0, 1] })
  return res.code === 0
}

/** Tracked files with staged / unstaged changes. Untracked files are not "dirty". */
async function trackedChanges(repo: string): Promise<{ staged: string[]; unstaged: string[] }> {
  const out = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=no', '--no-renames'])
  const staged: string[] = []
  const unstaged: string[] = []
  for (const entry of out.split('\0')) {
    if (entry.length < 4) continue
    const path = entry.slice(3)
    if (entry[0] !== ' ' && entry[0] !== '?') staged.push(path)
    if (entry[1] !== ' ' && entry[1] !== '?') unstaged.push(path)
  }
  return { staged, unstaged }
}

const listFiles = (files: string[], max = 5): string =>
  files.length <= max ? files.join(', ') : `${files.slice(0, max).join(', ')} and ${files.length - max} more`

// =================================================================================
// Interactive rebase
// =================================================================================

/** Where the tip of the branch is saved before it is rewritten */
const BACKUP_PREFIX = 'refs/original/gitkroken/'
const BACKUPS_KEPT = 20
const ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop']

interface Range {
  dirs: Dirs
  branch: string
  head: string
  base: string
  /** `base..HEAD`, oldest first */
  commits: Commit[]
}

const fullMessage = (c: Commit): string => (c.body ? `${c.subject}\n\n${c.body}` : c.subject)

/** Every check that must pass before the range can be offered or rewritten. */
async function inspectRange(repo: string, base: string): Promise<Range> {
  assertRef(base, 'base')
  const dirs = await locate(repo)
  const op = operationInProgress(dirs.gitDir)
  if (op) {
    throw new Error(`A ${op} is in progress. Finish or abort it before starting an interactive rebase.`)
  }
  const head = await headState(repo)
  if (!head.sha) throw new Error('This repository has no commits yet.')
  if (!head.branch) {
    throw new Error(
      'HEAD is detached (no branch is checked out). Check out a branch before starting an interactive rebase.'
    )
  }
  const dirty = await trackedChanges(repo)
  const changed = [...new Set([...dirty.staged, ...dirty.unstaged])]
  if (changed.length) {
    throw new Error(
      `There are uncommitted changes (${listFiles(changed)}). Commit or stash them before starting an interactive rebase.`
    )
  }
  const resolved = await tryGit(repo, ['rev-parse', '--verify', '--quiet', `${base}^{commit}`])
  const baseSha = resolved?.trim()
  if (!baseSha) throw new Error(`Base commit "${base}" not found.`)
  if (baseSha === head.sha) {
    throw new Error(`There are no commits between ${short(baseSha)} and the tip of "${head.branch}": nothing to rebase.`)
  }
  if (!(await isAncestor(repo, baseSha, head.sha))) {
    throw new Error(`${short(baseSha)} is not an ancestor of the current branch "${head.branch}": it cannot be used as the base.`)
  }
  const commits = parseLog(
    await git(repo, ['log', '--reverse', '--topo-order', '-z', `--format=${LOG_FORMAT}`, `${baseSha}..${head.sha}`, '--'])
  )
  const merges = commits.filter((c) => c.parents.length > 1)
  if (merges.length) {
    const names = merges.slice(0, 3).map((c) => `${short(c.hash)} "${clip(c.subject, 40)}"`)
    throw new Error(
      `The range contains ${merges.length === 1 ? 'a merge commit' : `${merges.length} merge commits`} ` +
        `(${names.join(', ')}${merges.length > 3 ? '…' : ''}). Interactive rebase does not rewrite merges, ` +
        'because that would flatten them. Pick a base that comes after the merge.'
    )
  }
  if (commits.length === 0) throw new Error('There are no commits to rebase.')
  return { dirs, branch: head.branch, head: head.sha, base: baseSha, commits }
}

async function rebaseTodo(repo: string, base: string): Promise<Commit[]> {
  return (await inspectRange(repo, base)).commits
}

interface Plan {
  /** Lines of git's todo file; `{msg:N}` stands for the path of message N */
  lines: string[]
  /** Commit messages applied with `git commit --amend -F` */
  messages: string[]
  /** Commits the branch will have on top of the base */
  resulting: number
}

/**
 * Validates `steps` against the range and turns them into a todo list.
 * Throws (before anything is touched) when the plan is not exactly a
 * rearrangement of the range. Pure: exported for the tests.
 */
export function buildPlan(commits: readonly Commit[], steps: readonly RebaseStep[]): Plan {
  if (!Array.isArray(steps)) throw new Error('Invalid rebase plan')
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  const seen = new Set<string>()
  for (const step of steps) {
    if (!step || typeof step.hash !== 'string' || !ACTIONS.includes(step.action)) throw new Error('Invalid rebase plan')
    if (step.message !== undefined && typeof step.message !== 'string') throw new Error('Invalid rebase plan')
    if (!byHash.has(step.hash)) {
      throw new Error(`The plan includes a commit that is not part of the range: ${short(step.hash) || '(empty)'}`)
    }
    if (seen.has(step.hash)) throw new Error(`Commit ${short(step.hash)} appears more than once in the plan`)
    seen.add(step.hash)
    if (step.message !== undefined && step.action !== 'reword' && step.action !== 'squash') {
      throw new Error(`Only reword and squash take a message (${short(step.hash)} is ${step.action})`)
    }
    if (step.action === 'reword' && !step.message?.trim()) {
      throw new Error(`The new message for the reword of ${short(step.hash)} is missing`)
    }
    if (step.action === 'squash' && step.message !== undefined && !step.message.trim()) {
      throw new Error(`The message of the squashed commit (${short(step.hash)}) is empty`)
    }
  }
  const missing = commits.filter((c) => !seen.has(c.hash))
  if (missing.length) {
    throw new Error(
      `The plan is missing ${missing.length === 1 ? '1 commit' : `${missing.length} commits`} of the range ` +
        `(${listFiles(missing.map((c) => short(c.hash)))}). To remove a commit, mark it as drop.`
    )
  }
  const kept = steps.filter((s) => s.action !== 'drop')
  if (kept.length === 0) {
    throw new Error('The plan drops every commit of the range. If that is what you want, use Reset instead.')
  }
  if (kept[0]!.action === 'squash' || kept[0]!.action === 'fixup') {
    throw new Error(
      `The first commit that is kept (${short(kept[0]!.hash)}) cannot be ${kept[0]!.action}: ` +
        'there is no earlier commit to combine it with.'
    )
  }
  if (steps.every((s, i) => s.action === 'pick' && s.hash === commits[i]!.hash)) {
    throw new Error('The plan changes nothing: every commit is picked, in the same order.')
  }

  // A group is a pick / reword followed by the squash / fixup steps folded into it.
  interface Group {
    target: RebaseStep
    squashes: RebaseStep[]
    /** Index in `steps` of the last member: the message is applied right after it */
    last: number
  }
  const groups: Group[] = []
  steps.forEach((step, i) => {
    if (step.action === 'drop') return
    if (step.action === 'pick' || step.action === 'reword') {
      groups.push({ target: step, squashes: [], last: i })
      return
    }
    const group = groups[groups.length - 1]!
    if (step.action === 'squash') group.squashes.push(step)
    group.last = i
  })

  const messageAfter = new Map<number, string>()
  for (const group of groups) {
    const own = group.target.action === 'reword' ? group.target.message! : null
    if (group.squashes.length === 0) {
      if (own !== null) messageAfter.set(group.last, own)
      continue
    }
    const given = group.squashes.filter((s) => s.message !== undefined)
    const lastSquash = group.squashes[group.squashes.length - 1]!
    if (given.length > 1 || (given.length === 1 && given[0] !== lastSquash)) {
      throw new Error(
        `The message of the squashed commit must be set only on the last squash of its group (${short(lastSquash.hash)})`
      )
    }
    // No explicit message: the messages of the combined commits, in order.
    const combined =
      lastSquash.message ??
      [own ?? fullMessage(byHash.get(group.target.hash)!), ...group.squashes.map((s) => fullMessage(byHash.get(s.hash)!))].join('\n\n')
    messageAfter.set(group.last, combined)
  }

  const lines: string[] = []
  const messages: string[] = []
  steps.forEach((step, i) => {
    // squash is written as fixup: the final message is set explicitly below,
    // so git never has to build one (which would need an editor).
    const verb = step.action === 'drop' ? 'drop' : step.action === 'squash' || step.action === 'fixup' ? 'fixup' : 'pick'
    lines.push(`${verb} ${step.hash}`)
    const message = messageAfter.get(i)
    if (message !== undefined) {
      lines.push(`{msg:${messages.length}}`)
      messages.push(message.endsWith('\n') ? message : `${message}\n`)
    }
  })
  return { lines, messages, resulting: groups.length }
}

/** Installs the prepared todo list. Constant text: every path arrives through the environment. */
const SEQUENCE_EDITOR_SCRIPT = [
  '#!/bin/sh',
  '# GitKroken: replaces the todo list of `git rebase -i` with the prepared plan.',
  'cp -- "$GITKROKEN_REBASE_TODO" "$1" || exit 1',
  ': > "$GITKROKEN_REBASE_MARK"',
  ''
].join('\n')

/**
 * The todo line that sets a commit message. The message lives in a file of
 * the git dir and git locates it itself, so neither the message nor any path
 * is ever interpolated into a shell string. Hooks are skipped (--no-verify):
 * rewording must not fail on a pre-commit linter.
 */
const amendLine = (id: string, n: number): string =>
  'exec git commit --amend --no-verify --allow-empty --cleanup=whitespace -q ' +
  `-F "$(git rev-parse --git-path gitkroken/rebase/${id}/${n}.msg)"`

const rebaseStateDir = (gitDir: string): string => join(gitDir, 'gitkroken', 'rebase')
/** Git dirs whose rebase is being set up right now (its files exist before git's own state does) */
const starting = new Set<string>()

/** Message files of a finished rebase (they must outlive a stop on conflicts). */
async function removeStaleRebaseFiles(gitDir: string): Promise<void> {
  const dir = rebaseStateDir(gitDir)
  if (starting.has(gitDir) || !existsSync(dir) || operationInProgress(gitDir) === 'rebase') return
  await rm(dir, { recursive: true, force: true }).catch(() => {})
}

async function createBackup(repo: string, branch: string, sha: string): Promise<string> {
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  for (let attempt = 0; attempt < 50; attempt++) {
    const name = `${BACKUP_PREFIX}${branch}/${stamp}${attempt ? `-${attempt + 1}` : ''}`
    // Empty old value: the ref must not exist yet.
    const res = await runGit(repo, ['update-ref', '-m', 'gitkroken: before interactive rebase', name, sha, ''], {
      okCodes: [0, 1, 128]
    })
    if (res.code === 0) return name
  }
  throw new Error('Could not save a backup of the branch; the rebase was not started.')
}

async function pruneBackups(repo: string): Promise<void> {
  const out = await tryGit(repo, ['for-each-ref', '--format=%(refname)', BACKUP_PREFIX])
  if (!out) return
  const stampOf = (name: string): string => name.slice(name.lastIndexOf('/') + 1)
  const refs = out.split('\n').filter(Boolean).sort((a, b) => stampOf(b).localeCompare(stampOf(a)))
  for (const name of refs.slice(BACKUPS_KEPT)) await tryGit(repo, ['update-ref', '-d', name])
}

async function rebaseInteractiveLocked(repo: string, base: string, steps: RebaseStep[]): Promise<void> {
  const range = await inspectRange(repo, base)
  const plan = buildPlan(range.commits, steps)
  const { gitDir } = range.dirs
  await removeStaleRebaseFiles(gitDir)

  const id = `${Date.now().toString(36)}${Math.floor(Math.random() * 1e6).toString(36)}`
  const messageDir = join(rebaseStateDir(gitDir), id)
  const dropMessages = async (): Promise<void> => {
    await rm(messageDir, { recursive: true, force: true }).catch(() => {})
    // Only goes away when empty
    await rmdir(rebaseStateDir(gitDir)).catch(() => {})
  }
  let backup = ''
  let failure: unknown = null
  let installed = false

  const scratch = await mkdtemp(join(tmpdir(), 'gitkroken-rebase-'))
  starting.add(gitDir)
  try {
    await mkdir(messageDir, { recursive: true })
    await Promise.all(plan.messages.map((text, n) => writeFile(join(messageDir, `${n}.msg`), text)))
    const todo = plan.lines.map((line) => {
      const m = /^\{msg:(\d+)\}$/.exec(line)
      return m ? amendLine(id, Number(m[1])) : line
    })
    const todoFile = join(scratch, 'todo')
    const script = join(scratch, 'install-todo.sh')
    const mark = join(scratch, 'installed')
    await writeFile(todoFile, `${todo.join('\n')}\n`)
    await writeFile(script, SEQUENCE_EDITOR_SCRIPT, { mode: 0o700 })

    backup = await createBackup(repo, range.branch, range.head)
    try {
      await runGit(
        repo,
        [
          // The plan is the whole todo list: nothing may rewrite or extend it.
          '-c', 'rebase.autoSquash=false',
          '-c', 'rebase.autoStash=false',
          '-c', 'rebase.updateRefs=false',
          '-c', 'rebase.rebaseMerges=false',
          '-c', 'rebase.abbreviateCommands=false',
          'rebase', '-i', '--empty=keep', '--no-autosquash', '--no-autostash', range.base
        ],
        {
          env: {
            // git runs this through the shell and appends the todo file path.
            GIT_SEQUENCE_EDITOR: 'sh "$GITKROKEN_REBASE_SCRIPT"',
            GITKROKEN_REBASE_SCRIPT: script,
            GITKROKEN_REBASE_TODO: todoFile,
            GITKROKEN_REBASE_MARK: mark
          }
        }
      )
    } catch (e) {
      failure = e
    }
    installed = existsSync(mark)
  } catch (e) {
    // Nothing was started (could not write the helper files or the backup).
    await dropMessages()
    throw e
  } finally {
    starting.delete(gitDir)
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }

  const stopped = operationInProgress(gitDir) === 'rebase'
  const restoredNote = `"${range.branch}" is exactly as it was (${short(range.head)}).`
  const detail = failure instanceof GitError || failure instanceof Error ? failure.message : ''

  if (!failure && installed && !stopped) {
    await dropMessages()
    await pruneBackups(repo)
    const count = Number((await git(repo, ['rev-list', '--count', `${range.base}..HEAD`])).trim())
    if (count !== plan.resulting) {
      throw new Error(
        `The rebase finished, but the result has ${count} commits and the plan expected ${plan.resulting}. ` +
          `Check the branch; the previous state is saved in ${backup}.`
      )
    }
    return
  }

  if (stopped) {
    const unmerged = (await git(repo, ['diff', '--name-only', '--diff-filter=U', '-z'])).split('\0').filter(Boolean)
    if (installed && unmerged.length) {
      // A real conflict: the in-progress flow of the app (continue / abort) takes over.
      throw new Error(
        `The rebase stopped on conflicts in ${listFiles(unmerged)}. Resolve them and press Continue, ` +
          `or Abort to leave "${range.branch}" as it was. The previous state is saved in ${backup}.`
      )
    }
    // Stopped for any other reason (a step that cannot be applied, a failed
    // command, a plan that was not installed): do not leave a half-done rebase.
    await runGit(repo, ['rebase', '--abort'])
  }
  await dropMessages()

  const after = await headState(repo)
  if (after.branch !== range.branch || after.sha !== range.head) {
    throw new Error(
      `The rebase failed and the branch is not as it was. The previous state is saved in ${backup} ` +
        `(git reset --keep ${backup}).${detail ? `\n${detail}` : ''}`
    )
  }
  await tryGit(repo, ['update-ref', '-d', backup, range.head])
  if (/would make\s+it empty/.test(detail)) {
    throw new Error(
      `Combining those commits would leave an empty commit (they cancel each other out). Drop them instead of combining them. ${restoredNote}`
    )
  }
  if (!installed && !failure) throw new Error(`The rebase plan could not be applied. ${restoredNote}`)
  throw new Error(`The rebase could not be completed. ${restoredNote}${detail ? `\n${detail}` : ''}`)
}

// =================================================================================
// Undo / Redo
// =================================================================================
//
// The undo timeline is HEAD's reflog: git records there every commit,
// checkout, reset, merge, pull, cherry-pick, revert and rebase, whoever ran
// it. Undo reverses the newest entry that is still "live"; a small journal in
// the git dir remembers how far back undo has gone and what can be redone.
// The journal is only trusted while the reflog ends exactly where this module
// left it: anything appended since (a new action, inside or outside the app)
// empties the redo stack and makes undo start again from the newest entry.

type Kind = 'commit' | 'amend' | 'checkout' | 'reset' | 'merge' | 'pull' | 'cherry-pick' | 'revert' | 'rebase' | 'rename'
/** How a branch tip is moved: all three keep uncommitted work (see moveTip) */
type Mode = 'soft' | 'mixed' | 'keep'

interface Point {
  sha: string
  /** Branch HEAD is attached to; null when detached */
  ref: string | null
}

interface Action {
  kind: Kind
  label: string
  /** State before the action / after undoing it */
  from: Point
  /** State after the action / after redoing it */
  to: Point
  /** The action only moved the branch onto existing commits (nothing of its own to un-publish) */
  ff?: boolean
  /** How undo moved the tip, so that redo is its exact inverse */
  mode?: Mode
}

interface Journal {
  v: 1
  /** Size and last line of HEAD's reflog right after our last undo / redo */
  size: number
  tail: string
  /** Reflog entries ending at or before this byte offset can still be undone */
  cursor: number
  /** Actions that were redone (newest last): undone again before the reflog is consulted */
  undo: Action[]
  redo: Action[]
}

interface LogLine {
  old: string
  new: string
  msg: string
  raw: string
  /** Byte offsets in the file */
  start: number
  end: number
}

interface Reflog {
  size: number
  lines: LogLine[]
}

const LOG_WINDOW = 4 * 1024 * 1024

/** Tail of a reflog file with the byte offset of each entry; null when there is none. */
async function readReflog(file: string): Promise<Reflog | null> {
  let handle
  try {
    handle = await open(file, 'r')
  } catch {
    return null
  }
  try {
    const { size } = await handle.stat()
    const from = Math.max(0, size - LOG_WINDOW)
    const buf = Buffer.alloc(size - from)
    let got = 0
    while (got < buf.length) {
      const { bytesRead } = await handle.read(buf, got, buf.length - got, from + got)
      if (bytesRead === 0) break
      got += bytesRead
    }
    const lines: LogLine[] = []
    let pos = 0
    // A window that starts mid-file begins with a partial line: skip it.
    if (from > 0) pos = buf.indexOf(10) + 1
    while (pos < got) {
      const nl = buf.indexOf(10, pos)
      if (nl < 0 || nl >= got) break
      const raw = buf.toString('utf8', pos, nl)
      const tab = raw.indexOf('\t')
      const [old = '', next = ''] = raw.split(' ', 2)
      if (isSha(old) && isSha(next)) {
        lines.push({ old, new: next, msg: tab < 0 ? '' : raw.slice(tab + 1), raw, start: from + pos, end: from + nl + 1 })
      }
      pos = nl + 1
    }
    return { size: from + got, lines }
  } finally {
    await handle.close()
  }
}

const journalFile = (gitDir: string): string => join(gitDir, 'gitkroken', 'undo.json')

const isPoint = (p: unknown): p is Point =>
  !!p && typeof (p as Point).sha === 'string' && ((p as Point).ref === null || typeof (p as Point).ref === 'string')

async function readJournal(gitDir: string): Promise<Journal | null> {
  try {
    const j = JSON.parse(await readFile(journalFile(gitDir), 'utf8')) as Journal
    const okList = (list: unknown): boolean =>
      Array.isArray(list) && list.every((a: Action) => a && typeof a.label === 'string' && isPoint(a.from) && isPoint(a.to))
    if (j?.v !== 1 || typeof j.size !== 'number' || typeof j.tail !== 'string' || typeof j.cursor !== 'number') return null
    if (!okList(j.undo) || !okList(j.redo)) return null
    return j
  } catch {
    return null
  }
}

async function writeJournal(gitDir: string, journal: Journal): Promise<void> {
  const file = journalFile(gitDir)
  await mkdir(join(gitDir, 'gitkroken'), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  await writeFile(tmp, JSON.stringify(journal))
  await rename(tmp, file)
}

interface Ctx {
  repo: string
  dirs: Dirs
  head: Head
  op: Operation | null
  log: Reflog | null
  journal: Journal
}

async function loadCtx(repo: string): Promise<Ctx> {
  const dirs = await locate(repo)
  const [head, log, saved] = await Promise.all([
    headState(repo),
    readReflog(join(dirs.gitDir, 'logs', 'HEAD')),
    readJournal(dirs.gitDir)
  ])
  const size = log?.size ?? 0
  const tail = log?.lines[log.lines.length - 1]?.raw ?? ''
  // The journal is valid only if nothing was appended to the reflog since we wrote it.
  const journal: Journal =
    saved && saved.size === size && saved.tail === tail ? saved : { v: 1, size, tail, cursor: size, undo: [], redo: [] }
  return { repo, dirs, head, op: operationInProgress(dirs.gitDir), log, journal }
}

// --- reading an action out of the reflog ---------------------------------------------

interface Derived {
  action: Action
  /** First reflog entry of the action (a rebase spans several) */
  first: LogLine
}

const RE_RENAME = /^Branch: renamed refs\/heads\/(\S+) to refs\/heads\/(\S+)$/
const RE_CHECKOUT = /^checkout: moving from (\S+) to (\S+)$/
const RE_FINISH = /^(\S.*?) \(finish\): returning to refs\/heads\/(\S+)$/
const RE_MERGED = /^(merge|pull)\b(.*?): (Fast-forward|Merge made by .*)$/

/** `Revert "x"` -> x */
const revertedSubject = (subject: string): string => /^Revert "(.*)"$/.exec(subject)?.[1] ?? subject

/**
 * The action recorded by reflog entry `i`, provided HEAD is still where that
 * entry left it. null for anything not recognised: never guess.
 */
function deriveAction(lines: readonly LogLine[], i: number, head: Head): Derived | null {
  const e = lines[i]
  if (!e || !head.sha || e.new !== head.sha) return null
  const branch = head.branch
  const where = branch ?? 'HEAD'
  const here = (sha: string): Point => ({ sha, ref: branch })
  const simple = (kind: Kind, label: string, extra: Partial<Action> = {}): Derived | null =>
    isZero(e.old) || e.old === e.new ? null : { first: e, action: { kind, label, from: here(e.old), to: here(e.new), ...extra } }
  let m: RegExpExecArray | null

  if ((m = RE_RENAME.exec(e.msg))) {
    // git logs a rename of the current branch as two entries (sha -> 0, 0 -> sha).
    if (branch !== m[2]) return null
    const prev = lines[i - 1]
    const first = prev && prev.msg === e.msg && isZero(prev.new) ? prev : e
    return {
      first,
      action: {
        kind: 'rename',
        label: `Rename branch ${m[1]} → ${m[2]}`,
        from: { sha: e.new, ref: m[1]! },
        to: { sha: e.new, ref: m[2]! }
      }
    }
  }
  if ((m = RE_CHECKOUT.exec(e.msg))) {
    if (isZero(e.old)) return null
    const [, source, target] = m as unknown as [string, string, string]
    // Attached: the entry must be the checkout of the branch we are on.
    if (branch !== null && branch !== target) return null
    const detachedSource = isSha(source) && source === e.old
    return {
      first: e,
      action: {
        kind: 'checkout',
        label: `Checkout ${isSha(target) ? short(target) : target}`,
        from: { sha: e.old, ref: detachedSource ? null : source },
        to: { sha: e.new, ref: branch }
      }
    }
  }
  if ((m = /^commit: (.*)$/.exec(e.msg))) return simple('commit', `Commit "${clip(m[1]!)}"`)
  if ((m = /^commit \(amend\): (.*)$/.exec(e.msg))) return simple('amend', `Amend "${clip(m[1]!)}"`)
  if ((m = /^commit \(merge\): (.*)$/.exec(e.msg))) return simple('merge', `Merge "${clip(m[1]!)}"`)
  if ((m = /^commit \(cherry-pick\): (.*)$/.exec(e.msg))) return simple('cherry-pick', `Cherry pick "${clip(m[1]!)}"`)
  if ((m = /^cherry-pick: (.*)$/.exec(e.msg))) return simple('cherry-pick', `Cherry pick "${clip(m[1]!)}"`)
  if ((m = /^revert: (.*)$/.exec(e.msg))) return simple('revert', `Revert "${clip(revertedSubject(m[1]!))}"`)
  if ((m = /^reset: moving to (.+)$/.exec(e.msg))) return simple('reset', `Reset ${where} to ${short(e.new)}`)
  if ((m = RE_MERGED.exec(e.msg))) {
    const ff = m[3] === 'Fast-forward'
    if (m[1] === 'pull') return simple('pull', `Pull into ${where}`, { ff })
    // The app merges by full ref name (refs/heads/x); show it the way the user knows it.
    const merged = m[2]!.trim().replace(/^refs\/(heads|remotes|tags)\//, '')
    return simple('merge', `Merge ${clip(merged, 40)} into ${where}`, { ff })
  }
  if ((m = RE_FINISH.exec(e.msg))) {
    // A rebase: from its "(start)" entry to this "(finish)" one.
    const prefix = m[1]!
    const kind: Kind | null = /^pull\b/.test(prefix) ? 'pull' : /^rebase\b/.test(prefix) ? 'rebase' : null
    if (!kind || branch !== m[2]) return null
    for (let j = i - 1; j >= 0; j--) {
      const msg = lines[j]!.msg
      if (/ \((finish|abort)\): /.test(msg)) return null
      if (!msg.startsWith(`${prefix} (start): `)) continue
      const start = lines[j]!
      if (isZero(start.old) || start.old === e.new) return null
      const label = kind === 'pull' ? `Pull (rebase) into ${where}` : `Rebase ${where}`
      return { first: start, action: { kind, label, from: here(start.old), to: here(e.new) } }
    }
    return null
  }
  return null
}

/** True when the reflog of `branch` also records the move `from` -> `to`. */
async function branchLogHas(dirs: Dirs, branch: string, from: string, to: string): Promise<boolean> {
  const log = await readReflog(join(dirs.commonDir, 'logs', 'refs', 'heads', ...branch.split('/')))
  return !!log && log.lines.some((l) => l.old === from && l.new === to)
}

interface Candidate {
  action: Action
  /** Set when the action came from the reflog: where the cursor goes once undone */
  first?: LogLine
  /** Why it must not be undone (already published) */
  blocked?: string
}

/** Short name of a remote-tracking branch that already contains `sha`, if any. */
async function publishedOn(repo: string, sha: string): Promise<string | null> {
  const out = await tryGit(repo, ['for-each-ref', '--count=1', `--contains=${sha}`, '--format=%(refname:short)', 'refs/remotes'])
  return out?.trim().split('\n')[0] || null
}

/** Kinds that create commits of their own: undoing them after a push rewrites shared history. */
const CREATES_COMMITS: readonly Kind[] = ['commit', 'amend', 'merge', 'pull', 'cherry-pick', 'revert', 'rebase']

async function checkBackward(ctx: Ctx, action: Action): Promise<Candidate | null> {
  const { repo, head } = ctx
  if (head.sha !== action.to.sha || head.branch !== action.to.ref) return null
  if (!(await commitExists(repo, action.from.sha))) return null
  if (action.kind === 'checkout') {
    // Going back to a branch only makes sense if it is still where we left it.
    if (action.from.ref !== null && (await branchTip(repo, action.from.ref)) !== action.from.sha) return null
    return { action }
  }
  if (action.kind === 'rename') {
    if (!action.from.ref || (await branchTip(repo, action.from.ref)) !== null) return null
    return { action }
  }
  if (CREATES_COMMITS.includes(action.kind) && !action.ff) {
    const remote = await publishedOn(repo, action.to.sha)
    if (remote) {
      return {
        action,
        blocked:
          `Cannot undo ${action.label}: it is already pushed to ${remote}. Undoing it would rewrite ` +
          'shared history; use "Revert commit" to cancel it with a new commit instead.'
      }
    }
  }
  return { action }
}

async function findUndo(ctx: Ctx): Promise<Candidate | null> {
  const { journal, log, head, repo } = ctx
  if (!head.sha) return null
  const redone = journal.undo[journal.undo.length - 1]
  if (redone) return checkBackward(ctx, redone)

  if (!log) return null
  let i = log.lines.length - 1
  while (i >= 0 && log.lines[i]!.end > journal.cursor) i--
  const derived = deriveAction(log.lines, i, head)
  if (!derived) return null
  const { action } = derived

  if (action.kind === 'commit') {
    // A plain commit has exactly one parent, the previous tip.
    const parents = (await git(repo, ['rev-list', '--no-walk', '--parents', action.to.sha, '--'])).trim().split(/\s+/).slice(1)
    if (parents.length !== 1 || parents[0] !== action.from.sha) return null
  }
  if (action.kind !== 'checkout' && action.kind !== 'rename' && head.branch) {
    // The branch's own reflog must tell the same story (it would not if the
    // operation ran on another branch, e.g. `git rebase main other`).
    if (!(await branchLogHas(ctx.dirs, head.branch, action.from.sha, action.to.sha))) return null
  }
  if (action.kind === 'rebase' || (action.kind === 'pull' && action.ff === undefined)) {
    action.ff = await isAncestor(repo, action.from.sha, action.to.sha)
  }
  const checked = await checkBackward(ctx, action)
  return checked && { ...checked, first: derived.first }
}

async function findRedo(ctx: Ctx): Promise<Action | null> {
  const { journal, head, repo } = ctx
  const action = journal.redo[journal.redo.length - 1]
  if (!action || !head.sha) return null
  if (head.sha !== action.from.sha || head.branch !== action.from.ref) return null
  if (!(await commitExists(repo, action.to.sha))) return null
  if (action.kind === 'checkout' && action.to.ref !== null && (await branchTip(repo, action.to.ref)) !== action.to.sha) return null
  if (action.kind === 'rename' && (!action.to.ref || (await branchTip(repo, action.to.ref)) !== null)) return null
  return action
}

// --- moving HEAD without losing work ---------------------------------------------------

const SAVE_FIRST = 'Commit or stash your changes and try again.'

async function indexMatches(repo: string, sha: string): Promise<boolean> {
  const res = await runGit(repo, ['diff', '--cached', '--quiet', sha, '--'], { okCodes: [0, 1] })
  return res.code === 0
}

/** True when the tracked files of the worktree are exactly the tree of `sha`. */
async function worktreeMatches(repo: string, gitDir: string, sha: string): Promise<boolean> {
  // Asked to a scratch copy of the index, so the real one is never touched.
  const scratch = await mkdtemp(join(tmpdir(), 'gitkroken-index-'))
  try {
    const index = join(scratch, 'index')
    await copyFile(join(gitDir, 'index'), index)
    const env = { GIT_INDEX_FILE: index }
    // --reset: like -m, but local edits are not an error; unchanged entries keep their stat data.
    await runGit(repo, ['read-tree', '--reset', sha], { env })
    // Entries without stat data must be compared by content (exec.ts turns that off by default).
    const res = await runGit(repo, ['-c', 'diff.autoRefreshIndex=true', 'diff', '--quiet', '--'], { env, okCodes: [0, 1] })
    return res.code === 0
  } catch {
    return false
  } finally {
    await rm(scratch, { recursive: true, force: true }).catch(() => {})
  }
}

/**
 * `reset --keep` refuses to overwrite modified and untracked files, but git
 * treats ignored files as expendable. We do not: a file that exists on disk
 * where `sha` wants to create one blocks the move.
 */
async function filesInTheWay(repo: string, sha: string): Promise<string[]> {
  const top = (await git(repo, ['rev-parse', '--show-toplevel'])).replace(/\r?\n$/, '')
  const out = await git(repo, ['diff', '--name-only', '-z', '--no-renames', '--diff-filter=A', 'HEAD', sha, '--'])
  const blocked: string[] = []
  const listings = new Map<string, Promise<string[]>>()
  for (const path of out.split('\0').filter(Boolean)) {
    const full = join(top, path)
    if (!(await lstat(full).then(() => true, () => false))) continue
    // On a case-insensitive disk `Readme.md` "exists" when README.md does:
    // only a file with exactly this name is in the way.
    const dir = dirname(full)
    if (!listings.has(dir)) listings.set(dir, readdir(dir).catch(() => []))
    if ((await listings.get(dir)!).includes(basename(full))) blocked.push(path)
  }
  return blocked
}

/**
 * Moves the current branch (or a detached HEAD) to `sha` in a way that cannot
 * discard uncommitted work; refuses when that is not possible.
 *   soft   HEAD only. Index and files untouched.
 *   mixed  HEAD + index. Files untouched; only used when nothing is staged.
 *   keep   HEAD + index + files, like a checkout: local changes are carried
 *          along and git aborts if one of them would be overwritten.
 *   auto   whichever of the three leaves the tree as it was before a reset.
 * `reset --hard` is never used.
 */
async function moveTip(ctx: Ctx, sha: string, mode: Mode | 'auto', verb: 'undo' | 'redo', label: string): Promise<Mode> {
  const { repo } = ctx
  const env = { GIT_REFLOG_ACTION: `gitkroken ${verb}` }
  const reset = (m: Mode): Promise<unknown> => runGit(repo, ['reset', `--${m}`, '-q', sha, '--'], { env })

  if (mode === 'soft') {
    await reset('soft')
    return 'soft'
  }
  if (mode === 'auto' && (await indexMatches(repo, sha))) {
    // The index already holds the target (what a soft reset leaves behind).
    await reset('soft')
    return 'soft'
  }
  const dirty = await trackedChanges(repo)
  if (dirty.staged.length) {
    throw new Error(
      `Cannot ${verb} ${label}: there are staged changes (${listFiles(dirty.staged)}) that would be lost. ${SAVE_FIRST}`
    )
  }
  if (mode === 'mixed' || (mode === 'auto' && dirty.unstaged.length && (await worktreeMatches(repo, ctx.dirs.gitDir, sha)))) {
    // Nothing is staged, so the index carries no work of its own.
    await reset('mixed')
    return 'mixed'
  }
  const inTheWay = await filesInTheWay(repo, sha)
  if (inTheWay.length) {
    throw new Error(
      `Cannot ${verb} ${label}: it would overwrite untracked files (${listFiles(inTheWay)}). ` +
        'Move or delete them and try again.'
    )
  }
  try {
    await reset('keep')
  } catch (e) {
    throw new Error(`Cannot ${verb} ${label} without overwriting uncommitted changes. ${SAVE_FIRST}\n${errMessage(e)}`)
  }
  return 'keep'
}

async function checkoutPoint(repo: string, point: Point, verb: 'undo' | 'redo', label: string): Promise<void> {
  // No -f / -m: git itself refuses to overwrite local changes (and, with
  // --no-overwrite-ignore, ignored files) and carries the rest along.
  const target = point.ref !== null ? [point.ref] : ['--detach', point.sha]
  try {
    await runGit(repo, ['checkout', '--no-overwrite-ignore', ...target, '--'])
  } catch (e) {
    throw new Error(`Cannot ${verb} ${label} without overwriting uncommitted changes. ${SAVE_FIRST}\n${errMessage(e)}`)
  }
}

const backwardMode = (kind: Kind): Mode | 'auto' => (kind === 'commit' || kind === 'amend' ? 'soft' : kind === 'reset' ? 'auto' : 'keep')

async function applyAction(ctx: Ctx, action: Action, verb: 'undo' | 'redo'): Promise<Action> {
  const { repo } = ctx
  const [source, target] = verb === 'undo' ? [action.to, action.from] : [action.from, action.to]
  let mode = action.mode
  if (action.kind === 'checkout') {
    await checkoutPoint(repo, target, verb, action.label)
  } else if (action.kind === 'rename') {
    await runGit(repo, ['branch', '-m', '--', source.ref!, target.ref!])
  } else if (verb === 'undo') {
    mode = await moveTip(ctx, target.sha, backwardMode(action.kind), verb, action.label)
  } else {
    await moveTip(ctx, target.sha, action.mode ?? (backwardMode(action.kind) === 'soft' ? 'soft' : 'keep'), verb, action.label)
  }
  const after = await headState(repo)
  if (after.sha !== target.sha || after.branch !== target.ref) {
    throw new Error(`Could not ${verb} ${action.label}: the repository did not end up in the expected state.`)
  }
  return { ...action, mode }
}

function assertIdle(ctx: Ctx, doing: string): void {
  if (ctx.op) throw new Error(`A ${ctx.op} is in progress: finish or abort it before you ${doing}.`)
}

/** Persists the stacks, anchored to the reflog as it is now. */
async function saveJournal(ctx: Ctx, next: Pick<Journal, 'cursor' | 'undo' | 'redo'>): Promise<void> {
  const log = await readReflog(join(ctx.dirs.gitDir, 'logs', 'HEAD'))
  const tail = log?.lines[log.lines.length - 1]?.raw ?? ''
  await writeJournal(ctx.dirs.gitDir, { v: 1, size: log?.size ?? 0, tail, ...next })
}

async function undoLocked(repo: string): Promise<void> {
  const ctx = await loadCtx(repo)
  assertIdle(ctx, 'undo')
  const found = await findUndo(ctx)
  if (!found) throw new Error('Nothing to undo.')
  if (found.blocked) throw new Error(found.blocked)
  const done = await applyAction(ctx, found.action, 'undo')
  const { journal } = ctx
  await saveJournal(ctx, {
    cursor: found.first ? found.first.start : journal.cursor,
    undo: found.first ? journal.undo : journal.undo.slice(0, -1),
    redo: [...journal.redo, done]
  })
}

async function redoLocked(repo: string): Promise<void> {
  const ctx = await loadCtx(repo)
  assertIdle(ctx, 'redo')
  const action = await findRedo(ctx)
  if (!action) throw new Error('Nothing to redo.')
  const done = await applyAction(ctx, action, 'redo')
  const { journal } = ctx
  await saveJournal(ctx, { cursor: journal.cursor, undo: [...journal.undo, done], redo: journal.redo.slice(0, -1) })
}

async function undoState(repo: string): Promise<UndoState> {
  try {
    const ctx = await loadCtx(repo)
    await removeStaleRebaseFiles(ctx.dirs.gitDir)
    if (ctx.op) return { undo: null, redo: null }
    const [undo, redo] = await Promise.all([findUndo(ctx), findRedo(ctx)])
    return {
      undo: undo ? (undo.blocked ? `${undo.action.label} (already pushed: cannot be undone)` : undo.action.label) : null,
      redo: redo?.label ?? null
    }
  } catch {
    // A polled, read-only query: when in doubt there is nothing to undo.
    return { undo: null, redo: null }
  }
}

// --- the API object ---------------------------------------------------------------------

export const rebaseApi: Pick<GitApi, 'rebaseTodo' | 'rebaseInteractive' | 'undoState' | 'undo' | 'redo'> = {
  rebaseTodo,
  rebaseInteractive: (repo, base, steps) => withLock(repo, () => rebaseInteractiveLocked(repo, base, steps)),
  undoState,
  undo: (repo) => withLock(repo, () => undoLocked(repo)),
  redo: (repo) => withLock(repo, () => redoLocked(repo))
}
