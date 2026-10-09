// The interactive-rebase plan the user edits, as pure data. No React, no
// IPC: everything here is unit-tested (plan.test.ts).
import type { Commit, RebaseAction, RebaseStep, Ref, Status } from '@shared/types'

export interface Row {
  hash: string
  action: RebaseAction
  /** New message while the row is `reword` (starts as the commit's own message) */
  message: string
  /**
   * Message of the combined commit when squash rows are folded into this
   * row; null = automatic (the messages of the combined commits, in order).
   */
  combined: string | null
}

export const ACTIONS: readonly RebaseAction[] = ['pick', 'reword', 'squash', 'fixup', 'drop']

export const ACTION_INFO: Record<RebaseAction, { label: string; key: string; hint: string }> = {
  pick: { label: 'Pick', key: 'P', hint: 'Keep the commit as it is' },
  reword: { label: 'Reword', key: 'R', hint: 'Keep the commit and change its message' },
  squash: { label: 'Squash', key: 'S', hint: 'Combine with the previous commit and merge the messages' },
  fixup: { label: 'Fixup', key: 'F', hint: 'Combine with the previous commit and discard this message' },
  drop: { label: 'Drop', key: 'D', hint: 'Remove the commit and its changes' }
}

export const fullMessage = (c: Commit): string => (c.body ? `${c.subject}\n\n${c.body}` : c.subject)
export const shortHash = (hash: string): string => hash.slice(0, 7)

/** One row per commit, oldest first, all `pick`. */
export function initialRows(commits: readonly Commit[]): Row[] {
  return commits.map((c) => ({ hash: c.hash, action: 'pick', message: fullMessage(c), combined: null }))
}

export function moveRow(rows: readonly Row[], from: number, to: number): Row[] {
  if (from === to || from < 0 || to < 0 || from >= rows.length || to >= rows.length) return [...rows]
  const next = [...rows]
  const [row] = next.splice(from, 1)
  next.splice(to, 0, row!)
  return next
}

export function setAction(rows: readonly Row[], index: number, action: RebaseAction): Row[] {
  return rows.map((row, i) => (i === index ? { ...row, action } : row))
}

export function setMessage(rows: readonly Row[], index: number, message: string): Row[] {
  return rows.map((row, i) => (i === index ? { ...row, message } : row))
}

export function setCombined(rows: readonly Row[], index: number, combined: string | null): Row[] {
  return rows.map((row, i) => (i === index ? { ...row, combined } : row))
}

export interface Group {
  /** Index of the pick / reword row everything is folded into */
  target: number
  /** Indices of its squash + fixup rows, in order */
  members: number[]
  /** Indices of the squash rows only (their messages are kept) */
  squashes: number[]
}

export interface Analysis {
  /** For each row: the index of the row it is folded into (squash / fixup), else null */
  targetOf: (number | null)[]
  /** Groups with at least one member, keyed by target index */
  groups: Map<number, Group>
  /** Why the plan cannot start (empty when it can) */
  errors: string[]
  /** False while the plan is identical to the current history */
  changed: boolean
  /** Index of the first row that differs from the current history (= rows.length when unchanged) */
  firstChanged: number
  resulting: number
  dropped: number
  folded: number
  reworded: number
  reordered: boolean
  summary: string
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** Message the combined commit gets unless the user writes another one. */
export function defaultCombined(rows: readonly Row[], group: Group, byHash: ReadonlyMap<string, Commit>): string {
  const original = (i: number): string => {
    const c = byHash.get(rows[i]!.hash)
    return c ? fullMessage(c) : ''
  }
  const target = rows[group.target]!
  const own = target.action === 'reword' && target.message.trim() ? target.message.trim() : original(group.target)
  return [own, ...group.squashes.map(original)].filter(Boolean).join('\n\n')
}

export function analyse(rows: readonly Row[], commits: readonly Commit[]): Analysis {
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  const targetOf: (number | null)[] = rows.map(() => null)
  const groups = new Map<number, Group>()
  const errors: string[] = []
  let current: number | null = null
  let orphan: number | null = null

  rows.forEach((row, i) => {
    if (row.action === 'drop') return
    if (row.action === 'pick' || row.action === 'reword') {
      current = i
      return
    }
    if (current === null) {
      if (orphan === null) orphan = i
      return
    }
    targetOf[i] = current
    const group = groups.get(current) ?? { target: current, members: [], squashes: [] }
    group.members.push(i)
    if (row.action === 'squash') group.squashes.push(i)
    groups.set(current, group)
  })

  const kept = rows.filter((r) => r.action !== 'drop')
  const dropped = rows.length - kept.length
  const resulting = kept.filter((r) => r.action === 'pick' || r.action === 'reword').length
  const folded = kept.length - resulting
  const name = (i: number): string => `${shortHash(rows[i]!.hash)} "${byHash.get(rows[i]!.hash)?.subject ?? ''}"`

  if (rows.length > 0 && kept.length === 0) {
    errors.push('The plan drops every commit. Keep at least one (to discard them all, use Reset).')
  }
  if (orphan !== null) {
    errors.push(
      `${name(orphan)} is the first row that is kept, so it cannot be ${ACTION_INFO[rows[orphan]!.action].label}: ` +
        'there is no earlier commit to combine it with.'
    )
  }
  let reworded = 0
  rows.forEach((row, i) => {
    const group = groups.get(i)
    if (group && group.squashes.length) {
      const text = row.combined ?? defaultCombined(rows, group, byHash)
      if (!text.trim()) errors.push(`The message of the squashed commit at ${name(i)} is empty.`)
      return
    }
    if (row.action !== 'reword') return
    if (!row.message.trim()) errors.push(`The new message of ${name(i)} is empty.`)
    else if (row.message.trim() !== fullMessage(byHash.get(row.hash) ?? emptyCommit).trim()) reworded++
  })

  let firstChanged = 0
  while (firstChanged < rows.length && rows[firstChanged]!.action === 'pick' && rows[firstChanged]!.hash === commits[firstChanged]?.hash) {
    firstChanged++
  }
  const changed = firstChanged < rows.length
  const keptOrder = kept.map((r) => r.hash)
  const originalOrder = commits.map((c) => c.hash).filter((h) => keptOrder.includes(h))
  const reordered = keptOrder.some((h, i) => h !== originalOrder[i])

  const parts: string[] = []
  if (dropped) parts.push(`${dropped} dropped`)
  if (folded) parts.push(`${folded} squashed`)
  if (reworded) parts.push(`${reworded} reworded`)
  if (reordered) parts.push('reordered')
  const summary = `${plural(rows.length, 'commit', 'commits')} → ${resulting}${parts.length ? `; ${parts.join(', ')}` : ''}`

  return { targetOf, groups, errors, changed, firstChanged, resulting, dropped, folded, reworded, reordered, summary }
}

const emptyCommit: Commit = { hash: '', parents: [], author: '', email: '', date: 0, subject: '', body: '' }

/** What is sent to `git.rebaseInteractive`. Only call it on a plan without errors. */
export function toSteps(rows: readonly Row[], commits: readonly Commit[]): RebaseStep[] {
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  const { groups } = analyse(rows, commits)
  /** squash row index -> message of its group, for the last squash of each group */
  const combinedAt = new Map<number, string>()
  const squashTargets = new Set<number>()
  for (const group of groups.values()) {
    if (group.squashes.length === 0) continue
    squashTargets.add(group.target)
    const text = rows[group.target]!.combined ?? defaultCombined(rows, group, byHash)
    combinedAt.set(group.squashes[group.squashes.length - 1]!, text.trim())
  }
  return rows.map((row, i): RebaseStep => {
    if (row.action === 'reword') {
      // Folded into a combined commit: its message is the combined one.
      if (squashTargets.has(i)) return { hash: row.hash, action: 'pick' }
      return { hash: row.hash, action: 'reword', message: row.message.trim() }
    }
    if (row.action === 'squash' && combinedAt.has(i)) return { hash: row.hash, action: 'squash', message: combinedAt.get(i)! }
    return { hash: row.hash, action: row.action }
  })
}

/**
 * How many commits of `todo` (oldest first, a linear range ending at the
 * branch tip) are already on the branch's upstream. They are always the
 * oldest ones: whatever the upstream contains, it contains its ancestors too.
 */
export function pushedCount(todo: readonly Commit[], branch: Ref | undefined): number {
  if (!branch || !branch.upstream || branch.ahead === undefined) return 0
  return Math.max(0, todo.length - branch.ahead)
}

/** Pushed commits the plan would rewrite: every commit from the first changed row on gets a new hash. */
export function pushedRewritten(pushed: number, analysis: Analysis): number {
  return analysis.changed ? Math.max(0, pushed - analysis.firstChanged) : 0
}

// --- where an interactive rebase can start (graph context menus) -------------------

export interface RebaseTarget {
  /** Base to pass to the rebase view; null when it cannot start */
  base: string | null
  /** Why not, as a short parenthetical for the menu label */
  reason: string | null
}

const no = (reason: string): RebaseTarget => ({ base: null, reason })

function preconditions(status: Status | null): string | null {
  if (!status?.head) return 'no commits yet'
  if (status.inProgress) return `a ${status.inProgress} is in progress`
  if (!status.branch) return 'HEAD is detached: check out a branch first'
  return null
}

/**
 * Walks first parents from HEAD looking for `hash`. The range must be linear:
 * a merge commit on the way (or `hash` not being an ancestor) stops it.
 */
function findOnBranch(
  hash: string,
  commits: readonly Commit[],
  status: Status
): { commit: Commit; isHead: boolean } | { reason: string } {
  const byHash = new Map(commits.map((c) => [c.hash, c]))
  const branch = status.branch ?? 'HEAD'
  let cur = byHash.get(status.head ?? '')
  while (cur) {
    if (cur.hash === hash) return { commit: cur, isHead: cur.hash === status.head }
    if (cur.parents.length > 1) {
      // Is it an ancestor at all? Then the merge is what is in the way.
      const seen = new Set<string>()
      const queue = [...cur.parents]
      while (queue.length) {
        const h = queue.pop()!
        if (h === hash) return { reason: `there is a merge commit between it and ${branch}` }
        if (seen.has(h)) continue
        seen.add(h)
        queue.push(...(byHash.get(h)?.parents ?? []))
      }
      break
    }
    cur = cur.parents[0] ? byHash.get(cur.parents[0]) : undefined
  }
  return { reason: `not an ancestor of ${branch}` }
}

/** "Interactive rebase from here": the clicked commit is the oldest one included. */
export function rebaseFromCommit(commit: Commit, commits: readonly Commit[], status: Status | null): RebaseTarget {
  const blocked = preconditions(status)
  if (blocked) return no(blocked)
  if (commit.parents.length > 1) return no('it is a merge commit')
  const found = findOnBranch(commit.hash, commits, status!)
  if ('reason' in found) return no(found.reason)
  if (commit.parents.length === 0) return no('the root commit cannot be included')
  return { base: commit.parents[0]!, reason: null }
}

/** "Interactive rebase <branch> onto <X>": every commit of the branch after `hash`. */
export function rebaseOnto(hash: string, commits: readonly Commit[], status: Status | null): RebaseTarget {
  const blocked = preconditions(status)
  if (blocked) return no(blocked)
  const found = findOnBranch(hash, commits, status!)
  if ('reason' in found) return no(found.reason)
  if (found.isHead) return no('no commits to rebase')
  return { base: hash, reason: null }
}
