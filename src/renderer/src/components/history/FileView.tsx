// Centre view "file": a file exactly as it is in one commit, read only, with
// syntax colours. Opened from "View all files" in the commit panel, so it
// works for files the commit did not change. Virtualised like the blame view.
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import { FileText, FileX, History, LoaderCircle, UserSearch, X } from 'lucide-react'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { plural } from '../details/common'
import { displayWidth } from '../diff/rows'
import type { Tok } from '../diff/highlight'
import { highlightLines } from './highlightLines'
import { Notice, PathLabel, errText, useEscape } from './common'
import './history.css'

const ROW_H = 20
const OVERSCAN = 30
const CHUNK = 20
/** Longer lines are cut on screen (minified bundles would freeze the layout) */
const MAX_CHARS = 3000

/** `a\r\nb\n` -> ['a', 'b'] */
export function splitLines(text: string): string[] {
  if (text === '') return []
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()
  return lines.map((l) => (l.endsWith('\r') ? l.slice(0, -1) : l))
}

export function FileView() {
  const repo = useStore((s) => s.activeRepo)
  const view = useStore((s) => s.view)
  if (!repo || view.kind !== 'file') return null
  return <FileAt key={`${repo}\0${view.rev}\0${view.path}`} repo={repo} path={view.path} rev={view.rev} />
}

interface Loaded {
  lines: string[] | null
  missing: boolean
  error: string | null
}

function FileAt({ repo, path, rev }: { repo: string; path: string; rev: string }) {
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  useEffect(() => {
    let cancelled = false
    git.fileAt(repo, path, rev).then(
      (text) => {
        if (!cancelled) setLoaded({ lines: text === null ? null : splitLines(text), missing: text === null, error: null })
      },
      (e) => {
        if (!cancelled) setLoaded({ lines: null, missing: false, error: errText(e) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [repo, path, rev])

  const close = () => useStore.getState().openView({ kind: 'graph' })
  useEscape(close)
  const lines = loaded?.lines ?? null

  return (
    <div className="hv hv-file">
      <div className="hv-header">
        <FileText size={15} className="hv-header-icon" />
        <span className="hv-header-kind">File</span>
        <PathLabel path={path} />
        <span className="hv-badge hv-rev" title={`As it is in commit ${rev}`}>
          {rev.slice(0, 7)}
        </span>
        {lines && <span className="hv-header-info">{plural(lines.length, 'line', 'lines')}</span>}
        <span className="hv-spring" />
        <button
          className="gd-mini-btn"
          title="Who last changed every line"
          onClick={() => useStore.getState().openView({ kind: 'blame', path, rev })}
        >
          <UserSearch size={12} />
          Blame
        </button>
        <button
          className="gd-mini-btn"
          title="Commits that changed this file"
          onClick={() => useStore.getState().openView({ kind: 'fileHistory', path })}
        >
          <History size={12} />
          File History
        </button>
        <button className="gd-icon-btn" title="Close (Esc)" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>

      {!loaded ? (
        <Notice icon={<LoaderCircle size={22} className="hv-spin" />} text="Loading file…" />
      ) : loaded.error ? (
        <Notice icon={<FileX size={34} strokeWidth={1.25} />} text="Could not show the file" detail={loaded.error} error />
      ) : loaded.missing || !lines ? (
        <Notice
          icon={<FileX size={34} strokeWidth={1.25} />}
          text="Not a file in this commit"
          detail="It is a folder or a submodule, or it does not exist in this revision."
        />
      ) : lines.length === 0 ? (
        <Notice icon={<FileText size={34} strokeWidth={1.25} />} text="Empty file" />
      ) : (
        <FileBody lines={lines} path={path} />
      )}
    </div>
  )
}

function FileBody({ lines, path }: { lines: string[]; path: string }) {
  const digits = Math.max(3, String(lines.length).length)
  const maxCols = useMemo(() => {
    let max = 0
    for (const l of lines) {
      const w = l.length > MAX_CHARS ? MAX_CHARS + 24 : displayWidth(l)
      if (w > max) max = w
    }
    return max
  }, [lines])

  // Syntax colours arrive in slices; lines show as plain text until theirs is ready
  const [tokens, setTokens] = useState<ReadonlyArray<Tok[] | undefined> | null>(null)
  const [, setDone] = useState(0)
  useEffect(() => {
    const job = highlightLines(lines, path, (list, done) => {
      setTokens(list)
      setDone(done)
    })
    return () => job.cancel()
  }, [lines, path])

  const ref = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 80 })
  const update = () => {
    const el = ref.current
    if (!el) return
    const first = Math.floor(el.scrollTop / ROW_H)
    const last = Math.ceil((el.scrollTop + el.clientHeight) / ROW_H)
    const start = Math.max(0, Math.floor((first - OVERSCAN) / CHUNK) * CHUNK)
    const end = Math.min(lines.length, Math.ceil((last + OVERSCAN) / CHUNK) * CHUNK)
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }
  const updateRef = useRef(update)
  updateRef.current = update

  useLayoutEffect(() => {
    const el = ref.current
    if (!el) return
    updateRef.current()
    el.focus({ preventScroll: true })
    const ro = new ResizeObserver(() => updateRef.current())
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const end = Math.min(range.end, lines.length)
  const start = Math.min(range.start, end)
  const rows = []
  for (let i = start; i < end; i++) rows.push(<FileRow key={i} lineNo={i + 1} text={lines[i]} toks={tokens?.[i]} />)

  const vars = { '--hv-digits': String(digits) } as CSSProperties
  return (
    <div className="hv-bl-scroll" ref={ref} tabIndex={0} style={vars} onScroll={update}>
      <div className="hv-bl-spacer" style={{ height: lines.length * ROW_H, width: `max(100%, calc(${digits + maxCols}ch + 64px))` }}>
        <div className="hv-bl-window" style={{ top: start * ROW_H }}>
          {rows}
        </div>
      </div>
    </div>
  )
}

const FileRow = memo(function FileRow(props: { lineNo: number; text: string; toks: Tok[] | undefined }) {
  let text = props.text
  const cut = text.length > MAX_CHARS ? text.length - MAX_CHARS : 0
  if (cut) text = text.slice(0, MAX_CHARS)
  return (
    <div className="hv-bl-row">
      <span className="hv-bl-left">
        <span className="hv-bl-num">{props.lineNo}</span>
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
