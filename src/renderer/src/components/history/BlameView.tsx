// Centre view "blame": the file with syntax colours and, to its left, who
// last changed every line. Consecutive lines of the same commit share one
// annotation block; the list is virtualised (rows have a fixed height).
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type MouseEvent } from 'react'
import { ArrowLeft, Copy, FileX, GitGraph, History, LoaderCircle, RefreshCw, UserSearch, X } from 'lucide-react'
import type { CommitDetails, Status } from '@shared/types'
import { useStore, WIP } from '../../store'
import { git } from '../../lib/git'
import { copyText, plural } from '../details/common'
import { hueOf, relativeTime } from '../details/commitMessage'
import { initials } from '../graph/refLabels'
import { displayWidth } from '../diff/rows'
import type { Tok } from '../diff/highlight'
import { blameBefore, blockIndex, commitAges, groupBlame, isUncommitted, revLabel, type BlameLineX } from './blameModel'
import { highlightLines } from './highlightLines'
import { Notice, PathLabel, errText, fullDate, shortRelative, showInGraph, useEscape } from './common'
import './history.css'

const ROW_H = 20
const OVERSCAN = 30
const CHUNK = 20
/** Longer lines are cut on screen (minified bundles would freeze the layout) */
const MAX_CHARS = 3000
/** A blame slower than this is not repeated on every refresh of the repository */
const CHEAP_MS = 400

interface Target {
  path: string
  rev?: string
}

/** A revision that can never point anywhere else: its blame can be cached */
const isFixedRev = (rev: string | undefined): boolean => !!rev && /^[0-9a-f]{7,64}([~^]\d*)*$/.test(rev)

export function BlameView() {
  const repo = useStore((s) => s.activeRepo)
  const view = useStore((s) => s.view)
  if (!repo || view.kind !== 'blame') return null
  // Opening another file / revision starts over (including the back stack)
  return <Blame key={`${repo}\0${view.path}\0${view.rev ?? ''}`} repo={repo} path={view.path} rev={view.rev} />
}

interface Loaded {
  key: string
  lines: BlameLineX[] | null
  error: string | null
}

function sameBlame(a: readonly BlameLineX[], b: readonly BlameLineX[]): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    if (a[i].hash !== b[i].hash || a[i].text !== b[i].text || a[i].lineNo !== b[i].lineNo) return false
  }
  return true
}

/** Changes whenever the working-tree state of `path` (or HEAD) changes */
function statusSignature(status: Status | null, path: string): string {
  if (!status) return ''
  const of = (list: Status['staged']) => list.find((f) => f.path === path)?.status ?? '-'
  return [status.head, of(status.staged), of(status.unstaged), of(status.conflicted)].join('|')
}

function Blame({ repo, path, rev }: { repo: string; path: string; rev?: string }) {
  // "Blame before this commit" pushes a target; the back button pops it
  const [stack, setStack] = useState<Target[]>(() => [{ path, rev }])
  const target = stack[stack.length - 1]
  const key = `${repo}\0${target.rev ?? ''}\0${target.path}`
  const fixed = isFixedRev(target.rev)

  const [loaded, setLoaded] = useState<Loaded | null>(null)
  const [reload, setReload] = useState(0)
  const [selLine, setSelLine] = useState<number | null>(null)
  const cache = useRef(new Map<string, BlameLineX[]>())
  const cheap = useRef(false)
  /** Scroll position of the body, saved per stack level when leaving it */
  const scrollNow = useRef(0)
  const savedScroll = useRef<number[]>([])
  const startScroll = useRef(0)

  // What makes a blame stale: nothing for a fixed revision; HEAD for a named
  // one; the file's working state for the working tree (every refresh of the
  // repository when the blame is quick enough to repeat).
  const status = useStore((s) => s.status)
  const live: unknown = fixed ? null : target.rev ? (status?.head ?? null) : cheap.current ? status : statusSignature(status, target.path)

  useEffect(() => {
    const hit = fixed ? cache.current.get(key) : undefined
    if (hit) {
      setLoaded({ key, lines: hit, error: null })
      return
    }
    let cancelled = false
    const t0 = performance.now()
    git.blame(repo, target.path, target.rev).then(
      (lines) => {
        if (cancelled) return
        cheap.current = performance.now() - t0 < CHEAP_MS
        if (fixed) cache.current.set(key, lines)
        // Same content: keep the old object so nothing re-renders (and colours are not recomputed)
        setLoaded((prev) => (prev && prev.key === key && prev.lines && sameBlame(prev.lines, lines) ? prev : { key, lines, error: null }))
      },
      (e) => {
        if (!cancelled) setLoaded({ key, lines: null, error: errText(e) })
      }
    )
    return () => {
      cancelled = true
    }
    // `key` covers repo and target
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, live, reload])

  const current = loaded && loaded.key === key ? loaded : null
  const lines = current?.lines ?? null
  const selected = lines && selLine !== null ? (lines[selLine] ?? null) : null

  const close = () => useStore.getState().openView({ kind: 'graph' })
  useEscape(() => {
    if (selLine !== null) setSelLine(null)
    else close()
  })

  const goBefore = (line: BlameLineX) => {
    const before = blameBefore(line, target.path)
    if (!before) return
    savedScroll.current[stack.length - 1] = scrollNow.current
    startScroll.current = scrollNow.current // roughly the same region of the file
    setSelLine(null)
    setStack([...stack, before])
  }
  const goBack = () => {
    if (stack.length < 2) return
    startScroll.current = savedScroll.current[stack.length - 2] ?? 0
    setSelLine(null)
    setStack(stack.slice(0, -1))
  }

  const summary = useMemo(() => {
    if (!lines) return null
    const commits = new Set<string>()
    for (const l of lines) if (!isUncommitted(l.hash)) commits.add(l.hash)
    return `${plural(lines.length, 'line', 'lines')} · ${plural(commits.size, 'commit', 'commits')}`
  }, [lines])

  return (
    <div className="hv hv-blame">
      <div className="hv-header">
        <UserSearch size={15} className="hv-header-icon" />
        <span className="hv-header-kind">Blame</span>
        <PathLabel path={target.path} />
        <span className="hv-badge hv-rev" title={target.rev ? `Revision: ${target.rev}` : 'Includes uncommitted changes'}>
          {revLabel(target.rev)}
        </span>
        {stack.length > 1 && (
          <button className="gd-mini-btn" title="Back to the previous blame" onClick={goBack}>
            <ArrowLeft size={12} />
            Back
          </button>
        )}
        {summary && <span className="hv-header-info">{summary}</span>}
        <span className="hv-spring" />
        {!fixed && (
          <button className="gd-icon-btn" title="Refresh blame" aria-label="Refresh" onClick={() => setReload((n) => n + 1)}>
            <RefreshCw size={14} />
          </button>
        )}
        <button
          className="gd-mini-btn"
          title="Commits that changed this file"
          onClick={() => useStore.getState().openView({ kind: 'fileHistory', path: target.path })}
        >
          <History size={12} />
          File History
        </button>
        <button className="gd-icon-btn" title="Close (Esc)" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>

      {!current ? (
        <Notice icon={<LoaderCircle size={22} className="hv-spin" />} text="Computing blame…" />
      ) : current.error || !lines ? (
        <Notice icon={<FileX size={34} strokeWidth={1.25} />} text="Could not compute the blame" detail={current.error ?? ''} error>
          {stack.length > 1 && (
            <button className="gd-mini-btn" onClick={goBack}>
              <ArrowLeft size={12} />
              Back to the previous blame
            </button>
          )}
        </Notice>
      ) : lines.length === 0 ? (
        <Notice icon={<FileX size={34} strokeWidth={1.25} />} text="Empty file" detail="There are no lines to attribute to an author." />
      ) : (
        <>
          <BlameBody
            key={key}
            lines={lines}
            path={target.path}
            initialScroll={startScroll.current}
            scrollNow={scrollNow}
            selHash={selected?.hash ?? null}
            onSelect={(i) => setSelLine((prev) => (prev !== null && lines[prev]?.hash === lines[i]?.hash ? null : i))}
          />
          {selected && (
            <BlameDetail
              repo={repo}
              line={selected}
              lineCount={lines.reduce((n, l) => n + (l.hash === selected.hash ? 1 : 0), 0)}
              canGoBefore={blameBefore(selected, target.path) !== null}
              onBefore={() => goBefore(selected)}
              onClose={() => setSelLine(null)}
            />
          )}
        </>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Body: virtualised lines
// ---------------------------------------------------------------------------

function BlameBody(props: {
  lines: BlameLineX[]
  path: string
  initialScroll: number
  scrollNow: { current: number }
  selHash: string | null
  onSelect: (lineIndex: number) => void
}) {
  const { lines, path, selHash } = props
  const blocks = useMemo(() => groupBlame(lines), [lines])
  const blockOf = useMemo(() => blockIndex(blocks, lines.length), [blocks, lines.length])
  const ages = useMemo(() => commitAges(lines), [lines])
  const digits = Math.max(3, String(lines.length).length)
  const maxCols = useMemo(() => {
    let max = 0
    for (const l of lines) {
      const w = l.text.length > MAX_CHARS ? MAX_CHARS + 24 : displayWidth(l.text)
      if (w > max) max = w
    }
    return max
  }, [lines])

  // Syntax colours arrive in slices; lines show as plain text until theirs is ready
  const [tokens, setTokens] = useState<{ list: ReadonlyArray<Tok[] | undefined>; done: number } | null>(null)
  useEffect(() => {
    setTokens(null)
    const job = highlightLines(
      lines.map((l) => l.text),
      path,
      (list, done) => setTokens({ list, done })
    )
    return () => job.cancel()
  }, [lines, path])

  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 80 })
  /** First line in view: it repeats the annotation of a block whose start has scrolled away */
  const [topLine, setTopLine] = useState(0)
  const [hover, setHover] = useState<string | null>(null)

  const update = () => {
    const el = ref.current
    if (!el) return
    props.scrollNow.current = el.scrollTop
    const first = Math.floor(el.scrollTop / ROW_H)
    const last = Math.ceil((el.scrollTop + el.clientHeight) / ROW_H)
    const start = Math.max(0, Math.floor((first - OVERSCAN) / CHUNK) * CHUNK)
    const end = Math.min(lines.length, Math.ceil((last + OVERSCAN) / CHUNK) * CHUNK)
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
    // the first line that is fully in view
    setTopLine(Math.min(Math.ceil(el.scrollTop / ROW_H), Math.max(0, lines.length - 1)))
  }

  const updateRef = useRef(update)
  updateRef.current = update

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    el.scrollTop = props.initialScroll
    updateRef.current()
    el.focus({ preventScroll: true })
    const ro = new ResizeObserver(() => updateRef.current())
    ro.observe(el)
    return () => ro.disconnect()
    // mount only: the component is keyed by what it shows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // The working tree changed under the same view: the number of rows may differ
  useLayoutEffect(() => updateRef.current(), [lines.length])

  const lineOf = (e: MouseEvent): number | null => {
    const cell = (e.target as HTMLElement).closest<HTMLElement>('[data-bl]')
    return cell ? Number(cell.dataset.bl) : null
  }
  const onMouseOver = (e: MouseEvent) => {
    const i = lineOf(e)
    const hash = i === null ? null : (lines[i]?.hash ?? null)
    setHover((prev) => (prev === hash ? prev : hash))
  }
  const onClick = (e: MouseEvent) => {
    const i = lineOf(e)
    if (i !== null) props.onSelect(i)
  }

  const now = Date.now() / 1000
  const end = Math.min(range.end, lines.length)
  const start = Math.min(range.start, end)
  const rows = []
  for (let i = start; i < end; i++) {
    const line = lines[i]
    const block = blocks[blockOf[i]]
    rows.push(
      <BlameRow
        key={i}
        index={i}
        line={line}
        first={block.start === i}
        label={block.start === i || i === topLine}
        odd={blockOf[i] % 2 === 1}
        hl={hover === line.hash}
        sel={selHash === line.hash}
        age={ages.get(line.hash) ?? 1}
        toks={tokens?.list[i]}
        now={now}
      />
    )
  }

  const vars = { '--hv-digits': String(digits) } as CSSProperties
  return (
    <div
      className="hv-bl-scroll"
      ref={ref}
      tabIndex={0}
      style={vars}
      onScroll={update}
      onMouseOver={onMouseOver}
      onMouseLeave={() => setHover(null)}
      onClick={onClick}
    >
      <div
        className="hv-bl-spacer"
        style={{ height: lines.length * ROW_H, width: `max(100%, calc(var(--hv-gutter) + ${digits + maxCols}ch + 64px))` }}
      >
        <div className="hv-bl-window" style={{ top: start * ROW_H }}>
          {rows}
        </div>
      </div>
    </div>
  )
}

const BlameRow = memo(function BlameRow(props: {
  index: number
  line: BlameLineX
  /** First line of its block (draws the separator) */
  first: boolean
  /** Shows the annotation: the first line of the block, or the first one in view */
  label: boolean
  odd: boolean
  hl: boolean
  sel: boolean
  age: number
  toks: Tok[] | undefined
  now: number
}) {
  const { line, first } = props
  const pending = isUncommitted(line.hash)
  const cls =
    'hv-bl-row' +
    (first ? ' first' : '') +
    (props.odd ? ' odd' : '') +
    (props.hl ? ' hl' : '') +
    (props.sel ? ' sel' : '') +
    (pending ? ' pending' : '')
  const title = pending
    ? 'Uncommitted changes\nThese lines do not belong to any commit yet'
    : `${line.summary}\n${line.author} · ${fullDate(line.date)}\n${line.hash.slice(0, 7)}`

  let text = line.text
  const cut = text.length > MAX_CHARS ? text.length - MAX_CHARS : 0
  if (cut) text = text.slice(0, MAX_CHARS)

  return (
    <div className={cls}>
      <span className="hv-bl-left">
        <span
          className="hv-bl-gutter"
          data-bl={props.index}
          title={title}
          style={{ '--hv-age': `${Math.round(props.age * 100)}%` } as CSSProperties}
        >
          <span className="hv-bl-bar" />
          {props.label &&
            (pending ? (
              <span className="hv-bl-summary">Uncommitted changes</span>
            ) : (
              <>
                <span className="hv-bl-author">{line.author}</span>
                <span className="hv-bl-summary">{line.summary}</span>
                <span className="hv-bl-date">{shortRelative(line.date, props.now)}</span>
              </>
            ))}
        </span>
        <span className="hv-bl-num">{line.lineNo}</span>
      </span>
      <span className="hv-bl-code">
        {props.toks && !cut
          ? props.toks.map((t, i) =>
              t.color ? (
                <span key={i} style={{ color: t.color }}>
                  {t.text}
                </span>
              ) : (
                t.text
              )
            )
          : text}
        {cut > 0 && <span className="hv-bl-aside">… +{cut} characters</span>}
      </span>
    </div>
  )
})

// ---------------------------------------------------------------------------
// Details of the clicked block
// ---------------------------------------------------------------------------

// Commits are immutable, so their details can be cached for the session
const detailsCache = new Map<string, CommitDetails>()

function BlameDetail(props: {
  repo: string
  line: BlameLineX
  lineCount: number
  canGoBefore: boolean
  onBefore: () => void
  onClose: () => void
}) {
  const { repo, line } = props
  const pending = isUncommitted(line.hash)
  const key = `${repo}\0${line.hash}`
  const [details, setDetails] = useState<{ key: string; value: CommitDetails } | null>(null)

  useEffect(() => {
    if (pending || detailsCache.has(key)) return
    let cancelled = false
    git.commitDetails(repo, line.hash).then(
      (value) => {
        detailsCache.set(key, value)
        if (detailsCache.size > 200) detailsCache.delete(detailsCache.keys().next().value as string)
        if (!cancelled) setDetails({ key, value })
      },
      () => {
        /* the strip keeps showing what the blame itself knows */
      }
    )
    return () => {
      cancelled = true
    }
  }, [key, pending, repo, line.hash])

  const full = detailsCache.get(key) ?? (details?.key === key ? details.value : null)
  const lineText = plural(props.lineCount, 'line of this file', 'lines of this file')

  if (pending) {
    return (
      <div className="hv-bl-detail pending">
        <div className="hv-bl-detail-main">
          <div className="hv-bl-detail-subject">Uncommitted changes</div>
          <div className="hv-bl-detail-meta">
            {lineText} {props.lineCount === 1 ? 'does' : 'do'} not belong to any commit yet.
          </div>
        </div>
        <div className="hv-bl-detail-actions">
          <button className="gd-mini-btn" onClick={() => useStore.getState().select(WIP)}>
            <GitGraph size={12} />
            View changes in graph
          </button>
          <button className="gd-mini-btn" disabled={!props.canGoBefore} title="Blame of the committed version (HEAD)" onClick={props.onBefore}>
            <History size={12} />
            Blame without these changes
          </button>
          <button className="gd-icon-btn" title="Close details (Esc)" aria-label="Close details" onClick={props.onClose}>
            <X size={14} />
          </button>
        </div>
      </div>
    )
  }

  const email = full?.commit.email ?? ''
  const body = full?.commit.body.trim() ?? ''
  return (
    <div className="hv-bl-detail">
      <span className="hv-bl-avatar" style={{ background: `hsl(${hueOf(email || line.author)} 42% 40%)` }} aria-hidden>
        {initials(line.author)}
      </span>
      <div className="hv-bl-detail-main">
        <div className="hv-bl-detail-subject">{line.summary || '(no message)'}</div>
        {body && <div className="hv-bl-detail-body">{body}</div>}
        <div className="hv-bl-detail-meta">
          <span className="hv-bl-detail-author" title={email}>
            {line.author}
          </span>
          <span>
            {fullDate(line.date)} · {relativeTime(line.date, Date.now() / 1000, 'en')}
          </span>
          <span>{lineText}</span>
          {full && <span>{plural(full.files.length, 'file changed', 'files changed')}</span>}
        </div>
      </div>
      <div className="hv-bl-detail-actions">
        <button className="hv-sha" title="Copy the full SHA" onClick={() => copyText(line.hash, 'SHA')}>
          {line.hash.slice(0, 7)}
          <Copy size={11} />
        </button>
        <button className="gd-mini-btn" title="Select this commit in the graph" onClick={() => void showInGraph(line.hash)}>
          <GitGraph size={12} />
          View commit in graph
        </button>
        <button
          className="gd-mini-btn"
          disabled={!props.canGoBefore}
          title={
            props.canGoBefore
              ? 'Blame of the file as it was right before this commit'
              : 'This commit created the file: there is no earlier version'
          }
          onClick={props.onBefore}
        >
          <History size={12} />
          Blame before this commit
        </button>
        <button className="gd-icon-btn" title="Close details (Esc)" aria-label="Close details" onClick={props.onClose}>
          <X size={14} />
        </button>
      </div>
    </div>
  )
}
