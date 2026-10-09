// Interactive rebase and Undo / Redo against real temporary repositories.
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import type { RebaseStep } from '@shared/types'
import { coreApi as core } from '../core'
import { rebaseApi as api } from '../rebase'
import { analyse, initialRows, moveRow, pushedCount, pushedRewritten, setAction, toSteps } from '../../../renderer/src/components/rebase/plan'
import { cleanupAll, commitFiles, seededRepo, setupGitEnv, sh, tick, tmpDir, write } from './helpers'

// Each test spawns git many times; the whole suite runs in parallel with the other files.
vi.setConfig({ testTimeout: 60_000 })

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8')
const head = (repo: string): string => sh(repo, 'rev-parse', 'HEAD')
const tip = (repo: string, branch: string): string => sh(repo, 'rev-parse', `refs/heads/${branch}`)
const branchOf = (repo: string): string => sh(repo, 'rev-parse', '--abbrev-ref', 'HEAD')
/** Subjects of `range`, oldest first */
const subjects = (repo: string, range: string): string[] =>
  sh(repo, 'log', '--reverse', '--format=%s', range).split('\n').filter(Boolean)
const message = (repo: string, rev: string): string => sh(repo, 'log', '-1', '--format=%B', rev).replace(/\n+$/, '')
const files = (repo: string, rev = 'HEAD'): string[] => sh(repo, 'ls-tree', '-r', '--name-only', rev).split('\n').filter(Boolean)
const backups = (repo: string): string[] =>
  sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/original/gitkroken').split('\n').filter(Boolean)

/** Everything a failed or refused operation must leave untouched */
const snapshot = (repo: string): string =>
  [
    sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)'),
    sh(repo, 'rev-parse', 'HEAD'),
    sh(repo, 'symbolic-ref', '-q', 'HEAD'),
    sh(repo, 'status', '--porcelain=v1', '--untracked-files=all'),
    sh(repo, 'stash', 'list')
  ].join('\n--\n')

const errorOf = async (p: Promise<unknown>): Promise<string> =>
  p.then(
    () => {
      throw new Error('expected a rejection')
    },
    (e: Error) => e.message
  )

/** `first` + one commit per name; commit `x` writes `x.txt`. Returns hashes by name. */
function linearRepo(names: string[]): { repo: string; first: string; h: Record<string, string> } {
  const { repo, first } = seededRepo()
  const h: Record<string, string> = {}
  for (const name of names) h[name] = commitFiles(repo, { [`${name}.txt`]: `${name}\n` }, `add ${name}`)
  return { repo, first, h }
}

const pick = (hash: string): RebaseStep => ({ hash, action: 'pick' })

// ====================================================================================
describe('rebaseTodo', () => {
  it('lists base..HEAD oldest first', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c'])
    const todo = await api.rebaseTodo(repo, first)
    expect(todo.map((c) => c.hash)).toEqual([h.a, h.b, h.c])
    expect(todo.map((c) => c.subject)).toEqual(['add a', 'add b', 'add c'])
    expect((await api.rebaseTodo(repo, h.b!)).map((c) => c.hash)).toEqual([h.c])
    // Untracked files are not uncommitted changes
    write(repo, 'untracked.txt', 'x')
    expect(await api.rebaseTodo(repo, 'HEAD~2')).toHaveLength(2)
  })

  it('rejects a detached HEAD, a dirty tree, an operation in progress and a bad base', async () => {
    const { repo, first, h } = linearRepo(['a', 'b'])

    sh(repo, 'checkout', '-q', '--detach')
    expect(await errorOf(api.rebaseTodo(repo, first))).toMatch(/HEAD is detached/)
    sh(repo, 'checkout', '-q', 'main')

    write(repo, 'a.txt', 'changed\n')
    expect(await errorOf(api.rebaseTodo(repo, first))).toMatch(/uncommitted changes \(a\.txt\)/)
    sh(repo, 'add', 'a.txt')
    expect(await errorOf(api.rebaseTodo(repo, first))).toMatch(/uncommitted changes/)
    sh(repo, 'reset', '-q', '--hard')

    expect(await errorOf(api.rebaseTodo(repo, h.b!))).toMatch(/nothing to rebase/)
    expect(await errorOf(api.rebaseTodo(repo, 'nope'))).toMatch(/Base commit "nope" not found/)
    expect(await errorOf(api.rebaseTodo(repo, '--exec=x'))).toMatch(/must not start with/)

    // A commit on another branch is not an ancestor
    sh(repo, 'checkout', '-q', '-b', 'side', first)
    const side = commitFiles(repo, { 'side.txt': 's\n' }, 'side')
    sh(repo, 'checkout', '-q', 'main')
    expect(await errorOf(api.rebaseTodo(repo, side))).toMatch(/not an ancestor of the current branch "main"/)

    // Conflicting merge left in progress
    sh(repo, 'checkout', '-q', 'side')
    commitFiles(repo, { 'a.txt': 'side version\n' }, 'side a')
    sh(repo, 'checkout', '-q', 'main')
    await core.merge(repo, 'side').catch(() => {})
    expect((await core.status(repo)).inProgress).toBe('merge')
    expect(await errorOf(api.rebaseTodo(repo, first))).toMatch(/A merge is in progress/)
  })

  it('rejects a range with merge commits, naming them', async () => {
    const { repo, first } = linearRepo(['a'])
    sh(repo, 'checkout', '-q', '-b', 'side', first)
    commitFiles(repo, { 'side.txt': 's\n' }, 'side')
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'merge', '-q', '--no-ff', '-m', 'Merge side', 'side')
    const merge = head(repo)
    const after = commitFiles(repo, { 'z.txt': 'z\n' }, 'after merge')

    const before = snapshot(repo)
    const msg = await errorOf(api.rebaseTodo(repo, first))
    expect(msg).toMatch(/contains a merge commit/)
    expect(msg).toContain(`${merge.slice(0, 7)} "Merge side"`)
    expect(await errorOf(api.rebaseInteractive(repo, first, [pick(after)]))).toMatch(/merge commit/)
    expect(snapshot(repo)).toBe(before)
    // After the merge the range is linear again
    expect((await api.rebaseTodo(repo, merge)).map((c) => c.hash)).toEqual([after])
  })
})

// ====================================================================================
describe('rebaseInteractive: actions', () => {
  it('reword changes only the message and keeps the author', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c'])
    sh(repo, 'commit', '-q', '--amend', '--author=Ada <ada@example.com>', '-m', 'add c')
    const c = head(repo)
    // An active profile reaches git as GIT_AUTHOR_* / GIT_COMMITTER_*: it must not take over authorship
    const saved = { ...process.env }
    Object.assign(process.env, { GIT_AUTHOR_NAME: 'Profile', GIT_AUTHOR_EMAIL: 'profile@example.com', GIT_COMMITTER_NAME: 'Profile' })
    try {
      await api.rebaseInteractive(repo, first, [
        pick(h.a!),
        { hash: h.b!, action: 'reword', message: 'B renamed\n\nwith a body' },
        { hash: c, action: 'reword', message: 'add c' }
      ])
    } finally {
      for (const key of ['GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME']) {
        if (saved[key] === undefined) delete process.env[key]
        else process.env[key] = saved[key]
      }
    }
    expect(sh(repo, 'log', '-1', '--format=%an|%cn', 'HEAD~1')).toBe('Test User|Profile')

    expect(subjects(repo, `${first}..HEAD`)).toEqual(['add a', 'B renamed', 'add c'])
    expect(message(repo, 'HEAD~1')).toBe('B renamed\n\nwith a body')
    expect(sh(repo, 'log', '-1', '--format=%an <%ae>')).toBe('Ada <ada@example.com>')
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    // The untouched prefix keeps its hash
    expect(sh(repo, 'rev-parse', 'HEAD~2')).toBe(h.a)
    expect(branchOf(repo)).toBe('main')
    expect((await core.status(repo)).inProgress).toBeNull()
  })

  it('squash combines commits with the given message; without one it joins the messages', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c', 'd'])
    await api.rebaseInteractive(repo, first, [
      pick(h.a!),
      { hash: h.b!, action: 'squash' },
      { hash: h.c!, action: 'squash', message: 'a + b + c' },
      pick(h.d!)
    ])
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['a + b + c', 'add d'])
    expect(sh(repo, 'show', '--format=', '--name-only', 'HEAD~1').split('\n')).toEqual(['a.txt', 'b.txt', 'c.txt'])

    const [x, y] = sh(repo, 'rev-list', '--reverse', `${first}..HEAD`).split('\n') as [string, string]
    await api.rebaseInteractive(repo, first, [pick(x), { hash: y, action: 'squash' }])
    expect(message(repo, 'HEAD')).toBe('a + b + c\n\nadd d')
    expect(sh(repo, 'rev-list', '--count', `${first}..HEAD`)).toBe('1')
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
  })

  it('fixup keeps the message of the target; drop removes the commit and its changes', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c', 'd'])
    await api.rebaseInteractive(repo, first, [
      pick(h.a!),
      { hash: h.b!, action: 'fixup' },
      { hash: h.c!, action: 'drop' },
      pick(h.d!)
    ])
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['add a', 'add d'])
    expect(message(repo, 'HEAD~1')).toBe('add a')
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'd.txt'])
    expect(existsSync(join(repo, 'c.txt'))).toBe(false)
  })

  it('reorders commits', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c'])
    await api.rebaseInteractive(repo, first, [pick(h.c!), pick(h.a!), pick(h.b!)])
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['add c', 'add a', 'add b'])
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'c.txt'])
  })

  it('combines reorder + squash + reword + fixup + drop in one plan', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c', 'd', 'e', 'f'])
    write(repo, 'untracked.txt', 'keep me\n')
    await api.rebaseInteractive(repo, first, [
      { hash: h.e!, action: 'reword', message: 'E first' },
      { hash: h.a!, action: 'fixup' },
      { hash: h.c!, action: 'drop' },
      { hash: h.f!, action: 'reword', message: 'ignored: the squash message wins' },
      { hash: h.b!, action: 'squash', message: 'F and B\n\n- together' },
      pick(h.d!)
    ])
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['E first', 'F and B', 'add d'])
    expect(message(repo, 'HEAD~1')).toBe('F and B\n\n- together')
    expect(sh(repo, 'show', '--format=', '--name-only', 'HEAD~2').split('\n')).toEqual(['a.txt', 'e.txt'])
    expect(sh(repo, 'show', '--format=', '--name-only', 'HEAD~1').split('\n')).toEqual(['b.txt', 'f.txt'])
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'd.txt', 'e.txt', 'f.txt'])
    expect(read(repo, 'untracked.txt')).toBe('keep me\n')
    expect((await core.status(repo)).unstaged).toEqual([{ path: 'untracked.txt', status: 'untracked' }])
  })

  it('applies awkward messages verbatim, in a repo whose path needs quoting', async () => {
    const repo = join(tmpDir(`gitkroken it's "odd" $x-`), 'my repo')
    mkdirSync(repo)
    sh(repo, 'init', '-q')
    const first = commitFiles(repo, { 'a.txt': 'one\n' }, 'first')
    const a = commitFiles(repo, { 'x.txt': 'x\n' }, 'x')
    const b = commitFiles(repo, { 'y.txt': 'y\n' }, 'y')
    const c = commitFiles(repo, { 'z.txt': 'z\n' }, 'z')
    const d = commitFiles(repo, { 'w.txt': 'w\n' }, 'w')

    const nasty = [
      '--amend -m "pwned" \'single\' `id` $(touch INJECTED) ; rm -rf . && echo \\',
      '',
      '# this line starts with a hash',
      '-- leading dashes',
      '  indented "quotes" and \'apostrophes\'',
      'ünïcödé 日本語 🎉 %s %H \\n \\t',
      'exec echo not-a-todo-line',
      'pick 1234567 neither is this'
    ].join('\n')
    const combined = '-F /etc/passwd\n\n#!/bin/sh\n$HOME "$(whoami)"'

    await api.rebaseInteractive(repo, first, [
      { hash: a, action: 'reword', message: nasty },
      pick(b),
      { hash: c, action: 'squash', message: combined },
      { hash: d, action: 'reword', message: '#only-a-hash-subject' }
    ])
    expect(message(repo, 'HEAD~2')).toBe(nasty)
    expect(message(repo, 'HEAD~1')).toBe(combined)
    expect(message(repo, 'HEAD')).toBe('#only-a-hash-subject')
    expect(existsSync(join(repo, 'INJECTED'))).toBe(false)
    expect(files(repo)).toEqual(['a.txt', 'w.txt', 'x.txt', 'y.txt', 'z.txt'])
    expect(sh(repo, 'status', '--porcelain')).toBe('')
  })

  it('never opens an editor and ignores hostile configuration and hooks', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c', 'd'])
    for (const [key, value] of [
      ['core.editor', 'false'],
      ['sequence.editor', 'false'],
      ['rebase.autoSquash', 'true'],
      ['rebase.autoStash', 'true'],
      ['rebase.missingCommitsCheck', 'error'],
      ['rebase.abbreviateCommands', 'true'],
      ['rebase.updateRefs', 'true'],
      ['commit.cleanup', 'strip'],
      ['core.commentChar', ';']
    ]) {
      sh(repo, 'config', key!, value!)
    }
    // A hook that would reject every commit made with `git commit`
    for (const hook of ['pre-commit', 'commit-msg']) {
      const file = join(repo, '.git', 'hooks', hook)
      mkdirSync(join(repo, '.git', 'hooks'), { recursive: true })
      writeFileSync(file, '#!/bin/sh\nexit 1\n')
      chmodSync(file, 0o755)
    }
    // A branch pointing inside the range must not be dragged along (rebase.updateRefs)
    sh(repo, 'branch', 'bookmark', h.b!)

    await api.rebaseInteractive(repo, first, [
      { hash: h.a!, action: 'reword', message: '# kept\n; kept too' },
      { hash: h.c!, action: 'squash', message: 'fixup! add a' },
      { hash: h.b!, action: 'drop' },
      pick(h.d!)
    ])
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['fixup! add a', 'add d'])
    expect(tip(repo, 'bookmark')).toBe(h.b)
    expect(files(repo)).toEqual(['a.txt', 'c.txt', 'd.txt'])

    const [x, y] = sh(repo, 'rev-list', '--reverse', `${first}..HEAD`).split('\n') as [string, string]
    await api.rebaseInteractive(repo, first, [{ hash: x, action: 'reword', message: '# kept\n; kept too' }, pick(y)])
    expect(message(repo, 'HEAD~1')).toBe('# kept\n; kept too')
  })

  it('works inside a linked worktree', async () => {
    const { repo, first } = linearRepo(['a'])
    const wt = join(tmpDir(), 'wt')
    sh(repo, 'worktree', 'add', '-q', '-b', 'feature', wt, first)
    const x = commitFiles(wt, { 'x.txt': 'x\n' }, 'x')
    const y = commitFiles(wt, { 'y.txt': 'y\n' }, 'y')
    const mainBefore = tip(repo, 'main')

    await api.rebaseInteractive(wt, first, [{ hash: y, action: 'reword', message: 'Y first' }, { hash: x, action: 'squash', message: 'both' }])
    expect(subjects(wt, `${first}..HEAD`)).toEqual(['both'])
    expect(tip(repo, 'main')).toBe(mainBefore)
    expect(await api.undoState(wt)).toEqual({ undo: 'Rebase feature', redo: null })
    await api.undo(wt)
    expect(head(wt)).toBe(y)
  })
})

// ====================================================================================
describe('rebaseInteractive: safety', () => {
  it('saves the original tip in a backup ref that the graph does not show', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c'])
    const original = head(repo)
    await api.rebaseInteractive(repo, first, [pick(h.a!), { hash: h.c!, action: 'drop' }, pick(h.b!)])
    expect(head(repo)).not.toBe(original)

    const refs = backups(repo)
    expect(refs).toHaveLength(1)
    expect(refs[0]).toMatch(new RegExp(`^refs/original/gitkroken/main/\\d{8}-\\d{6} ${original}$`))
    // Still reachable, so git gc cannot drop it; and hidden from the log / refs of the app
    sh(repo, 'reflog', 'expire', '--expire=now', '--all')
    sh(repo, 'gc', '-q', '--prune=now')
    expect(sh(repo, 'cat-file', '-t', h.c!)).toBe('commit')
    expect((await core.log(repo)).map((c) => c.hash)).not.toContain(h.c)
    expect((await core.refs(repo)).map((r) => r.name)).toEqual(['main'])
    // Recovering by hand
    sh(repo, 'reset', '-q', '--keep', refs[0]!.split(' ')[0]!)
    expect(head(repo)).toBe(original)
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    // No helper files left behind
    expect(existsSync(join(repo, '.git', 'gitkroken', 'rebase'))).toBe(false)
    expect(readdirSync(tmpdir()).filter((n) => n.startsWith('gitkroken-rebase-'))).toEqual([])
  })

  it('validates the plan before touching anything', async () => {
    const { repo, first, h } = linearRepo(['a', 'b', 'c'])
    const stranger = sh(repo, 'rev-parse', first)
    sh(repo, 'stash', 'list')
    write(repo, 'untracked.txt', 'u\n')
    const before = snapshot(repo)
    const all = [pick(h.a!), pick(h.b!), pick(h.c!)]

    const cases: [RebaseStep[], RegExp][] = [
      [[pick(h.a!), pick(h.b!)], /missing 1 commit of the range/],
      [[pick(h.a!)], /missing 2 commits of the range/],
      [[...all, pick(stranger)], /not part of the range/],
      [[...all, pick('0'.repeat(40))], /not part of the range/],
      [[pick(h.a!), pick(h.b!), pick(h.b!), pick(h.c!)], /appears more than once/],
      [[{ hash: h.a!, action: 'squash' }, pick(h.b!), pick(h.c!)], /cannot be squash/],
      [[{ hash: h.a!, action: 'drop' }, { hash: h.b!, action: 'fixup' }, pick(h.c!)], /cannot be fixup/],
      [[{ hash: h.a!, action: 'reword' }, pick(h.b!), pick(h.c!)], /new message for the reword of \w+ is missing/],
      [[{ hash: h.a!, action: 'reword', message: ' \n\t' }, pick(h.b!), pick(h.c!)], /new message for the reword of \w+ is missing/],
      [[pick(h.a!), { hash: h.b!, action: 'squash', message: '  ' }, pick(h.c!)], /squashed commit \(\w+\) is empty/],
      [[pick(h.a!), { hash: h.b!, action: 'squash', message: 'x' }, { hash: h.c!, action: 'squash' }], /only on the last squash/],
      [[{ hash: h.a!, action: 'pick', message: 'x' }, pick(h.b!), pick(h.c!)], /Only reword and squash take a message/],
      [all.map((s) => ({ ...s, action: 'drop' as const })), /drops every commit/],
      [all, /changes nothing/],
      [[{ hash: h.a!, action: 'edit' as never }, pick(h.b!), pick(h.c!)], /Invalid rebase plan/],
      [[{ hash: h.a!.slice(0, 7), action: 'pick' }, pick(h.b!), pick(h.c!)], /not part of the range/],
      ['nope' as never, /Invalid rebase plan/]
    ]
    for (const [steps, expected] of cases) {
      expect(await errorOf(api.rebaseInteractive(repo, first, steps))).toMatch(expected)
      expect(snapshot(repo)).toBe(before)
    }
    expect(backups(repo)).toEqual([])
    expect(existsSync(join(repo, '.git', 'gitkroken', 'rebase'))).toBe(false)

    // Preconditions are checked too: dirty tree, detached HEAD
    write(repo, 'a.txt', 'dirty\n')
    expect(await errorOf(api.rebaseInteractive(repo, first, [pick(h.b!), pick(h.a!), pick(h.c!)]))).toMatch(/uncommitted changes/)
    expect(read(repo, 'a.txt')).toBe('dirty\n')
    expect(head(repo)).toBe(h.c)
  })

  it('stops on a conflict; continue then applies the remaining rewords and squash messages', async () => {
    const { repo, first } = seededRepo()
    const c1 = commitFiles(repo, { 'a.txt': 'two\n' }, 'c1')
    const c2 = commitFiles(repo, { 'a.txt': 'three\n' }, 'c2')
    const c3 = commitFiles(repo, { 'b.txt': 'b\n' }, 'c3')
    const c4 = commitFiles(repo, { 'c.txt': 'c\n' }, 'c4')
    const c5 = commitFiles(repo, { 'd.txt': 'd\n' }, 'c5')
    const original = head(repo)
    write(repo, 'untracked.txt', 'u\n')

    // Dropping c1 makes c2 (two -> three) conflict against "one"
    const msg = await errorOf(
      api.rebaseInteractive(repo, first, [
        { hash: c1, action: 'drop' },
        { hash: c2, action: 'reword', message: 'c2 reworded\n\n# after the conflict' },
        pick(c3),
        { hash: c4, action: 'squash', message: 'c3 + c4' },
        { hash: c5, action: 'reword', message: 'c5 reworded' }
      ])
    )
    expect(msg).toMatch(/stopped on conflicts in a\.txt/)
    expect(msg).toMatch(/refs\/original\/gitkroken\/main\//)
    let st = await core.status(repo)
    expect(st.inProgress).toBe('rebase')
    expect(st.conflicted).toEqual([{ path: 'a.txt', status: 'conflicted' }])
    expect(tip(repo, 'main')).toBe(original)
    expect(backups(repo)[0]).toContain(original)
    // Nothing can be undone or started while it is in progress
    expect(await api.undoState(repo)).toEqual({ undo: null, redo: null })
    expect(await errorOf(api.undo(repo))).toMatch(/A rebase is in progress/)
    expect(await errorOf(api.rebaseTodo(repo, first))).toMatch(/A rebase is in progress/)

    write(repo, 'a.txt', 'three\n')
    await core.stage(repo, ['a.txt'])
    await core.continueOp(repo)

    st = await core.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.branch).toBe('main')
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['c2 reworded', 'c3 + c4', 'c5 reworded'])
    expect(message(repo, 'HEAD~2')).toBe('c2 reworded\n\n# after the conflict')
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'c.txt', 'd.txt'])
    expect(read(repo, 'a.txt')).toBe('three\n')
    expect(read(repo, 'untracked.txt')).toBe('u\n')
    // The message files are removed once the rebase is over
    await api.undoState(repo)
    expect(existsSync(join(repo, '.git', 'gitkroken', 'rebase'))).toBe(false)
    // ...and the whole thing can still be undone
    expect(await api.undoState(repo)).toEqual({ undo: 'Rebase main', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(original)
    expect(read(repo, 'a.txt')).toBe('three\n')
  })

  it('abort after a conflict restores the branch exactly', async () => {
    const { repo, first } = seededRepo()
    const c1 = commitFiles(repo, { 'a.txt': 'two\n' }, 'c1')
    const c2 = commitFiles(repo, { 'a.txt': 'three\n' }, 'c2')
    const c3 = commitFiles(repo, { 'b.txt': 'b\n' }, 'c3')
    sh(repo, 'branch', 'other', c1)
    write(repo, 'untracked.txt', 'u\n')
    sh(repo, 'stash', 'push', '-q', '--include-untracked', '-m', 'saved')
    write(repo, 'untracked2.txt', 'u2\n')
    const before = snapshot(repo)

    // c3 is applied (and reworded) first, then c2 conflicts
    await errorOf(
      api.rebaseInteractive(repo, first, [
        { hash: c3, action: 'reword', message: 'c3 first' },
        { hash: c2, action: 'squash', message: 'c3 + c2' },
        { hash: c1, action: 'fixup' }
      ])
    )
    expect((await core.status(repo)).inProgress).toBe('rebase')
    await core.abort(repo)

    const refsNow = snapshot(repo).split('\n').filter((l) => !l.startsWith('refs/original/gitkroken/')).join('\n')
    expect(refsNow).toBe(before)
    expect(head(repo)).toBe(c3)
    expect(branchOf(repo)).toBe('main')
    expect(read(repo, 'a.txt')).toBe('three\n')
    expect(read(repo, 'untracked2.txt')).toBe('u2\n')
    expect(sh(repo, 'stash', 'list')).toMatch(/saved/)
    expect((await core.status(repo)).inProgress).toBeNull()
  })

  it('a second conflict after continue is handled the same way', async () => {
    const { repo, first } = seededRepo()
    const c1 = commitFiles(repo, { 'a.txt': 'two\n' }, 'c1')
    const c2 = commitFiles(repo, { 'a.txt': 'three\n' }, 'c2')
    const c3 = commitFiles(repo, { 'a.txt': 'four\n' }, 'c3')
    // Reversed: every step conflicts
    await errorOf(
      api.rebaseInteractive(repo, first, [
        { hash: c3, action: 'reword', message: 'three' },
        { hash: c2, action: 'reword', message: 'two' },
        { hash: c1, action: 'reword', message: 'one' }
      ])
    )
    for (const content of ['x1\n', 'x2\n', 'x3\n']) {
      expect((await core.status(repo)).inProgress).toBe('rebase')
      write(repo, 'a.txt', content)
      await core.stage(repo, ['a.txt'])
      await core.continueOp(repo).catch(() => {})
    }
    expect((await core.status(repo)).inProgress).toBeNull()
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['three', 'two', 'one'])
    expect(read(repo, 'a.txt')).toBe('x3\n')
  })

  it('undoes itself when a step cannot be applied for a reason other than a conflict', async () => {
    const { repo, first } = seededRepo()
    const add = commitFiles(repo, { 'x.txt': 'x\n' }, 'add x')
    sh(repo, 'rm', '-q', 'x.txt')
    tick()
    sh(repo, 'commit', '-q', '-m', 'remove x')
    const remove = head(repo)
    const last = commitFiles(repo, { 'y.txt': 'y\n' }, 'add y')
    const before = snapshot(repo)

    // add + remove cancel each other out: git cannot make the combined commit
    const msg = await errorOf(api.rebaseInteractive(repo, first, [pick(add), { hash: remove, action: 'fixup' }, pick(last)]))
    expect(msg).toMatch(/would leave an empty commit/)
    expect(msg).toMatch(/is exactly as it was/)
    expect(snapshot(repo)).toBe(before)
    expect((await core.status(repo)).inProgress).toBeNull()
    expect(existsSync(join(repo, '.git', 'gitkroken', 'rebase', 'x'))).toBe(false)

    // An untracked file in the way of a commit being re-applied
    await api.rebaseInteractive(repo, first, [pick(add), pick(remove), { hash: last, action: 'reword', message: 'Y' }])
    const tipNow = head(repo)
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1')
    const y = commitFiles(repo, { 'z.txt': 'z\n' }, 'add z')
    write(repo, 'x.txt', 'precious untracked\n')
    const msg2 = await errorOf(api.rebaseInteractive(repo, first, [pick(add), { hash: remove, action: 'drop' }, pick(y)]))
    expect(msg2).toMatch(/could not be completed|conflicts/)
    expect(read(repo, 'x.txt')).toBe('precious untracked\n')
    expect(head(repo)).toBe(y)
    expect(tipNow).not.toBe(y)
    expect((await core.status(repo)).inProgress).toBeNull()
  })

  it('detects commits that are already pushed (what the view warns about)', async () => {
    const { repo, first } = seededRepo()
    const remote = tmpDir()
    sh(remote, 'init', '-q', '--bare')
    sh(repo, 'remote', 'add', 'origin', remote)
    const a = commitFiles(repo, { 'a1.txt': '1\n' }, 'pushed 1')
    const b = commitFiles(repo, { 'a2.txt': '2\n' }, 'pushed 2')
    await core.push(repo)
    const c = commitFiles(repo, { 'a3.txt': '3\n' }, 'local 1')
    const d = commitFiles(repo, { 'a4.txt': '4\n' }, 'local 2')

    const current = async () => (await core.refs(repo)).find((r) => r.isCurrent)
    let todo = await api.rebaseTodo(repo, first)
    expect(todo.map((x) => x.hash)).toEqual([a, b, c, d])
    expect(pushedCount(todo, await current())).toBe(2)
    expect(pushedCount(await api.rebaseTodo(repo, b), await current())).toBe(0)
    expect(pushedCount(await api.rebaseTodo(repo, a), await current())).toBe(1)

    // Only plans that touch a pushed commit rewrite published history
    let rows = initialRows(todo)
    expect(pushedRewritten(2, analyse(rows, todo))).toBe(0)
    rows = moveRow(rows, 3, 2)
    expect(pushedRewritten(2, analyse(rows, todo))).toBe(0)
    rows = setAction(rows, 1, 'reword')
    rows[1]!.message = 'pushed 2, reworded'
    expect(pushedRewritten(2, analyse(rows, todo))).toBe(1)
    rows = setAction(rows, 0, 'drop')
    expect(pushedRewritten(2, analyse(rows, todo))).toBe(2)

    // The plan built by the view is accepted by the backend as is
    rows = setAction(rows, 0, 'pick')
    await api.rebaseInteractive(repo, first, toSteps(rows, todo))
    expect(subjects(repo, `${first}..HEAD`)).toEqual(['pushed 1', 'pushed 2, reworded', 'local 2', 'local 1'])
    // The branch has diverged: one pushed commit was rewritten
    const ref = await current()
    expect(ref?.behind).toBe(1)
    expect(ref?.ahead).toBe(3)
    todo = await api.rebaseTodo(repo, first)
    expect(pushedCount(todo, ref)).toBe(1)

    // No upstream, or an upstream that is gone: nothing is "pushed"
    sh(repo, 'checkout', '-q', '-b', 'local-only')
    expect(pushedCount(await api.rebaseTodo(repo, first), await current())).toBe(0)
  })
})

// ====================================================================================
describe('undo / redo', () => {
  const state = (repo: string) => api.undoState(repo)

  it('commit: back to the parent with the changes staged; redo restores the same commit', async () => {
    const { repo, first } = seededRepo()
    expect(await state(repo)).toEqual({ undo: null, redo: null }) // the initial commit cannot be undone
    expect(await errorOf(api.undo(repo))).toMatch(/Nothing to undo/)
    expect(await errorOf(api.redo(repo))).toMatch(/Nothing to redo/)

    write(repo, 'a.txt', 'two\n')
    write(repo, 'new.txt', 'new\n')
    await core.stageAll(repo)
    await core.commit(repo, 'second commit\n\nbody')
    const second = head(repo)
    write(repo, 'untracked.txt', 'u\n')
    write(repo, 'a.txt', 'two, edited after the commit\n')
    expect(await state(repo)).toEqual({ undo: 'Commit "second commit"', redo: null })

    await api.undo(repo)
    expect(head(repo)).toBe(first)
    expect(branchOf(repo)).toBe('main')
    let st = await core.status(repo)
    expect(st.staged).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'new.txt', status: 'added' }
    ])
    expect(sh(repo, 'show', ':a.txt')).toBe('two')
    expect(read(repo, 'a.txt')).toBe('two, edited after the commit\n')
    expect(read(repo, 'untracked.txt')).toBe('u\n')
    expect(await state(repo)).toEqual({ undo: null, redo: 'Commit "second commit"' })

    await api.redo(repo)
    expect(head(repo)).toBe(second)
    st = await core.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'untracked.txt', status: 'untracked' }
    ])
    expect(read(repo, 'a.txt')).toBe('two, edited after the commit\n')
    expect(await state(repo)).toEqual({ undo: 'Commit "second commit"', redo: null })

    // Undo again (now from the journal) and commit something else: redo is gone
    await api.undo(repo)
    expect(head(repo)).toBe(first)
    await core.commit(repo, 'a different commit')
    expect(await state(repo)).toEqual({ undo: 'Commit "a different commit"', redo: null })
    expect(await errorOf(api.redo(repo))).toMatch(/Nothing to redo/)
  })

  it('amend: back to the commit before the amend, keeping what the amend added staged', async () => {
    const { repo } = seededRepo()
    const second = commitFiles(repo, { 'b.txt': 'b\n' }, 'second')
    write(repo, 'b.txt', 'b amended\n')
    await core.stageAll(repo)
    await core.commit(repo, 'second, amended', { amend: true })
    const amended = head(repo)
    expect(await state(repo)).toEqual({ undo: 'Amend "second, amended"', redo: null })

    await api.undo(repo)
    expect(head(repo)).toBe(second)
    expect((await core.status(repo)).staged).toEqual([{ path: 'b.txt', status: 'modified' }])
    expect(read(repo, 'b.txt')).toBe('b amended\n')
    await api.redo(repo)
    expect(head(repo)).toBe(amended)
    expect(sh(repo, 'status', '--porcelain')).toBe('')
  })

  it('checkout: returns to the previous branch or detached commit, carrying local changes', async () => {
    const { repo, first } = seededRepo()
    const second = commitFiles(repo, { 'b.txt': 'b\n' }, 'second')
    sh(repo, 'branch', 'feature', first)

    write(repo, 'a.txt', 'local edit\n')
    write(repo, 'untracked.txt', 'u\n')
    await core.checkout(repo, 'feature')
    expect(await state(repo)).toEqual({ undo: 'Checkout feature', redo: null })
    await api.undo(repo)
    expect(branchOf(repo)).toBe('main')
    expect(head(repo)).toBe(second)
    expect(read(repo, 'a.txt')).toBe('local edit\n')
    expect(read(repo, 'untracked.txt')).toBe('u\n')
    expect(await state(repo)).toEqual({ undo: 'Commit "second"', redo: 'Checkout feature' })
    await api.redo(repo)
    expect(branchOf(repo)).toBe('feature')
    expect(read(repo, 'a.txt')).toBe('local edit\n')
    sh(repo, 'checkout', '-q', '--', 'a.txt')

    // branch -> detached commit -> branch
    await core.checkout(repo, second)
    expect(await state(repo)).toEqual({ undo: `Checkout ${second.slice(0, 7)}`, redo: null })
    await api.undo(repo)
    expect(branchOf(repo)).toBe('feature')
    await api.redo(repo)
    expect(branchOf(repo)).toBe('HEAD')
    expect(head(repo)).toBe(second)
    await core.checkout(repo, 'main')
    expect(await state(repo)).toEqual({ undo: 'Checkout main', redo: null })
    await api.undo(repo)
    expect(branchOf(repo)).toBe('HEAD')
    expect(head(repo)).toBe(second)
    expect(tip(repo, 'main')).toBe(second)
    expect(tip(repo, 'feature')).toBe(first)

    // Creating a branch with checkout: undo goes back, the new branch stays
    await core.checkout(repo, 'main')
    await core.createBranch(repo, 'topic', undefined, true)
    expect(await state(repo)).toEqual({ undo: 'Checkout topic', redo: null })
    await api.undo(repo)
    expect(branchOf(repo)).toBe('main')
    expect(tip(repo, 'topic')).toBe(second)
  })

  it('checkout: refuses when going back would overwrite local changes or the branch is gone', async () => {
    const { repo, first } = seededRepo()
    commitFiles(repo, { 'a.txt': 'main version\n' }, 'second')
    sh(repo, 'branch', 'feature', first)
    await core.checkout(repo, 'feature')
    write(repo, 'a.txt', 'work in progress\n')
    const before = snapshot(repo)
    expect(await errorOf(api.undo(repo))).toMatch(/without overwriting uncommitted changes/)
    expect(snapshot(repo)).toBe(before)
    expect(read(repo, 'a.txt')).toBe('work in progress\n')
    // Still offered once the change is out of the way
    sh(repo, 'checkout', '-q', '--', 'a.txt')
    expect((await state(repo)).undo).toBe('Checkout feature')

    // The branch we came from was deleted or moved: nothing to go back to
    sh(repo, 'branch', '-m', 'main', 'renamed')
    expect(await state(repo)).toEqual({ undo: null, redo: null })
    sh(repo, 'branch', '-m', 'renamed', 'main')
    sh(repo, 'branch', '-f', 'main', first)
    expect(await state(repo)).toEqual({ undo: null, redo: null })
  })

  it('reset --hard: the branch returns to where it was, and back again', async () => {
    const { repo, first } = seededRepo()
    commitFiles(repo, { 'b.txt': 'b\n' }, 'second')
    const third = commitFiles(repo, { 'a.txt': 'three\n', 'c.txt': 'c\n' }, 'third')
    write(repo, 'untracked.txt', 'u\n')

    await core.reset(repo, first, 'hard')
    expect(await state(repo)).toEqual({ undo: `Reset main to ${first.slice(0, 7)}`, redo: null })
    // An unrelated local edit made after the reset rides along
    write(repo, 'untracked.txt', 'u2\n')
    await api.undo(repo)
    expect(head(repo)).toBe(third)
    expect(files(repo)).toEqual(['a.txt', 'b.txt', 'c.txt'])
    expect(read(repo, 'a.txt')).toBe('three\n')
    expect(read(repo, 'untracked.txt')).toBe('u2\n')
    expect(sh(repo, 'status', '--porcelain')).toBe('?? untracked.txt')

    await api.redo(repo)
    expect(head(repo)).toBe(first)
    expect(existsSync(join(repo, 'c.txt'))).toBe(false)
    expect(sh(repo, 'status', '--porcelain')).toBe('?? untracked.txt')
    await api.undo(repo)
    expect(head(repo)).toBe(third)
    expect(await state(repo)).toEqual({ undo: 'Commit "third"', redo: `Reset main to ${first.slice(0, 7)}` })
  })

  it('reset --soft and --mixed: undo and redo are exact inverses', async () => {
    for (const mode of ['soft', 'mixed'] as const) {
      const { repo, first } = seededRepo()
      const third = commitFiles(repo, { 'a.txt': 'three\n', 'c.txt': 'c\n' }, 'third')
      await core.reset(repo, first, mode)
      const afterReset = sh(repo, 'status', '--porcelain')
      expect(afterReset).toBe(mode === 'soft' ? 'M  a.txt\nA  c.txt' : ' M a.txt\n?? c.txt')

      await api.undo(repo)
      expect(head(repo)).toBe(third)
      expect(sh(repo, 'status', '--porcelain')).toBe('')
      expect(read(repo, 'c.txt')).toBe('c\n')

      await api.redo(repo)
      expect(head(repo)).toBe(first)
      expect(sh(repo, 'status', '--porcelain')).toBe(afterReset)
      expect(read(repo, 'a.txt')).toBe('three\n')
      expect(read(repo, 'c.txt')).toBe('c\n')

      await api.undo(repo)
      expect(head(repo)).toBe(third)
      expect(sh(repo, 'status', '--porcelain')).toBe('')
    }
  })

  it('reset: refuses rather than overwrite modified, staged, untracked or ignored files', async () => {
    const { repo, first } = seededRepo()
    const third = commitFiles(repo, { 'a.txt': 'three\n', 'c.txt': 'c\n', 'd.txt': 'd\n' }, 'third')
    await core.reset(repo, first, 'hard')

    // 1. a tracked file that the undo has to change was edited
    write(repo, 'a.txt', 'edited after the reset\n')
    let before = snapshot(repo)
    expect(await errorOf(api.undo(repo))).toMatch(/without overwriting uncommitted changes/)
    expect(snapshot(repo)).toBe(before)
    expect(read(repo, 'a.txt')).toBe('edited after the reset\n')

    // 2. ...and staged
    sh(repo, 'add', 'a.txt')
    before = snapshot(repo)
    expect(await errorOf(api.undo(repo))).toMatch(/there are staged changes \(a\.txt\)/)
    expect(snapshot(repo)).toBe(before)
    expect(sh(repo, 'show', ':a.txt')).toBe('edited after the reset')
    sh(repo, 'reset', '-q', '--hard')
    // (that plain `git reset` is a new entry: it is the last action now, and it changed nothing)
    expect(await state(repo)).toEqual({ undo: null, redo: null })
    sh(repo, 'reset', '-q', '--hard', third)
    await core.reset(repo, first, 'hard')

    // 3. an untracked file where the undo would restore one
    write(repo, 'c.txt', 'my untracked c\n')
    before = snapshot(repo)
    expect(await errorOf(api.undo(repo))).toMatch(/would overwrite untracked files \(c\.txt\)/)
    expect(snapshot(repo)).toBe(before)
    expect(read(repo, 'c.txt')).toBe('my untracked c\n')
    rmSync(join(repo, 'c.txt'))

    // 4. the same with an ignored file, which git itself would silently replace
    write(repo, '.git/info/exclude', 'd.txt\n')
    write(repo, 'd.txt', 'ignored but mine\n')
    expect(sh(repo, 'status', '--porcelain')).toBe('')
    expect(await errorOf(api.undo(repo))).toMatch(/would overwrite untracked files \(d\.txt\)/)
    expect(read(repo, 'd.txt')).toBe('ignored but mine\n')
    expect(head(repo)).toBe(first)
    rmSync(join(repo, 'd.txt'))

    await api.undo(repo)
    expect(head(repo)).toBe(third)
    expect(read(repo, 'd.txt')).toBe('d\n')
  })

  it('merge (fast-forward, merge commit, and one concluded after conflicts)', async () => {
    const { repo, first } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'feature')
    const f1 = commitFiles(repo, { 'f.txt': 'f\n' }, 'feature work')
    sh(repo, 'checkout', '-q', 'main')

    await core.merge(repo, 'feature')
    expect(head(repo)).toBe(f1)
    expect(await state(repo)).toEqual({ undo: 'Merge feature into main', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(first)
    expect(existsSync(join(repo, 'f.txt'))).toBe(false)
    expect(tip(repo, 'feature')).toBe(f1)
    await api.redo(repo)
    expect(head(repo)).toBe(f1)
    await api.undo(repo)

    // A real merge commit
    const m1 = commitFiles(repo, { 'm.txt': 'm\n' }, 'main work')
    await core.merge(repo, 'feature')
    const merge = head(repo)
    expect(sh(repo, 'rev-list', '--parents', '-1', 'HEAD').split(' ')).toHaveLength(3)
    write(repo, 'untracked.txt', 'u\n')
    write(repo, 'm.txt', 'local edit\n')
    await api.undo(repo)
    expect(head(repo)).toBe(m1)
    expect(read(repo, 'm.txt')).toBe('local edit\n')
    expect(read(repo, 'untracked.txt')).toBe('u\n')
    expect(existsSync(join(repo, 'f.txt'))).toBe(false)
    await api.redo(repo)
    expect(head(repo)).toBe(merge)
    expect(read(repo, 'm.txt')).toBe('local edit\n')
    sh(repo, 'checkout', '-q', '--', 'm.txt')

    // Conflicting merge, resolved and committed
    rmSync(join(repo, 'untracked.txt'))
    sh(repo, 'checkout', '-q', '-b', 'clash', first)
    commitFiles(repo, { 'a.txt': 'clash\n' }, 'clash')
    sh(repo, 'checkout', '-q', 'main')
    const beforeMerge = commitFiles(repo, { 'a.txt': 'main\n' }, 'main a')
    await core.merge(repo, 'clash').catch(() => {})
    expect(await state(repo)).toEqual({ undo: null, redo: null })
    expect(await errorOf(api.undo(repo))).toMatch(/A merge is in progress/)
    expect(await errorOf(api.redo(repo))).toMatch(/A merge is in progress/)
    write(repo, 'a.txt', 'resolved\n')
    await core.stage(repo, ['a.txt'])
    await core.continueOp(repo)
    expect((await state(repo)).undo).toMatch(/^Merge "Merge branch '(refs\/heads\/)?clash'/)
    await api.undo(repo)
    expect(head(repo)).toBe(beforeMerge)
    expect(read(repo, 'a.txt')).toBe('main\n')
    expect(sh(repo, 'status', '--porcelain')).toBe('')
  })

  it('cherry-pick and revert', async () => {
    const { repo, first } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'feature')
    const f1 = commitFiles(repo, { 'f.txt': 'f\n' }, 'feature work')
    sh(repo, 'checkout', '-q', 'main')

    await core.cherryPick(repo, f1)
    const picked = head(repo)
    expect(await state(repo)).toEqual({ undo: 'Cherry pick "feature work"', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(first)
    expect(existsSync(join(repo, 'f.txt'))).toBe(false)
    await api.redo(repo)
    expect(head(repo)).toBe(picked)

    await core.revert(repo, picked)
    const reverted = head(repo)
    expect(existsSync(join(repo, 'f.txt'))).toBe(false)
    expect(await state(repo)).toEqual({ undo: 'Revert "feature work"', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(picked)
    expect(read(repo, 'f.txt')).toBe('f\n')
    await api.redo(repo)
    expect(head(repo)).toBe(reverted)
    expect(tip(repo, 'feature')).toBe(f1)
  })

  it('rebase, plain and interactive', async () => {
    const { repo, first } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'feature')
    commitFiles(repo, { 'f1.txt': '1\n' }, 'f1')
    const f2 = commitFiles(repo, { 'f2.txt': '2\n' }, 'f2')
    sh(repo, 'checkout', '-q', 'main')
    const m1 = commitFiles(repo, { 'm.txt': 'm\n' }, 'main work')
    sh(repo, 'checkout', '-q', 'feature')
    write(repo, 'untracked.txt', 'u\n')

    await core.rebase(repo, 'main')
    const rebased = head(repo)
    expect(sh(repo, 'merge-base', 'HEAD', 'main')).toBe(m1)
    expect(await state(repo)).toEqual({ undo: 'Rebase feature', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(f2)
    expect(branchOf(repo)).toBe('feature')
    expect(existsSync(join(repo, 'm.txt'))).toBe(false)
    expect(tip(repo, 'main')).toBe(m1)
    await api.redo(repo)
    expect(head(repo)).toBe(rebased)
    expect(read(repo, 'm.txt')).toBe('m\n')

    // Interactive: rewords and squashes add entries of their own in between
    const [a, b] = sh(repo, 'rev-list', '--reverse', 'main..HEAD').split('\n') as [string, string]
    await api.rebaseInteractive(repo, m1, [
      { hash: b, action: 'reword', message: 'f2 first' },
      { hash: a, action: 'squash', message: 'both' }
    ])
    const rewritten = head(repo)
    expect(subjects(repo, 'main..HEAD')).toEqual(['both'])
    expect(await state(repo)).toEqual({ undo: 'Rebase feature', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(rebased)
    expect(subjects(repo, 'main..HEAD')).toEqual(['f1', 'f2'])
    await api.redo(repo)
    expect(head(repo)).toBe(rewritten)
    expect(read(repo, 'untracked.txt')).toBe('u\n')
    expect(first).not.toBe(rewritten)

    // A rebase that was aborted changed nothing: nothing to undo
    sh(repo, 'checkout', '-q', '-b', 'clash', first)
    commitFiles(repo, { 'm.txt': 'clash\n' }, 'clash')
    await core.rebase(repo, 'main').catch(() => {})
    await core.abort(repo)
    expect((await state(repo)).undo).toBeNull()
  })

  it('pull: fast-forward, merge and rebase', async () => {
    const { repo } = seededRepo()
    const remote = tmpDir()
    sh(remote, 'init', '-q', '--bare')
    sh(repo, 'remote', 'add', 'origin', remote)
    await core.push(repo)
    const other = join(tmpDir(), 'other')
    sh(tmpDir(), 'clone', '-q', remote, other)
    const publish = (file: string, msg: string): string => {
      const hash = commitFiles(other, { [file]: `${msg}\n` }, msg)
      sh(other, 'push', '-q')
      return hash
    }

    // Fast-forward: the pulled commits are on the remote by definition, and undo is still fine
    const start = head(repo)
    const r1 = publish('r1.txt', 'remote 1')
    await core.pull(repo, { rebase: false })
    expect(head(repo)).toBe(r1)
    expect(await state(repo)).toEqual({ undo: 'Pull into main', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(start)
    expect(sh(repo, 'rev-parse', 'origin/main')).toBe(r1)
    await api.redo(repo)
    expect(head(repo)).toBe(r1)

    // Merge pull
    const l1 = commitFiles(repo, { 'l1.txt': 'l\n' }, 'local 1')
    publish('r2.txt', 'remote 2')
    await core.pull(repo, { rebase: false })
    const merged = head(repo)
    expect(await state(repo)).toEqual({ undo: 'Pull into main', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(l1)
    await api.redo(repo)
    expect(head(repo)).toBe(merged)
    await api.undo(repo)

    // Rebase pull
    await core.pull(repo, { rebase: true })
    const rebased = head(repo)
    expect(subjects(repo, 'origin/main..HEAD')).toEqual(['local 1'])
    expect(await state(repo)).toEqual({ undo: 'Pull (rebase) into main', redo: null })
    await api.undo(repo)
    expect(head(repo)).toBe(l1)
    await api.redo(repo)
    expect(head(repo)).toBe(rebased)

    // Once pushed, the result of the pull is published history
    await core.push(repo)
    expect(await state(repo)).toEqual({ undo: 'Pull (rebase) into main (already pushed: cannot be undone)', redo: null })
    expect(await errorOf(api.undo(repo))).toMatch(/already pushed to origin\/main/)
    expect(head(repo)).toBe(rebased)
  })

  it('refuses to undo a commit that is already pushed, and says so', async () => {
    const { repo } = seededRepo()
    const remote = tmpDir()
    sh(remote, 'init', '-q', '--bare')
    sh(repo, 'remote', 'add', 'origin', remote)
    const pushed = commitFiles(repo, { 'b.txt': 'b\n' }, 'published work')
    expect((await state(repo)).undo).toBe('Commit "published work"')
    await core.push(repo)

    expect(await state(repo)).toEqual({ undo: 'Commit "published work" (already pushed: cannot be undone)', redo: null })
    const before = snapshot(repo)
    const msg = await errorOf(api.undo(repo))
    expect(msg).toMatch(/already pushed to origin\/main/)
    expect(msg).toMatch(/Revert commit/)
    expect(snapshot(repo)).toBe(before)
    expect(head(repo)).toBe(pushed)

    // A newer, unpushed commit on top can be undone; the pushed one below it cannot
    const local = commitFiles(repo, { 'c.txt': 'c\n' }, 'local work')
    expect((await state(repo)).undo).toBe('Commit "local work"')
    await api.undo(repo)
    expect(head(repo)).toBe(pushed)
    expect((await state(repo)).undo).toBe('Commit "published work" (already pushed: cannot be undone)')
    expect(await errorOf(api.undo(repo))).toMatch(/already pushed/)
    await api.redo(repo)
    expect(head(repo)).toBe(local)

    // Pushed to a remote branch without being the upstream: still published
    sh(repo, 'checkout', '-q', '-b', 'side')
    commitFiles(repo, { 'd.txt': 'd\n' }, 'side work')
    sh(repo, 'push', '-q', 'origin', 'side:elsewhere')
    expect((await state(repo)).undo).toBe('Commit "side work" (already pushed: cannot be undone)')
  })

  it('renaming the current branch', async () => {
    const { repo, first } = seededRepo()
    await core.renameBranch(repo, 'main', 'trunk')
    expect(await state(repo)).toEqual({ undo: 'Rename branch main → trunk', redo: null })
    await api.undo(repo)
    expect(branchOf(repo)).toBe('main')
    expect(sh(repo, 'branch', '--format=%(refname:short)')).toBe('main')
    await api.redo(repo)
    expect(branchOf(repo)).toBe('trunk')
    expect(head(repo)).toBe(first)
    // The old name was taken in the meantime: nothing to undo
    sh(repo, 'branch', 'main')
    expect((await state(repo)).undo).toBeNull()
  })

  it('walks back and forward through several actions; a new action clears redo', async () => {
    const { repo, first } = seededRepo()
    const c1 = commitFiles(repo, { 'b.txt': 'b\n' }, 'one')
    await core.createBranch(repo, 'feature', undefined, true)
    write(repo, 'c.txt', 'c\n')
    await core.stageAll(repo)
    await core.commit(repo, 'two')
    const c2 = head(repo)
    await core.checkout(repo, 'main')
    await core.merge(repo, 'feature')
    write(repo, 'untracked.txt', 'u\n')

    const labels: (string | null)[] = []
    for (let i = 0; i < 5; i++) {
      labels.push((await state(repo)).undo)
      await api.undo(repo)
    }
    expect(labels).toEqual(['Merge feature into main', 'Checkout main', 'Commit "two"', 'Checkout feature', 'Commit "one"'])
    expect(head(repo)).toBe(first)
    expect(branchOf(repo)).toBe('main')
    expect(tip(repo, 'feature')).toBe(c1)
    // Everything that was committed is staged, nothing was lost
    expect(sh(repo, 'status', '--porcelain')).toBe('A  b.txt\nA  c.txt\n?? untracked.txt')
    expect(await state(repo)).toEqual({ undo: null, redo: 'Commit "one"' })

    const redone: (string | null)[] = []
    for (let i = 0; i < 5; i++) {
      redone.push((await state(repo)).redo)
      await api.redo(repo)
    }
    expect(redone).toEqual([...labels].reverse())
    expect(head(repo)).toBe(c2)
    expect(branchOf(repo)).toBe('main')
    expect(tip(repo, 'feature')).toBe(c2)
    expect(sh(repo, 'status', '--porcelain')).toBe('?? untracked.txt')
    expect(await state(repo)).toEqual({ undo: 'Merge feature into main', redo: null })

    // Undo twice, then do something new: the redo stack is dropped
    await api.undo(repo)
    await api.undo(repo)
    expect(branchOf(repo)).toBe('feature')
    expect((await state(repo)).redo).toBe('Checkout main')
    commitFiles(repo, { 'd.txt': 'd\n' }, 'three')
    expect(await state(repo)).toEqual({ undo: 'Commit "three"', redo: null })
    expect(await errorOf(api.redo(repo))).toMatch(/Nothing to redo/)
  })

  it('never touches stashes, other branches, tags or untracked files', async () => {
    const { repo, first } = seededRepo()
    sh(repo, 'branch', 'other', first)
    sh(repo, 'tag', 'v1', first)
    write(repo, 'a.txt', 'stashed work\n')
    write(repo, 'stashed-untracked.txt', 's\n')
    await core.stashSave(repo, 'precious')
    // Stashing is the last action and cannot be undone
    expect(await state(repo)).toEqual({ undo: null, redo: null })

    const others = (): string =>
      [
        sh(repo, 'stash', 'list', '--format=%H %gs'),
        tip(repo, 'other'),
        sh(repo, 'rev-parse', 'v1'),
        sh(repo, 'for-each-ref', '--format=%(refname) %(objectname)', 'refs/tags', 'refs/stash')
      ].join('\n')
    const before = others()

    const c1 = commitFiles(repo, { 'b.txt': 'b\n' }, 'one')
    write(repo, 'untracked.txt', 'u\n')
    await api.undo(repo)
    expect(others()).toBe(before)
    await api.redo(repo)
    expect(others()).toBe(before)
    await core.reset(repo, first, 'hard')
    await api.undo(repo)
    expect(head(repo)).toBe(c1)
    await api.redo(repo)
    await api.undo(repo)
    await core.checkout(repo, 'other')
    await api.undo(repo)
    await api.redo(repo)
    expect(others()).toBe(before)
    expect(read(repo, 'untracked.txt')).toBe('u\n')

    await core.stashPop(repo, 0)
    expect(read(repo, 'a.txt')).toBe('stashed work\n')
    expect(read(repo, 'stashed-untracked.txt')).toBe('s\n')
  })

  it('reports nothing to undo when the reflog does not match (changes made outside the app)', async () => {
    const { repo, first } = seededRepo()
    const c1 = commitFiles(repo, { 'b.txt': 'b\n' }, 'one')
    const c2 = commitFiles(repo, { 'c.txt': 'c\n' }, 'two')

    // After an undo, an external commit invalidates redo
    await api.undo(repo)
    expect((await state(repo)).redo).toBe('Commit "two"')
    sh(repo, 'commit', '-q', '-m', 'made in a terminal')
    expect(await state(repo)).toEqual({ undo: 'Commit "made in a terminal"', redo: null })

    // The branch was moved behind git's back: HEAD is not where the last entry left it
    sh(repo, 'reset', '-q', '--hard', c2)
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${c1}\n`)
    expect(head(repo)).toBe(c1)
    expect(await state(repo)).toEqual({ undo: null, redo: null })
    expect(await errorOf(api.undo(repo))).toMatch(/Nothing to undo/)
    expect(head(repo)).toBe(c1)
    sh(repo, 'reset', '-q', '--hard', c2)

    // An entry this module does not know how to reverse
    sh(repo, 'update-ref', '-m', 'something custom', 'HEAD', c1)
    expect(await state(repo)).toEqual({ undo: null, redo: null })
    sh(repo, 'reset', '-q', '--hard', c2)

    // The journal says "redo two" but the repository is somewhere else
    const c3 = commitFiles(repo, { 'd.txt': 'd\n' }, 'three')
    await api.undo(repo)
    const journal = join(repo, '.git', 'gitkroken', 'undo.json')
    expect(existsSync(journal)).toBe(true)
    expect(existsSync(join(repo, 'gitkroken'))).toBe(false)
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${first}\n`)
    expect((await state(repo)).redo).toBeNull()
    expect(await errorOf(api.redo(repo))).toMatch(/Nothing to redo/)
    writeFileSync(join(repo, '.git', 'refs', 'heads', 'main'), `${c2}\n`)
    expect((await state(repo)).redo).toBe('Commit "three"')

    // A corrupt journal is ignored
    writeFileSync(journal, '{ not json')
    expect((await state(repo)).redo).toBeNull()
    writeFileSync(journal, JSON.stringify({ v: 1, size: 1, tail: 'x', cursor: 0, undo: 'x', redo: [{}] }))
    expect((await state(repo)).redo).toBeNull()
    expect(c3).not.toBe(c2)

    // A rebase of another branch run from here (`git rebase main other`) is not ours to undo
    sh(repo, 'reset', '-q', '--hard', c2)
    sh(repo, 'checkout', '-q', '-b', 'other', first)
    commitFiles(repo, { 'o.txt': 'o\n' }, 'other work')
    sh(repo, 'checkout', '-q', '-b', 'third', first)
    sh(repo, 'rebase', '-q', 'main', 'other')
    expect(branchOf(repo)).toBe('other')
    expect(await state(repo)).toEqual({ undo: null, redo: null })

    // No reflog at all
    rmSync(join(repo, '.git', 'logs'), { recursive: true, force: true })
    expect(await state(repo)).toEqual({ undo: null, redo: null })
    // Not a repository
    expect(await api.undoState(tmpDir())).toEqual({ undo: null, redo: null })
  })

  it('works on a detached HEAD', async () => {
    const { repo, first } = seededRepo()
    sh(repo, 'checkout', '-q', '--detach')
    const c1 = commitFiles(repo, { 'b.txt': 'b\n' }, 'detached work')
    expect((await state(repo)).undo).toBe('Commit "detached work"')
    await api.undo(repo)
    expect(head(repo)).toBe(first)
    expect(branchOf(repo)).toBe('HEAD')
    expect(sh(repo, 'status', '--porcelain')).toBe('A  b.txt')
    await api.redo(repo)
    expect(head(repo)).toBe(c1)
    expect(tip(repo, 'main')).toBe(first)
  })
})
