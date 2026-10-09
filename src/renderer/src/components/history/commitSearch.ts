// Pure helpers of the commit search of the graph: the matching predicate (the
// same rules as `searchCommits` in the backend), the text ranges to highlight
// and the navigation between matches. Unit-tested in plain Node.
import type { Commit } from '@shared/types'

/** Shortest hexadecimal query that is also tried as a SHA prefix (as in the backend) */
export const MIN_SHA_PREFIX = 4

export type Range = [start: number, end: number]

export interface Matcher {
  /** The query as it is sent to the backend */
  readonly query: string
  /** Lower-case SHA prefix when the query looks like hexadecimal, else null */
  readonly shaPrefix: string | null
  /** True when the message, the author (`Name <email>`) or the start of the SHA matches */
  test(commit: Commit): boolean
  /** Every occurrence of the query in `text`, as [start, end) offsets */
  ranges(text: string): Range[]
  /** Part of a (possibly abbreviated) SHA matched by the query */
  shaRange(sha: string): Range | null
}

const escapeRegExp = (text: string): string => text.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&')

// One string per commit to search in. Fields are joined by line feeds, which a
// query can never contain, so a match cannot straddle two fields.
const haystacks = new WeakMap<Commit, string>()
function haystack(c: Commit): string {
  let h = haystacks.get(c)
  if (h === undefined) {
    h = `${c.subject}\n${c.body}\n${c.author} <${c.email}>`
    haystacks.set(c, h)
  }
  return h
}

/**
 * Builds the matcher for what the user typed, or null when there is nothing
 * to search for. The text is literal (never a regular expression) and case
 * does not matter.
 */
export function createMatcher(raw: string): Matcher | null {
  const query = raw.replace(/[\r\n]+/g, ' ')
  if (query.trim() === '') return null
  const source = escapeRegExp(query)
  const one = new RegExp(source, 'iu')
  const hex = query.trim().toLowerCase()
  const shaPrefix = hex.length >= MIN_SHA_PREFIX && /^[0-9a-f]{1,64}$/.test(hex) ? hex : null

  return {
    query,
    shaPrefix,
    test: (c) => one.test(haystack(c)) || (shaPrefix !== null && c.hash.startsWith(shaPrefix)),
    ranges(text) {
      const out: Range[] = []
      const all = new RegExp(source, 'giu')
      for (let m = all.exec(text); m; m = all.exec(text)) {
        if (m[0].length === 0) break
        out.push([m.index, m.index + m[0].length])
      }
      return out
    },
    shaRange(sha) {
      if (shaPrefix === null) return null
      const shown = sha.toLowerCase()
      const n = Math.min(shown.length, shaPrefix.length)
      return n > 0 && shown.slice(0, n) === shaPrefix.slice(0, n) ? [0, n] : null
    }
  }
}

export interface Segment {
  text: string
  hit: boolean
}

/** Cuts `text` into matched / unmatched pieces (for rendering with <mark>). */
export function splitByRanges(text: string, ranges: readonly Range[]): Segment[] {
  const out: Segment[] = []
  let pos = 0
  for (const [start, end] of ranges) {
    if (start < pos || end <= start) continue
    if (start > pos) out.push({ text: text.slice(pos, start), hit: false })
    out.push({ text: text.slice(start, end), hit: true })
    pos = end
  }
  if (pos < text.length) out.push({ text: text.slice(pos), hit: false })
  return out
}

/** Row of a commit in the graph, or undefined while its page is not loaded */
export type IndexOf = (hash: string) => number | undefined

/**
 * The matches in the order the user walks them: the loaded ones as they appear
 * in the graph, then the ones the backend found further down the history (in
 * the order it returned them).
 */
export function orderMatches(local: readonly string[], remote: readonly string[], indexOf: IndexOf): string[] {
  const seen = new Set<string>()
  const loaded: Array<{ hash: string; row: number }> = []
  const pending: string[] = []
  for (const hash of [...local, ...remote]) {
    if (seen.has(hash)) continue
    seen.add(hash)
    const row = indexOf(hash)
    if (row === undefined) pending.push(hash)
    else loaded.push({ hash, row })
  }
  loaded.sort((a, b) => a.row - b.row)
  return [...loaded.map((m) => m.hash), ...pending]
}

/**
 * The match to go to when the query changes: the first one at or below
 * `fromRow` (so typing does not jump back to the top), else the first one.
 */
export function firstMatchFrom(matches: readonly string[], indexOf: IndexOf, fromRow: number): string | null {
  for (const hash of matches) {
    const row = indexOf(hash)
    if (row === undefined || row >= fromRow) return hash
  }
  return matches[0] ?? null
}

/**
 * Next (`dir` 1) or previous (`dir` -1) match, wrapping around. `selected` is
 * the selected commit and `selectedRow` its row (-1 when there is none): when
 * the selection is not a match itself, the walk starts from its position.
 */
export function stepMatch(
  matches: readonly string[],
  indexOf: IndexOf,
  selected: string | null,
  selectedRow: number,
  dir: 1 | -1
): string | null {
  const n = matches.length
  if (n === 0) return null
  const at = selected === null ? -1 : matches.indexOf(selected)
  if (at >= 0) return matches[(at + dir + n) % n]
  if (dir === 1) {
    for (const hash of matches) {
      const row = indexOf(hash)
      if (row === undefined || row > selectedRow) return hash
    }
    return matches[0]
  }
  for (let i = n - 1; i >= 0; i--) {
    const row = indexOf(matches[i])
    if (row !== undefined && row < selectedRow) return matches[i]
  }
  return matches[n - 1]
}

/** "3 of 27", "27 results", "500+ results", "No results" */
export function countLabel(position: number, total: number, more: boolean): string {
  if (total === 0) return 'No results'
  const all = `${total}${more ? '+' : ''}`
  if (position >= 0) return `${position + 1} of ${all}`
  return total === 1 && !more ? '1 result' : `${all} results`
}
