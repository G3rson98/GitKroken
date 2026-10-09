// Read-only diff of one file: the Hunk / Inline views of the diff viewer
// without any staging action. Everything that matters comes from
// components/diff (parser, row model, geometry, word diff, syntax colours and
// the `dv-*` styles); only the React shell is local, because DiffView.tsx
// does not export its body.
import { memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { DiffFile, DiffLine } from '../diff/parseDiff'
import { ROW_HEIGHT, buildRows, maxWidths, rowOffsets, visibleRange, type DiffRow } from '../diff/rows'
import { wordDiff, type Segment, type WordDiff } from '../diff/wordDiff'
import { highlightFile, mergeTokens, type Tok, type TokenMap } from '../diff/highlight'
import '../diff/DiffView.css'

export type ReadonlyDiffMode = 'hunk' | 'inline'

/** Longer lines are cut on screen (minified bundles would freeze the layout) */
const MAX_CHARS = 3000
const SIGN: Record<DiffLine['type'], string> = { add: '+', del: '-', context: ' ' }
const clean = (text: string) => (text.endsWith('\r') ? text.slice(0, -1) : text)

/** Syntax colours arrive asynchronously; the diff shows as plain text until then */
function useSyntaxTokens(file: DiffFile, path: string): TokenMap | null {
  const [state, setState] = useState<{ file: DiffFile; tokens: TokenMap } | null>(null)
  useEffect(() => {
    let alive = true
    highlightFile(file, path)
      .then((tokens) => alive && tokens && setState({ file, tokens }))
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [file, path])
  return state && state.file === file ? state.tokens : null
}

export function ReadonlyDiff({ file, mode, path }: { file: DiffFile; mode: ReadonlyDiffMode; path: string }) {
  const rows = useMemo(() => buildRows(file, mode), [file, mode])
  const offsets = useMemo(() => rowOffsets(rows), [rows])
  const widths = useMemo(() => maxWidths(file, MAX_CHARS + 24), [file])
  const digits = useMemo(() => {
    const last = file.hunks[file.hunks.length - 1]
    const max = last ? Math.max(last.oldStart + last.oldLines, last.newStart + last.newLines) : 0
    return Math.max(3, String(max).length)
  }, [file])
  const tokens = useSyntaxTokens(file, path)

  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState(() => visibleRange(offsets, 0, 800))
  const [paneWidth, setPaneWidth] = useState(0)

  const update = useCallback(() => {
    const el = ref.current
    if (!el) return
    const next = visibleRange(offsets, el.scrollTop, el.clientHeight)
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
  }, [offsets])

  // A new file or mode: whole-file views open on the first change, not on line 1
  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    let top = 0
    if (mode !== 'hunk') {
      const index = rows.findIndex((r) => r.kind === 'line' && r.line.type !== 'context')
      if (index > 0) top = Math.max(0, offsets[index] - 6 * ROW_HEIGHT.line)
    }
    el.scrollTop = top
    el.scrollLeft = 0
    update()
  }, [rows, offsets, mode, update])

  useEffect(() => {
    const el = ref.current
    if (!el) return
    const measure = () => {
      setPaneWidth(el.clientWidth)
      update()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [update])

  const end = Math.min(range.end, rows.length)
  const start = Math.min(range.start, end)
  const vars = { '--dv-digits': String(digits), '--dv-vw': `${paneWidth}px` } as CSSProperties
  const hunkCount = file.hunks.length

  return (
    <div className={`dv-body dv-unified dv-mode-${mode}`} style={vars}>
      <div className="dv-scroll" ref={ref} onScroll={update}>
        <div
          className="dv-spacer"
          style={{ height: offsets[rows.length], width: `max(100%, calc(${2 * digits + 8 + widths.all}ch + 48px))` }}
        >
          <div className="dv-window" style={{ top: offsets[start] }}>
            {rows.slice(start, end).map((row, i) => (
              <Row key={start + i} row={row} hunkCount={hunkCount} tokens={tokens} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const Row = memo(function Row({ row, hunkCount, tokens }: { row: DiffRow; hunkCount: number; tokens: TokenMap | null }) {
  if (row.kind === 'hunk') {
    return (
      <div className="dv-hunk">
        <div className="dv-sticky">
          <span className="dv-hunk-range">{row.hunk.header.replace(/^(@@+ .*? @@+).*$/, '$1')}</span>
          <span className="dv-hunk-section">{row.hunk.section}</span>
          <span className="dv-spring" />
          <span className="dv-hunk-count">
            Hunk {row.hunkIndex + 1} of {hunkCount}
          </span>
        </div>
      </div>
    )
  }
  if (row.kind === 'gap') {
    return (
      <div className="dv-gap">
        <div className="dv-sticky">
          <span>
            ⋯ {row.skipped} {row.skipped === 1 ? 'unchanged line' : 'unchanged lines'}
          </span>
          {row.hunk.section && <span className="dv-hunk-section">{row.hunk.section}</span>}
        </div>
      </div>
    )
  }
  if (row.kind !== 'line') return null
  const { line } = row
  return (
    <div className={`dv-row dv-${line.type}`}>
      <span className="dv-gutter">
        <span className="dv-num">{line.oldNo ?? ''}</span>
        <span className="dv-num">{line.newNo ?? ''}</span>
        <span className="dv-sign">{SIGN[line.type]}</span>
      </span>
      <Code line={line} pair={row.pair} toks={tokens?.get(line)} />
    </div>
  )
})

// Word-level highlight, computed lazily for the rows on screen and cached per removed line
const wordCache = new WeakMap<DiffLine, { add: DiffLine; diff: WordDiff | null }>()

function segmentsFor(line: DiffLine, pair: DiffLine): Segment[] | null {
  const del = line.type === 'del' ? line : pair
  const add = line.type === 'del' ? pair : line
  if (del.type !== 'del' || add.type !== 'add') return null
  let hit = wordCache.get(del)
  if (!hit || hit.add !== add) {
    hit = { add, diff: wordDiff(clean(del.text), clean(add.text)) }
    wordCache.set(del, hit)
  }
  return hit.diff ? (line === del ? hit.diff.old : hit.diff.new) : null
}

function Code({ line, pair, toks }: { line: DiffLine; pair: DiffLine | null; toks: Tok[] | undefined }) {
  let text = clean(line.text)
  const cut = text.length > MAX_CHARS ? text.length - MAX_CHARS : 0
  if (cut) text = text.slice(0, MAX_CHARS)
  const segs = !cut && pair ? segmentsFor(line, pair) : null
  const pieces = toks && !cut ? mergeTokens(toks, segs) : null
  return (
    <span className="dv-code">
      {pieces
        ? pieces.map((p, i) =>
            p.changed ? (
              <mark key={i} style={p.color ? { color: p.color } : undefined}>
                {p.text}
              </mark>
            ) : p.color ? (
              <span key={i} style={{ color: p.color }}>
                {p.text}
              </span>
            ) : (
              p.text
            )
          )
        : segs
          ? segs.map((s, i) => (s.changed ? <mark key={i}>{s.text}</mark> : s.text))
          : text}
      {cut > 0 && <span className="dv-aside">… +{cut} characters</span>}
      {line.noNewline && <span className="dv-aside">⊘ no newline at end of file</span>}
    </span>
  )
}
