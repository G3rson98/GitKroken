// Centre view "conflict": the merge tool. Two read-only panes (ours / theirs)
// with a checkbox per conflict and per line, and below them the editable
// result. Binary files and delete/modify conflicts get a plain choice instead.
//
// The logic lives in pure modules: regions.ts (what the conflicts are) and
// resolution.ts (what the checkboxes and hand edits make of them).
import {
  memo,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type RefObject
} from 'react'
import {
  Check,
  ChevronDown,
  ChevronUp,
  CircleCheck,
  FileWarning,
  FileX,
  Info,
  LoaderCircle,
  Minus,
  Pencil,
  RotateCcw,
  Save,
  Trash2,
  TriangleAlert,
  X
} from 'lucide-react'
import type { ConflictFile, Status } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog } from '../ui/overlays'
import { plural, splitPath } from '../details/common'
import { buildModel, lineBody, sideText, splitLines, type ConflictChunk, type ConflictModel, type Side } from './regions'
import {
  applyEdit,
  buildRows,
  emptyChoice,
  finalText,
  isResolved,
  joinBlocks,
  outputBlocks,
  progress,
  sideRank,
  sideState,
  takeSide,
  toggleLine,
  toggleNone,
  toggleSide,
  type Block,
  type Choice,
  type ManualEdits,
  type PaneLine,
  type PaneRow,
  type PaneRows,
  type TriState
} from './resolution'
import type { Tok } from '../diff/highlight'
import { highlightLines } from '../history/highlightLines'
import './ConflictEditor.css'

const ROW = 20
const OVERSCAN = 12
/** Longer lines are cut on screen (minified bundles would freeze the layout) */
const MAX_CHARS = 3000
const SPLIT_KEY = 'gitkroken.conflictSplit'

const OPERATION: Record<NonNullable<Status['inProgress']>, string> = {
  merge: 'Merge in progress',
  rebase: 'Rebase in progress',
  'cherry-pick': 'Cherry-pick in progress',
  revert: 'Revert in progress'
}

const SIDE_NAME: Record<Side, string> = { ours: 'Ours', theirs: 'Theirs' }

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Opens the next conflicted file, or goes back to the graph when none is left. */
function leave(path: string): void {
  const { status, openView } = useStore.getState()
  const next = status?.conflicted.find((f) => f.path !== path)
  openView(next ? { kind: 'conflict', path: next.path } : { kind: 'graph' })
}

const close = (): void => useStore.getState().openView({ kind: 'graph' })

// Unsaved work survives a detour to another view (a click on the graph, a diff):
// it is kept per file until it is saved, reset or explicitly discarded.
interface Draft {
  file: ConflictFile
  choices: Choice[]
  manual: ManualEdits
}
const drafts = new Map<string, Draft>()
const sameSource = (a: ConflictFile, b: ConflictFile): boolean =>
  a.base === b.base && a.ours === b.ours && a.theirs === b.theirs && a.merged === b.merged

export function ConflictEditor() {
  const repo = useStore((s) => s.activeRepo)
  const view = useStore((s) => s.view)
  if (!repo || view.kind !== 'conflict') return null
  return <Loader key={`${repo}\0${view.path}`} repo={repo} path={view.path} />
}

function Loader({ repo, path }: { repo: string; path: string }) {
  const [loaded, setLoaded] = useState<{ file: ConflictFile | null; error: string | null } | null>(null)

  useEffect(() => {
    let alive = true
    git.conflictFile(repo, path).then(
      (file) => alive && setLoaded({ file, error: null }),
      (e) => alive && setLoaded({ file: null, error: errText(e) })
    )
    return () => {
      alive = false
    }
  }, [repo, path])

  const file = loaded?.file
  if (file && !file.binary && file.ours !== null && file.theirs !== null) {
    return <TextMerge repo={repo} file={file} ours={file.ours} theirs={file.theirs} />
  }
  return (
    <div className="ce">
      <Header path={path} onClose={close} />
      <CloseOnEscape onClose={close} />
      {!loaded ? (
        <Notice icon={<LoaderCircle size={30} strokeWidth={1.5} className="ce-spin" />} title="Loading conflict…" />
      ) : file ? (
        <SideChoice file={file} />
      ) : (
        <Notice
          icon={<FileX size={34} strokeWidth={1.25} />}
          title="This conflict could not be opened"
          detail={loaded.error ?? undefined}
          error
        >
          <button className="btn" onClick={close}>
            Back to the graph
          </button>
        </Notice>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Shared pieces
// ---------------------------------------------------------------------------

/** Escape closes the view, unless a dialog or a menu is open (it is theirs then). */
function useEscape(onClose: () => void): void {
  const ref = useRef(onClose)
  ref.current = onClose
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.modal-backdrop, .ctx-menu')) return
      e.preventDefault()
      ref.current()
    }
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

function CloseOnEscape({ onClose }: { onClose: () => void }) {
  useEscape(onClose)
  return null
}

function Header(props: { path: string; onClose: () => void; children?: ReactNode }) {
  const op = useStore((s) => s.status?.inProgress ?? null)
  const [dir, name] = splitPath(props.path)
  return (
    <div className="ce-header">
      <span className="ce-header-icon" title="Conflicted file">
        <TriangleAlert size={15} strokeWidth={2.25} />
      </span>
      <div className="ce-path" title={props.path}>
        <span className="ce-path-inner">
          <span className="ce-path-dir">{dir}</span>
          <span className="ce-path-name">{name}</span>
        </span>
      </div>
      <span className="ce-badge">{op ? OPERATION[op] : 'Unmerged changes'}</span>
      {props.children}
      <button className="gd-icon-btn" title="Close (Esc)" aria-label="Close" onClick={props.onClose}>
        <X size={16} />
      </button>
    </div>
  )
}

function Notice(props: { icon: ReactNode; title: string; detail?: string; error?: boolean; children?: ReactNode }) {
  return (
    <div className={`ce-notice${props.error ? ' error' : ''}`}>
      {props.icon}
      <div className="ce-notice-title">{props.title}</div>
      {props.detail && <div className="ce-notice-detail">{props.detail}</div>}
      {props.children}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Binary files and delete/modify conflicts: choose a side
// ---------------------------------------------------------------------------

function SideChoice({ file }: { file: ConflictFile }) {
  const busy = useStore((s) => s.busy !== null)
  const [, name] = splitPath(file.path)
  const hasOurs = file.ours !== null
  const hasTheirs = file.theirs !== null

  const take = async (side: Side): Promise<void> => {
    const removes = side === 'ours' ? !hasOurs : !hasTheirs
    const ok = await useStore
      .getState()
      .run('Resolve conflict', (r) => git.resolveWith(r, file.path, side), removes ? `"${name}" removed` : `"${name}" marked as resolved`)
    if (ok) leave(file.path)
  }

  let title: string
  let detail: string
  if (!hasOurs && !hasTheirs) {
    title = 'Removed on both sides'
    detail = 'Neither side has a file at this path any more (it was deleted or renamed on both). The only resolution is to remove it.'
  } else if (!hasOurs) {
    title = 'Deleted by us, changed by them'
    detail = `${file.oursLabel} deleted this file while ${file.theirsLabel} changed it. Keep their file, or keep it deleted.`
  } else if (!hasTheirs) {
    title = 'Changed by us, deleted by them'
    detail = `${file.oursLabel} changed this file while ${file.theirsLabel} deleted it. Keep our file, or delete it.`
  } else {
    title = 'Binary file'
    detail = 'This file is not text, so it cannot be merged line by line. Choose which version to keep.'
  }

  const option = (side: Side): ReactNode => {
    const exists = side === 'ours' ? hasOurs : hasTheirs
    const label = side === 'ours' ? file.oursLabel : file.theirsLabel
    return (
      <button className={`ce-option ce-${side}${exists ? '' : ' ce-option-delete'}`} disabled={busy} onClick={() => void take(side)}>
        <span className="ce-option-side">
          <span className="ce-side-tag">{SIDE_NAME[side]}</span>
          <span className="ce-option-label" title={label}>
            {label}
          </span>
        </span>
        <span className="ce-option-action">
          {exists ? <Check size={15} /> : <Trash2 size={15} />}
          {exists ? (hasOurs && hasTheirs ? `Take ${side}` : 'Keep the file') : 'Delete the file'}
        </span>
        <span className="ce-option-hint">
          {exists ? (hasOurs && hasTheirs ? `Use the version from ${label}` : `Keep the version from ${label}`) : `As in ${label}, where it no longer exists`}
        </span>
      </button>
    )
  }

  // The surviving version of a delete/modify conflict, to decide with the text in view
  const survivor = file.binary ? null : (file.ours ?? file.theirs)
  const preview = useMemo(() => {
    if (survivor === null) return null
    const lines = splitLines(survivor)
    return { lines: lines.slice(0, 400).map(lineBody), total: lines.length }
  }, [survivor])

  return (
    <div className="ce-choice">
      <div className="ce-choice-card">
        <FileWarning size={30} strokeWidth={1.4} className="ce-choice-icon" />
        <div className="ce-choice-title">{title}</div>
        <div className="ce-choice-detail">{detail}</div>
        <div className="ce-options">
          {!hasOurs && !hasTheirs ? (
            <button className="ce-option ce-option-delete" disabled={busy} onClick={() => void take('ours')}>
              <span className="ce-option-action">
                <Trash2 size={15} />
                Remove the file
              </span>
              <span className="ce-option-hint">Marks the conflict as resolved</span>
            </button>
          ) : (
            <>
              {option('ours')}
              {option('theirs')}
            </>
          )}
        </div>
      </div>
      {preview && preview.total > 0 && (
        <div className="ce-preview">
          <div className="ce-preview-head">
            {hasOurs ? `Our version (${file.oursLabel})` : `Their version (${file.theirsLabel})`}
            {preview.total > preview.lines.length && ` · first ${preview.lines.length} of ${preview.total} lines`}
          </div>
          <pre className="ce-preview-body">{preview.lines.join('\n')}</pre>
        </div>
      )}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Text conflicts: the editor
// ---------------------------------------------------------------------------

interface Nav {
  conflict: number
  /** Bumped on every jump, so jumping to the same conflict again scrolls again */
  seq: number
  /** Line of the output to show instead of the start of the conflict */
  line?: number
}

function TextMerge({ repo, file, ours, theirs }: { repo: string; file: ConflictFile; ours: string; theirs: string }) {
  const path = file.path
  const draftKey = `${repo}\0${path}`
  const busy = useStore((s) => s.busy !== null)
  const stillConflicted = useStore((s) => !s.status || s.status.conflicted.some((f) => f.path === path))

  const model = useMemo(() => buildModel({ base: file.base, ours, theirs, merged: file.merged }), [file, ours, theirs])
  const panes = useMemo(() => buildRows(model), [model])
  const labels = useMemo(() => ({ ours: file.oursLabel, theirs: file.theirsLabel }), [file])
  const conflicts = useMemo(() => {
    const list: Array<{ chunk: number; conflict: ConflictChunk }> = []
    model.chunks.forEach((c, chunk) => {
      if (c.kind === 'conflict') list[c.index] = { chunk, conflict: c }
    })
    return list
  }, [model])

  const initial = useMemo(() => {
    const draft = drafts.get(draftKey)
    if (draft && sameSource(draft.file, file) && draft.choices.length === conflicts.length) return draft
    return { file, choices: conflicts.map((c) => emptyChoice(c.conflict)), manual: new Map() as ManualEdits }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [choices, setChoices] = useState<Choice[]>(initial.choices)
  const [manual, setManual] = useState<ManualEdits>(initial.manual)
  const [nav, setNav] = useState<Nav>({ conflict: 0, seq: 0 })
  const [blockedShown, setBlockedShown] = useState(false)
  const leaving = useRef(false)

  const blocks = useMemo(() => outputBlocks(model, choices, manual, labels), [model, choices, manual, labels])
  const text = useMemo(() => joinBlocks(blocks), [blocks])
  const prog = useMemo(() => progress(model, choices, blocks), [model, choices, blocks])
  const dirty = manual.size > 0 || choices.some(isResolved)
  const complete = prog.resolved === prog.total && prog.markerLine < 0
  /** Conflicts whose block of the result was edited by hand */
  const edited = useMemo(() => new Set(conflicts.flatMap((c, i) => (manual.has(c.chunk) ? [i] : []))), [conflicts, manual])

  useEffect(() => {
    if (dirty) drafts.set(draftKey, { file, choices, manual })
    else drafts.delete(draftKey)
  }, [draftKey, file, choices, manual, dirty])

  useEffect(() => {
    if (complete) setBlockedShown(false)
  }, [complete])

  // Resolved from somewhere else (context menu, terminal, the operation was
  // aborted): nothing to do here any more, unless there is unsaved work to rescue.
  useEffect(() => {
    if (!stillConflicted && !leaving.current && !dirty) leave(path)
  }, [stillConflicted, dirty, path])

  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const state = useRef({ choices, manual, conflicts, edited })
  state.current = { choices, manual, conflicts, edited }

  /** Changes the boxes of one conflict; a hand edit of its block is only dropped after asking. */
  const change = useCallback(async (index: number, fn: (choice: Choice, conflict: ConflictChunk) => Choice): Promise<void> => {
    const { conflicts: list, manual: edits } = state.current
    const entry = list[index]
    if (!entry) return
    if (edits.has(entry.chunk)) {
      const ok = await confirmDialog({
        title: 'Discard the manual edit of this conflict?',
        message: `You edited the result of conflict ${index + 1} by hand. Changing its checkboxes rebuilds that part of the output from the selected lines, and your edit there is lost.\n\nManual edits elsewhere in the file are kept.`,
        confirmLabel: 'Rebuild from checkboxes',
        danger: true
      })
      if (!ok) return
      setManual((m) => {
        const next = new Map(m)
        next.delete(entry.chunk)
        return next
      })
    }
    setChoices((prev) => prev.map((c, i) => (i === index ? fn(c, entry.conflict) : c)))
    setNav((n) => (n.conflict === index ? n : { conflict: index, seq: n.seq }))
  }, [])

  const actions = useMemo<PaneActions>(
    () => ({
      side: (index, side) => void change(index, (c) => toggleSide(c, side)),
      line: (index, side, line) => void change(index, (c) => toggleLine(c, side, line)),
      none: (index) => void change(index, (c) => toggleNone(c)),
      select: (index) => setNav((n) => (n.conflict === index ? n : { conflict: index, seq: n.seq }))
    }),
    [change]
  )

  const takeAll = async (side: Side): Promise<void> => {
    if (edited.size > 0) {
      const ok = await confirmDialog({
        title: `Take all ${side}?`,
        message: `${plural(edited.size, 'conflict was', 'conflicts were')} edited by hand in the output. Taking all of ${SIDE_NAME[side].toLowerCase()} rebuilds every conflict from that side and those edits are lost.\n\nManual edits outside the conflicts are kept.`,
        confirmLabel: `Take all ${side}`,
        danger: true
      })
      if (!ok) return
    }
    setManual((m) => {
      const next = new Map(m)
      for (const c of conflicts) next.delete(c.chunk)
      return next
    })
    setChoices(conflicts.map((c) => takeSide(c.conflict, side)))
  }

  const reset = async (): Promise<void> => {
    if (!dirty) return
    const ok = await confirmDialog({
      title: 'Reset this file?',
      message:
        manual.size > 0
          ? 'Every checkbox is cleared and everything you typed in the output is discarded. The file on disk is not touched.'
          : 'Every checkbox is cleared and the output goes back to the unresolved conflicts. The file on disk is not touched.',
      confirmLabel: 'Reset',
      danger: true
    })
    if (!ok) return
    setChoices(conflicts.map((c) => emptyChoice(c.conflict)))
    setManual(new Map())
  }

  const discardManual = async (): Promise<void> => {
    const ok = await confirmDialog({
      title: 'Discard manual edits?',
      message: 'Everything you typed in the output is discarded and the output is rebuilt from the checkboxes.',
      confirmLabel: 'Discard edits',
      danger: true
    })
    if (ok) setManual(new Map())
  }

  /** Starts over from the file as it is on disk, as one hand-edited text */
  const loadDisk = async (): Promise<void> => {
    if (dirty) {
      const ok = await confirmDialog({
        title: 'Load the file on disk?',
        message: 'The output is replaced by the current content of the file on disk. Your selections and edits here are discarded.',
        confirmLabel: 'Load file',
        danger: true
      })
      if (!ok) return
    }
    const next = new Map<number, string>()
    model.chunks.forEach((_, i) => next.set(i, i === 0 ? file.merged.replace(/\r\n/g, '\n') : ''))
    setChoices(conflicts.map((c) => emptyChoice(c.conflict)))
    setManual(next)
  }

  const save = async (force: boolean): Promise<void> => {
    if (busy) return
    if (!complete && !force) {
      setBlockedShown(true)
      return
    }
    const content = finalText(model, choices, manual, labels)
    leaving.current = true
    const [, name] = splitPath(path)
    const ok = await useStore.getState().run('Resolve conflict', (r) => git.resolveConflict(r, path, content), `"${name}" marked as resolved`)
    if (!ok) {
      leaving.current = false
      return
    }
    drafts.delete(draftKey)
    leave(path)
  }

  const requestClose = async (): Promise<void> => {
    if (dirty) {
      const ok = await confirmDialog({
        title: 'Close without saving?',
        message: `Your selections${manual.size > 0 ? ' and manual edits' : ''} for "${path}" are discarded. The file stays in conflict.`,
        confirmLabel: 'Discard and close',
        danger: true
      })
      if (!ok) return
    }
    leaving.current = true
    drafts.delete(draftKey)
    close()
  }
  useEscape(() => void requestClose())

  const go = useCallback(
    (delta: number) => {
      const total = state.current.conflicts.length
      if (total === 0) return
      setNav((n) => ({ conflict: Math.max(0, Math.min(total - 1, n.conflict + delta)), seq: n.seq + 1 }))
    },
    []
  )

  // Keyboard: F7 / Shift+F7 (or Alt+Down / Alt+Up outside the output) move between conflicts; Ctrl/Cmd+S saves
  const keys = useRef({ save, go })
  keys.current = { save, go }
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.defaultPrevented || document.querySelector('.modal-backdrop, .ctx-menu')) return
      const typing = (e.target as HTMLElement | null)?.tagName === 'TEXTAREA'
      if ((e.metaKey || e.ctrlKey) && !e.altKey && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void keys.current.save(false)
      } else if (e.key === 'F7' || (e.altKey && !typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp'))) {
        e.preventDefault()
        keys.current.go(e.key === 'ArrowUp' || (e.key === 'F7' && e.shiftKey) ? -1 : 1)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  const onEdit = useCallback((next: string) => setManual((m) => applyEdit(blocksRef.current, m, next)), [])

  const split = useSplit()
  const tokens = useSyntax(path, model)
  const current = Math.min(nav.conflict, Math.max(0, conflicts.length - 1))
  const outputLine = nav.line ?? (conflicts[current] ? (blocks[conflicts[current]!.chunk]?.line ?? 0) : 0)
  const manualBlocks = manual.size

  return (
    <div className="ce">
      <Header path={path} onClose={() => void requestClose()}>
        <span className={`ce-counter${complete ? ' done' : ''}`} title="Conflicts settled by their checkboxes or by hand">
          {complete ? <CircleCheck size={13} /> : null}
          {prog.total === 0 ? 'No conflicts left to resolve' : `${prog.resolved} of ${prog.total} ${prog.total === 1 ? 'conflict' : 'conflicts'} resolved`}
        </span>
        <span className="ce-spring" />
        {prog.total > 0 && (
          <span className="ce-nav">
            <button className="gd-icon-btn" title="Previous conflict (Shift+F7 · Alt+↑)" aria-label="Previous conflict" disabled={current <= 0} onClick={() => go(-1)}>
              <ChevronUp size={16} />
            </button>
            <span className="ce-nav-pos">
              {current + 1} / {prog.total}
            </span>
            <button
              className="gd-icon-btn"
              title="Next conflict (F7 · Alt+↓)"
              aria-label="Next conflict"
              disabled={current >= prog.total - 1}
              onClick={() => go(1)}
            >
              <ChevronDown size={16} />
            </button>
          </span>
        )}
      </Header>

      <div className="ce-toolbar">
        <button className="gd-mini-btn ce-btn-ours" disabled={busy || prog.total === 0} title={`Resolve every conflict with ${file.oursLabel}`} onClick={() => void takeAll('ours')}>
          Take all ours
        </button>
        <button className="gd-mini-btn ce-btn-theirs" disabled={busy || prog.total === 0} title={`Resolve every conflict with ${file.theirsLabel}`} onClick={() => void takeAll('theirs')}>
          Take all theirs
        </button>
        <button className="gd-mini-btn" disabled={busy || !dirty} title="Clear every checkbox and manual edit" onClick={() => void reset()}>
          <RotateCcw size={12} />
          Reset
        </button>
        <span className="ce-spring" />
        <button
          className={`ce-save${complete ? '' : ' blocked'}`}
          disabled={busy || !stillConflicted}
          title={complete ? 'Write the output to the file and stage it (Ctrl/Cmd+S)' : 'There are unresolved conflicts left'}
          onClick={() => void save(false)}
        >
          <Save size={13} />
          Save and mark as resolved
        </button>
      </div>

      {!stillConflicted && (
        <Banner kind="warn" icon={<TriangleAlert size={14} />}>
          This file is no longer in conflict in the repository (it was resolved elsewhere, or the operation ended). Your unsaved work here can no longer be saved as a resolution.
          <button className="gd-mini-btn" onClick={() => void requestClose()}>
            Close
          </button>
        </Banner>
      )}
      {blockedShown && !complete && (
        <Banner kind="error" icon={<TriangleAlert size={14} />}>
          <span>
            <strong>Not saved.</strong>{' '}
            {prog.total - prog.resolved > 0
              ? `${plural(prog.total - prog.resolved, 'conflict is', 'conflicts are')} still unresolved, so the output still contains conflict markers (<<<<<<<, =======, >>>>>>>).`
              : 'The text you typed in the output still contains conflict markers (<<<<<<<, =======, >>>>>>>).'}{' '}
            Committing them would break the file.
          </span>
          <button
            className="gd-mini-btn"
            onClick={() => {
              const first = prog.done.indexOf(false)
              setNav((n) => (first >= 0 ? { conflict: first, seq: n.seq + 1 } : { conflict: n.conflict, seq: n.seq + 1, line: prog.markerLine }))
            }}
          >
            Show first
          </button>
          <button className="gd-mini-btn red" disabled={busy} title="Write the output with the markers in it and stage it" onClick={() => void save(true)}>
            Save anyway
          </button>
          <button className="gd-icon-btn" aria-label="Dismiss" title="Dismiss" onClick={() => setBlockedShown(false)}>
            <X size={14} />
          </button>
        </Banner>
      )}
      {!model.diskMatches && (
        <Banner kind="warn" icon={<Info size={14} />}>
          The file on disk does not have the conflict markers git wrote any more (it may have been edited outside GitKroken). The editor starts from the original versions of both sides.
          <button className="gd-mini-btn" onClick={() => void loadDisk()}>
            Load the file on disk into the output
          </button>
        </Banner>
      )}
      {model.source === 'markers' && (
        <Banner kind="info" icon={<Info size={14} />}>
          Git merged this file in a way this editor cannot reproduce from the two versions alone, so the conflicts were read from the markers in the file. Outside the conflicts, both panes show git&apos;s merged text.
        </Banner>
      )}

      <div className="ce-work" ref={split.ref}>
        <div className="ce-top" style={{ flex: `${split.ratio} 1 0` }}>
          <SidePanes
            panes={panes}
            file={file}
            choices={choices}
            done={prog.done}
            edited={edited}
            current={prog.total > 0 ? current : -1}
            nav={nav}
            tokens={tokens}
            actions={actions}
          />
        </div>
        <div className="ce-divider" onMouseDown={split.onMouseDown} title="Drag to resize" />
        <div className="ce-bottom" style={{ flex: `${1 - split.ratio} 1 0` }}>
          <OutputPane
            text={text}
            blocks={blocks}
            model={model}
            done={prog.done}
            current={prog.total > 0 ? current : -1}
            scroll={{ line: outputLine, seq: nav.seq }}
            manualBlocks={manualBlocks}
            onEdit={onEdit}
            onDiscardManual={() => void discardManual()}
          />
        </div>
      </div>
    </div>
  )
}

function Banner(props: { kind: 'info' | 'warn' | 'error'; icon: ReactNode; children: ReactNode }) {
  return (
    <div className={`ce-banner ${props.kind}`} role={props.kind === 'error' ? 'alert' : 'status'}>
      <span className="ce-banner-icon">{props.icon}</span>
      <div className="ce-banner-body">{props.children}</div>
    </div>
  )
}

/** Height share of the side panes, draggable and remembered */
function useSplit(): { ratio: number; ref: RefObject<HTMLDivElement>; onMouseDown: (e: ReactMouseEvent) => void } {
  const ref = useRef<HTMLDivElement>(null)
  const [ratio, setRatio] = useState(() => {
    try {
      const v = Number(localStorage.getItem(SPLIT_KEY))
      return v >= 0.2 && v <= 0.8 ? v : 0.55
    } catch {
      return 0.55
    }
  })
  const onMouseDown = (e: ReactMouseEvent): void => {
    e.preventDefault()
    const box = ref.current?.getBoundingClientRect()
    if (!box || box.height <= 0) return
    let last = ratio
    const move = (ev: MouseEvent): void => {
      last = Math.max(0.2, Math.min(0.8, (ev.clientY - box.top) / box.height))
      setRatio(last)
    }
    const up = (): void => {
      window.removeEventListener('mousemove', move)
      window.removeEventListener('mouseup', up)
      try {
        localStorage.setItem(SPLIT_KEY, String(last))
      } catch {
        /* storage unavailable: the size just does not persist */
      }
    }
    window.addEventListener('mousemove', move)
    window.addEventListener('mouseup', up)
  }
  return { ratio, ref, onMouseDown }
}

/** Tokens per line (index = line number - 1); a line not coloured yet is missing */
type LineTokens = ReadonlyArray<Tok[] | undefined>

interface SideTokens {
  ours: LineTokens | null
  theirs: LineTokens | null
}

// Syntax colours arrive progressively (the blame view's whole-file highlighter);
// the panes show plain text until then
function useSyntax(path: string, model: ConflictModel): SideTokens | null {
  const [state, setState] = useState<{ model: ConflictModel; tokens: SideTokens } | null>(null)
  useEffect(() => {
    const jobs = (['ours', 'theirs'] as const).map((side) =>
      highlightLines(splitLines(sideText(model.chunks, side)).map(lineBody), path, (tokens) =>
        // The highlighter fills one array in place: a new wrapper object makes React look again
        setState((prev) => ({
          model,
          tokens: { ...(prev?.model === model ? prev.tokens : { ours: null, theirs: null }), [side]: tokens }
        }))
      )
    )
    return () => jobs.forEach((job) => job.cancel())
  }, [path, model])
  return state && state.model === model ? state.tokens : null
}

// ---------------------------------------------------------------------------
// The two side panes
// ---------------------------------------------------------------------------

interface PaneActions {
  side: (conflict: number, side: Side) => void
  line: (conflict: number, side: Side, line: number) => void
  none: (conflict: number) => void
  select: (conflict: number) => void
}

function SidePanes(props: {
  panes: PaneRows
  file: ConflictFile
  choices: Choice[]
  done: boolean[]
  edited: ReadonlySet<number>
  current: number
  nav: Nav
  tokens: SideTokens | null
  actions: PaneActions
}) {
  const { panes, file, choices, done, edited, current, tokens, actions } = props
  const { rows } = panes
  const leftRef = useRef<HTMLDivElement>(null)
  const rightRef = useRef<HTMLDivElement>(null)
  const [range, setRange] = useState({ start: 0, end: 60 })
  const [paneWidth, setPaneWidth] = useState(0)

  const update = useCallback(() => {
    const el = rightRef.current
    if (!el) return
    const start = Math.max(0, Math.floor(el.scrollTop / ROW) - OVERSCAN)
    const end = Math.min(rows.length, Math.ceil((el.scrollTop + el.clientHeight) / ROW) + OVERSCAN)
    setRange((prev) => (prev.start === start && prev.end === end ? prev : { start, end }))
  }, [rows.length])

  useLayoutEffect(update, [update])

  useEffect(() => {
    const el = rightRef.current
    if (!el) return
    const measure = (): void => {
      setPaneWidth(el.clientWidth)
      update()
    }
    measure()
    const ro = new ResizeObserver(measure)
    ro.observe(el)
    return () => ro.disconnect()
  }, [update])

  // Both panes have the same rows, so keeping them in step is copying the offsets.
  const sync = (from: HTMLDivElement | null, to: HTMLDivElement | null): void => {
    if (!from || !to) return
    if (to.scrollTop !== from.scrollTop) to.scrollTop = from.scrollTop
    if (to.scrollLeft !== from.scrollLeft) to.scrollLeft = from.scrollLeft
  }
  const onRightScroll = (): void => {
    sync(rightRef.current, leftRef.current)
    update()
  }
  const onLeftScroll = (): void => sync(leftRef.current, rightRef.current)

  // Jump to the conflict asked for (also on open: the first one)
  useLayoutEffect(() => {
    const el = rightRef.current
    const row = panes.headRow[props.nav.conflict]
    if (!el || row === undefined) return
    el.scrollTop = Math.max(0, row * ROW - 3 * ROW)
    if (leftRef.current) leftRef.current.scrollTop = el.scrollTop
    update()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.nav.seq, panes])

  const digits = Math.max(3, String(Math.max(panes.oursLines, panes.theirsLines)).length)
  const chars = Math.min(panes.maxChars, MAX_CHARS + 24)
  const vars = { '--ce-digits': String(digits), '--ce-vw': `${paneWidth}px` } as CSSProperties
  const width = `max(100%, calc(${digits + chars + 6}ch + 64px))`
  const end = Math.min(range.end, rows.length)
  const start = Math.min(range.start, end)
  const slice = rows.slice(start, end)
  const total = rows.length * ROW

  const pane = (side: Side): ReactNode => {
    const label = side === 'ours' ? file.oursLabel : file.theirsLabel
    const lines = side === 'ours' ? panes.oursLines : panes.theirsLines
    const sideTokens = side === 'ours' ? tokens?.ours : tokens?.theirs
    return (
      <div className={`ce-pane ce-${side}`}>
        <div className="ce-pane-head">
          <span className="ce-side-tag">{SIDE_NAME[side]}</span>
          <span className="ce-pane-label" title={label}>
            {label}
          </span>
          <span className="ce-pane-meta">{plural(lines, 'line', 'lines')}</span>
        </div>
        <div className="ce-scroll" ref={side === 'ours' ? leftRef : rightRef} onScroll={side === 'ours' ? onLeftScroll : onRightScroll}>
          <div className="ce-spacer" style={{ height: total, width }}>
            <div className="ce-window" style={{ top: start * ROW }}>
              {slice.map((row, i) => {
                const choice = row.conflict >= 0 ? choices[row.conflict] : undefined
                const isCurrent = row.conflict >= 0 && row.conflict === current
                if (row.kind === 'head') {
                  return (
                    <HeadRow
                      key={start + i}
                      row={row}
                      side={side}
                      choice={choice}
                      total={panes.headRow.length}
                      done={!!done[row.conflict]}
                      edited={edited.has(row.conflict)}
                      current={isCurrent}
                      actions={actions}
                    />
                  )
                }
                const line = side === 'ours' ? row.ours : row.theirs
                return (
                  <LineRow
                    key={start + i}
                    row={row}
                    side={side}
                    line={line}
                    choice={choice}
                    current={isCurrent}
                    toks={line && sideTokens ? (sideTokens[line.no - 1] ?? null) : null}
                    actions={actions}
                  />
                )
              })}
            </div>
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="ce-panes" style={vars}>
      {pane('ours')}
      {pane('theirs')}
    </div>
  )
}

function Tick(props: { state: TriState; label: string; onClick: () => void; small?: boolean }) {
  return (
    <button
      type="button"
      role="checkbox"
      aria-checked={props.state === 'all' ? true : props.state === 'some' ? 'mixed' : false}
      aria-label={props.label}
      title={props.label}
      className={`ce-tick ${props.state}${props.small ? ' small' : ''}`}
      onClick={(e) => {
        e.stopPropagation()
        props.onClick()
      }}
    >
      {props.state === 'all' ? <Check size={props.small ? 9 : 11} strokeWidth={3.5} /> : props.state === 'some' ? <Minus size={props.small ? 9 : 11} strokeWidth={3.5} /> : null}
    </button>
  )
}

const HeadRow = memo(function HeadRow(props: {
  row: Extract<PaneRow, { kind: 'head' }>
  side: Side
  choice: Choice | undefined
  total: number
  done: boolean
  edited: boolean
  current: boolean
  actions: PaneActions
}) {
  const { row, side, choice, actions } = props
  if (!choice) return <div className="ce-row ce-head" />
  const state = sideState(choice, side)
  const rank = sideRank(choice, side)
  const count = choice[side].length
  const picked = choice[side].filter(Boolean).length
  return (
    <div
      className={`ce-row ce-head${props.done ? ' done' : ' pending'}${props.current ? ' current' : ''}`}
      onClick={() => actions.select(row.conflict)}
    >
      <div className="ce-sticky">
        <Tick
          state={state}
          label={state === 'all' ? `Leave ${side} out of conflict ${row.conflict + 1}` : `Take ${side} for conflict ${row.conflict + 1}`}
          onClick={() => actions.side(row.conflict, side)}
        />
        {rank > 0 && (
          <span className="ce-rank" title={rank === 1 ? 'Goes first in the output' : 'Goes second in the output'}>
            {rank}
          </span>
        )}
        <span className="ce-head-title">
          Conflict {row.conflict + 1} of {props.total}
        </span>
        <span className="ce-head-meta">
          {count === 0 ? 'nothing on this side (lines removed)' : state === 'some' ? `${picked} of ${plural(count, 'line', 'lines')}` : plural(count, 'line', 'lines')}
        </span>
        <span className="ce-spring" />
        {props.edited && (
          <span className="ce-chip edited" title="The result of this conflict was edited by hand in the output">
            <Pencil size={10} />
            edited by hand
          </span>
        )}
        {props.done && !props.edited && side === 'theirs' && (
          <span className="ce-chip ok">
            <Check size={10} strokeWidth={3} />
            resolved
          </span>
        )}
        {side === 'theirs' && (
          <button
            type="button"
            className={`ce-none${choice.none ? ' on' : ''}`}
            title="Resolve this conflict taking neither side"
            aria-pressed={choice.none}
            onClick={(e) => {
              e.stopPropagation()
              actions.none(row.conflict)
            }}
          >
            Neither
          </button>
        )}
      </div>
    </div>
  )
})

const LineRow = memo(function LineRow(props: {
  row: Extract<PaneRow, { kind: 'line' }>
  side: Side
  line: PaneLine | null
  choice: Choice | undefined
  current: boolean
  toks: Tok[] | null
  actions: PaneActions
}) {
  const { row, side, line, choice, actions } = props
  if (!line) {
    return (
      <div className={`ce-row ce-fill ce-t-${row.type}${props.current ? ' current' : ''}`}>
        <span className="ce-gutter">
          <span className="ce-box" />
          <span className="ce-num" />
        </span>
      </div>
    )
  }
  let cls = `ce-row ce-t-${row.type}`
  let picked = false
  if (row.type === 'conflict' && choice) {
    picked = !!choice[side][row.index]
    cls += picked ? ' picked' : isResolved(choice) ? ' unpicked' : ' pending'
    if (props.current) cls += ' current'
  } else if (row.type === 'auto') {
    cls += row.from === side ? ' changed' : ' unchanged'
  }
  return (
    <div className={cls}>
      <span className="ce-gutter">
        <span className="ce-box">
          {row.type === 'conflict' && (
            <Tick
              small
              state={picked ? 'all' : 'none'}
              label={picked ? `Leave line ${line.no} out` : `Include line ${line.no}`}
              onClick={() => actions.line(row.conflict, side, row.index)}
            />
          )}
        </span>
        <span className="ce-num">{line.no}</span>
      </span>
      <Code line={line} toks={props.toks} />
    </div>
  )
})

function Code({ line, toks }: { line: PaneLine; toks: Tok[] | null }) {
  const cut = line.text.length > MAX_CHARS ? line.text.length - MAX_CHARS : 0
  return (
    <span className="ce-code">
      {toks && !cut
        ? toks.map((t, i) =>
            t.color ? (
              <span key={i} style={{ color: t.color }}>
                {t.text}
              </span>
            ) : (
              t.text
            )
          )
        : cut
          ? line.text.slice(0, MAX_CHARS)
          : line.text}
      {cut > 0 && <span className="ce-aside">… +{cut} characters</span>}
      {line.noEol && <span className="ce-aside">⊘ no newline at end of file</span>}
    </span>
  )
}

// ---------------------------------------------------------------------------
// The result
// ---------------------------------------------------------------------------

function OutputPane(props: {
  text: string
  blocks: Block[]
  model: ConflictModel
  done: boolean[]
  current: number
  scroll: { line: number; seq: number }
  manualBlocks: number
  onEdit: (next: string) => void
  onDiscardManual: () => void
}) {
  const { text, blocks, model } = props
  const areaRef = useRef<HTMLTextAreaElement>(null)
  const numsRef = useRef<HTMLPreElement>(null)
  const marksRef = useRef<HTMLDivElement>(null)

  const breaks = blocks.length ? blocks[blocks.length - 1]!.line + blocks[blocks.length - 1]!.breaks : 0
  // The gutter also numbers the empty line after a final newline, like any editor
  const lineCount = breaks + 1
  const fileLines = breaks + (text !== '' && !text.endsWith('\n') ? 1 : 0)
  const numbers = useMemo(() => Array.from({ length: lineCount }, (_, i) => i + 1).join('\n'), [lineCount])
  const digits = Math.max(3, String(lineCount).length)

  const onScroll = (): void => {
    const top = areaRef.current?.scrollTop ?? 0
    if (numsRef.current) numsRef.current.style.transform = `translateY(${-top}px)`
    if (marksRef.current) marksRef.current.style.transform = `translateY(${-top}px)`
  }
  useLayoutEffect(onScroll)

  useLayoutEffect(() => {
    const el = areaRef.current
    if (!el) return
    el.scrollTop = Math.max(0, props.scroll.line * ROW - 2 * ROW)
    onScroll()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.scroll.seq])

  const onKeyDown = (e: ReactKeyboardEvent<HTMLTextAreaElement>): void => {
    // Tab types a tab instead of leaving the editor (through the browser's own
    // insertion, so it stays in the undo history).
    if (e.key === 'Tab' && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey) {
      e.preventDefault()
      document.execCommand('insertText', false, '\t')
    }
  }

  // Coloured bands behind the text: one per conflict, plus hand-edited stretches
  const marks = blocks.flatMap((b) => {
    const chunk = model.chunks[b.chunk]!
    const isConflict = chunk.kind === 'conflict'
    if (!isConflict && !b.manual) return []
    const done = isConflict ? !!props.done[chunk.index] : true
    const cls = `ce-mark${isConflict ? (done ? ' done' : ' pending') : ''}${b.manual ? ' manual' : ''}${isConflict && chunk.index === props.current ? ' current' : ''}`
    // A block with no line of its own (a conflict resolved to nothing) is a thin line
    const lines = b.text === '' ? 0 : b.breaks + (b.text.endsWith('\n') ? 0 : 1)
    return [<div key={b.chunk} className={`${cls}${lines === 0 ? ' empty' : ''}`} style={{ top: b.line * ROW, height: Math.max(2, lines * ROW) }} />]
  })

  return (
    <div className="ce-out" style={{ '--ce-digits': String(digits) } as CSSProperties}>
      <div className="ce-pane-head">
        <span className="ce-side-tag out">Output</span>
        <span className="ce-pane-label">The file as it will be saved — you can also edit it directly</span>
        <span className="ce-spring" />
        {props.manualBlocks > 0 && (
          <>
            <span className="ce-chip edited" title="Parts of the output typed by hand. Checkboxes never overwrite them without asking.">
              <Pencil size={10} />
              edited by hand
            </span>
            <button className="gd-mini-btn" title="Rebuild the whole output from the checkboxes" onClick={props.onDiscardManual}>
              Discard manual edits
            </button>
          </>
        )}
        <span className="ce-pane-meta">{plural(fileLines, 'line', 'lines')}</span>
      </div>
      <div className="ce-out-body">
        <div className="ce-out-gutter">
          <pre className="ce-out-nums" ref={numsRef}>
            {numbers}
          </pre>
        </div>
        <div className="ce-out-main">
          <div className="ce-out-marks" ref={marksRef}>
            {marks}
          </div>
          <textarea
            ref={areaRef}
            className="ce-out-text"
            value={text}
            wrap="off"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            aria-label="Merge result"
            onChange={(e) => props.onEdit(e.target.value)}
            onScroll={onScroll}
            onKeyDown={onKeyDown}
          />
        </div>
      </div>
    </div>
  )
}
