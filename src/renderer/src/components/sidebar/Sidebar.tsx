import { Fragment, useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Archive,
  Check,
  ChevronDown,
  ChevronRight,
  Cloud,
  Folder,
  FolderOpen,
  GitBranch,
  Monitor,
  Plus,
  Search,
  Tag,
  X
} from 'lucide-react'
import type { Ref } from '@shared/types'
import { useStore } from '../../store'
import { showContextMenu } from '../ui/overlays'
import { checkoutRef, createBranchAtHead, shortSha } from '../toolbar/actions'
import { addRemote, localBranchMenu, remoteBranchMenu, remoteMenu, stashMenu, tagMenu } from './menus'
import { buildTree, groupRemotes, stashIndex, useCollapsed, type TreeLeaf, type TreeNode } from './tree'
import { Chevron, Section } from './Section'
import { ExtraSections } from '../extras/Sections'
import { HostingSections } from '../hosting/Sections'
import './sidebar.css'

/** Rows rendered per flat list (stashes, tags) before "show more" */
const PAGE = 300
const INDENT = 14
const BASE_PAD = 8
/** Width of a chevron + its gap: leaves are shifted by it so their icons line up with folder icons */
const CHEVRON_W = 18


function Row(props: {
  depth: number
  icon: ReactNode
  label: string
  meta?: ReactNode
  title?: string
  active?: boolean
  current?: boolean
  onClick: () => void
  onDoubleClick?: () => void
  onContextMenu: (e: MouseEvent) => void
}) {
  return (
    <div
      className={`sb-row${props.active ? ' active' : ''}${props.current ? ' current' : ''}`}
      style={{ paddingLeft: BASE_PAD + CHEVRON_W + props.depth * INDENT }}
      title={props.title}
      onClick={props.onClick}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
    >
      <span className="sb-icon">{props.icon}</span>
      <span className="sb-label">{props.label}</span>
      {props.meta}
    </div>
  )
}

/** Recursive folder tree for branch names containing `/`. */
function Tree(props: {
  nodes: TreeNode[]
  depth: number
  isOpen: (key: string) => boolean
  toggle: (key: string) => void
  renderLeaf: (leaf: TreeLeaf, depth: number) => ReactNode
}) {
  const { nodes, depth, isOpen, toggle, renderLeaf } = props
  return (
    <>
      {nodes.map((n) => {
        if (n.kind === 'leaf') return renderLeaf(n, depth)
        const open = isOpen(n.path)
        return (
          <Fragment key={`dir:${n.path}`}>
            <div
              className="sb-row sb-folder"
              style={{ paddingLeft: BASE_PAD + depth * INDENT }}
              title={n.path.split('/').slice(1).join('/')}
              onClick={() => toggle(n.path)}
            >
              <Chevron open={open} />
              <span className="sb-icon">{open ? <FolderOpen size={14} /> : <Folder size={14} />}</span>
              <span className="sb-label">{n.name}</span>
              <span className="sb-count">{n.count}</span>
            </div>
            {open && <Tree nodes={n.children} depth={depth + 1} isOpen={isOpen} toggle={toggle} renderLeaf={renderLeaf} />}
          </Fragment>
        )
      })}
    </>
  )
}

/** Long flat lists (tags in big repos) are rendered in pages to keep the panel snappy. */
function Paged<T>(props: { items: T[]; render: (item: T, index: number) => ReactNode }) {
  const [limit, setLimit] = useState(PAGE)
  const rest = props.items.length - limit
  return (
    <>
      {props.items.slice(0, limit).map(props.render)}
      {rest > 0 && (
        <button className="sb-more" onClick={() => setLimit(limit + PAGE)}>
          Mostrar {Math.min(rest, PAGE)} más ({rest} restantes)
        </button>
      )}
    </>
  )
}

const AheadBehind = ({ ahead, behind }: { ahead?: number; behind?: number }) =>
  ahead || behind ? (
    <span className="sb-meta">
      {ahead ? <span className="sb-ahead">↑{ahead}</span> : null}
      {behind ? <span className="sb-behind">↓{behind}</span> : null}
    </span>
  ) : null

export function Sidebar() {
  const activeRepo = useStore((s) => s.activeRepo)
  const refs = useStore((s) => s.refs)
  const remotes = useStore((s) => s.remotes)
  const selected = useStore((s) => s.selected)
  const select = useStore((s) => s.select)

  const [filter, setFilter] = useState('')
  /** Last clicked item; it stays highlighted while its commit is the selected one */
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const { isCollapsed, toggle } = useCollapsed()

  const q = filter.trim().toLowerCase()
  const filtering = q !== ''
  // while filtering everything is expanded so no match stays hidden
  const isOpen = (key: string) => filtering || !isCollapsed(key)

  const model = useMemo(() => {
    const match = (...texts: (string | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q))
    const locals = refs.filter((r) => r.type === 'head')
    const stashes = refs.filter((r) => r.type === 'stash')
    const tags = refs.filter((r) => r.type === 'tag')
    const groups = groupRemotes(
      remotes,
      refs.filter((r) => r.type === 'remote')
    )

    const shownLocals = locals.filter((r) => match(r.name))
    const shownGroups = groups
      .map((g) => {
        // a match on the remote name itself keeps all of its branches
        const entries = match(g.name) ? g.entries : g.entries.filter((e) => match(e.ref.name))
        return { ...g, entries, tree: buildTree(entries, `remote/${g.name}`) }
      })
      .filter((g) => !q || g.entries.length > 0 || match(g.name))

    return {
      localCount: shownLocals.length,
      localTree: buildTree(
        shownLocals.map((ref) => ({ label: ref.name, ref })),
        'local'
      ),
      groups: shownGroups,
      // keep the original position: it is the fallback stash index
      stashes: stashes.map((ref, i) => ({ ref, index: stashIndex(ref, i) })).filter((s) => match(s.ref.message, s.ref.name)),
      tags: tags.filter((r) => match(r.name))
    }
  }, [refs, remotes, q])

  const keyOf = (ref: Ref) => `${activeRepo}|${ref.type}:${ref.name}`
  const isActive = (ref: Ref) => activeKey === keyOf(ref) && selected === ref.hash
  const pick = (ref: Ref) => {
    setActiveKey(keyOf(ref))
    select(ref.hash)
  }

  const renderLocal = (leaf: TreeLeaf, depth: number) => {
    const ref = leaf.ref
    return (
      <Row
        key={`head:${ref.name}`}
        depth={depth}
        icon={ref.isCurrent ? <Check size={14} className="sb-check" /> : <GitBranch size={14} />}
        label={leaf.name}
        title={[ref.name, ref.upstream ? `→ ${ref.upstream}` : '', ref.isCurrent ? '(rama actual)' : '']
          .filter(Boolean)
          .join(' ')}
        meta={<AheadBehind ahead={ref.ahead} behind={ref.behind} />}
        active={isActive(ref)}
        current={ref.isCurrent}
        onClick={() => pick(ref)}
        onDoubleClick={() => {
          if (!ref.isCurrent) void checkoutRef(ref.name)
        }}
        onContextMenu={(e) => {
          pick(ref)
          showContextMenu(e, localBranchMenu(ref))
        }}
      />
    )
  }

  const renderRemote = (leaf: TreeLeaf, depth: number) => {
    const ref = leaf.ref
    return (
      <Row
        key={`remote:${ref.name}`}
        depth={depth}
        icon={<GitBranch size={14} />}
        label={leaf.name}
        title={ref.name}
        active={isActive(ref)}
        onClick={() => pick(ref)}
        onDoubleClick={() => void checkoutRef(ref.name)}
        onContextMenu={(e) => {
          pick(ref)
          showContextMenu(e, remoteBranchMenu(ref, remotes))
        }}
      />
    )
  }

  const empty = (text: string) => <div className="sb-empty">{filtering ? 'Sin coincidencias' : text}</div>

  return (
    <div className="sb">
      <div className="sb-filter">
        <Search size={14} className="sb-filter-icon" />
        <input
          spellCheck={false}
          placeholder="Filtrar ramas, stashes y tags"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Escape') setFilter('')
          }}
        />
        {filter && (
          <button className="sb-filter-clear" title="Limpiar filtro" onClick={() => setFilter('')}>
            <X size={13} />
          </button>
        )}
      </div>

      <div className="sb-scroll">
        <Section
          icon={<Monitor size={14} />}
          title="LOCAL"
          count={model.localCount}
          open={isOpen('section:local')}
          onToggle={() => toggle('section:local')}
          onAdd={() => void createBranchAtHead()}
          addTitle="Crear rama"
        >
          {model.localCount === 0 && empty('No hay ramas locales')}
          <Tree nodes={model.localTree} depth={0} isOpen={isOpen} toggle={toggle} renderLeaf={renderLocal} />
        </Section>

        <Section
          icon={<Cloud size={14} />}
          title="REMOTE"
          count={model.groups.length}
          open={isOpen('section:remote')}
          onToggle={() => toggle('section:remote')}
          onAdd={() => void addRemote()}
          addTitle="Añadir remoto"
        >
          {model.groups.length === 0 && empty('No hay remotos')}
          {model.groups.map((g) => {
            const key = `remote:${g.name}`
            const open = isOpen(key)
            return (
              <Fragment key={key}>
                <div
                  className="sb-row sb-remote"
                  style={{ paddingLeft: BASE_PAD }}
                  title={g.url ? `${g.name} — ${g.url}` : g.name}
                  onClick={() => toggle(key)}
                  onContextMenu={(e) => showContextMenu(e, remoteMenu(g.name, g.url))}
                >
                  <Chevron open={open} />
                  <span className="sb-icon">
                    <Cloud size={14} />
                  </span>
                  <span className="sb-label">{g.name}</span>
                  <span className="sb-count">{g.entries.length}</span>
                </div>
                {open && (
                  <Tree nodes={g.tree} depth={1} isOpen={isOpen} toggle={toggle} renderLeaf={renderRemote} />
                )}
              </Fragment>
            )
          })}
        </Section>

        <Section
          icon={<Archive size={14} />}
          title="STASHES"
          count={model.stashes.length}
          open={isOpen('section:stashes')}
          onToggle={() => toggle('section:stashes')}
        >
          {model.stashes.length === 0 && empty('No hay stashes')}
          <Paged
            items={model.stashes}
            render={({ ref, index }) => (
              <Row
                key={`stash:${ref.name}`}
                depth={0}
                icon={<Archive size={14} />}
                label={ref.message || ref.name}
                title={`${ref.name}${ref.message ? ` — ${ref.message}` : ''}`}
                active={isActive(ref)}
                onClick={() => pick(ref)}
                onContextMenu={(e) => {
                  pick(ref)
                  showContextMenu(e, stashMenu(ref, index))
                }}
              />
            )}
          />
        </Section>

        <Section
          icon={<Tag size={14} />}
          title="TAGS"
          count={model.tags.length}
          open={isOpen('section:tags')}
          onToggle={() => toggle('section:tags')}
        >
          {model.tags.length === 0 && empty('No hay tags')}
          <Paged
            items={model.tags}
            render={(ref) => (
              <Row
                key={`tag:${ref.name}`}
                depth={0}
                icon={<Tag size={14} />}
                label={ref.name}
                title={`${ref.name} (${shortSha(ref.hash)})`}
                active={isActive(ref)}
                onClick={() => pick(ref)}
                onContextMenu={(e) => {
                  pick(ref)
                  showContextMenu(e, tagMenu(ref))
                }}
              />
            )}
          />
        </Section>

        <ExtraSections filter={filter} />
        <HostingSections filter={filter} />
      </div>
    </div>
  )
}
