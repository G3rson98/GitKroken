import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode
} from 'react'
import { GitCommitHorizontal, LoaderCircle } from 'lucide-react'
import type { Commit, Status } from '@shared/types'
import { useStore, WIP } from '../../store'
import { layoutGraph, sameTopology, type GraphLayout, type LayoutCommit } from './layout'
import { graphWidth } from './geometry'
import { buildLabels } from './refLabels'
import { CommitRow, WipRow, type WipCounts } from './GraphRow'
import './graph.css'

const HEAD_H = 26
/** Rows rendered above / below the viewport */
const OVERSCAN = 8
/** The rendered window moves in steps of this many rows */
const CHUNK = 4
/** Ask for the next page when this many rows are left below the viewport */
const LOAD_AHEAD = 40
const COLS_KEY = 'gitkroken.graph.cols'

type ColKey = 'refs' | 'graph' | 'author' | 'date' | 'sha'

interface Cols {
  refs: number
  /** null = fit the graph automatically */
  graph: number | null
  author: number
  date: number
  sha: number
}

const DEFAULT_COLS: Cols = { refs: 160, graph: null, author: 150, date: 150, sha: 74 }
const LIMITS: Record<ColKey, [number, number]> = {
  refs: [70, 480],
  graph: [34, 1200],
  author: [60, 360],
  date: [70, 260],
  sha: [56, 330]
}
const clamp = (v: number, min: number, max: number): number => Math.max(min, Math.min(max, v))

function loadCols(): Cols {
  try {
    const raw = JSON.parse(localStorage.getItem(COLS_KEY) ?? '') as Partial<Record<ColKey, unknown>>
    const num = (k: ColKey): number | null => {
      const v = raw[k]
      return typeof v === 'number' && Number.isFinite(v) ? clamp(v, LIMITS[k][0], LIMITS[k][1]) : null
    }
    return {
      refs: num('refs') ?? DEFAULT_COLS.refs,
      graph: num('graph'),
      author: num('author') ?? DEFAULT_COLS.author,
      date: num('date') ?? DEFAULT_COLS.date,
      sha: num('sha') ?? DEFAULT_COLS.sha
    }
  } catch {
    return DEFAULT_COLS
  }
}

const readRowHeight = (): number =>
  parseFloat(getComputedStyle(document.documentElement).getPropertyValue('--row-h')) || 28

/** Pages loaded around a concurrent change may overlap: keep the first copy. */
function dedupe(commits: Commit[]): Commit[] {
  const seen = new Set<string>()
  for (const c of commits) seen.add(c.hash)
  if (seen.size === commits.length) return commits
  seen.clear()
  return commits.filter((c) => (seen.has(c.hash) ? false : (seen.add(c.hash), true)))
}

function countWip(status: Status | null): WipCounts | null {
  if (!status) return null
  if (status.staged.length + status.unstaged.length + status.conflicted.length === 0) return null
  const byPath = new Map<string, string>()
  for (const f of status.unstaged) byPath.set(f.path, f.status)
  for (const f of status.staged) byPath.set(f.path, f.status)
  for (const f of status.conflicted) byPath.set(f.path, 'conflicted')
  const counts: WipCounts = { modified: 0, added: 0, deleted: 0, conflicted: 0 }
  for (const s of byPath.values()) {
    if (s === 'conflicted') counts.conflicted++
    else if (s === 'added' || s === 'untracked') counts.added++
    else if (s === 'deleted') counts.deleted++
    else counts.modified++
  }
  return counts
}

export function Graph() {
  const activeRepo = useStore((s) => s.activeRepo)
  const rawCommits = useStore((s) => s.commits)
  const refs = useStore((s) => s.refs)
  const remotes = useStore((s) => s.remotes)
  const status = useStore((s) => s.status)
  const selected = useStore((s) => s.selected)
  const hasMore = useStore((s) => s.hasMore)
  const loading = useStore((s) => s.loading)

  const scrollRef = useRef<HTMLDivElement>(null)
  const [rowH] = useState(readRowHeight)
  const [view, setView] = useState({ w: 900, h: 600 })
  const [start, setStart] = useState(0)
  const [cols, setCols] = useState(loadCols)

  // --- data ---------------------------------------------------------------
  const commits = useMemo(() => dedupe(rawCommits), [rawCommits])

  // status is a new object on every refresh: reduce it to stable values
  const wipKey = useMemo(() => {
    const c = countWip(status)
    return c ? `${c.modified},${c.added},${c.deleted},${c.conflicted}` : ''
  }, [status])
  const wip = useMemo<WipCounts | null>(() => {
    if (!wipKey) return null
    const [modified, added, deleted, conflicted] = wipKey.split(',').map(Number)
    return { modified, added, deleted, conflicted }
  }, [wipKey])
  const head = status?.head ?? null
  const detachedHead = status && status.branch === null ? status.head : null
  const offset = wip ? 1 : 0

  const items = useMemo<readonly LayoutCommit[]>(
    () => (wip ? [{ hash: WIP, parents: head ? [head] : [], dashed: true }, ...commits] : commits),
    [commits, wip !== null, head] // eslint-disable-line react-hooks/exhaustive-deps
  )

  // Refreshes hand over brand new arrays even when nothing changed: keep the
  // previous layout (and its row objects, which the memoised rows depend on).
  const layoutCache = useRef<{ items: readonly LayoutCommit[]; layout: GraphLayout } | null>(null)
  const layout = useMemo(() => {
    const prev = layoutCache.current
    const next = prev && sameTopology(prev.items, items) ? prev.layout : layoutGraph(items)
    layoutCache.current = { items, layout: next }
    return next
  }, [items])

  const labels = useMemo(
    () => buildLabels(refs, remotes.map((r) => r.name), detachedHead),
    [refs, remotes, detachedHead]
  )

  const total = items.length

  // --- columns ------------------------------------------------------------
  const graphW = cols.graph ?? clamp(graphWidth(layout.width), 66, 300)
  const fixed = cols.refs + graphW
  const showAuthor = view.w - fixed - cols.author >= 170
  const showDate = showAuthor && view.w - fixed - cols.author - cols.date >= 190
  const showSha = showDate && view.w - fixed - cols.author - cols.date - cols.sha >= 210
  const template =
    `${cols.refs}px ${graphW}px minmax(60px, 1fr)` +
    (showAuthor ? ` ${cols.author}px` : '') +
    (showDate ? ` ${cols.date}px` : '') +
    (showSha ? ` ${cols.sha}px` : '')

  useEffect(() => {
    localStorage.setItem(COLS_KEY, JSON.stringify(cols))
  }, [cols])

  const startResize = (key: ColKey, dir: 1 | -1) => (e: ReactMouseEvent) => {
    e.preventDefault()
    e.stopPropagation()
    const startX = e.clientX
    const startW = key === 'graph' ? graphW : cols[key]
    const [min, max] = LIMITS[key]
    const handle = e.currentTarget
    handle.classList.add('dragging')
    document.body.style.cursor = 'col-resize'
    const move = (ev: MouseEvent) => {
      const w = clamp(Math.round(startW + dir * (ev.clientX - startX)), min, max)
      setCols((c) => (c[key] === w ? c : { ...c, [key]: w }))
    }
    const up = () => {
      handle.classList.remove('dragging')
      document.body.style.cursor = ''
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  const autoGraph = () => setCols((c) => ({ ...c, graph: null }))

  // --- virtualisation -------------------------------------------------------
  useLayoutEffect(() => {
    const el = scrollRef.current
    if (!el) return
    const measure = () =>
      setView((v) => (v.w === el.clientWidth && v.h === el.clientHeight ? v : { w: el.clientWidth, h: el.clientHeight }))
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  const maybeLoadMore = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const s = useStore.getState()
    if (!s.hasMore || s.loading) return
    if (el.scrollTop + el.clientHeight >= el.scrollHeight - LOAD_AHEAD * rowH) void s.loadMore()
  }, [rowH])

  /** Moves the rendered window to the current scroll position */
  const syncWindow = useCallback(() => {
    const el = scrollRef.current
    if (!el) return
    const first = Math.floor(el.scrollTop / rowH)
    setStart(Math.max(0, Math.floor(first / CHUNK) * CHUNK - OVERSCAN))
  }, [rowH])

  const onScroll = () => {
    syncWindow()
    maybeLoadMore()
  }

  // a page just landed (or the view grew) and the end is still in sight
  useEffect(() => {
    maybeLoadMore()
  }, [maybeLoadMore, commits.length, hasMore, loading, view.h])

  useEffect(() => {
    const el = scrollRef.current
    if (el) el.scrollTop = 0
    setStart(0)
  }, [activeRepo])

  const end = Math.min(total, start + Math.ceil(view.h / rowH) + 2 * OVERSCAN + CHUNK)

  // --- selection --------------------------------------------------------------
  // Bring the selection into view when it changes (keyboard, sidebar, ...), but
  // not on every refresh, so a background fetch never steals the scroll.
  const revealed = useRef<string | null>(null)
  useLayoutEffect(() => {
    if (selected === null) {
      revealed.current = null
      return
    }
    if (revealed.current === selected) return
    const el = scrollRef.current
    const i = layout.index.get(selected)
    if (!el || i === undefined) return // not loaded yet: retry when the layout changes
    revealed.current = selected
    const top = i * rowH
    const visibleH = el.clientHeight - HEAD_H
    if (top < el.scrollTop) {
      el.scrollTop = el.scrollTop - top > visibleH ? Math.max(0, top - (visibleH - rowH) / 2) : top
    } else if (top + rowH > el.scrollTop + visibleH) {
      const minimal = top + rowH - visibleH
      el.scrollTop = minimal - el.scrollTop > visibleH ? top - (visibleH - rowH) / 2 : minimal
    }
    // the scroll event only arrives with the next frame: move the window now
    // so a long jump (End, a branch picked in the sidebar) never paints blank
    syncWindow()
  }, [selected, layout, rowH, syncWindow])

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (e.metaKey || e.ctrlKey || e.altKey || total === 0) return
    const cur = selected !== null ? (layout.index.get(selected) ?? -1) : -1
    const page = Math.max(1, Math.floor((view.h - HEAD_H) / rowH) - 1)
    let next: number
    switch (e.key) {
      case 'ArrowDown':
        next = cur + 1
        break
      case 'ArrowUp':
        next = cur < 0 ? 0 : cur - 1
        break
      case 'PageDown':
        next = cur + page
        break
      case 'PageUp':
        next = cur < 0 ? 0 : cur - page
        break
      case 'Home':
        next = 0
        break
      case 'End':
        next = total - 1
        break
      default:
        return
    }
    e.preventDefault()
    next = clamp(next, 0, total - 1)
    if (next !== cur) useStore.getState().select(items[next].hash)
  }

  // --- render -------------------------------------------------------------------
  const rows: ReactNode[] = []
  for (let i = start; i < end; i++) {
    const row = layout.rows[i]
    if (i < offset) {
      if (wip) rows.push(<WipRow key={WIP} row={row} counts={wip} selected={selected === WIP} top={0} rowH={rowH} />)
      continue
    }
    const commit = commits[i - offset]
    rows.push(
      <CommitRow
        key={commit.hash}
        commit={commit}
        row={row}
        labels={labels.get(commit.hash)}
        selected={selected === commit.hash}
        top={i * rowH}
        rowH={rowH}
      />
    )
  }

  const empty = commits.length === 0
  const rootClass =
    'graph' + (showAuthor ? '' : ' no-author') + (showDate ? '' : ' no-date') + (showSha ? '' : ' no-sha')

  return (
    <div className={rootClass} style={{ '--g-cols': template } as CSSProperties}>
      <div
        ref={scrollRef}
        className="g-scroll"
        tabIndex={0}
        role="grid"
        aria-label="Historial de commits"
        aria-rowcount={total}
        onScroll={onScroll}
        onKeyDown={onKeyDown}
      >
        <div className="g-head" role="row">
          <div className="g-hc">
            <span>Rama / Etiqueta</span>
            <span className="g-rs r" onMouseDown={startResize('refs', 1)} />
          </div>
          <div className="g-hc">
            <span>Grafo</span>
            <span
              className="g-rs r"
              title="Arrastra para redimensionar · doble clic para ajustar al grafo"
              onMouseDown={startResize('graph', 1)}
              onDoubleClick={autoGraph}
            />
          </div>
          <div className="g-hc">
            <span>Mensaje del commit</span>
          </div>
          <div className="g-hc g-c-author">
            <span className="g-rs l" onMouseDown={startResize('author', -1)} />
            <span>Autor</span>
          </div>
          <div className="g-hc g-c-date">
            <span className="g-rs l" onMouseDown={startResize('date', -1)} />
            <span>Fecha</span>
          </div>
          <div className="g-hc g-c-sha">
            <span className="g-rs l" onMouseDown={startResize('sha', -1)} />
            <span>SHA</span>
          </div>
        </div>

        <div className="g-body" style={{ height: total * rowH }}>
          {rows}
        </div>

        {hasMore && !empty && (
          <div className="g-more-row">
            <LoaderCircle size={13} className="g-spin" />
            Cargando más commits…
          </div>
        )}

        {empty && (
          <div className="g-empty">
            {loading ? (
              <>
                <LoaderCircle size={22} className="g-spin" />
                <p>Cargando historial…</p>
              </>
            ) : (
              <>
                <GitCommitHorizontal size={34} strokeWidth={1.5} />
                <h4>Este repositorio aún no tiene commits</h4>
                <p>
                  {wip
                    ? 'Prepara tus cambios y crea el primer commit: aparecerá aquí.'
                    : 'Añade archivos y crea el primer commit: el historial aparecerá aquí.'}
                </p>
              </>
            )}
          </div>
        )}
      </div>

      <div className={`g-loading${loading && !empty ? ' on' : ''}`} aria-hidden="true">
        <i />
      </div>
    </div>
  )
}
