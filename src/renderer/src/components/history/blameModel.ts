// Pure helpers of the blame view: grouping lines into blocks and ranking
// commits by age. No DOM / React imports: unit-tested in plain Node.
import type { BlameLine } from '@shared/types'

/**
 * What the backend really sends for each line. `path` and `previous` are not
 * in the shared `BlameLine` contract yet, so they are read as optional extras.
 */
export interface BlameLineX extends BlameLine {
  /** Name the file had in the commit the line comes from */
  path?: string
  /** Commit and path to blame to see the file "before this commit" */
  previous?: { hash: string; path: string }
}

/** Lines that only exist in the working tree come with an all-zero hash */
export const isUncommitted = (hash: string): boolean => /^0+$/.test(hash)

export interface BlameBlock {
  /** Index (0-based) of the first line of the block */
  start: number
  /** Index one past the last line */
  end: number
  hash: string
}

/** Collapses consecutive lines that come from the same commit into one block. */
export function groupBlame(lines: readonly Pick<BlameLine, 'hash'>[]): BlameBlock[] {
  const blocks: BlameBlock[] = []
  let current: BlameBlock | null = null
  for (let i = 0; i < lines.length; i++) {
    const hash = lines[i].hash
    if (current && current.hash === hash) {
      current.end = i + 1
    } else {
      current = { start: i, end: i + 1, hash }
      blocks.push(current)
    }
  }
  return blocks
}

/** For every line, the index of the block it belongs to. */
export function blockIndex(blocks: readonly BlameBlock[], lineCount: number): Int32Array {
  const out = new Int32Array(lineCount)
  blocks.forEach((b, i) => out.fill(i, b.start, Math.min(b.end, lineCount)))
  return out
}

/**
 * Age of every commit as a number from 0 (the oldest in the file) to 1 (the
 * newest). It is the rank among the distinct commits, not the raw date, so a
 * single very old commit does not flatten everything else into "recent".
 * Uncommitted lines are always 1.
 */
export function commitAges(lines: readonly Pick<BlameLine, 'hash' | 'date'>[]): Map<string, number> {
  const dates = new Map<string, number>()
  for (const l of lines) if (!isUncommitted(l.hash) && !dates.has(l.hash)) dates.set(l.hash, l.date)
  const distinct = [...new Set(dates.values())].sort((a, b) => a - b)
  const rank = new Map(distinct.map((d, i) => [d, distinct.length > 1 ? i / (distinct.length - 1) : 1]))
  const ages = new Map<string, number>()
  for (const [hash, date] of dates) ages.set(hash, rank.get(date) ?? 1)
  for (const l of lines) if (isUncommitted(l.hash)) ages.set(l.hash, 1)
  return ages
}

/** How the header names the revision being blamed: full hashes are abbreviated (`3a2b42b`, `3a2b42b^`) */
export function revLabel(rev: string | undefined): string {
  if (!rev) return 'Working tree'
  return rev.replace(/^[0-9a-f]{40,64}(?=$|[~^])/, (hash) => hash.slice(0, 7))
}

/**
 * Where "blame before this commit" goes for a line: the parent commit and the
 * name the file had there. Null when the commit created the file (there is
 * nothing before it).
 */
export function blameBefore(line: BlameLineX, viewPath: string): { path: string; rev: string } | null {
  if (line.previous) return { path: line.previous.path, rev: line.previous.hash }
  if (isUncommitted(line.hash)) return { path: viewPath, rev: 'HEAD' }
  // `path` always comes with `previous` information: its absence here means
  // the commit introduced the file.
  if (line.path !== undefined) return null
  // A backend that sends the bare contract: best effort, same name at the parent.
  return { path: viewPath, rev: `${line.hash}^` }
}
