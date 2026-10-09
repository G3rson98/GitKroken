// Centre-area diff viewer for `selectedFile`: Hunk / Inline / Split views
// over a virtualised list, with per-hunk stage / unstage / discard.
import {
  createContext,
  memo,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties
} from 'react'
import { AlignJustify, Columns2, FileDiff, Rows3, X } from 'lucide-react'
import type { FileChange, FileStatus } from '@shared/types'
import { useStore, type SelectedFile } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog } from '../ui/overlays'
import { STATUS_META, Segmented, StatusIcon, readPref, splitPath, writePref } from '../details/common'
import { findDiffFile, parseDiff, type DiffFile, type DiffLine } from './parseDiff'
import { buildHunkPatch } from './patch'
import { ROW_HEIGHT, buildRows, maxWidths, rowAt, rowOffsets, visibleRange, type DiffRow, type ViewMode } from './rows'
import { wordDiff, type Segment, type WordDiff } from './wordDiff'
import { highlightFile, mergeTokens, type TokenMap } from './highlight'
import './DiffView.css'

const MODES = ['hunk', 'inline', 'split'] as const
const MODE_KEY = 'gitkroken.diffMode'
/** Longer lines are cut on screen (minified bundles would freeze the layout) */
const MAX_CHARS = 3000

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const fileKey = (repo: string | null, f: SelectedFile) =>
  [repo, f.commit ?? (f.staged ? 'staged' : 'unstaged'), f.untracked ? 'u' : '', f.oldPath ?? '', f.path].join('\0')

interface Loaded {
  key: string
  text: string
  error: string | null
}

interface HunkActions {
  side: 'unstaged' | 'staged'
  stage: (hunkIndex: number) => void
  unstage: (hunkIndex: number) => void
  discard: (hunkIndex: number) => void
}

export function DiffView() {
  const repo = useStore((s) => s.activeRepo)
  const sel = useStore((s) => s.selectedFile)
  const status = useStore((s) => s.status)
  const busy = useStore((s) => s.busy !== null)
  const [mode, setModeState] = useState<ViewMode>(() => readPref(MODE_KEY, MODES, 'inline'))
  const [loaded, setLoaded] = useState<Loaded | null>(null)

  const setMode = (m: ViewMode) => {
    setModeState(m)
    writePref(MODE_KEY, m)
  }

  // Hunk view shows only the changes; Inline and Split show the whole file
  const full = mode !== 'hunk'
  const key = sel ? fileKey(repo, sel) + (full ? '\0full' : '') : ''
  const isWip = !!sel && !sel.commit
  // Only working-tree files are refetched when the status changes
  const liveStatus = isWip ? status : null

  useEffect(() => {
    if (!repo || !sel) return
    let cancelled = false
    git
      .diff(repo, {
        path: sel.path,
        oldPath: sel.oldPath,
        commit: sel.commit,
        staged: sel.staged,
        untracked: sel.untracked,
        fullContext: full
      })
      .then(
        (text) => {
          if (cancelled) return
          const next = typeof text === 'string' ? text : ''
          // Same text: keep the old object so nothing re-renders (and scroll stays put)
          setLoaded((prev) => (prev && prev.key === key && prev.text === next && !prev.error ? prev : { key, text: next, error: null }))
        },
        (e) => {
          if (!cancelled) setLoaded({ key, text: '', error: errText(e) })
        }
      )
    return () => {
      cancelled = true
    }
    // `key` covers every field of `sel` and `repo`
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, liveStatus])

  // Follow a working-tree file when it moves between unstaged and staged, and
  // close the view once it has no changes left.
  useEffect(() => {
    if (!sel || sel.commit || !status) return
    const find = (list: FileChange[]) => list.find((f) => f.path === sel.path)
    const unstaged = find(status.unstaged) ?? find(status.conflicted)
    const staged = find(status.staged)
    const here = sel.staged ? staged : unstaged
    const { selectFile } = useStore.getState()
    if (here) {
      const untracked = here.status === 'untracked'
      if (!sel.staged && untracked !== !!sel.untracked) selectFile(toSelection(here, false))
      return
    }
    const other = sel.staged ? unstaged : staged
    selectFile(other ? toSelection(other, !sel.staged) : null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status, key])

  // Escape closes the diff (unless a dialog / menu / text field has the focus)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.modal-backdrop, .ctx-menu')) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      useStore.getState().selectFile(null)
    }
    // Capture phase: runs before the dialog / menu handle (and unmount on) the same Escape
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])

  const current = loaded && loaded.key === key ? loaded : null
  const text = current?.text ?? ''
  const file = useMemo(() => (sel ? findDiffFile(parseDiff(text), sel.path) : null), [text, sel?.path])

  const tokens = useSyntaxTokens(file, sel?.path)

  const conflicted = isWip && !!status?.conflicted.some((f) => f.path === sel?.path)
  const fileRef = useRef(file)
  fileRef.current = file

  const actions = useMemo<HunkActions | null>(() => {
    if (!isWip || !sel || sel.untracked || conflicted) return null
    const { run } = useStore.getState()
    const patch = (i: number, reverse: boolean) => {
      const f = fileRef.current
      if (!f) throw new Error('El diff ya no está disponible')
      return buildHunkPatch(f, i, { reverse })
    }
    return {
      side: sel.staged ? 'staged' : 'unstaged',
      stage: (i) => void run('Stage hunk', (r) => git.applyPatch(r, patch(i, false), { cached: true })),
      unstage: (i) =>
        void run('Unstage hunk', (r) => git.applyPatch(r, patch(i, true), { cached: true, reverse: true })),
      discard: async (i) => {
        const ok = await confirmDialog({
          title: 'Descartar hunk',
          message: `Se perderán los cambios de este bloque en "${sel.path}". Esta acción no se puede deshacer.`,
          confirmLabel: 'Descartar hunk',
          danger: true
        })
        if (ok) void run('Discard hunk', (r) => git.applyPatch(r, patch(i, true), { reverse: true }))
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, isWip, conflicted])

  if (!sel) return null

  const fileStatus: FileStatus = conflicted
    ? 'conflicted'
    : sel.untracked
      ? 'untracked'
      : (file?.status ?? (sel.oldPath ? 'renamed' : 'modified'))
  const canApplyHunks = !!actions && !!file && !file.binary && !file.combined

  return (
    <div className="dv">
      <DiffHeader
        sel={sel}
        file={file}
        status={fileStatus}
        mode={mode}
        setMode={setMode}
        busy={busy}
        isWip={isWip}
        conflicted={conflicted}
      />
      {!current ? (
        <Notice text="Cargando diff…" />
      ) : current.error ? (
        <Notice text="No se pudo cargar el diff" detail={current.error} error />
      ) : !file ? (
        <Notice
          text={sel.untracked ? 'Archivo vacío' : 'No hay diferencias que mostrar'}
          detail={sel.untracked ? undefined : 'El archivo no tiene cambios de contenido en esta comparación.'}
        />
      ) : file.binary ? (
        <Notice text="Archivo binario" detail="No se puede mostrar el diff de un archivo binario." />
      ) : file.hunks.length === 0 ? (
        <Notice text={emptyReason(file)} />
      ) : (
        <SyntaxCtx.Provider value={tokens}>
          <DiffBody key={key} file={file} mode={mode} actions={canApplyHunks && !full ? actions : null} busy={busy} />
        </SyntaxCtx.Provider>
      )}
    </div>
  )
}

// Syntax colours arrive asynchronously; the diff shows as plain text until then
const SyntaxCtx = createContext<TokenMap | null>(null)

function useSyntaxTokens(file: DiffFile | null, path: string | undefined): TokenMap | null {
  const [state, setState] = useState<{ file: DiffFile; tokens: TokenMap } | null>(null)
  useEffect(() => {
    if (!file || !path) return
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

function toSelection(f: FileChange, staged: boolean): SelectedFile {
  const out: SelectedFile = { path: f.path, staged }
  if (f.oldPath) out.oldPath = f.oldPath
  if (!staged && f.status === 'untracked') out.untracked = true
  return out
}

function emptyReason(file: DiffFile): string {
  if (file.status === 'renamed') return 'Archivo renombrado sin cambios de contenido'
  if (file.status === 'copied') return 'Archivo copiado sin cambios de contenido'
  if (file.oldMode && file.newMode && file.oldMode !== file.newMode) {
    return `Solo cambió el modo del archivo (${file.oldMode} → ${file.newMode})`
  }
  if (file.status === 'added') return 'Archivo vacío'
  if (file.status === 'deleted') return 'Se eliminó un archivo vacío'
  return 'No hay diferencias que mostrar'
}

function Notice(props: { text: string; detail?: string; error?: boolean }) {
  return (
    <div className={`dv-notice${props.error ? ' error' : ''}`}>
      <FileDiff size={34} strokeWidth={1.25} />
      <div className="dv-notice-title">{props.text}</div>
      {props.detail && <div className="dv-notice-detail">{props.detail}</div>}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Header
// ---------------------------------------------------------------------------

function DiffHeader(props: {
  sel: SelectedFile
  file: DiffFile | null
  status: FileStatus
  mode: ViewMode
  setMode: (m: ViewMode) => void
  busy: boolean
  isWip: boolean
  conflicted: boolean
}) {
  const { sel, file, status, busy } = props
  const [dir, name] = splitPath(sel.path)
  const oldPath = sel.oldPath ?? (file && file.status === 'renamed' ? file.oldPath : null)
  const paths = sel.oldPath ? [sel.path, sel.oldPath] : [sel.path]
  const { run, selectFile } = useStore.getState()

  // A conflicted file already says so in its status badge
  const origin = sel.commit ? `commit ${sel.commit.slice(0, 7)}` : props.conflicted ? null : sel.staged ? 'Staged' : 'Unstaged'

  return (
    <div className="dv-header">
      <StatusIcon status={status} size={14} />
      <div className="dv-path" title={oldPath && oldPath !== sel.path ? `${oldPath} → ${sel.path}` : sel.path}>
        <span className="dv-path-inner">
          {oldPath && oldPath !== sel.path && <span className="dv-path-old">{oldPath} → </span>}
          <span className="dv-path-dir">{dir}</span>
          <span className="dv-path-name">{name}</span>
        </span>
      </div>
      <span className={`dv-badge fs-${status}`}>{STATUS_META[status].label}</span>
      {origin && <span className="dv-badge">{origin}</span>}
      {file && !file.binary && (file.additions > 0 || file.deletions > 0) && (
        <span className="dv-stats">
          <span className="dv-stat-add">+{file.additions}</span>
          <span className="dv-stat-del">−{file.deletions}</span>
        </span>
      )}
      <span className="dv-spring" />
      {props.isWip &&
        (sel.staged ? (
          <button
            className="gd-mini-btn red"
            disabled={busy}
            title="Quitar el archivo completo del stage"
            onClick={() => void run('Unstage', (r) => git.unstage(r, paths))}
          >
            Unstage File
          </button>
        ) : (
          <button
            className="gd-mini-btn green"
            disabled={busy}
            title={props.conflicted ? 'Marcar el conflicto como resuelto' : 'Añadir el archivo completo al stage'}
            onClick={() => void run('Stage', (r) => git.stage(r, [sel.path]))}
          >
            {props.conflicted ? 'Marcar como resuelto' : 'Stage File'}
          </button>
        ))}
      <Segmented
        value={props.mode}
        onChange={props.setMode}
        options={[
          { value: 'hunk', label: 'Hunk', icon: <Rows3 size={12} />, title: 'Solo los bloques modificados' },
          { value: 'inline', label: 'Inline', icon: <AlignJustify size={12} />, title: 'Vista unificada' },
          { value: 'split', label: 'Split', icon: <Columns2 size={12} />, title: 'Antes y después, lado a lado' }
        ]}
      />
      <button className="gd-icon-btn" title="Cerrar (Esc)" aria-label="Cerrar" onClick={() => selectFile(null)}>
        <X size={16} />
      </button>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Body: virtualised rows
// ---------------------------------------------------------------------------

const rowLine = (row: DiffRow): DiffLine | null =>
  row.kind === 'line' ? row.line : row.kind === 'split' ? (row.left ?? row.right) : (row.hunk.lines[0] ?? null)

const rowHasLine = (row: DiffRow, line: DiffLine): boolean =>
  row.kind === 'line' ? row.line === line : row.kind === 'split' ? row.left === line || row.right === line : false

function DiffBody(props: { file: DiffFile; mode: ViewMode; actions: HunkActions | null; busy: boolean }) {
  const { file, mode, actions, busy } = props
  const split = mode === 'split'
  const rows = useMemo(() => buildRows(file, mode), [file, mode])
  const offsets = useMemo(() => rowOffsets(rows), [rows])
  const widths = useMemo(() => maxWidths(file, MAX_CHARS + 24), [file])
  const digits = useMemo(() => {
    const last = file.hunks[file.hunks.length - 1]
    const max = last ? Math.max(last.oldStart + last.oldLines, last.newStart + last.newLines) : 0
    return Math.max(3, String(max).length)
  }, [file])

  const mainRef = useRef<HTMLDivElement>(null)
  const leftRef = useRef<HTMLDivElement>(null)
  const anchor = useRef<DiffLine | null>(null)
  const [range, setRange] = useState(() => visibleRange(offsets, 0, 800))
  const [paneWidth, setPaneWidth] = useState(0)

  const update = useCallback(() => {
    const el = mainRef.current
    if (!el) return
    const next = visibleRange(offsets, el.scrollTop, el.clientHeight)
    setRange((prev) => (prev.start === next.start && prev.end === next.end ? prev : next))
    const top = rows[rowAt(offsets, el.scrollTop)]
    anchor.current = top && el.scrollTop > 0 ? rowLine(top) : null
  }, [offsets, rows])

  // Switching view mode: keep the line that was at the top of the viewport there
  useLayoutEffect(() => {
    const line = anchor.current
    const el = mainRef.current
    if (!el) return
    const index = line ? rows.findIndex((r) => rowHasLine(r, line)) : -1
    if (index >= 0) el.scrollTop = offsets[index]
    // The left pane of the split view is new: start it where the main one is
    if (leftRef.current) {
      leftRef.current.scrollTop = el.scrollTop
      leftRef.current.scrollLeft = el.scrollLeft
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [mode])

  // Whole-file views open on the first change instead of the top of the file
  useLayoutEffect(() => {
    const el = mainRef.current
    if (!el || mode === 'hunk') return
    const changed = (l: DiffLine | null) => !!l && l.type !== 'context'
    const index = rows.findIndex((r) => (r.kind === 'line' ? changed(r.line) : r.kind === 'split' && (changed(r.left) || changed(r.right))))
    if (index > 0) el.scrollTop = Math.max(0, offsets[index] - 6 * ROW_HEIGHT.line)
    if (leftRef.current) leftRef.current.scrollTop = el.scrollTop
    update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  useLayoutEffect(update, [update])

  useEffect(() => {
    const el = mainRef.current
    if (!el) return
    const measure = () => {
      setPaneWidth(el.clientWidth)
      update()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [update, split])

  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null) => {
    if (!from || !to) return
    if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop
    if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft
  }
  const onMainScroll = () => {
    sync(mainRef.current, leftRef.current)
    update()
  }
  const onLeftScroll = () => sync(leftRef.current, mainRef.current)

  const end = Math.min(range.end, rows.length)
  const start = Math.min(range.start, end)
  const slice = rows.slice(start, end)
  const total = offsets[rows.length]
  const vars = { '--dv-digits': String(digits), '--dv-vw': `${paneWidth}px` } as CSSProperties
  const windowStyle: CSSProperties = { top: offsets[start] }
  const hunkCount = file.hunks.length

  if (split) {
    // Same width on both sides so the two panes can scroll horizontally in sync
    const width = `max(100%, calc(${digits + 6 + widths.all}ch + 48px))`
    return (
      <div className="dv-body dv-split" style={vars}>
        <div key="left" className="dv-scroll dv-left" ref={leftRef} onScroll={onLeftScroll}>
          <div className="dv-spacer" style={{ height: total, width }}>
            <div className="dv-window" style={windowStyle}>
              {slice.map((row, i) => (
                <SplitRow key={start + i} row={row} side="left" />
              ))}
            </div>
          </div>
        </div>
        <div key="main" className="dv-scroll dv-right" ref={mainRef} onScroll={onMainScroll}>
          <div className="dv-spacer" style={{ height: total, width }}>
            <div className="dv-window" style={windowStyle}>
              {slice.map((row, i) => (
                <SplitRow key={start + i} row={row} side="right" />
              ))}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className={`dv-body dv-unified dv-mode-${mode}`} style={vars}>
      <div key="main" className="dv-scroll" ref={mainRef} onScroll={update}>
        <div
          className="dv-spacer"
          style={{ height: total, width: `max(100%, calc(${2 * digits + 8 + widths.all}ch + 48px))` }}
        >
          <div className="dv-window" style={windowStyle}>
            {slice.map((row, i) => (
              <UnifiedRow key={start + i} row={row} actions={actions} busy={busy} hunkCount={hunkCount} />
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}

const SIGN: Record<DiffLine['type'], string> = { add: '+', del: '-', context: ' ' }

const UnifiedRow = memo(function UnifiedRow(props: {
  row: DiffRow
  actions: HunkActions | null
  busy: boolean
  hunkCount: number
}) {
  const { row, actions, busy } = props
  if (row.kind === 'hunk') {
    const i = row.hunkIndex
    return (
      <div className="dv-hunk">
        <div className="dv-sticky">
          <span className="dv-hunk-range">{row.hunk.header.replace(/^(@@+ .*? @@+).*$/, '$1')}</span>
          <span className="dv-hunk-section">{row.hunk.section}</span>
          <span className="dv-spring" />
          <span className="dv-hunk-count">
            Hunk {i + 1} de {props.hunkCount}
          </span>
          {actions?.side === 'unstaged' && (
            <>
              <button className="gd-mini-btn red" disabled={busy} onClick={() => actions.discard(i)}>
                Discard Hunk
              </button>
              <button className="gd-mini-btn green" disabled={busy} onClick={() => actions.stage(i)}>
                Stage Hunk
              </button>
            </>
          )}
          {actions?.side === 'staged' && (
            <button className="gd-mini-btn red" disabled={busy} onClick={() => actions.unstage(i)}>
              Unstage Hunk
            </button>
          )}
        </div>
      </div>
    )
  }
  if (row.kind === 'gap') return <GapRow row={row} />
  if (row.kind !== 'line') return null
  const { line } = row
  return (
    <div className={`dv-row dv-${line.type}`}>
      <span className="dv-gutter">
        <span className="dv-num">{line.oldNo ?? ''}</span>
        <span className="dv-num">{line.newNo ?? ''}</span>
        <span className="dv-sign">{SIGN[line.type]}</span>
      </span>
      <Code line={line} pair={row.pair} />
    </div>
  )
})

const SplitRow = memo(function SplitRow({ row, side }: { row: DiffRow; side: 'left' | 'right' }) {
  if (row.kind === 'gap') return <GapRow row={row} quiet={side === 'right'} />
  if (row.kind !== 'split') return null
  const line = side === 'left' ? row.left : row.right
  if (!line) {
    return (
      <div className="dv-row dv-empty">
        <span className="dv-gutter">
          <span className="dv-num" />
          <span className="dv-sign" />
        </span>
      </div>
    )
  }
  const other = side === 'left' ? row.right : row.left
  return (
    <div className={`dv-row dv-${line.type}`}>
      <span className="dv-gutter">
        <span className="dv-num">{(side === 'left' ? line.oldNo : line.newNo) ?? ''}</span>
        <span className="dv-sign">{SIGN[line.type]}</span>
      </span>
      <Code line={line} pair={line.type === 'context' ? null : other} />
    </div>
  )
})

function GapRow({ row, quiet }: { row: Extract<DiffRow, { kind: 'gap' }>; quiet?: boolean }) {
  return (
    <div className="dv-gap">
      <div className="dv-sticky">
        {!quiet && (
          <>
            <span>
              ⋯ {row.skipped} {row.skipped === 1 ? 'línea sin cambios' : 'líneas sin cambios'}
            </span>
            {row.hunk.section && <span className="dv-hunk-section">{row.hunk.section}</span>}
          </>
        )}
      </div>
    </div>
  )
}

// Word-level highlight, computed lazily for the rows on screen and cached per removed line
const wordCache = new WeakMap<DiffLine, { add: DiffLine; diff: WordDiff | null }>()
const clean = (text: string) => (text.endsWith('\r') ? text.slice(0, -1) : text)

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

function Code({ line, pair }: { line: DiffLine; pair: DiffLine | null }) {
  let text = clean(line.text)
  const cut = text.length > MAX_CHARS ? text.length - MAX_CHARS : 0
  if (cut) text = text.slice(0, MAX_CHARS)
  const segs = !cut && pair ? segmentsFor(line, pair) : null
  const toks = useContext(SyntaxCtx)?.get(line)
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
      {cut > 0 && <span className="dv-aside">… +{cut} caracteres</span>}
      {line.noNewline && <span className="dv-aside">⊘ sin salto de línea al final del archivo</span>}
    </span>
  )
}
