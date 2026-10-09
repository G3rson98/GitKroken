// Turns a parsed file diff into the flat list of rows each view mode renders,
// plus the geometry helpers the virtual list needs. Pure module.
import type { DiffFile, DiffHunk, DiffLine } from './parseDiff'

export type ViewMode = 'hunk' | 'inline' | 'split'

export type DiffRow =
  /** Hunk view: header bar with the hunk range and its actions */
  | { kind: 'hunk'; hunkIndex: number; hunk: DiffHunk }
  /** Inline / split view: thin separator standing for the unchanged lines not in the diff */
  | { kind: 'gap'; hunkIndex: number; hunk: DiffHunk; skipped: number }
  /** Unified line; `pair` is the opposite line of a replaced line (for word highlight) */
  | { kind: 'line'; line: DiffLine; pair: DiffLine | null }
  /** Side-by-side line; either side may be empty */
  | { kind: 'split'; left: DiffLine | null; right: DiffLine | null }

export const ROW_HEIGHT: Record<DiffRow['kind'], number> = { hunk: 32, gap: 24, line: 20, split: 20 }

/** Splits hunk lines into context lines and change blocks (removed run + added run). */
function blocks(lines: DiffLine[]): Array<{ context: DiffLine } | { dels: DiffLine[]; adds: DiffLine[] }> {
  const out: Array<{ context: DiffLine } | { dels: DiffLine[]; adds: DiffLine[] }> = []
  let i = 0
  while (i < lines.length) {
    if (lines[i].type === 'context') {
      out.push({ context: lines[i++] })
      continue
    }
    const dels: DiffLine[] = []
    const adds: DiffLine[] = []
    while (i < lines.length && lines[i].type === 'del') dels.push(lines[i++])
    while (i < lines.length && lines[i].type === 'add') adds.push(lines[i++])
    out.push({ dels, adds })
  }
  return out
}

/** Number of unchanged old-file lines hidden right before hunk `index`. */
export function skippedBefore(hunks: DiffHunk[], index: number): number {
  const h = hunks[index]
  const begin = h.oldLines > 0 ? h.oldStart : h.oldStart + 1
  const prev = hunks[index - 1]
  const prevEnd = !prev ? 1 : prev.oldLines > 0 ? prev.oldStart + prev.oldLines : prev.oldStart + 1
  return Math.max(0, begin - prevEnd)
}

export function buildRows(file: DiffFile, mode: ViewMode): DiffRow[] {
  const rows: DiffRow[] = []
  file.hunks.forEach((hunk, hunkIndex) => {
    if (mode === 'hunk') {
      rows.push({ kind: 'hunk', hunkIndex, hunk })
    } else {
      const skipped = skippedBefore(file.hunks, hunkIndex)
      if (skipped > 0) rows.push({ kind: 'gap', hunkIndex, hunk, skipped })
    }
    for (const b of blocks(hunk.lines)) {
      if ('context' in b) {
        rows.push(
          mode === 'split'
            ? { kind: 'split', left: b.context, right: b.context }
            : { kind: 'line', line: b.context, pair: null }
        )
      } else if (mode === 'split') {
        const n = Math.max(b.dels.length, b.adds.length)
        for (let i = 0; i < n; i++) rows.push({ kind: 'split', left: b.dels[i] ?? null, right: b.adds[i] ?? null })
      } else {
        b.dels.forEach((line, i) => rows.push({ kind: 'line', line, pair: b.adds[i] ?? null }))
        b.adds.forEach((line, i) => rows.push({ kind: 'line', line, pair: b.dels[i] ?? null }))
      }
    }
  })
  return rows
}

/** Prefix sums of the row heights: `offsets[i]` is the top of row i, `offsets[n]` the total height. */
export function rowOffsets(rows: DiffRow[]): number[] {
  const offsets = new Array<number>(rows.length + 1)
  let y = 0
  for (let i = 0; i < rows.length; i++) {
    offsets[i] = y
    y += ROW_HEIGHT[rows[i].kind]
  }
  offsets[rows.length] = y
  return offsets
}

/** Index of the row containing vertical position `y` (clamped). */
export function rowAt(offsets: number[], y: number): number {
  const n = offsets.length - 1
  if (n <= 0) return 0
  let lo = 0
  let hi = n - 1
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (offsets[mid] <= y) lo = mid
    else hi = mid - 1
  }
  return lo
}

/**
 * Rows to render for a viewport, snapped to `chunk` so that scrolling by a
 * few pixels does not change the window (and so does not re-render).
 */
export function visibleRange(
  offsets: number[],
  scrollTop: number,
  viewport: number,
  overscan = 30,
  chunk = 20
): { start: number; end: number } {
  const n = offsets.length - 1
  if (n <= 0) return { start: 0, end: 0 }
  const first = rowAt(offsets, Math.max(0, scrollTop))
  const last = rowAt(offsets, Math.max(0, scrollTop + viewport))
  const start = Math.max(0, Math.floor((first - overscan) / chunk) * chunk)
  const end = Math.min(n, Math.ceil((last + 1 + overscan) / chunk) * chunk)
  return { start, end }
}

/** Display width of a line in monospace cells, with tabs expanded. */
export function displayWidth(text: string, tabSize = 4): number {
  if (!text.includes('\t')) return text.length
  let col = 0
  for (let i = 0; i < text.length; i++) col += text[i] === '\t' ? tabSize - (col % tabSize) : 1
  return col
}

/** Longest line per side, in monospace cells (capped), to size the horizontal scroll area. */
export function maxWidths(file: DiffFile, cap = 5000): { old: number; new: number; all: number } {
  let o = 0
  let n = 0
  for (const h of file.hunks) {
    for (const l of h.lines) {
      const w = Math.min(cap, displayWidth(l.text))
      if (l.type !== 'add' && w > o) o = w
      if (l.type !== 'del' && w > n) n = w
    }
  }
  return { old: o, new: n, all: Math.max(o, n) }
}
