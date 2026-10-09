// What the user decided for each conflict, and the result file that follows
// from it. Pure module: no DOM, no React, unit-tested in plain Node.
//
// The result is a sequence of BLOCKS, one per chunk of the model (a stretch of
// common text, an automatically merged change, or a conflict). A block is
// either generated (from the chunk and, for a conflict, its checkboxes) or
// MANUAL: text the user typed in the result pane. That split is what keeps
// hand edits safe: ticking a box regenerates the block of that one conflict and
// nothing else.
import {
  firstMarkerLine,
  hasEol,
  lineBody,
  markerKind,
  renderMarkers,
  splitLines,
  type Chunk,
  type ConflictChunk,
  type ConflictModel,
  type Side
} from './regions'

// --- choices ---------------------------------------------------------------------------

export interface Choice {
  /** Sides that take part in the result, in the order they were first ticked */
  order: readonly Side[]
  /** For each line of the side: is it included? */
  ours: readonly boolean[]
  theirs: readonly boolean[]
  /** Settled as "neither side" */
  none: boolean
}

export type TriState = 'all' | 'some' | 'none'

const fill = (n: number, value: boolean): boolean[] => Array.from({ length: n }, () => value)

export function emptyChoice(conflict: ConflictChunk): Choice {
  return { order: [], ours: fill(conflict.ours.length, false), theirs: fill(conflict.theirs.length, false), none: false }
}

export const isResolved = (choice: Choice): boolean => choice.order.length > 0 || choice.none

/** State of the checkbox of a whole side */
export function sideState(choice: Choice, side: Side): TriState {
  if (!choice.order.includes(side)) return 'none'
  return choice[side].every(Boolean) ? 'all' : 'some'
}

/** Position (1, 2) of the side in the result when both take part, else 0 */
export function sideRank(choice: Choice, side: Side): number {
  return choice.order.length > 1 ? choice.order.indexOf(side) + 1 : 0
}

/** The checkbox of a whole side: all of its lines in, or the side out. */
export function toggleSide(choice: Choice, side: Side): Choice {
  const taking = sideState(choice, side) !== 'all'
  return {
    ...choice,
    order: taking ? [...choice.order.filter((s) => s !== side), side] : choice.order.filter((s) => s !== side),
    [side]: fill(choice[side].length, taking),
    none: false
  }
}

/** The checkbox of one line. A side joins the result with its first line and leaves with its last. */
export function toggleLine(choice: Choice, side: Side, index: number): Choice {
  if (index < 0 || index >= choice[side].length) return choice
  const lines = choice[side].map((v, i) => (i === index ? !v : v))
  const any = lines.some(Boolean)
  const others = choice.order.filter((s) => s !== side)
  const order = !any ? others : choice.order.includes(side) ? choice.order : [...others, side]
  return { ...choice, order, [side]: lines, none: order.length === 0 ? choice.none : false }
}

/** "Neither side": the conflict is settled and contributes nothing. Toggles. */
export function toggleNone(choice: Choice): Choice {
  return { order: [], ours: fill(choice.ours.length, false), theirs: fill(choice.theirs.length, false), none: !choice.none }
}

export function takeSide(conflict: ConflictChunk, side: Side): Choice {
  return toggleSide(emptyChoice(conflict), side)
}

/** The lines a resolved conflict contributes */
export function chosenLines(conflict: ConflictChunk, choice: Choice): string[] {
  const out: string[] = []
  for (const side of choice.order) {
    const picked = choice[side]
    conflict[side].forEach((line, i) => {
      if (picked[i]) out.push(line)
    })
  }
  return out
}

// --- result blocks ---------------------------------------------------------------------

/** Chunk index -> the text the user typed for that block (line breaks are "\n") */
export type ManualEdits = ReadonlyMap<number, string>

export interface Block {
  /** Index of the chunk in `model.chunks` */
  chunk: number
  text: string
  manual: boolean
  /** 0-based line of the result where the block starts */
  line: number
  /** Number of line breaks in `text` */
  breaks: number
}

export interface Labels {
  ours: string
  theirs: string
}

interface Rendered {
  /** As shown in the result pane: every line break is "\n" */
  display: string
  /** With the original line terminators */
  exact: string
}

const staticCache = new WeakMap<Chunk, Rendered>()
const choiceCache = new WeakMap<Choice, Rendered>()

/**
 * Joins lines. Only the last line of a file may lack a terminator, but picked
 * lines can put it in the middle: it then gets one.
 */
function render(lines: readonly string[], eol: string): Rendered {
  let display = ''
  let exact = ''
  const last = lines.length - 1
  for (let i = 0; i <= last; i++) {
    const line = lines[i]!
    if (hasEol(line)) {
      exact += line
      display += lineBody(line) + '\n'
    } else if (i < last) {
      exact += line + eol
      display += line + '\n'
    } else {
      exact += line
      display += line
    }
  }
  return { display, exact }
}

function generated(model: ConflictModel, chunk: Chunk, choice: Choice | undefined, labels: Labels): Rendered {
  if (chunk.kind !== 'conflict') {
    let hit = staticCache.get(chunk)
    if (!hit) staticCache.set(chunk, (hit = render(chunk.kind === 'same' ? chunk.lines : chunk[chunk.from], model.eol)))
    return hit
  }
  const ch = choice ?? emptyChoice(chunk)
  let hit = choiceCache.get(ch)
  if (!hit) {
    const lines = isResolved(ch) ? chosenLines(chunk, ch) : renderMarkers(chunk, labels, model.eol)
    choiceCache.set(ch, (hit = render(lines, model.eol)))
  }
  return hit
}

function countBreaks(text: string): number {
  let n = 0
  for (let i = text.indexOf('\n'); i >= 0; i = text.indexOf('\n', i + 1)) n++
  return n
}

function layout(
  model: ConflictModel,
  choices: readonly Choice[],
  manual: ManualEdits,
  labels: Labels,
  exact: boolean
): Block[] {
  const texts = model.chunks.map((chunk, i) => {
    const typed = manual.get(i)
    if (typed !== undefined) return typed
    const r = generated(model, chunk, chunk.kind === 'conflict' ? choices[chunk.index] : undefined, labels)
    return exact ? r.exact : r.display
  })
  // A generated block that ends without a line break (the unterminated last
  // line of a side) and is not the end of the result needs one.
  const eol = exact ? model.eol : '\n'
  let pending = false
  for (let i = texts.length - 1; i >= 0; i--) {
    const text = texts[i]!
    if (text === '') continue
    if (pending && !manual.has(i) && !text.endsWith('\n')) texts[i] = text + eol
    pending = true
  }
  let line = 0
  return texts.map((text, chunk) => {
    const breaks = countBreaks(text)
    const block: Block = { chunk, text, manual: manual.has(chunk), line, breaks }
    line += breaks
    return block
  })
}

/** The blocks of the result as shown in the result pane (line breaks are "\n") */
export function outputBlocks(model: ConflictModel, choices: readonly Choice[], manual: ManualEdits, labels: Labels): Block[] {
  return layout(model, choices, manual, labels, false)
}

export const joinBlocks = (blocks: readonly Block[]): string => blocks.map((b) => b.text).join('')

/**
 * The text to write to disk. Generated blocks keep the exact line terminators
 * of their lines; hand-edited blocks come from a <textarea> and carry "\n"
 * (the backend restores the file's line-ending style).
 */
export function finalText(model: ConflictModel, choices: readonly Choice[], manual: ManualEdits, labels: Labels): string {
  return joinBlocks(layout(model, choices, manual, labels, true))
}

/**
 * Folds an edit of the result pane into the manual blocks. `blocks` is what
 * the pane showed and `next` what it holds now. The changed span is found by
 * trimming the common prefix and suffix; every block it touches becomes
 * manual. An edit across several blocks leaves the typed text in the first,
 * empties the ones in between and keeps the untouched tail of the last.
 */
export function applyEdit(blocks: readonly Block[], manual: ManualEdits, next: string): ManualEdits {
  const prev = joinBlocks(blocks)
  if (prev === next || blocks.length === 0) return manual
  const max = Math.min(prev.length, next.length)
  let p = 0
  while (p < max && prev.charCodeAt(p) === next.charCodeAt(p)) p++
  let s = 0
  while (s < max - p && prev.charCodeAt(prev.length - 1 - s) === next.charCodeAt(next.length - 1 - s)) s++
  const q = prev.length - s // the edit replaced prev[p, q) ...
  const inserted = next.slice(p, next.length - s) // ... with this

  // Blocks the replaced span overlaps; a pure insertion goes to the block the caret is in.
  let first = -1
  let last = -1
  let start = 0
  const starts: number[] = []
  blocks.forEach((b, i) => {
    starts.push(start)
    const end = start + b.text.length
    const hit = p === q ? start <= p && p < end : start < q && end > p
    if (hit) {
      if (first < 0) first = i
      last = i
    }
    start = end
  })
  if (first < 0) {
    // Insertion at the very end of the text: it belongs to the last block that has text
    // (or to the last block of all when the result is empty).
    first = last = blocks.length - 1
    for (let i = blocks.length - 1; i >= 0; i--) {
      if (blocks[i]!.text !== '') {
        first = last = i
        break
      }
    }
  }

  const out = new Map(manual)
  const head = blocks[first]!.text.slice(0, Math.max(0, p - starts[first]!))
  const tail = blocks[last]!.text.slice(Math.max(0, q - starts[last]!))
  if (first === last) {
    out.set(blocks[first]!.chunk, head + inserted + tail)
  } else {
    out.set(blocks[first]!.chunk, head + inserted)
    for (let i = first + 1; i < last; i++) out.set(blocks[i]!.chunk, '')
    out.set(blocks[last]!.chunk, tail)
  }
  return out
}

// --- progress --------------------------------------------------------------------------

export interface Progress {
  total: number
  resolved: number
  /** For each conflict: settled (by its boxes, or by hand with no markers left) */
  done: boolean[]
  /** 0-based line of the result where the first leftover conflict marker is, or -1 */
  markerLine: number
}

/**
 * How far the resolution is. A conflict edited by hand counts as resolved once
 * its block has no conflict markers left. Generated text is never scanned for
 * markers (a file may legitimately contain `=======` lines); hand-typed text is.
 */
export function progress(model: ConflictModel, choices: readonly Choice[], blocks: readonly Block[]): Progress {
  const done: boolean[] = []
  let markerLine = -1
  for (const block of blocks) {
    const chunk = model.chunks[block.chunk]!
    const leftover = block.manual ? leftoverMarker(block.text, chunk) : -1
    if (chunk.kind === 'conflict') {
      const choice = choices[chunk.index]
      const ok = block.manual ? leftover < 0 : !!choice && isResolved(choice)
      done[chunk.index] = ok
      if (!ok && markerLine < 0) markerLine = block.line + Math.max(0, leftover)
    } else if (leftover >= 0 && markerLine < 0) {
      markerLine = block.line + leftover
    }
  }
  return { total: model.conflicts, resolved: done.filter(Boolean).length, done, markerLine }
}

/**
 * Line of the first conflict marker in hand-edited `text` that the user must
 * have left or typed: marker-looking lines that are part of the chunk's own
 * content (a file about git, a `=======` underline) do not count.
 */
function leftoverMarker(text: string, chunk: Chunk): number {
  if (firstMarkerLine(text) < 0) return -1
  const own = new Map<string, number>()
  const sources = chunk.kind === 'same' ? [chunk.lines] : [chunk.ours, chunk.theirs]
  for (const lines of sources) {
    for (const line of lines) {
      if (markerKind(line)) own.set(lineBody(line), (own.get(lineBody(line)) ?? 0) + 1)
    }
  }
  const lines = splitLines(text)
  for (let i = 0; i < lines.length; i++) {
    if (!markerKind(lines[i]!)) continue
    const body = lineBody(lines[i]!)
    const left = own.get(body) ?? 0
    if (left === 0) return i
    own.set(body, left - 1)
  }
  return -1
}

// --- rows of the two side panes --------------------------------------------------------

export interface PaneLine {
  /** 1-based line number in that side's file */
  no: number
  text: string
  /** Last line of the file, without a final newline */
  noEol: boolean
}

export type PaneRow =
  /** Header of a conflict: the checkboxes of the whole sides */
  | { kind: 'head'; chunk: number; conflict: number }
  | {
      kind: 'line'
      chunk: number
      type: 'same' | 'auto' | 'conflict'
      /** Conflict index, or -1 */
      conflict: number
      /** Side that made the change of an `auto` row */
      from: Side | null
      /** Index of the line inside its chunk (the per-line checkboxes use it) */
      index: number
      ours: PaneLine | null
      theirs: PaneLine | null
    }

export interface PaneRows {
  rows: PaneRow[]
  /** Row of the header of each conflict */
  headRow: number[]
  oursLines: number
  theirsLines: number
  /** Longest line, in characters (sizes the horizontal scroll) */
  maxChars: number
}

/**
 * The two side panes as one list of aligned rows: common lines face each
 * other, and where the sides differ the shorter one is padded, so both panes
 * always have the same height and scroll as one.
 */
export function buildRows(model: ConflictModel): PaneRows {
  const rows: PaneRow[] = []
  const headRow: number[] = []
  let oursNo = 0
  let theirsNo = 0
  let maxChars = 0
  const line = (text: string | undefined, side: Side): PaneLine | null => {
    if (text === undefined) return null
    const body = lineBody(text)
    if (body.length > maxChars) maxChars = body.length
    return { no: side === 'ours' ? ++oursNo : ++theirsNo, text: body, noEol: !hasEol(text) }
  }
  model.chunks.forEach((chunk, c) => {
    if (chunk.kind === 'same') {
      chunk.lines.forEach((text, index) => {
        rows.push({ kind: 'line', chunk: c, type: 'same', conflict: -1, from: null, index, ours: line(text, 'ours'), theirs: line(text, 'theirs') })
      })
      return
    }
    const conflict = chunk.kind === 'conflict' ? chunk.index : -1
    if (chunk.kind === 'conflict') {
      headRow[chunk.index] = rows.length
      rows.push({ kind: 'head', chunk: c, conflict })
    }
    const n = Math.max(chunk.ours.length, chunk.theirs.length)
    for (let index = 0; index < n; index++) {
      rows.push({
        kind: 'line',
        chunk: c,
        type: chunk.kind,
        conflict,
        from: chunk.kind === 'auto' ? chunk.from : null,
        index,
        ours: line(chunk.ours[index], 'ours'),
        theirs: line(chunk.theirs[index], 'theirs')
      })
    }
  })
  return { rows, headRow, oursLines: oursNo, theirsLines: theirsNo, maxChars }
}
