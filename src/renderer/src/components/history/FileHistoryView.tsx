// Centre view "history of one file": the commits that touched it on the left
// (following renames, virtualised and paged) and, on the right, what the
// selected commit changed in that file.
import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent
} from 'react'
import { AlignJustify, FileDiff, GitGraph, History, LoaderCircle, Rows3, UserSearch, X } from 'lucide-react'
import type { FileHistoryEntry } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { STATUS_META, Segmented, StatusIcon, copyText, readPref, writePref } from '../details/common'
import { findDiffFile, parseDiff, type DiffFile } from '../diff/parseDiff'
import { rowAt, visibleRange } from '../diff/rows'
import { ReadonlyDiff, type ReadonlyDiffMode } from './ReadonlyDiff'
import { Notice, PathLabel, errText, fullDate, shortRelative, showInGraph, useEscape } from './common'
import './history.css'

/** `oldPath` is not in the shared `FileHistoryEntry` contract yet: read as an optional extra */
type Entry = FileHistoryEntry & { oldPath?: string }

const PAGE = 100
const ROW_H = 46
const ROW_H_RENAMED = 64
/** Ask for the next page when this many pixels are left below the viewport */
const LOAD_AHEAD = 600
const MODES = ['hunk', 'inline'] as const
const MODE_KEY = 'gitkroken.historyDiffMode'
const LIST_W_KEY = 'gitkroken.historyListW'

export function FileHistoryView() {
  const repo = useStore((s) => s.activeRepo)
  const view = useStore((s) => s.view)
  if (!repo || view.kind !== 'fileHistory') return null
  // A different file is a different view: all local state starts over
  return <FileHistory key={`${repo}\0${view.path}`} repo={repo} path={view.path} />
}

/** Previous name of the file for an entry that renamed (or copied) it */
function oldPathOf(entries: readonly Entry[], i: number): string | undefined {
  const e = entries[i]
  if (!e || (e.status !== 'renamed' && e.status !== 'copied')) return undefined
  // without the extra field, the next (older) entry still carries the old name
  const old = e.oldPath ?? entries[i + 1]?.path
  return old && old !== e.path ? old : undefined
}

function FileHistory({ repo, path }: { repo: string; path: string }) {
  // The history is re-read when HEAD moves (a new commit, a checkout...)
  const head = useStore((s) => s.status?.head ?? null)
  const [entries, setEntries] = useState<Entry[] | null>(null)
  const [hasMore, setHasMore] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [selHash, setSelHash] = useState<string | null>(null)
  const [mode, setModeState] = useState<ReadonlyDiffMode>(() => readPref(MODE_KEY, MODES, 'hunk'))
  const [listW, setListW] = useState(() => Math.max(220, Math.min(640, Number(localStorage.getItem(LIST_W_KEY)) || 340)))
  const rootRef = useRef<HTMLDivElement>(null)
  /** Bumped by every (re)load so that late answers of an older one are dropped */
  const seq = useRef(0)
  const count = useRef(0)
  count.current = entries?.length ?? 0

  const setMode = (m: ReadonlyDiffMode) => {
    setModeState(m)
    writePref(MODE_KEY, m)
  }

  useEffect(() => {
    const id = ++seq.current
    // keep what was already paged in when this is a refresh
    const limit = Math.max(PAGE, count.current)
    git.fileHistory(repo, path, { limit }).then(
      (list) => {
        if (id !== seq.current) return
        setEntries(list)
        setHasMore(list.length >= limit)
        setLoadingMore(false)
        setError(null)
        setSelHash((prev) => (prev && list.some((e) => e.commit.hash === prev) ? prev : (list[0]?.commit.hash ?? null)))
      },
      (e) => {
        if (id !== seq.current) return
        setError(errText(e))
        setLoadingMore(false)
      }
    )
  }, [repo, path, head])

  const loadMore = useCallback(() => {
    if (!entries || !hasMore || loadingMore) return
    const id = seq.current
    setLoadingMore(true)
    git.fileHistory(repo, path, { limit: PAGE, skip: entries.length }).then(
      (more) => {
        if (id !== seq.current) return
        setEntries((prev) => {
          const seen = new Set((prev ?? []).map((e) => e.commit.hash))
          return [...(prev ?? []), ...more.filter((e) => !seen.has(e.commit.hash))]
        })
        setHasMore(more.length >= PAGE)
        setLoadingMore(false)
      },
      () => {
        if (id !== seq.current) return
        setHasMore(false)
        setLoadingMore(false)
      }
    )
  }, [entries, hasMore, loadingMore, repo, path])

  const close = () => useStore.getState().openView({ kind: 'graph' })
  useEscape(close)

  useEffect(() => rootRef.current?.focus(), [])

  const selIndex = useMemo(() => (entries && selHash ? entries.findIndex((e) => e.commit.hash === selHash) : -1), [entries, selHash])
  const sel = entries && selIndex >= 0 ? entries[selIndex] : null
  const selOldPath = entries && selIndex >= 0 ? oldPathOf(entries, selIndex) : undefined

  const listRef = useRef<HTMLDivElement>(null)
  const move = (to: number) => {
    if (!entries || entries.length === 0) return
    const next = Math.max(0, Math.min(entries.length - 1, to))
    setSelHash(entries[next].commit.hash)
    if (next >= entries.length - 3) loadMore()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || !entries || entries.length === 0) return
    const t = e.target as HTMLElement
    if (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA') return
    const page = Math.max(1, Math.floor((listRef.current?.clientHeight ?? 400) / ROW_H) - 1)
    const cur = selIndex
    switch (e.key) {
      case 'ArrowDown':
        move(cur + 1)
        break
      case 'ArrowUp':
        move(cur < 0 ? 0 : cur - 1)
        break
      case 'PageDown':
        move(cur + page)
        break
      case 'PageUp':
        move(cur < 0 ? 0 : cur - page)
        break
      case 'Home':
        move(0)
        break
      case 'End':
        move(entries.length - 1)
        break
      case 'Enter':
        if (sel && t.tagName !== 'BUTTON') void showInGraph(sel.commit.hash)
        else return
        break
      default:
        return
    }
    e.preventDefault()
  }

  const startResize = (e: ReactMouseEvent) => {
    e.preventDefault()
    const startX = e.clientX
    const startW = listW
    let last = startW
    const onMove = (ev: MouseEvent) => {
      last = Math.max(220, Math.min(640, startW + ev.clientX - startX))
      setListW(last)
    }
    const up = () => {
      window.removeEventListener('mousemove', onMove)
      window.removeEventListener('mouseup', up)
      writePref(LIST_W_KEY, String(last))
    }
    window.addEventListener('mousemove', onMove)
    window.addEventListener('mouseup', up)
  }

  const openBlame = () => {
    const { openView } = useStore.getState()
    if (!sel) openView({ kind: 'blame', path })
    // a commit that deleted the file has nothing to blame: show it as it was right before
    else if (sel.status === 'deleted') openView({ kind: 'blame', path: sel.path, rev: `${sel.commit.hash}^` })
    else openView({ kind: 'blame', path: sel.path, rev: sel.commit.hash })
  }

  return (
    <div className="hv" ref={rootRef} tabIndex={-1} onKeyDown={onKeyDown}>
      <div className="hv-header">
        <History size={15} className="hv-header-icon" />
        <span className="hv-header-kind">File History</span>
        <PathLabel path={path} />
        {entries && entries.length > 0 && (
          <span className="hv-badge">
            {entries.length}
            {hasMore ? '+' : ''} {entries.length === 1 && !hasMore ? 'commit' : 'commits'}
          </span>
        )}
        <span className="hv-spring" />
        <button
          className="gd-mini-btn"
          disabled={!entries || entries.length === 0}
          title={sel ? `Blame of the file at commit ${sel.commit.hash.slice(0, 7)}` : 'Blame of the file'}
          onClick={openBlame}
        >
          <UserSearch size={12} />
          Blame
        </button>
        <button
          className="gd-mini-btn"
          disabled={!sel}
          title="Select this commit in the graph (Enter)"
          onClick={() => sel && void showInGraph(sel.commit.hash)}
        >
          <GitGraph size={12} />
          View in graph
        </button>
        <button className="gd-icon-btn" title="Close (Esc)" aria-label="Close" onClick={close}>
          <X size={16} />
        </button>
      </div>

      {error && !entries ? (
        <Notice icon={<History size={34} strokeWidth={1.25} />} text="Could not load the file history" detail={error} error />
      ) : !entries ? (
        <Notice icon={<LoaderCircle size={22} className="hv-spin" />} text="Loading file history…" />
      ) : entries.length === 0 ? (
        <Notice
          icon={<History size={34} strokeWidth={1.25} />}
          text="This file has no history"
          detail="No commit has changed this file yet."
        />
      ) : (
        <div className="hv-split">
          <div className="hv-list-pane" style={{ width: listW }}>
            <CommitList
              ref={listRef}
              entries={entries}
              selIndex={selIndex}
              hasMore={hasMore}
              loadingMore={loadingMore}
              onSelect={(i) => setSelHash(entries[i].commit.hash)}
              onOpen={(i) => void showInGraph(entries[i].commit.hash)}
              onNearEnd={loadMore}
            />
          </div>
          <div className="hv-resizer" onMouseDown={startResize} />
          <div className="hv-diff-pane">
            {sel && <DiffPane repo={repo} entry={sel} oldPath={selOldPath} mode={mode} setMode={setMode} />}
          </div>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Commit list
// ---------------------------------------------------------------------------

interface CommitListProps {
  entries: Entry[]
  selIndex: number
  hasMore: boolean
  loadingMore: boolean
  onSelect: (index: number) => void
  onOpen: (index: number) => void
  onNearEnd: () => void
}

const CommitList = forwardRef<HTMLDivElement, CommitListProps>(function CommitList(props, outerRef) {
  const { entries, selIndex, hasMore, loadingMore, onNearEnd } = props
  const innerRef = useRef<HTMLDivElement | null>(null)
  const setRef = (el: HTMLDivElement | null) => {
    innerRef.current = el
    if (typeof outerRef === 'function') outerRef(el)
    else if (outerRef) outerRef.current = el
  }

  const olds = useMemo(() => entries.map((_, i) => oldPathOf(entries, i)), [entries])
  const offsets = useMemo(() => {
    const out = new Array<number>(entries.length + 1)
    let y = 0
    for (let i = 0; i < entries.length; i++) {
      out[i] = y
      y += olds[i] ? ROW_H_RENAMED : ROW_H
    }
    out[entries.length] = y
    return out
  }, [entries, olds])

  const [range, setRange] = useState(() => visibleRange(offsets, 0, 800, 8, 4))

  const update = useCallback(() => {
    const el = innerRef.current
    if (!el) return
    const next = visibleRange(offsets, el.scrollTop, el.clientHeight, 8, 4)
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_AHEAD) onNearEnd()
  }, [offsets, onNearEnd])

  useLayoutEffect(update, [update])
  useEffect(() => {
    const el = innerRef.current
    if (!el) return
    const ro = new ResizeObserver(update)
    ro.observe(el)
    return () => ro.disconnect()
  }, [update])

  // Keep the selection in view when it moves (keyboard)
  const revealed = useRef(-1)
  useLayoutEffect(() => {
    const el = innerRef.current
    if (!el || selIndex < 0 || revealed.current === selIndex) return
    revealed.current = selIndex
    const top = offsets[selIndex]
    const bottom = offsets[selIndex + 1]
    if (top < el.scrollTop) el.scrollTop = top
    else if (bottom > el.scrollTop + el.clientHeight) el.scrollTop = bottom - el.clientHeight
    update()
  }, [selIndex, offsets, update])

  const now = Date.now() / 1000
  const end = Math.min(range.end, entries.length)
  const start = Math.min(range.start, end)
  const rows = []
  for (let i = start; i < end; i++) {
    rows.push(
      <CommitItem
        key={entries[i].commit.hash}
        entry={entries[i]}
        oldPath={olds[i]}
        index={i}
        top={offsets[i]}
        selected={i === selIndex}
        now={now}
        onSelect={props.onSelect}
        onOpen={props.onOpen}
      />
    )
  }

  return (
    <div className="hv-list" ref={setRef} onScroll={update} role="listbox" aria-label="Commits that changed the file">
      <div className="hv-list-body" style={{ height: offsets[entries.length] }}>
        {rows}
      </div>
      {(hasMore || loadingMore) && (
        <div className="hv-list-more">
          <LoaderCircle size={13} className="hv-spin" />
          Loading more commits…
        </div>
      )}
    </div>
  )
})

const CommitItem = memo(function CommitItem(props: {
  entry: Entry
  oldPath: string | undefined
  index: number
  top: number
  selected: boolean
  now: number
  onSelect: (index: number) => void
  onOpen: (index: number) => void
}) {
  const { entry, oldPath } = props
  const c = entry.commit
  return (
    <div
      className={`hv-item${props.selected ? ' selected' : ''}${oldPath ? ' renamed' : ''}`}
      style={{ top: props.top }}
      role="option"
      aria-selected={props.selected}
      title={`${c.subject}\n${c.author} · ${fullDate(c.date)}\n${entry.path}`}
      onClick={() => props.onSelect(props.index)}
      onDoubleClick={() => props.onOpen(props.index)}
    >
      <div className="hv-item-top">
        <StatusIcon status={entry.status} />
        <span className="hv-item-subject">{c.subject || <i className="hv-dim">(no message)</i>}</span>
      </div>
      <div className="hv-item-meta">
        <span className="hv-item-author">{c.author}</span>
        <span className="hv-item-date">{shortRelative(c.date, props.now)}</span>
        <span className="hv-item-sha">{c.hash.slice(0, 7)}</span>
      </div>
      {oldPath && (
        <div className="hv-item-rename" title={`${oldPath} → ${entry.path}`}>
          <span className="hv-item-rename-label">{entry.status === 'copied' ? 'copied from' : 'was'}</span>
          <span className="hv-item-rename-path">{oldPath}</span>
        </div>
      )}
    </div>
  )
})

// ---------------------------------------------------------------------------
// Diff of the selected commit
// ---------------------------------------------------------------------------

// Commits are immutable: the last diffs are kept so that moving up and down is instant
const diffCache = new Map<string, string>()
const DIFF_CACHE_MAX = 40

interface Loaded {
  key: string
  text: string
  error: string | null
}

function DiffPane(props: {
  repo: string
  entry: Entry
  oldPath: string | undefined
  mode: ReadonlyDiffMode
  setMode: (m: ReadonlyDiffMode) => void
}) {
  const { repo, entry, oldPath, mode } = props
  const full = mode !== 'hunk'
  const key = [repo, entry.commit.hash, entry.path, oldPath ?? '', full ? 'full' : ''].join('\0')
  const [loaded, setLoaded] = useState<Loaded | null>(() => (diffCache.has(key) ? { key, text: diffCache.get(key)!, error: null } : null))

  useEffect(() => {
    const hit = diffCache.get(key)
    if (hit !== undefined) {
      setLoaded({ key, text: hit, error: null })
      return
    }
    let cancelled = false
    // A short delay: holding an arrow key must not start one git process per row
    const timer = setTimeout(() => {
      git.diff(repo, { path: entry.path, oldPath, commit: entry.commit.hash, fullContext: full }).then(
        (text) => {
          const value = typeof text === 'string' ? text : ''
          diffCache.set(key, value)
          if (diffCache.size > DIFF_CACHE_MAX) diffCache.delete(diffCache.keys().next().value as string)
          if (!cancelled) setLoaded({ key, text: value, error: null })
        },
        (e) => {
          if (!cancelled) setLoaded({ key, text: '', error: errText(e) })
        }
      )
    }, 60)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `key` covers every input
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])

  const current = loaded && loaded.key === key ? loaded : null
  const file = useMemo<DiffFile | null>(
    () => (current && !current.error ? findDiffFile(parseDiff(current.text), entry.path) : null),
    [current, entry.path]
  )
  const c = entry.commit

  return (
    <div className="dv hv-diff">
      <div className="hv-diff-head">
        <div className="hv-diff-title">
          <span className="hv-diff-subject" title={c.body ? `${c.subject}\n\n${c.body}` : c.subject}>
            {c.subject || '(no message)'}
          </span>
          <span className="hv-diff-meta">
            {c.author} · {fullDate(c.date)}
          </span>
        </div>
        <span className={`dv-badge fs-${entry.status}`}>{STATUS_META[entry.status]?.label ?? entry.status}</span>
        {file && !file.binary && (file.additions > 0 || file.deletions > 0) && (
          <span className="dv-stats">
            <span className="dv-stat-add">+{file.additions}</span>
            <span className="dv-stat-del">−{file.deletions}</span>
          </span>
        )}
        <button className="hv-sha" title="Copy the full SHA" onClick={() => copyText(c.hash, 'SHA')}>
          {c.hash.slice(0, 7)}
        </button>
        <Segmented
          value={mode}
          onChange={props.setMode}
          options={[
            { value: 'hunk', label: 'Hunk', icon: <Rows3 size={12} />, title: 'Only the changed hunks' },
            { value: 'inline', label: 'Inline', icon: <AlignJustify size={12} />, title: 'The whole file' }
          ]}
        />
      </div>
      {!current ? (
        <Notice icon={<LoaderCircle size={22} className="hv-spin" />} text="Loading diff…" />
      ) : current.error ? (
        <Notice icon={<FileDiff size={34} strokeWidth={1.25} />} text="Could not load the diff" detail={current.error} error />
      ) : !file ? (
        <Notice
          icon={<FileDiff size={34} strokeWidth={1.25} />}
          text="No differences to show"
          detail="This commit does not change the content of the file relative to its first parent."
        />
      ) : file.binary ? (
        <Notice icon={<FileDiff size={34} strokeWidth={1.25} />} text="Binary file" detail="The diff of a binary file cannot be shown." />
      ) : file.hunks.length === 0 ? (
        <Notice icon={<FileDiff size={34} strokeWidth={1.25} />} text={emptyReason(file)} />
      ) : (
        <ReadonlyDiff key={key} file={file} mode={mode} path={entry.path} />
      )}
    </div>
  )
}

function emptyReason(file: DiffFile): string {
  if (file.status === 'renamed') return 'File renamed without content changes'
  if (file.status === 'copied') return 'File copied without content changes'
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode) {
    return `Only the file mode changed (${file.oldMode} → ${file.newMode})`
  }
  if (file.status === 'added') return 'Empty file'
  if (file.status === 'deleted') return 'An empty file was deleted'
  return 'No differences to show'
}
