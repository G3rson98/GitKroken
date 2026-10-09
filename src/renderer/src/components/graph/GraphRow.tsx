import { memo, useMemo, type DragEvent, type MouseEvent } from 'react'
import { Archive, Check, Cloud, Laptop, Minus, Pencil, Plus, Tag, TriangleAlert } from 'lucide-react'
import type { Commit } from '@shared/types'
import { useStore, WIP } from '../../store'
import { showContextMenu } from '../ui/overlays'
import type { GraphRow as LayoutRow } from './layout'
import { laneX, rowPaths } from './geometry'
import { formatDate, formatFullDate, initials, type RefLabel } from './refLabels'
import { checkoutLabel, commitMenu, dropMenu, isBranchLabel, labelMenu, wipMenu } from './actions'

// --- graph cell --------------------------------------------------------------

type NodeKind = 'commit' | 'merge' | 'stash' | 'wip'

interface GraphCellProps {
  row: LayoutRow
  kind: NodeKind
  rowH: number
  /** Initials shown inside a regular commit node */
  text?: string
  /** Draw the thin connector coming from the ref pills */
  linked?: boolean
}

const GraphCell = memo(function GraphCell({ row, kind, rowH, text, linked }: GraphCellProps) {
  const paths = useMemo(() => rowPaths(row, rowH), [row, rowH])
  const x = laneX(row.col)
  const y = rowH / 2
  const lane = `lc-${row.color}`

  let node
  if (kind === 'wip') {
    node = <circle className={`g-node-wip ${lane}`} cx={x} cy={y} r={10} />
  } else if (kind === 'stash') {
    node = (
      <g className={lane}>
        <rect className="g-node-stash" x={x - 8} y={y - 8} width={16} height={16} rx={3.5} />
        <path className="g-node-glyph" d={`M${x - 3.5} ${y - 1}h7M${x - 3.5} ${y + 2.5}h7`} />
      </g>
    )
  } else if (kind === 'merge') {
    node = <circle className={`g-node-merge ${lane}`} cx={x} cy={y} r={5} />
  } else {
    node = (
      <g className={lane}>
        <circle className="g-node" cx={x} cy={y} r={10} />
        <text className="g-node-text" x={x} y={y}>
          {text}
        </text>
      </g>
    )
  }

  return (
    <svg className="g-svg" width="100%" height={rowH} aria-hidden="true">
      <rect className={`g-band ${lane}`} x={x} y={1} width="100%" height={rowH - 2} />
      {linked && <line className={`g-link ${lane}`} x1={0} y1={y} x2={x} y2={y} />}
      {paths.map((p, i) => (
        <path key={i} className={`g-ln lc-${p.color}${p.dashed ? ' dashed' : ''}`} d={p.d} />
      ))}
      {node}
    </svg>
  )
})

// --- ref pills ---------------------------------------------------------------

/** Pill being dragged (HTML5 drag & drop does not expose the payload on dragover) */
let dragSource: RefLabel | null = null

const canDrop = (target: RefLabel): boolean =>
  dragSource !== null && dragSource.key !== target.key && isBranchLabel(target)

function pillTitle(label: RefLabel): string {
  switch (label.kind) {
    case 'local': {
      const { upstream, ahead = 0, behind = 0 } = label.local ?? {}
      let text = (label.isCurrent ? 'Current branch: ' : 'Local branch: ') + label.name
      if (label.remote) text += `\nSincronizada con ${label.remote.name}`
      else if (upstream && ahead + behind > 0) text += `\n${upstream}: ↑${ahead} ↓${behind}`
      return text
    }
    case 'remote':
      return `Remote branch: ${label.name}`
    case 'tag':
      return `Etiqueta: ${label.name}`
    case 'stash':
      return label.ref?.message ? `${label.name}: ${label.ref.message}` : label.name
    case 'detached':
      return 'HEAD separado (detached)'
  }
}

const Pill = memo(function Pill({ label }: { label: RefLabel }) {
  const branch = isBranchLabel(label)

  const onContextMenu = (e: MouseEvent) => {
    const items = labelMenu(label)
    if (items.length > 0) showContextMenu(e, items) // otherwise the row menu opens
  }
  const onDoubleClick = (e: MouseEvent) => {
    if (!branch) return
    e.stopPropagation()
    checkoutLabel(label)
  }
  const onDragStart = (e: DragEvent) => {
    dragSource = label
    e.dataTransfer.effectAllowed = 'link'
    e.dataTransfer.setData('text/plain', label.name)
  }
  const onDragEnd = () => {
    dragSource = null
  }
  const onDragOver = (e: DragEvent<HTMLSpanElement>) => {
    if (!canDrop(label)) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'link'
    e.currentTarget.classList.add('drop')
  }
  const onDragLeave = (e: DragEvent<HTMLSpanElement>) => {
    e.currentTarget.classList.remove('drop')
  }
  const onDrop = (e: DragEvent<HTMLSpanElement>) => {
    e.currentTarget.classList.remove('drop')
    const src = dragSource
    dragSource = null
    if (!src || src.key === label.key || !isBranchLabel(label)) return
    showContextMenu(e, dropMenu(src, label))
  }

  return (
    <span
      className={`g-pill k-${label.kind}${label.isCurrent ? ' current' : ''}`}
      title={pillTitle(label)}
      draggable={branch}
      onContextMenu={onContextMenu}
      onDoubleClick={onDoubleClick}
      onDragStart={branch ? onDragStart : undefined}
      onDragEnd={branch ? onDragEnd : undefined}
      onDragOver={branch ? onDragOver : undefined}
      onDragLeave={branch ? onDragLeave : undefined}
      onDrop={branch ? onDrop : undefined}
    >
      {label.isCurrent && <Check size={11} strokeWidth={3.5} />}
      <span className="g-pill-name">{label.name}</span>
      {label.kind === 'local' && <Laptop size={11} />}
      {label.remote && <Cloud size={11} />}
      {label.kind === 'tag' && <Tag size={10} />}
      {label.kind === 'stash' && <Archive size={10} />}
    </span>
  )
})

const RefCell = memo(function RefCell({ labels }: { labels: RefLabel[] }) {
  const extra = labels.length - 1
  return (
    <>
      <Pill label={labels[0]} />
      {extra > 0 && <span className="g-more">+{extra}</span>}
      <span className="g-ref-line" />
      {extra > 0 && (
        <div className="g-refs-pop">
          {labels.map((l) => (
            <Pill key={l.key} label={l} />
          ))}
        </div>
      )}
    </>
  )
})

// --- rows ----------------------------------------------------------------------

function onRowContextMenu(e: MouseEvent, hash: string, commit: Commit | null): void {
  const s = useStore.getState()
  if (s.selected !== hash) s.select(hash)
  showContextMenu(e, commit ? commitMenu(commit) : wipMenu())
}

interface CommitRowProps {
  commit: Commit
  row: LayoutRow
  labels: RefLabel[] | undefined
  selected: boolean
  top: number
  rowH: number
}

export const CommitRow = memo(function CommitRow({ commit, row, labels, selected, top, rowH }: CommitRowProps) {
  const kind: NodeKind = commit.isStash ? 'stash' : commit.parents.length > 1 ? 'merge' : 'commit'
  const text = kind === 'commit' ? initials(commit.author) : undefined
  return (
    <div
      className={`g-row lc-${row.color}${selected ? ' selected' : ''}${commit.isStash ? ' is-stash' : ''}`}
      style={{ top }}
      role="row"
      aria-selected={selected}
      onClick={() => useStore.getState().select(commit.hash)}
      onContextMenu={(e) => onRowContextMenu(e, commit.hash, commit)}
    >
      <div className="g-c g-c-refs">{labels && <RefCell labels={labels} />}</div>
      <div className="g-c g-c-graph">
        <GraphCell row={row} kind={kind} rowH={rowH} text={text} linked={labels !== undefined} />
      </div>
      <div className="g-c g-c-msg" title={commit.subject}>
        {commit.subject || <span className="g-dim">(no message)</span>}
        {commit.body && <span className="g-msg-body">{commit.body.split('\n', 1)[0]}</span>}
      </div>
      <div className="g-c g-c-author" title={commit.email ? `${commit.author} <${commit.email}>` : commit.author}>
        {commit.author}
      </div>
      <div className="g-c g-c-date" title={formatFullDate(commit.date)}>
        {formatDate(commit.date)}
      </div>
      <div className="g-c g-c-sha" title={commit.hash}>
        {commit.hash.slice(0, 7)}
      </div>
    </div>
  )
})

export interface WipCounts {
  modified: number
  added: number
  deleted: number
  conflicted: number
}

interface WipRowProps {
  row: LayoutRow
  counts: WipCounts
  selected: boolean
  top: number
  rowH: number
}

export const WipRow = memo(function WipRow({ row, counts, selected, top, rowH }: WipRowProps) {
  return (
    <div
      className={`g-row is-wip lc-${row.color}${selected ? ' selected' : ''}`}
      style={{ top }}
      role="row"
      aria-selected={selected}
      onClick={() => useStore.getState().select(WIP)}
      onContextMenu={(e) => onRowContextMenu(e, WIP, null)}
    >
      <div className="g-c g-c-refs" />
      <div className="g-c g-c-graph">
        <GraphCell row={row} kind="wip" rowH={rowH} />
      </div>
      <div className="g-c g-c-msg g-wip-msg">
        <span className="g-wip-text">// WIP</span>
        {counts.modified > 0 && (
          <span className="g-count modified" title={`${counts.modified} modified`}>
            <Pencil size={11} />
            {counts.modified}
          </span>
        )}
        {counts.added > 0 && (
          <span className="g-count added" title={`${counts.added} added`}>
            <Plus size={12} strokeWidth={3} />
            {counts.added}
          </span>
        )}
        {counts.deleted > 0 && (
          <span className="g-count deleted" title={`${counts.deleted} deleted`}>
            <Minus size={12} strokeWidth={3} />
            {counts.deleted}
          </span>
        )}
        {counts.conflicted > 0 && (
          <span className="g-count conflicted" title={`${counts.conflicted} conflicted`}>
            <TriangleAlert size={11} />
            {counts.conflicted}
          </span>
        )}
      </div>
      <div className="g-c g-c-author" />
      <div className="g-c g-c-date" />
      <div className="g-c g-c-sha" />
    </div>
  )
})
