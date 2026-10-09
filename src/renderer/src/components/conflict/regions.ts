// Conflict regions of a file, computed from its three versions (base / ours /
// theirs) and cross-checked against the conflict markers git wrote to disk.
// Pure module: no DOM, no React, unit-tested in plain Node.
//
// Lines are kept WITH their terminator ("\n", "\r\n", or nothing for an
// unterminated last line), so joining lines back is always byte-exact: CRLF
// files and files without a final newline need no special cases.
import { diffLines } from './lineDiff'

export type Side = 'ours' | 'theirs'

export type Chunk =
  /** Identical on both sides (and in the result) */
  | { kind: 'same'; lines: string[] }
  /** Changed by one side only: git already merged it, nothing to decide. The result takes `from`. */
  | { kind: 'auto'; from: Side; ours: string[]; theirs: string[] }
  /** Both sides changed the same place. `index` counts conflicts from 0. */
  | { kind: 'conflict'; index: number; ours: string[]; theirs: string[]; base: string[] | null }

export type ConflictChunk = Extract<Chunk, { kind: 'conflict' }>

export interface ConflictModel {
  chunks: Chunk[]
  /** Number of conflict chunks */
  conflicts: number
  /**
   * `stages`: regions computed from the three versions (the normal case).
   * `markers`: regions read from the markers of the file on disk, because git
   * merged it differently than our own three-way merge would.
   */
  source: 'stages' | 'markers'
  /** False when the file on disk is not the conflicted merge we expect (edited by hand, markers removed...) */
  diskMatches: boolean
  /** Line ending for the marker lines we generate */
  eol: '\n' | '\r\n'
}

// --- lines ---------------------------------------------------------------------------

/** Splits text into lines that keep their terminator. `'a\nb'` -> `['a\n', 'b']` */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const out: string[] = []
  let start = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', start)) {
    out.push(text.slice(start, i + 1))
    start = i + 1
  }
  if (start < text.length) out.push(text.slice(start))
  return out
}

/** The line without its terminator */
export function lineBody(line: string): string {
  if (line.endsWith('\r\n')) return line.slice(0, -2)
  if (line.endsWith('\n')) return line.slice(0, -1)
  return line
}

export const hasEol = (line: string): boolean => line.endsWith('\n')

export function dominantEol(text: string): '\n' | '\r\n' {
  let crlf = 0
  let lf = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) {
    if (i > 0 && text.charCodeAt(i - 1) === 13) crlf++
    else lf++
  }
  return crlf > lf ? '\r\n' : '\n'
}

// --- conflict markers ------------------------------------------------------------------

export type MarkerKind = 'start' | 'base' | 'sep' | 'end'

/**
 * Classifies a line as a conflict marker. Git writes exactly seven marker
 * characters, then either the end of the line or a space and a label
 * (`=======` never has a label).
 */
export function markerKind(line: string): MarkerKind | null {
  const c = line.charCodeAt(0)
  // '<' 60, '=' 61, '>' 62, '|' 124
  if (c !== 60 && c !== 61 && c !== 62 && c !== 124) return null
  const text = lineBody(line)
  if (text.length < 7) return null
  for (let i = 1; i < 7; i++) if (text.charCodeAt(i) !== c) return null
  if (c === 61) return text.length === 7 ? 'sep' : null
  if (text.length > 7 && text.charCodeAt(7) !== 32) return null
  return c === 60 ? 'start' : c === 62 ? 'end' : 'base'
}

/** True when `text` still contains a line that looks like a conflict marker */
export function hasConflictMarkers(text: string): boolean {
  return firstMarkerLine(text) !== -1
}

/** 0-based index of the first conflict-marker line of `text`, or -1 */
export function firstMarkerLine(text: string): number {
  // Cheap pre-check: nearly every text has no run of seven marker characters.
  if (!/[<=>|]{7}/.test(text)) return -1
  const lines = splitLines(text)
  for (let i = 0; i < lines.length; i++) if (markerKind(lines[i]!)) return i
  return -1
}

export type MarkerPart =
  | { kind: 'text'; lines: string[] }
  | { kind: 'conflict'; ours: string[]; base: string[] | null; theirs: string[]; oursLabel: string; theirsLabel: string }

export interface ParsedMarkers {
  parts: MarkerPart[]
  conflicts: number
  /**
   * False when the markers do not form complete `<<<<<<< / ======= / >>>>>>>`
   * blocks (a stray marker, an unterminated block). Whatever could not be
   * understood is kept as plain text, so nothing is ever dropped.
   */
  wellFormed: boolean
}

/**
 * Reads the conflict blocks out of a file with markers, in both styles:
 *
 *     <<<<<<< ours-label          <<<<<<< ours-label
 *     ours                        ours
 *     =======                     ||||||| base-label
 *     theirs                      base
 *     >>>>>>> theirs-label        =======
 *                                 theirs
 *                                 >>>>>>> theirs-label
 *
 * A marker-looking line that cannot be a marker where it stands (a `=======`
 * underline outside a block, a `>>>>>>>` quote...) is ordinary content.
 */
export function parseMarkers(text: string): ParsedMarkers {
  const lines = splitLines(text)
  const parts: MarkerPart[] = []
  let wellFormed = true
  let conflicts = 0
  let plain: string[] = []
  const flush = (): void => {
    if (plain.length) parts.push({ kind: 'text', lines: plain })
    plain = []
  }

  let i = 0
  while (i < lines.length) {
    const line = lines[i]!
    const kind = markerKind(line)
    if (kind !== 'start') {
      // `|||||||`, `=======` and `>>>>>>>` only mean something inside a block.
      // A stray `>>>>>>>` is suspicious (half-deleted block); `=======` alone
      // is too common in real text (Markdown / reST underlines) to complain.
      if (kind === 'end') wellFormed = false
      plain.push(line)
      i++
      continue
    }

    // Try to read one complete block starting at `i`.
    const ours: string[] = []
    const theirs: string[] = []
    let base: string[] | null = null
    let state: 'ours' | 'base' | 'theirs' = 'ours'
    let end = -1
    for (let j = i + 1; j < lines.length; j++) {
      const k = markerKind(lines[j]!)
      if (k === 'start') break // a new block before this one closed: not a block
      if (k === 'base' && state === 'ours') {
        state = 'base'
        base = []
      } else if (k === 'sep' && state !== 'theirs') {
        state = 'theirs'
      } else if (k === 'end' && state === 'theirs') {
        end = j
        break
      } else if (k === 'end') {
        break // `>>>>>>>` before `=======`: not a block
      } else {
        ;(state === 'ours' ? ours : state === 'base' ? base! : theirs).push(lines[j]!)
      }
    }
    if (end < 0) {
      wellFormed = false
      plain.push(line)
      i++
      continue
    }
    flush()
    parts.push({
      kind: 'conflict',
      ours,
      base,
      theirs,
      oursLabel: lineBody(line).slice(8),
      theirsLabel: lineBody(lines[end]!).slice(8)
    })
    conflicts++
    i = end + 1
  }
  flush()
  return { parts, conflicts, wellFormed }
}

/** The file that results from taking one side in every block */
export function resolveMarkers(parsed: ParsedMarkers, side: Side): string {
  let out = ''
  for (const part of parsed.parts) out += (part.kind === 'text' ? part.lines : part[side]).join('')
  return out
}

/**
 * Marker lines for a conflict, the way git writes them. A side whose last
 * line has no terminator (end of file) gets one, like git does, so the next
 * marker starts on its own line.
 */
export function renderMarkers(
  conflict: { ours: readonly string[]; theirs: readonly string[] },
  labels: { ours: string; theirs: string },
  eol: string
): string[] {
  const closed = (lines: readonly string[]): string[] => {
    const out = [...lines]
    const last = out[out.length - 1]
    if (last !== undefined && !hasEol(last)) out[out.length - 1] = last + eol
    return out
  }
  const label = (text: string): string => {
    // A label is one line; keep it short enough to read in the result pane.
    const clean = text.replace(/[\r\n]+/g, ' ').trim()
    return clean ? ` ${clean}` : ''
  }
  return [
    `<<<<<<<${label(labels.ours)}${eol}`,
    ...closed(conflict.ours),
    `=======${eol}`,
    ...closed(conflict.theirs),
    `>>>>>>>${label(labels.theirs)}${eol}`
  ]
}

// --- three-way merge -------------------------------------------------------------------

/** One entry of the merge list (xdiff's `xdmerge_t`). Modes: 0 conflict, 1 ours changed, 2 theirs changed, 4 identical */
interface Entry {
  mode: 0 | 1 | 2 | 4
  i0: number
  n0: number
  i1: number
  n1: number
  i2: number
  n2: number
  /** The base range is no longer exact once a conflict has been split or joined */
  exactBase: boolean
}

export interface Merge3Options {
  /** Also join conflicts separated only by lines without letters or digits (what `git merge-file` does; `git merge` does not) */
  joinAcrossPunctuation?: boolean
}

const sameLines = (a: readonly string[], ai: number, b: readonly string[], bi: number, n: number): boolean => {
  for (let k = 0; k < n; k++) if (a[ai + k] !== b[bi + k]) return false
  return true
}

/**
 * Three-way merge of line arrays, following git's `xdl_merge` at its default
 * level ("zealous"): changes of one side merge by themselves; changes of both
 * sides that overlap *or touch* are a conflict, unless identical; each conflict
 * is then narrowed to the lines that really differ between the two sides, and
 * conflicts left with three or fewer common lines between them are joined.
 *
 * `base` empty (add/add) just makes everything that differs a conflict.
 */
export function merge3(
  base: readonly string[],
  ours: readonly string[],
  theirs: readonly string[],
  opts: Merge3Options = {}
): Chunk[] {
  const h1 = diffLines(base, ours)
  const h2 = diffLines(base, theirs)
  const entries: Entry[] = []

  const append = (mode: Entry['mode'], i0: number, n0: number, i1: number, n1: number, i2: number, n2: number): void => {
    const m = entries[entries.length - 1]
    if (m && (i1 <= m.i1 + m.n1 || i2 <= m.i2 + m.n2)) {
      // Touches the previous entry: they become one (a conflict if they were of different kinds).
      if (mode !== m.mode) m.mode = 0
      m.n0 = i0 + n0 - m.i0
      m.n1 = i1 + n1 - m.i1
      m.n2 = i2 + n2 - m.i2
    } else {
      entries.push({ mode, i0, n0, i1, n1, i2, n2, exactBase: true })
    }
  }

  let p = 0
  let q = 0
  while (p < h1.length && q < h2.length) {
    const x1 = h1[p]!
    const x2 = h2[q]!
    if (x1.a + x1.an < x2.a) {
      append(1, x1.a, x1.an, x1.b, x1.bn, x2.b - x2.a + x1.a, x1.an)
      p++
      continue
    }
    if (x2.a + x2.an < x1.a) {
      append(2, x2.a, x2.an, x1.b - x1.a + x2.a, x2.an, x2.b, x2.bn)
      q++
      continue
    }
    const identical = x1.a === x2.a && x1.an === x2.an && x1.bn === x2.bn && sameLines(ours, x1.b, theirs, x2.b, x1.bn)
    if (!identical) {
      const off = x1.a - x2.a
      const ffo = off + x1.an - x2.an
      let i0 = x1.a
      let i1 = x1.b
      let i2 = x2.b
      if (off > 0) {
        i0 -= off
        i1 -= off
      } else {
        i2 += off
      }
      let n0 = x1.a + x1.an - i0
      let n1 = x1.b + x1.bn - i1
      let n2 = x2.b + x2.bn - i2
      if (ffo < 0) {
        n0 -= ffo
        n1 -= ffo
      } else {
        n2 += ffo
      }
      append(0, i0, n0, i1, n1, i2, n2)
    }
    const e1 = x1.a + x1.an
    const e2 = x2.a + x2.an
    if (e1 >= e2) q++
    if (e2 >= e1) p++
  }
  for (; p < h1.length; p++) {
    const x1 = h1[p]!
    append(1, x1.a, x1.an, x1.b, x1.bn, x1.a + theirs.length - base.length, x1.an)
  }
  for (; q < h2.length; q++) {
    const x2 = h2[q]!
    append(2, x2.a, x2.an, x2.a + ours.length - base.length, x2.an, x2.b, x2.bn)
  }

  // Refine: inside a conflict, only the lines that differ between the two
  // sides are in conflict; what they share goes back to common text.
  const refined: Entry[] = []
  for (const m of entries) {
    if (m.mode !== 0 || m.n1 === 0 || m.n2 === 0) {
      refined.push(m)
      continue
    }
    const hunks = diffLines(ours.slice(m.i1, m.i1 + m.n1), theirs.slice(m.i2, m.i2 + m.n2))
    if (hunks.length === 0) {
      refined.push({ ...m, mode: 4 })
      continue
    }
    const whole = hunks.length === 1 && hunks[0]!.an === m.n1 && hunks[0]!.bn === m.n2
    for (const h of hunks) {
      refined.push({ mode: 0, i0: m.i0, n0: m.n0, i1: m.i1 + h.a, n1: h.an, i2: m.i2 + h.b, n2: h.bn, exactBase: whole })
    }
  }

  // Simplify: two conflicts with at most three common lines between them read
  // better (and take no more room) as a single conflict.
  const simplified: Entry[] = []
  for (const next of refined) {
    const m = simplified[simplified.length - 1]
    if (m && m.mode === 0 && next.mode === 0) {
      const begin = m.i1 + m.n1
      const gap = next.i1 - begin
      const join = gap <= 3 || (!!opts.joinAcrossPunctuation && !ours.slice(begin, next.i1).some((l) => /[\p{L}\p{N}]/u.test(l)))
      if (join) {
        m.n1 = next.i1 + next.n1 - m.i1
        m.n2 = next.i2 + next.n2 - m.i2
        m.exactBase = false
        continue
      }
    }
    simplified.push(next)
  }

  // Lay the entries out as chunks; everything between two entries is common.
  const chunks: Chunk[] = []
  let pos1 = 0
  let conflicts = 0
  const same = (upTo: number): void => {
    if (upTo <= pos1) return
    const prev = chunks[chunks.length - 1]
    const lines = ours.slice(pos1, upTo)
    if (prev?.kind === 'same') for (const line of lines) prev.lines.push(line)
    else chunks.push({ kind: 'same', lines })
    pos1 = upTo
  }
  for (const m of simplified) {
    same(m.i1)
    const mine = ours.slice(m.i1, m.i1 + m.n1)
    const yours = theirs.slice(m.i2, m.i2 + m.n2)
    if (m.mode === 4) {
      same(m.i1 + m.n1)
    } else if (m.mode === 0) {
      chunks.push({ kind: 'conflict', index: conflicts++, ours: mine, theirs: yours, base: m.exactBase ? base.slice(m.i0, m.i0 + m.n0) : null })
    } else if (m.n1 > 0 || m.n2 > 0) {
      chunks.push({ kind: 'auto', from: m.mode === 1 ? 'ours' : 'theirs', ours: mine, theirs: yours })
    }
    pos1 = m.i1 + m.n1
  }
  same(ours.length)
  return chunks
}

// --- the model -------------------------------------------------------------------------

/** One side's whole file, rebuilt from the chunks */
export function sideText(chunks: readonly Chunk[], side: Side): string {
  let out = ''
  for (const c of chunks) out += (c.kind === 'same' ? c.lines : c[side]).join('')
  return out
}

/** The merge result when every conflict takes `side` */
export function resolvedText(chunks: readonly Chunk[], side: Side): string {
  let out = ''
  for (const c of chunks) out += (c.kind === 'same' ? c.lines : c.kind === 'auto' ? c[c.from] : c[side]).join('')
  return out
}

/** Ignores line-ending style and one final newline: core.autocrlf changes the first, markers hide the second */
const loose = (text: string): string => text.replace(/\r\n/g, '\n').replace(/\n$/, '')

function fromMarkers(parsed: ParsedMarkers, ours: string, theirs: string): Chunk[] {
  const chunks: Chunk[] = []
  let index = 0
  for (const part of parsed.parts) {
    if (part.kind === 'text') chunks.push({ kind: 'same', lines: part.lines })
    else chunks.push({ kind: 'conflict', index: index++, ours: part.ours, theirs: part.theirs, base: part.base })
  }
  // Markers always sit on their own line, which hides that a side ended
  // without a final newline: restore that from the real files.
  const last = chunks[chunks.length - 1]
  if (last?.kind === 'conflict') {
    const unterminate = (lines: string[], text: string): void => {
      const tail = lines[lines.length - 1]
      if (tail !== undefined && text !== '' && !text.endsWith('\n')) lines[lines.length - 1] = lineBody(tail)
    }
    unterminate(last.ours, ours)
    unterminate(last.theirs, theirs)
  }
  return chunks
}

/**
 * True when `disk` is the chunks written out the way git does: common and
 * merged lines as they are, each conflict between markers (with or without a
 * base section). Lines are compared without their terminators.
 */
function matchesDisk(chunks: readonly Chunk[], disk: readonly string[]): boolean {
  let i = 0
  const take = (lines: readonly string[]): boolean => {
    for (const line of lines) {
      if (i >= disk.length || lineBody(disk[i]!) !== lineBody(line)) return false
      i++
    }
    return true
  }
  const marker = (kind: MarkerKind): boolean => {
    if (i >= disk.length || markerKind(disk[i]!) !== kind) return false
    i++
    return true
  }
  for (const c of chunks) {
    if (c.kind === 'same') {
      if (!take(c.lines)) return false
    } else if (c.kind === 'auto') {
      if (!take(c[c.from])) return false
    } else {
      if (!marker('start') || !take(c.ours)) return false
      if (marker('base')) {
        // The base section is whatever git says it is: skip to the separator
        // (past our own idea of the base first, in case it contains one).
        const at = i
        if (!c.base || !take(c.base) || markerKind(disk[i] ?? '') !== 'sep') {
          for (i = at; i < disk.length && markerKind(disk[i]!) !== 'sep'; i++);
        }
      }
      if (!marker('sep') || !take(c.theirs) || !marker('end')) return false
    }
  }
  return i === disk.length
}

export interface ConflictInput {
  base: string | null
  ours: string
  theirs: string
  /** The file on disk */
  merged: string
}

/**
 * Regions of a conflicted text file.
 *
 * Our own three-way merge of the stages gives the regions and, between them,
 * what each side looks like. The file on disk is git's word on the matter, so
 * it is used as a check: when its markers describe a different merge (custom
 * merge options, a merge driver...), the regions are read from those markers
 * instead, and when it has no usable markers at all the caller is told so.
 */
export function buildModel(input: ConflictInput): ConflictModel {
  const chunks = merge3(splitLines(input.base ?? ''), splitLines(input.ours), splitLines(input.theirs))
  const conflicts = chunks.reduce((n, c) => n + (c.kind === 'conflict' ? 1 : 0), 0)
  const eol = dominantEol(input.merged || input.ours || input.theirs)
  const parsed = parseMarkers(input.merged)

  // 1. The file on disk is exactly our merge written with markers. Checked line
  //    by line rather than by parsing the file, so content that itself contains
  //    marker lines (a text about git, a reST underline) cannot confuse it.
  if (conflicts > 0 && matchesDisk(chunks, splitLines(input.merged))) {
    return { chunks, conflicts, source: 'stages', diskMatches: true, eol }
  }
  if (parsed.conflicts > 0 && parsed.wellFormed) {
    // 2. Same merge, other shape (diff3 style keeps wider conflicts): taking
    //    either side everywhere gives the same two files.
    const agrees =
      loose(resolveMarkers(parsed, 'ours')) === loose(resolvedText(chunks, 'ours')) &&
      loose(resolveMarkers(parsed, 'theirs')) === loose(resolvedText(chunks, 'theirs'))
    if (agrees) return { chunks, conflicts, source: 'stages', diskMatches: true, eol }
    // 3. Git merged it differently: its markers are the truth.
    return {
      chunks: fromMarkers(parsed, input.ours, input.theirs),
      conflicts: parsed.conflicts,
      source: 'markers',
      diskMatches: true,
      eol
    }
  }
  // No usable markers on disk. That is expected only when there is nothing to
  // mark and the file is exactly the clean merge.
  const diskMatches = conflicts === 0 && loose(input.merged) === loose(resolvedText(chunks, 'ours'))
  return { chunks, conflicts, source: 'stages', diskMatches, eol }
}
