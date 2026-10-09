import { describe, expect, it } from 'vitest'
import type { Commit, Ref, Status } from '@shared/types'
import {
  analyse,
  defaultCombined,
  initialRows,
  moveRow,
  pushedCount,
  pushedRewritten,
  rebaseFromCommit,
  rebaseOnto,
  setAction,
  setCombined,
  setMessage,
  toSteps
} from './plan'

const hash = (n: number): string => String(n).padStart(40, '0')
const commit = (n: number, parents: number[], subject = `commit ${n}`, body = ''): Commit => ({
  hash: hash(n),
  parents: parents.map(hash),
  author: 'Ada',
  email: 'ada@example.com',
  date: 1_700_000_000 + n,
  subject,
  body
})
/** 1 <- 2 <- 3 <- 4 (oldest first), on top of base 0 */
const todo = [commit(1, [0]), commit(2, [1], 'second', 'with a body'), commit(3, [2]), commit(4, [3])]
const status = (over: Partial<Status> = {}): Status => ({
  branch: 'main',
  head: hash(4),
  staged: [],
  unstaged: [],
  conflicted: [],
  inProgress: null,
  ...over
})

describe('plan rows', () => {
  it('starts as all-pick, oldest first, and reports no change', () => {
    const rows = initialRows(todo)
    expect(rows.map((r) => r.action)).toEqual(['pick', 'pick', 'pick', 'pick'])
    expect(rows[1]!.message).toBe('second\n\nwith a body')
    const a = analyse(rows, todo)
    expect(a.changed).toBe(false)
    expect(a.firstChanged).toBe(4)
    expect(a.errors).toEqual([])
    expect(a.summary).toBe('4 commits → 4')
  })

  it('moves rows without losing any', () => {
    const rows = initialRows(todo)
    expect(moveRow(rows, 3, 0).map((r) => r.hash)).toEqual([hash(4), hash(1), hash(2), hash(3)])
    expect(moveRow(rows, 0, 2).map((r) => r.hash)).toEqual([hash(2), hash(3), hash(1), hash(4)])
    expect(moveRow(rows, 1, 1)).toEqual(rows)
    expect(moveRow(rows, 0, 9)).toEqual(rows)
    expect(moveRow(rows, -1, 2)).toEqual(rows)
    const a = analyse(moveRow(rows, 3, 2), todo)
    expect(a.changed).toBe(true)
    expect(a.firstChanged).toBe(2)
    expect(a.reordered).toBe(true)
    expect(a.summary).toBe('4 commits → 4; reordered')
  })

  it('groups squash and fixup rows under the pick above them, skipping dropped rows', () => {
    let rows = initialRows(todo)
    rows = setAction(rows, 1, 'squash')
    rows = setAction(rows, 2, 'drop')
    rows = setAction(rows, 3, 'fixup')
    const a = analyse(rows, todo)
    expect(a.targetOf).toEqual([null, 0, null, 0])
    expect(a.groups.get(0)).toEqual({ target: 0, members: [1, 3], squashes: [1] })
    expect(a.errors).toEqual([])
    expect(a.resulting).toBe(1)
    expect(a.summary).toBe('4 commits → 1; 1 dropped, 2 squashed')
  })

  it('matches the example of the brief: 3 commits → 2; 1 dropped', () => {
    const three = todo.slice(0, 3)
    const rows = setAction(initialRows(three), 1, 'drop')
    expect(analyse(rows, three).summary).toBe('3 commits → 2; 1 dropped')
  })

  it('explains invalid plans', () => {
    let rows = setAction(initialRows(todo), 0, 'squash')
    expect(analyse(rows, todo).errors[0]).toMatch(/first row that is kept, so it cannot be Squash/)
    rows = setAction(setAction(initialRows(todo), 0, 'drop'), 1, 'fixup')
    expect(analyse(rows, todo).errors[0]).toMatch(/"second" is the first row that is kept, so it cannot be Fixup/)
    rows = initialRows(todo).map((r) => ({ ...r, action: 'drop' as const }))
    expect(analyse(rows, todo).errors[0]).toMatch(/drops every commit/)
    rows = setMessage(setAction(initialRows(todo), 2, 'reword'), 2, '  \n')
    expect(analyse(rows, todo).errors[0]).toMatch(/new message of 0{7} "commit 3" is empty/)
    rows = setCombined(setAction(initialRows(todo), 1, 'squash'), 0, ' ')
    expect(analyse(rows, todo).errors[0]).toMatch(/squashed commit at .* is empty/)
  })

  it('counts a reword only when the message really changes', () => {
    let rows = setAction(initialRows(todo), 1, 'reword')
    expect(analyse(rows, todo).reworded).toBe(0)
    expect(analyse(rows, todo).changed).toBe(true)
    rows = setMessage(rows, 1, 'second, better')
    expect(analyse(rows, todo).summary).toBe('4 commits → 4; 1 reworded')
  })
})

describe('toSteps', () => {
  it('puts the combined message on the last squash of each group', () => {
    let rows = initialRows(todo)
    rows = setAction(rows, 1, 'squash')
    rows = setAction(rows, 2, 'squash')
    rows = setAction(rows, 3, 'fixup')
    const byHash = new Map(todo.map((c) => [c.hash, c]))
    const group = analyse(rows, todo).groups.get(0)!
    expect(defaultCombined(rows, group, byHash)).toBe('commit 1\n\nsecond\n\nwith a body\n\ncommit 3')
    expect(toSteps(rows, todo)).toEqual([
      { hash: hash(1), action: 'pick' },
      { hash: hash(2), action: 'squash' },
      { hash: hash(3), action: 'squash', message: 'commit 1\n\nsecond\n\nwith a body\n\ncommit 3' },
      { hash: hash(4), action: 'fixup' }
    ])
    rows = setCombined(rows, 0, '  all together \n')
    expect(toSteps(rows, todo)[2]).toEqual({ hash: hash(3), action: 'squash', message: 'all together' })
    rows = setCombined(rows, 0, null)
    expect(toSteps(rows, todo)[2]!.message).toMatch(/^commit 1/)
  })

  it('sends reword messages trimmed, and folds a reworded target into its squash message', () => {
    let rows = initialRows(todo)
    rows = setMessage(setAction(rows, 0, 'reword'), 0, ' first, reworded \n')
    expect(toSteps(rows, todo)[0]).toEqual({ hash: hash(1), action: 'reword', message: 'first, reworded' })
    rows = setAction(rows, 1, 'squash')
    const steps = toSteps(rows, todo)
    expect(steps[0]).toEqual({ hash: hash(1), action: 'pick' })
    expect(steps[1]).toEqual({ hash: hash(2), action: 'squash', message: 'first, reworded\n\nsecond\n\nwith a body' })
    expect(toSteps(setAction(rows, 3, 'drop'), todo)[3]).toEqual({ hash: hash(4), action: 'drop' })
  })
})

describe('pushed commits', () => {
  const ref = (over: Partial<Ref>): Ref => ({ name: 'main', type: 'head', hash: hash(4), isCurrent: true, ...over })

  it('are the oldest ones of the range', () => {
    expect(pushedCount(todo, ref({ upstream: 'origin/main', ahead: 1, behind: 0 }))).toBe(3)
    expect(pushedCount(todo, ref({ upstream: 'origin/main', ahead: 0, behind: 2 }))).toBe(4)
    expect(pushedCount(todo, ref({ upstream: 'origin/main', ahead: 9, behind: 0 }))).toBe(0)
    // No upstream, an upstream that is gone, no branch
    expect(pushedCount(todo, ref({}))).toBe(0)
    expect(pushedCount(todo, ref({ upstream: 'origin/main' }))).toBe(0)
    expect(pushedCount(todo, undefined)).toBe(0)
  })

  it('are rewritten from the first changed row on', () => {
    const rows = initialRows(todo)
    expect(pushedRewritten(3, analyse(rows, todo))).toBe(0)
    expect(pushedRewritten(3, analyse(setAction(rows, 3, 'drop'), todo))).toBe(0)
    expect(pushedRewritten(3, analyse(setAction(rows, 2, 'reword'), todo))).toBe(1)
    expect(pushedRewritten(3, analyse(moveRow(rows, 0, 1), todo))).toBe(3)
  })
})

describe('where an interactive rebase can start', () => {
  // 0 <- 1 <- 2 <- 3 <- 4 = main ; 9 on a side branch from 0
  const linear = [commit(4, [3]), commit(3, [2]), commit(2, [1]), commit(1, [0]), commit(9, [0]), commit(0, [])]

  it('from a commit of the current branch: the base is its parent', () => {
    expect(rebaseFromCommit(linear[2]!, linear, status())).toEqual({ base: hash(1), reason: null })
    expect(rebaseFromCommit(linear[0]!, linear, status())).toEqual({ base: hash(3), reason: null })
  })

  it('explains why it cannot', () => {
    expect(rebaseFromCommit(linear[4]!, linear, status()).reason).toBe('not an ancestor of main')
    expect(rebaseFromCommit(linear[5]!, linear, status()).reason).toBe('the root commit cannot be included')
    expect(rebaseFromCommit(linear[2]!, linear, status({ branch: null })).reason).toMatch(/HEAD is detached/)
    expect(rebaseFromCommit(linear[2]!, linear, status({ inProgress: 'merge' })).reason).toBe('a merge is in progress')
    expect(rebaseFromCommit(linear[2]!, linear, null).reason).toBe('no commits yet')
    expect(rebaseFromCommit(linear[2]!, linear, status()).base).not.toBeNull()
  })

  it('stops at merge commits', () => {
    // 0 <- 1 <- 5(merge of 1 and 9) <- 6 = main
    const merged = [commit(6, [5]), commit(5, [1, 9]), commit(9, [0]), commit(1, [0]), commit(0, [])]
    const st = status({ head: hash(6) })
    expect(rebaseFromCommit(merged[0]!, merged, st)).toEqual({ base: hash(5), reason: null })
    expect(rebaseFromCommit(merged[1]!, merged, st).reason).toBe('it is a merge commit')
    expect(rebaseFromCommit(merged[3]!, merged, st).reason).toBe('there is a merge commit between it and main')
    expect(rebaseFromCommit(merged[2]!, merged, st).reason).toBe('there is a merge commit between it and main')
    // Onto the merge itself is fine: everything after it is linear
    expect(rebaseOnto(hash(5), merged, st)).toEqual({ base: hash(5), reason: null })
    expect(rebaseOnto(hash(1), merged, st).reason).toBe('there is a merge commit between it and main')
  })

  it('onto a branch that the current one is ahead of', () => {
    expect(rebaseOnto(hash(1), linear, status())).toEqual({ base: hash(1), reason: null })
    expect(rebaseOnto(hash(4), linear, status()).reason).toBe('no commits to rebase')
    expect(rebaseOnto(hash(9), linear, status()).reason).toBe('not an ancestor of main')
    expect(rebaseOnto('', linear, status()).reason).toBe('not an ancestor of main')
  })
})
