// Sidebar sections rendered after TAGS: SUBMODULES, WORKTREES, LFS.
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import {
  Asterisk,
  Boxes,
  Check,
  Download,
  File,
  Files,
  FolderGit2,
  HardDrive,
  Lock,
  Package,
  PackageOpen,
  Plus,
  RefreshCw,
  TriangleAlert,
  X
} from 'lucide-react'
import type { LfsInfo, Submodule, Worktree } from '@shared/types'
import { useStore } from '../../store'
import { showContextMenu } from '../ui/overlays'
import { shortSha } from '../toolbar/actions'
import { Chevron } from '../sidebar/Section'
import {
  SUBMODULE_STATE,
  addSubmodule,
  addWorktree,
  baseName,
  initLfs,
  lfsFileMenu,
  lfsInstallHint,
  lfsPatternMenu,
  openSubmodule,
  openWorktree,
  pullLfs,
  submoduleMenu,
  trackLfsPattern,
  untrackLfsPattern,
  updateAllSubmodules,
  worktreeMenu
} from './actions'
import { useExtrasData, useOpenState } from './data'
import './extras.css'

// Same geometry as the rows of Sidebar.tsx, so icons line up with the sections above.
const INDENT = 14
const BASE_PAD = 8
const CHEVRON_W = 18
/** Rows rendered per list before "show more" */
const PAGE = 300

interface HeadAction {
  icon: ReactNode
  title: string
  onClick: () => void
}

/**
 * Same markup as `Section` (sidebar/Section.tsx) plus optional action buttons
 * in the header, which that component has no slot for.
 */
function ExSection(props: {
  icon: ReactNode
  title: string
  count: number | string
  open: boolean
  onToggle: () => void
  actions?: HeadAction[]
  onAdd?: () => void
  addTitle?: string
  children: ReactNode
}) {
  return (
    <section className="sb-section">
      <div className="sb-head" onClick={props.onToggle}>
        <Chevron open={props.open} />
        <span className="sb-head-icon">{props.icon}</span>
        <span className="sb-head-title">{props.title}</span>
        {props.actions?.map((a) => (
          <button
            key={a.title}
            className="sb-add"
            title={a.title}
            onClick={(e) => {
              e.stopPropagation()
              a.onClick()
            }}
          >
            {a.icon}
          </button>
        ))}
        <span className="sb-count">{props.count}</span>
        {props.onAdd && (
          <button
            className="sb-add"
            title={props.addTitle}
            onClick={(e) => {
              e.stopPropagation()
              props.onAdd?.()
            }}
          >
            <Plus size={14} />
          </button>
        )}
      </div>
      {props.open && props.children}
    </section>
  )
}

function Row(props: {
  depth?: number
  icon: ReactNode
  label: ReactNode
  meta?: ReactNode
  title?: string
  className?: string
  onDoubleClick?: () => void
  onContextMenu?: (e: MouseEvent) => void
}) {
  return (
    <div
      className={`sb-row${props.className ? ` ${props.className}` : ''}`}
      style={{ paddingLeft: BASE_PAD + CHEVRON_W + (props.depth ?? 0) * INDENT }}
      title={props.title}
      onDoubleClick={props.onDoubleClick}
      onContextMenu={props.onContextMenu}
    >
      <span className="sb-icon">{props.icon}</span>
      <span className="sb-label">{props.label}</span>
      {props.meta}
    </div>
  )
}

function Paged<T>(props: { items: T[]; render: (item: T, index: number) => ReactNode }) {
  const [limit, setLimit] = useState(PAGE)
  const rest = props.items.length - limit
  return (
    <>
      {props.items.slice(0, limit).map(props.render)}
      {rest > 0 && (
        <button className="sb-more" onClick={() => setLimit(limit + PAGE)}>
          Show {Math.min(rest, PAGE)} more ({rest} remaining)
        </button>
      )}
    </>
  )
}

const Badge = ({ kind, title, children }: { kind?: 'warn' | 'danger'; title?: string; children: ReactNode }) => (
  <span className={`ex-badge${kind ? ` ex-${kind}` : ''}`} title={title}>
    {children}
  </span>
)

const ReadError = ({ text }: { text?: string }) => (text ? <div className="sb-empty ex-error">{text}</div> : null)

// ----- submodules ------------------------------------------------------------

const SUBMODULE_ICON: Record<Submodule['status'], ReactNode> = {
  ok: <Package size={14} />,
  uninitialized: <PackageOpen size={14} />,
  modified: <Package size={14} />,
  conflict: <TriangleAlert size={14} />
}

function SubmoduleRow({ sub, depth }: { sub: Submodule; depth: number }) {
  const state = SUBMODULE_STATE[sub.status]
  const title = [
    sub.path,
    sub.url,
    `Status: ${state}`,
    `Recorded commit: ${sub.hash}`,
    sub.branch ? `Branch: ${sub.branch}` : sub.status === 'uninitialized' ? '' : 'Detached HEAD',
    sub.status === 'uninitialized' ? 'Double-click to initialize it' : 'Double-click to open it in a tab'
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <Row
      depth={depth}
      className={`ex-sub-${sub.status}`}
      icon={SUBMODULE_ICON[sub.status]}
      label={sub.path}
      title={title}
      meta={
        // The sidebar is narrow: a state badge takes the place of the hash (which stays in the tooltip).
        sub.status === 'uninitialized' ? (
          <Badge>not init</Badge>
        ) : sub.status === 'modified' ? (
          <Badge kind="warn">modified</Badge>
        ) : sub.status === 'conflict' ? (
          <Badge kind="danger">conflict</Badge>
        ) : (
          <span className="sb-meta ex-sha">{shortSha(sub.hash)}</span>
        )
      }
      onDoubleClick={() => void openSubmodule(sub)}
      onContextMenu={(e) => showContextMenu(e, submoduleMenu(sub))}
    />
  )
}

// ----- worktrees ---------------------------------------------------------------

function WorktreeRow({ wt, current }: { wt: Worktree; current: boolean }) {
  const where = wt.branch ?? (wt.head ? shortSha(wt.head) : 'bare')
  const title = [
    wt.path,
    wt.branch ? `Branch: ${wt.branch}` : wt.head ? `Detached HEAD at ${shortSha(wt.head)}` : 'Bare repository',
    wt.isMain ? 'Main worktree' : '',
    wt.locked ? 'Locked (git worktree lock)' : '',
    wt.prunable ? 'Its folder no longer exists' : '',
    current ? 'Open in this tab' : wt.prunable ? '' : 'Double-click to open it in a tab'
  ]
    .filter(Boolean)
    .join('\n')
  return (
    <Row
      className={`${current ? 'current' : ''}${wt.prunable ? ' ex-gone' : ''}`}
      icon={current ? <Check size={14} className="sb-check" /> : <FolderGit2 size={14} />}
      label={
        <>
          {baseName(wt.path)}
          <span className={`ex-where${wt.branch ? '' : ' ex-detached'}`}>{where}</span>
        </>
      }
      title={title}
      meta={
        <>
          {wt.isMain && <Badge>main</Badge>}
          {wt.locked && (
            <Badge kind="warn" title="Locked">
              <Lock size={10} />
            </Badge>
          )}
          {wt.prunable && <Badge kind="danger">missing</Badge>}
        </>
      }
      onDoubleClick={() => void openWorktree(wt)}
      onContextMenu={(e) => showContextMenu(e, worktreeMenu(wt))}
    />
  )
}

// ----- LFS -----------------------------------------------------------------------

function LfsBody(props: { info: LfsInfo; patterns: string[]; files: string[]; filtering: boolean }) {
  const { info, patterns, files, filtering } = props
  const [showFiles, setShowFiles] = useState(false)
  const filesOpen = filtering || showFiles
  return (
    <>
      {filtering ? null : !info.installed ? (
        <div className="ex-status ex-status-warn">
          <strong>git-lfs is not installed on this computer.</strong>
          <span>This repository uses LFS: without it you only get the pointer files. {lfsInstallHint()}</span>
        </div>
      ) : !info.enabled ? (
        <div className="ex-status">
          <span>LFS is not initialized in this repository.</span>
          <button className="btn ex-btn" onClick={() => void initLfs()}>
            Initialize LFS in this repository
          </button>
        </div>
      ) : (
        <div className="ex-status ex-status-ok">
          <span>
            <i className="ex-dot" />
            LFS is active in this repository
          </span>
        </div>
      )}

      {patterns.length === 0 && !(filtering && files.length > 0) && (
        <div className="sb-empty">{filtering ? 'No matches' : 'No tracked patterns'}</div>
      )}
      {patterns.map((pattern) => (
        <Row
          key={`pattern:${pattern}`}
          className="ex-pattern"
          icon={<Asterisk size={14} />}
          label={pattern}
          title={`${pattern}\n.gitattributes pattern tracked with LFS`}
          meta={
            info.installed ? (
              <button
                className="ex-row-btn"
                title={`Stop tracking ${pattern}`}
                onClick={(e) => {
                  e.stopPropagation()
                  void untrackLfsPattern(pattern)
                }}
              >
                <X size={13} />
              </button>
            ) : undefined
          }
          onContextMenu={(e) => showContextMenu(e, lfsPatternMenu(pattern, info))}
        />
      ))}

      {(filtering ? files.length > 0 : info.files.length > 0 || info.enabled) && (
        <div
          className="sb-row sb-folder"
          style={{ paddingLeft: BASE_PAD }}
          title={info.files.length ? 'Files stored in LFS' : 'No files stored in LFS yet'}
          onClick={() => setShowFiles(!showFiles)}
        >
          <Chevron open={filesOpen} />
          <span className="sb-icon">
            <Files size={14} />
          </span>
          <span className="sb-label">LFS files</span>
          <span className="sb-count">{files.length}</span>
        </div>
      )}
      {filesOpen && (
        <Paged
          items={files}
          render={(file) => (
            <Row
              key={`file:${file}`}
              depth={1}
              icon={<File size={14} />}
              label={file}
              title={file}
              onContextMenu={(e) => showContextMenu(e, lfsFileMenu(file))}
            />
          )}
        />
      )}
    </>
  )
}

// ----- the three sections --------------------------------------------------------

export function ExtraSections({ filter }: { filter: string }) {
  const activeRepo = useStore((s) => s.activeRepo)
  const loaded = useExtrasData()
  const { isOpen, toggle } = useOpenState()

  const q = filter.trim().toLowerCase()
  const filtering = q !== ''

  const model = useMemo(() => {
    const match = (...texts: (string | null | undefined)[]) => !q || texts.some((t) => t?.toLowerCase().includes(q))
    // Never show another repository's lists while the new ones load.
    const fresh = loaded.repo === activeRepo
    const submodules = fresh ? loaded.submodules : []
    const worktrees = fresh ? loaded.worktrees : []
    const lfs = fresh ? loaded.lfs : null

    const paths = submodules.map((s) => s.path)
    /** Number of listed submodules that contain this one */
    const depthOf = (path: string) => paths.filter((p) => path.startsWith(`${p}/`)).length

    return {
      submoduleTotal: submodules.length,
      submodules: submodules
        .filter((s) => match(s.path, s.url, s.branch))
        .map((sub) => ({ sub, depth: filtering ? 0 : depthOf(sub.path) })),
      worktreeTotal: worktrees.length,
      worktrees: worktrees
        .filter((w) => match(w.path, w.branch))
        // main first, then by folder name
        .sort((a, b) => Number(b.isMain) - Number(a.isMain) || baseName(a.path).localeCompare(baseName(b.path), undefined, { numeric: true, sensitivity: 'base' })),
      lfs,
      patterns: lfs ? lfs.patterns.filter((p) => match(p)) : [],
      files: lfs ? (q ? lfs.files.filter((f) => match(f)) : lfs.files) : [],
      errors: fresh ? loaded.errors : {}
    }
  }, [loaded, activeRepo, q, filtering])

  if (!activeRepo) return null

  const empty = (text: string) => <div className="sb-empty">{filtering ? 'No matches' : text}</div>
  // While filtering everything is expanded so no match stays hidden (as in the sections above).
  const section = (key: string, openByDefault: boolean) => {
    const open = isOpen(key, openByDefault)
    return { open: filtering || open, onToggle: () => toggle(key, open) }
  }

  const { lfs } = model
  // LFS is only relevant when the tool is available or the repository already uses it.
  const showLfs = lfs !== null && (lfs.installed || lfs.enabled || lfs.patterns.length > 0 || lfs.files.length > 0)

  return (
    <>
      <ExSection
        icon={<Boxes size={14} />}
        title="SUBMODULES"
        count={model.submodules.length}
        {...section('section:submodules', model.submoduleTotal > 0 || !!model.errors.submodules)}
        actions={
          model.submoduleTotal > 0
            ? [{ icon: <RefreshCw size={13} />, title: 'Update all submodules', onClick: () => void updateAllSubmodules() }]
            : undefined
        }
        onAdd={() => void addSubmodule()}
        addTitle="Add submodule"
      >
        <ReadError text={model.errors.submodules} />
        {model.submodules.length === 0 && !model.errors.submodules && empty('No submodules')}
        <Paged
          items={model.submodules}
          render={({ sub, depth }) => <SubmoduleRow key={`sub:${sub.path}`} sub={sub} depth={depth} />}
        />
      </ExSection>

      <ExSection
        icon={<FolderGit2 size={14} />}
        title="WORKTREES"
        count={model.worktrees.length}
        // just the main worktree: nothing to see until the user adds one
        {...section('section:worktrees', model.worktreeTotal > 1 || !!model.errors.worktrees)}
        onAdd={() => void addWorktree()}
        addTitle="New worktree"
      >
        <ReadError text={model.errors.worktrees} />
        {model.worktrees.length === 0 && !model.errors.worktrees && empty('No worktrees')}
        <Paged
          items={model.worktrees}
          render={(wt) => <WorktreeRow key={`wt:${wt.path}`} wt={wt} current={wt.path === activeRepo} />}
        />
      </ExSection>

      {showLfs && lfs && (
        <ExSection
          icon={<HardDrive size={14} />}
          title="LFS"
          count={model.patterns.length}
          {...section('section:lfs', lfs.patterns.length > 0 || lfs.enabled)}
          actions={
            lfs.installed
              ? [{ icon: <Download size={13} />, title: 'LFS pull: download the LFS files', onClick: () => void pullLfs() }]
              : undefined
          }
          onAdd={lfs.installed ? () => void trackLfsPattern() : undefined}
          addTitle="Track a pattern with LFS (e.g. *.psd)"
        >
          <ReadError text={model.errors.lfs} />
          <LfsBody info={lfs} patterns={model.patterns} files={model.files} filtering={filtering} />
        </ExSection>
      )}
    </>
  )
}
