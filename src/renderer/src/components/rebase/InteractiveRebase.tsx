// Interactive rebase (centre view): the commits of `base..HEAD` as an editable
// plan. All the logic lives in plan.ts; this file is presentation, drag and
// drop and keyboard handling.
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type DragEvent, type KeyboardEvent } from 'react'
import {
  ArrowDown,
  ChevronDown,
  ChevronUp,
  CloudUpload,
  CornerLeftUp,
  GripVertical,
  ListOrdered,
  LoaderCircle,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  X
} from 'lucide-react'
import type { Commit, RebaseAction } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog, toast } from '../ui/overlays'
import {
  ACTIONS,
  ACTION_INFO,
  analyse,
  defaultCombined,
  initialRows,
  moveRow,
  pushedCount,
  pushedRewritten,
  setAction,
  setCombined,
  setMessage,
  shortHash,
  toSteps,
  type Row
} from './plan'
import './rebase.css'

type Load = { state: 'loading' } | { state: 'error'; message: string } | { state: 'ready'; commits: Commit[]; head: string | null }

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const KEY_TO_ACTION: Record<string, RebaseAction> = { p: 'pick', r: 'reword', s: 'squash', f: 'fixup', d: 'drop' }
const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`
const dateText = (seconds: number): string =>
  new Date(seconds * 1000).toLocaleDateString('en', { year: 'numeric', month: 'short', day: 'numeric' })

function MessageEditor(props: {
  id: string
  label: string
  value: string
  invalid: boolean
  onChange: (text: string) => void
  onLeave: () => void
  onReset?: () => void
}) {
  const lines = props.value.split('\n').length
  return (
    <div className="ir-editor">
      <div className="ir-editor-head">
        <span>{props.label}</span>
        {props.onReset && (
          <button type="button" className="ir-link" onClick={props.onReset} title="Go back to the combined messages of the squashed commits">
            <RotateCcw size={11} /> Use default message
          </button>
        )}
      </div>
      <textarea
        id={props.id}
        className={props.invalid ? 'ir-invalid' : undefined}
        value={props.value}
        rows={Math.max(2, Math.min(12, lines))}
        spellCheck={false}
        placeholder="Commit message"
        onChange={(e) => props.onChange(e.target.value)}
        onKeyDown={(e) => {
          // Keys typed here are text, not shortcuts of the list
          e.stopPropagation()
          if (e.key === 'Escape') {
            e.preventDefault()
            props.onLeave()
          }
        }}
      />
    </div>
  )
}

export function InteractiveRebase() {
  const repo = useStore((s) => s.activeRepo)
  const view = useStore((s) => s.view)
  const status = useStore((s) => s.status)
  const refs = useStore((s) => s.refs)
  const graphCommits = useStore((s) => s.commits)
  const busy = useStore((s) => s.busy)
  const base = view.kind === 'rebase' ? view.base : null
  const head = status?.head ?? null

  const [load, setLoad] = useState<Load>({ state: 'loading' })
  const [rows, setRows] = useState<Row[]>([])
  const [selected, setSelected] = useState(0)
  const [drag, setDrag] = useState<{ from: number; to: number } | null>(null)
  const [attempt, setAttempt] = useState(0)
  const listRef = useRef<HTMLDivElement>(null)
  const armed = useRef(false)
  /** The plan differs from what was loaded (a reload would discard work) */
  const edited = useRef(false)
  /** Hash of the row whose message editor should take the focus once rendered */
  const focusNext = useRef<string | null>(null)

  // (Re)load the range whenever the repo, the base or the branch tip changes.
  useEffect(() => {
    if (!repo || !base) return
    let stale = false
    setLoad((prev) => (prev.state === 'ready' ? prev : { state: 'loading' }))
    git.rebaseTodo(repo, base).then(
      (commits) => {
        if (stale) return
        if (edited.current) toast('The branch changed: the rebase plan was reloaded.', 'info')
        edited.current = false
        setLoad({ state: 'ready', commits, head })
        setRows(initialRows(commits))
        setSelected(0)
      },
      (e) => !stale && setLoad({ state: 'error', message: errText(e) })
    )
    return () => {
      stale = true
    }
  }, [repo, base, head, attempt])

  const commits = load.state === 'ready' ? load.commits : EMPTY
  const byHash = useMemo(() => new Map(commits.map((c) => [c.hash, c])), [commits])
  const originalIndex = useMemo(() => new Map(commits.map((c, i) => [c.hash, i])), [commits])
  const analysis = useMemo(() => analyse(rows, commits), [rows, commits])
  const branchRef = refs.find((r) => r.type === 'head' && r.isCurrent)
  const pushed = pushedCount(commits, branchRef)
  const rewritesPushed = pushedRewritten(pushed, analysis)
  const branch = status?.branch ?? branchRef?.name ?? 'HEAD'
  const baseCommit = graphCommits.find((c) => c.hash === base || (base !== null && c.hash.startsWith(base)))

  const change = useCallback((next: (rows: Row[]) => Row[]) => {
    edited.current = true
    setRows(next)
  }, [])

  const blocker = analysis.errors[0] ?? (!analysis.changed ? 'Nothing has changed yet: reorder the commits or pick an action.' : null)
  const canStart = load.state === 'ready' && !blocker && !busy

  const close = (): void => useStore.getState().openView({ kind: 'graph' })

  const cancel = async (): Promise<void> => {
    if (analysis.changed) {
      const ok = await confirmDialog({
        title: 'Cancel interactive rebase',
        message: 'The plan you prepared will be discarded. The repository has not been changed.',
        confirmLabel: 'Discard plan',
        danger: true
      })
      if (!ok) return
    }
    close()
  }

  const reset = (): void => {
    edited.current = false
    setRows(initialRows(commits))
    listRef.current?.focus()
  }

  const start = async (): Promise<void> => {
    if (!canStart || !base) return
    const dropped = rows.filter((r) => r.action === 'drop')
    if (dropped.length) {
      const names = dropped.slice(0, 12).map((r) => `  ${shortHash(r.hash)}  ${byHash.get(r.hash)?.subject ?? ''}`)
      if (dropped.length > 12) names.push(`  …and ${dropped.length - 12} more`)
      const ok = await confirmDialog({
        title: `Drop ${plural(dropped.length, 'commit', 'commits')}`,
        message:
          `${dropped.length === 1 ? 'This commit and its changes' : 'These commits and their changes'} will be removed from ${branch}:\n\n` +
          `${names.join('\n')}\n\nThe current tip of the branch is saved first, so Undo can restore it.`,
        confirmLabel: dropped.length === 1 ? 'Drop commit and start' : 'Drop commits and start',
        danger: true
      })
      if (!ok) return
    }
    if (rewritesPushed > 0) {
      const ok = await confirmDialog({
        title: 'Rewrite pushed commits',
        message:
          `This plan rewrites ${plural(rewritesPushed, 'commit that is', 'commits that are')} already pushed to ${branchRef?.upstream ?? 'the remote'}.\n\n` +
          `Afterwards ${branch} and its remote will have diverged: a normal push will be rejected and you will need a force push. ` +
          'Anyone who based work on those commits will have to rebase it.',
        confirmLabel: 'Rewrite pushed commits',
        danger: true
      })
      if (!ok) return
    }
    const steps = toSteps(rows, commits)
    // From here on a change of the branch tip is our own doing
    edited.current = false
    const ok = await useStore
      .getState()
      .run('Interactive rebase', (r) => git.rebaseInteractive(r, base, steps), `Interactive rebase finished: ${analysis.summary}`)
    const after = useStore.getState()
    // Stopped on conflicts: the in-progress banner (Continue / Abort) takes over.
    if (ok || after.status?.inProgress === 'rebase') after.openView({ kind: 'graph' })
  }

  const move = (from: number, to: number): void => {
    if (to < 0 || to >= rows.length || from === to) return
    change((r) => moveRow(r, from, to))
    setSelected(to)
  }

  const act = (index: number, action: RebaseAction): void => {
    // Choosing Reword is asking to type the new message
    if (action === 'reword' && rows[index]?.action !== 'reword') focusNext.current = rows[index]?.hash ?? null
    change((r) => setAction(r, index, action))
    setSelected(index)
  }

  const focusEditor = (index: number): void => {
    const target = analysis.targetOf[index] ?? index
    const el = document.getElementById(`ir-msg-${rows[target]?.hash}`) ?? document.getElementById(`ir-msg-${rows[index]?.hash}`)
    if (el instanceof HTMLTextAreaElement) {
      el.focus()
      el.select()
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>): void => {
    if (document.querySelector('.modal-backdrop')) return
    const key = e.key.length === 1 ? e.key.toLowerCase() : e.key
    const mod = e.metaKey || e.ctrlKey
    if (key === 'Enter' && mod) {
      e.preventDefault()
      void start()
    } else if (key === 'Escape') {
      e.preventDefault()
      void cancel()
    } else if (rows.length === 0) {
      return
    } else if ((key === 'ArrowUp' || key === 'k') && (e.altKey || e.shiftKey)) {
      e.preventDefault()
      move(selected, selected - 1)
    } else if ((key === 'ArrowDown' || key === 'j') && (e.altKey || e.shiftKey)) {
      e.preventDefault()
      move(selected, selected + 1)
    } else if (key === 'ArrowUp' || key === 'k') {
      e.preventDefault()
      setSelected(Math.max(0, selected - 1))
    } else if (key === 'ArrowDown' || key === 'j') {
      e.preventDefault()
      setSelected(Math.min(rows.length - 1, selected + 1))
    } else if (key === 'Home') {
      e.preventDefault()
      setSelected(0)
    } else if (key === 'End') {
      e.preventDefault()
      setSelected(rows.length - 1)
    } else if (key === 'Enter') {
      e.preventDefault()
      focusEditor(selected)
    } else if (!mod && !e.altKey && KEY_TO_ACTION[key]) {
      e.preventDefault()
      act(selected, KEY_TO_ACTION[key]!)
    }
  }

  useEffect(() => {
    const hash = focusNext.current
    if (!hash) return
    focusNext.current = null
    const el = document.getElementById(`ir-msg-${hash}`)
    if (el instanceof HTMLTextAreaElement) {
      el.focus()
      el.select()
    }
  }, [rows])

  // Keep the selected row visible, and the list focused once it is ready.
  useEffect(() => {
    listRef.current?.querySelector(`[data-row="${selected}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [selected])
  const ready = load.state === 'ready'
  useEffect(() => {
    if (ready) listRef.current?.focus()
  }, [ready])

  // --- drag and drop (armed only from the grip, so text stays selectable) ---
  const onDragOver = (e: DragEvent<HTMLDivElement>, index: number): void => {
    if (!drag) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'move'
    const box = e.currentTarget.getBoundingClientRect()
    const after = e.clientY > box.top + box.height / 2
    // Index the dragged row would have after the move
    let to = after ? index + 1 : index
    if (drag.from < to) to--
    if (to !== drag.to) setDrag({ from: drag.from, to })
  }
  const endDrag = (commit: boolean): void => {
    if (drag && commit) move(drag.from, drag.to)
    armed.current = false
    setDrag(null)
  }

  if (!base) return null

  const header = (
    <div className="ir-header">
      <ListOrdered size={16} className="ir-header-icon" />
      <span className="ir-kind">Interactive rebase</span>
      <span className="ir-branch">{branch}</span>
      <span className="ir-onto" title={baseCommit ? `${baseCommit.hash}\n${baseCommit.subject}` : base}>
        onto <code>{shortHash(base)}</code>
        {baseCommit ? ` ${baseCommit.subject}` : ''}
      </span>
      <span className="ir-spring" />
      {ready && <span className={`ir-summary${analysis.changed ? ' changed' : ''}`}>{analysis.summary}</span>}
      <button type="button" className="ir-icon-btn" title="Cancel (Esc)" onClick={() => void cancel()}>
        <X size={15} />
      </button>
    </div>
  )

  if (load.state !== 'ready') {
    return (
      <div className="ir">
        {header}
        <div className={`ir-notice${load.state === 'error' ? ' error' : ''}`}>
          {load.state === 'loading' ? (
            <>
              <LoaderCircle size={22} className="ir-spin" />
              <div>Reading commits…</div>
            </>
          ) : (
            <>
              <TriangleAlert size={24} />
              <div className="ir-notice-title">An interactive rebase cannot start here</div>
              <div className="ir-notice-detail">{load.message}</div>
              <div className="ir-notice-actions">
                <button type="button" className="btn" onClick={() => setAttempt((n) => n + 1)}>
                  Try again
                </button>
                <button type="button" className="btn btn-primary" onClick={close}>
                  Back to the graph
                </button>
              </div>
            </>
          )}
        </div>
      </div>
    )
  }

  /** Index (in rows) of the last member of each squash group -> its target */
  const editorAfter = new Map<number, number>()
  for (const group of analysis.groups.values()) {
    if (group.squashes.length) editorAfter.set(group.members[group.members.length - 1]!, group.target)
  }
  const previewTo = drag?.to ?? -1

  return (
    <div className="ir">
      {header}

      {pushed > 0 && (
        <div className={`ir-banner warn${rewritesPushed > 0 ? ' strong' : ''}`}>
          <CloudUpload size={16} />
          <div>
            <strong>
              {plural(pushed, 'commit is', 'commits are')} already pushed to {branchRef?.upstream}.
            </strong>{' '}
            {rewritesPushed > 0
              ? `This plan rewrites ${rewritesPushed} of them: you will have to force push ${branch} afterwards, and anyone who based work on them will have to rebase it.`
              : 'Changing or moving them rewrites published history and requires a force push. The current plan leaves them untouched.'}
          </div>
        </div>
      )}

      <div className="ir-legend">
        <ArrowDown size={13} />
        <span>
          <strong>Oldest commit on top</strong>, newest at the bottom: applied from top to bottom.
        </span>
        <span className="ir-spring" />
        <span className="ir-keys">
          <kbd>P</kbd> <kbd>R</kbd> <kbd>S</kbd> <kbd>F</kbd> <kbd>D</kbd> action · <kbd>↑</kbd> <kbd>↓</kbd> select · <kbd>Alt</kbd>+<kbd>↑</kbd>{' '}
          <kbd>↓</kbd> move · <kbd>Enter</kbd> edit message
        </span>
      </div>

      <div
        className="ir-list"
        ref={listRef}
        tabIndex={0}
        role="listbox"
        aria-label="Commits to rebase, oldest first"
        aria-activedescendant={rows[selected] ? `ir-row-${rows[selected]!.hash}` : undefined}
        onKeyDown={onKeyDown}
      >
        {rows.map((row, i) => {
          const commit = byHash.get(row.hash)
          const target = analysis.targetOf[i]
          const group = analysis.groups.get(i)
          const headsSquash = !!group && group.squashes.length > 0
          const folded = row.action === 'squash' || row.action === 'fixup'
          const orphan = folded && target === null
          const isPushed = (originalIndex.get(row.hash) ?? Infinity) < pushed
          const classes = ['ir-row', `ir-${row.action}`]
          if (i === selected) classes.push('selected')
          if (folded) classes.push('folded')
          if (group) classes.push('has-members')
          if (orphan) classes.push('orphan')
          if (drag?.from === i) classes.push('dragging')
          if (drag && drag.from !== i && previewTo === i) classes.push(drag.from > i ? 'drop-before' : 'drop-after')
          const combinedTarget = editorAfter.get(i)
          const combinedRow = combinedTarget === undefined ? null : rows[combinedTarget]!
          const combinedGroup = combinedTarget === undefined ? null : analysis.groups.get(combinedTarget)!

          return (
            <Fragment key={row.hash}>
              <div
                id={`ir-row-${row.hash}`}
                data-row={i}
                className={classes.join(' ')}
                role="option"
                aria-selected={i === selected}
                draggable
                onMouseDown={() => setSelected(i)}
                onDragStart={(e) => {
                  if (!armed.current) {
                    e.preventDefault()
                    return
                  }
                  e.dataTransfer.effectAllowed = 'move'
                  e.dataTransfer.setData('text/plain', row.hash)
                  setDrag({ from: i, to: i })
                }}
                onDragOver={(e) => onDragOver(e, i)}
                onDrop={(e) => {
                  e.preventDefault()
                  endDrag(true)
                }}
                onDragEnd={() => endDrag(false)}
              >
                <span
                  className="ir-grip"
                  title="Drag to reorder"
                  onMouseDown={() => (armed.current = true)}
                  onMouseUp={() => (armed.current = false)}
                >
                  <GripVertical size={14} />
                </span>
                <span className="ir-num">{i + 1}</span>
                <span className="ir-actions" role="group" aria-label="Action">
                  {ACTIONS.map((action) => (
                    <button
                      key={action}
                      type="button"
                      tabIndex={-1}
                      className={`ir-action ir-a-${action}${row.action === action ? ' on' : ''}`}
                      title={`${ACTION_INFO[action].label} (${ACTION_INFO[action].key}): ${ACTION_INFO[action].hint}`}
                      aria-pressed={row.action === action}
                      onClick={() => {
                        act(i, action)
                        listRef.current?.focus()
                      }}
                    >
                      {ACTION_INFO[action].label}
                    </button>
                  ))}
                </span>
                <code className="ir-sha" title={row.hash}>
                  {shortHash(row.hash)}
                </code>
                <span className="ir-subject" title={commit ? `${commit.subject}${commit.body ? `\n\n${commit.body}` : ''}` : ''}>
                  {folded && !orphan && (
                    <span className="ir-into" title={`Combined into ${shortHash(rows[target!]!.hash)}`}>
                      <CornerLeftUp size={13} />
                    </span>
                  )}
                  <span className="ir-subject-text">{commit?.subject}</span>
                  {row.action === 'fixup' && !orphan && <span className="ir-tag">message discarded</span>}
                  {row.action === 'drop' && <span className="ir-tag danger">will be removed</span>}
                  {orphan && <span className="ir-tag danger">nothing above to combine with</span>}
                  {group && (
                    <span className="ir-tag">
                      + {plural(group.members.length, 'commit', 'commits')} combined
                    </span>
                  )}
                </span>
                {isPushed && (
                  <span className="ir-pushed" title={`Already pushed to ${branchRef?.upstream}`}>
                    <CloudUpload size={13} />
                  </span>
                )}
                <span className="ir-author" title={commit ? `${commit.author} <${commit.email}>` : ''}>
                  {commit?.author}
                </span>
                <span className="ir-date">{commit ? dateText(commit.date) : ''}</span>
                <span className="ir-move">
                  <button type="button" tabIndex={-1} title="Move up (Alt+↑)" disabled={i === 0} onClick={() => move(i, i - 1)}>
                    <ChevronUp size={14} />
                  </button>
                  <button type="button" tabIndex={-1} title="Move down (Alt+↓)" disabled={i === rows.length - 1} onClick={() => move(i, i + 1)}>
                    <ChevronDown size={14} />
                  </button>
                </span>
              </div>

              {row.action === 'reword' && !headsSquash && (
                <MessageEditor
                  id={`ir-msg-${row.hash}`}
                  label={`New message for ${shortHash(row.hash)}`}
                  value={row.message}
                  invalid={!row.message.trim()}
                  onChange={(text) => change((r) => setMessage(r, i, text))}
                  onLeave={() => listRef.current?.focus()}
                />
              )}
              {combinedRow && combinedGroup && (
                <MessageEditor
                  id={`ir-msg-${combinedRow.hash}`}
                  label={`Message of the squashed commit (${shortHash(combinedRow.hash)} + ${combinedGroup.members.length})`}
                  value={combinedRow.combined ?? defaultCombined(rows, combinedGroup, byHash)}
                  invalid={!(combinedRow.combined ?? defaultCombined(rows, combinedGroup, byHash)).trim()}
                  onChange={(text) => change((r) => setCombined(r, combinedTarget!, text))}
                  onLeave={() => listRef.current?.focus()}
                  onReset={combinedRow.combined === null ? undefined : () => change((r) => setCombined(r, combinedTarget!, null))}
                />
              )}
            </Fragment>
          )
        })}
      </div>

      <div className="ir-footer">
        <div className="ir-safety">
          <ShieldCheck size={15} />
          <span>
            Before anything is rewritten, the current tip of <strong>{branch}</strong>
            {head ? (
              <>
                {' '}
                (<code>{shortHash(head)}</code>)
              </>
            ) : null}{' '}
            is saved as <code>refs/original/gitkroken/{branch}/&lt;date&gt;</code>. To go back: <strong>Undo</strong> in the toolbar, or{' '}
            <code>git reset --keep {head ? shortHash(head) : '<that ref>'}</code>. If the rebase stops on a conflict, <strong>Abort</strong>{' '}
            restores the branch exactly.
          </span>
        </div>
        <div className="ir-footer-row">
          <span className={`ir-status${analysis.errors.length ? ' error' : ''}`}>
            {analysis.errors.length > 0 && <TriangleAlert size={14} />}
            {blocker ?? analysis.summary}
            {analysis.errors.length > 1 ? ` (+${analysis.errors.length - 1} more)` : ''}
          </span>
          <button type="button" className="btn" onClick={() => void cancel()}>
            Cancel
          </button>
          <button type="button" className="btn" disabled={!analysis.changed} onClick={reset} title="Back to the current history: every commit picked, original order">
            Reset
          </button>
          <button
            type="button"
            className="btn btn-primary"
            disabled={!canStart}
            title={blocker ?? (busy ? `${busy} is running…` : 'Start Rebase (Ctrl+Enter)')}
            onClick={() => void start()}
          >
            Start Rebase
          </button>
        </div>
      </div>
    </div>
  )
}

const EMPTY: Commit[] = []
