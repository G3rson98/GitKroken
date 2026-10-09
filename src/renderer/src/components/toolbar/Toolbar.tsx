import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  Archive,
  ArchiveRestore,
  ArrowDownToLine,
  ArrowUpFromLine,
  ChevronDown,
  ChevronRight,
  FolderGit2,
  GitBranch,
  GitBranchPlus,
  LoaderCircle,
  Redo2,
  RefreshCw,
  SquareTerminal,
  TriangleAlert,
  Undo2,
  X
} from 'lucide-react'
import type { Status, UndoState } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog, toast } from '../ui/overlays'
import { Selector, type SelectorItem } from './Selector'
import {
  cancelNetworkOp,
  checkoutRef,
  createBranchAtHead,
  errText,
  forcePush,
  isNetworkOp,
  menuBelow,
  openRepoFromDisk,
  pushBranch,
  run,
  shortSha
} from './actions'
import { fullRefName, topStash } from '../../lib/refs'
import './toolbar.css'

const OP_LABEL: Record<NonNullable<Status['inProgress']>, string> = {
  merge: 'Merge',
  rebase: 'Rebase',
  'cherry-pick': 'Cherry-pick',
  revert: 'Revert'
}

function ToolButton(props: {
  icon: ReactNode
  label: string
  title: string
  badge?: number
  disabled?: boolean
  onClick: () => void
}) {
  return (
    <button className="tool-btn" title={props.title} disabled={props.disabled} onClick={props.onClick}>
      <span className="tool-btn-icon">
        {props.icon}
        {props.badge ? <span className="tool-badge">{props.badge > 99 ? '99+' : props.badge}</span> : null}
      </span>
      <span className="tool-btn-label">{props.label}</span>
    </button>
  )
}

const NOTHING_TO_UNDO: UndoState = { undo: null, redo: null }

/**
 * What Undo / Redo would do right now. Asked again after every store refresh
 * (each refresh replaces `status` and `refs`). Any failure means "nothing to undo".
 */
function useUndoState(): UndoState {
  const activeRepo = useStore((s) => s.activeRepo)
  const status = useStore((s) => s.status)
  const refs = useStore((s) => s.refs)
  const [state, setState] = useState<UndoState>(NOTHING_TO_UNDO)
  const shownFor = useRef<string | null>(null)

  useEffect(() => {
    if (shownFor.current !== activeRepo) {
      // Another repository: its history is not ours to offer.
      shownFor.current = activeRepo
      setState(NOTHING_TO_UNDO)
    }
    if (!activeRepo) return
    let stale = false
    git.undoState(activeRepo).then(
      (next) => {
        if (!stale) setState({ undo: next?.undo ?? null, redo: next?.redo ?? null })
      },
      () => {
        if (!stale) setState(NOTHING_TO_UNDO)
      }
    )
    return () => {
      stale = true
    }
  }, [activeRepo, status, refs])

  return state
}

/** Spinner + label of the running operation, with Cancel while it is a network transfer. */
function BusyIndicator({ busy }: { busy: string }) {
  const [cancelling, setCancelling] = useState(false)
  // A new operation gets a fresh button.
  useEffect(() => setCancelling(false), [busy])
  const onCancel = () => {
    setCancelling(true)
    void cancelNetworkOp().finally(() => setCancelling(false))
  }
  return (
    <span className="tool-busy" title={busy}>
      <LoaderCircle size={15} className="tool-spin" />
      <span className="tool-busy-label">{busy}…</span>
      {isNetworkOp(busy) && (
        <button className="tool-cancel" title={`Cancel ${busy}`} disabled={cancelling} onClick={onCancel}>
          <X size={12} />
          Cancel
        </button>
      )}
    </span>
  )
}

function OperationBanner() {
  const status = useStore((s) => s.status)
  const busy = useStore((s) => s.busy)
  const op = status?.inProgress
  if (!status || !op) return null

  const label = OP_LABEL[op]
  const n = status.conflicted.length
  const conflicts = n === 0 ? 'no conflicts left' : n === 1 ? '1 conflict' : `${n} conflicts`

  const onContinue = async () => {
    const ok = await run(`Continue ${label}`, (repo) => git.continueOp(repo))
    // a rebase may stop again on the next commit, so only announce it when it really ended
    if (ok && !useStore.getState().status?.inProgress) toast(`${label} complete`, 'success')
  }
  const onAbort = async () => {
    const yes = await confirmDialog({
      title: `Abort ${label}`,
      message: `The ${label.toLowerCase()} in progress will be discarded and the repository goes back to how it was before.`,
      confirmLabel: 'Abort',
      danger: true
    })
    if (yes) await run(`Abort ${label}`, (repo) => git.abort(repo), `${label} aborted`)
  }

  return (
    <div className={`tool-banner${n > 0 ? ' conflicts' : ''}`} role="alert">
      <TriangleAlert size={16} />
      <span className="tool-banner-text">
        <strong>{label} in progress</strong> — {conflicts}
      </span>
      <button
        className="btn btn-primary"
        disabled={!!busy || n > 0}
        title={n > 0 ? 'Resolve and stage the conflicted files to continue' : `Continue ${label}`}
        onClick={() => void onContinue()}
      >
        Continue
      </button>
      <button className="btn btn-danger" disabled={!!busy} onClick={() => void onAbort()}>
        Abort
      </button>
    </div>
  )
}

export function Toolbar() {
  const tabs = useStore((s) => s.tabs)
  const recent = useStore((s) => s.recent)
  const activeRepo = useStore((s) => s.activeRepo)
  const refs = useStore((s) => s.refs)
  const remotes = useStore((s) => s.remotes)
  const status = useStore((s) => s.status)
  const busy = useStore((s) => s.busy)
  const loading = useStore((s) => s.loading)
  const undoState = useUndoState()

  const locked = busy !== null
  const locals = refs.filter((r) => r.type === 'head')
  const current = locals.find((r) => r.isCurrent)
  const stashCount = refs.filter((r) => r.type === 'stash').length
  const branchName = status?.branch ?? current?.name ?? null
  const detached = status !== null && status.branch === null
  const hasRemotes = remotes.length > 0
  const hasChanges = !!status && status.staged.length + status.unstaged.length + status.conflicted.length > 0
  const repoName = tabs.find((t) => t.path === activeRepo)?.name ?? activeRepo?.split(/[\\/]/).filter(Boolean).pop() ?? ''

  // ----- selectors ---------------------------------------------------------
  const repoItems: SelectorItem[] = [
    ...tabs.map((t) => ({
      key: `tab:${t.path}`,
      label: t.name,
      hint: t.path,
      group: 'Open',
      current: t.path === activeRepo,
      onSelect: () => {
        if (t.path !== useStore.getState().activeRepo) useStore.getState().setActive(t.path)
      }
    })),
    ...recent
      .filter((r) => !tabs.some((t) => t.path === r.path))
      .map((r) => ({
        key: `recent:${r.path}`,
        label: r.name,
        hint: r.path,
        group: 'Recent',
        onSelect: () => void useStore.getState().openRepo(r.path)
      }))
  ]

  const branchItems: SelectorItem[] = locals.map((r) => ({
    key: r.name,
    label: r.name,
    hint: [r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ') || undefined,
    current: r.isCurrent,
    onSelect: () => {
      if (!r.isCurrent) void checkoutRef(fullRefName(r))
    }
  }))

  const branchValue = branchName ?? (status?.head ? shortSha(status.head) : status ? 'no commits' : '…')

  // ----- actions -----------------------------------------------------------
  /** `rebase` undefined: whatever the user configured (pull.rebase), merge otherwise */
  const pull = (rebase?: boolean) =>
    void run(
      rebase === undefined ? 'Pull' : rebase ? 'Pull (rebase)' : 'Pull (merge)',
      (repo) => (rebase === undefined ? git.pull(repo) : git.pull(repo, { rebase })),
      'Pull complete'
    )
  const fetchAll = () => void run('Fetch', (repo) => git.fetch(repo), 'Fetch complete')
  const push = () => void pushBranch()
  const stash = () => void run('Stash', (repo) => git.stashSave(repo), 'Changes stashed')
  const pop = () => {
    const top = topStash()
    if (top) void run('Pop', (repo) => git.stashPop(repo, 0, top.hash), 'Stash applied')
  }
  const undo = () => void run('Undo', (repo) => git.undo(repo), undoState.undo ? `Undone: ${undoState.undo}` : undefined)
  const redo = () => void run('Redo', (repo) => git.redo(repo), undoState.redo ? `Redone: ${undoState.redo}` : undefined)
  const openTerminal = () => {
    if (activeRepo) git.openInTerminal(activeRepo).catch((e) => toast(`Terminal: ${errText(e)}`, 'error'))
  }

  const noRemoteHint = hasRemotes ? '' : ' (no remotes configured)'

  return (
    <>
      <div className="tool">
        <div className="tool-left">
          <Selector
            caption="repository"
            value={repoName}
            title={activeRepo ?? undefined}
            icon={<FolderGit2 size={14} />}
            items={repoItems}
            filterPlaceholder="Filter repositories"
            emptyText="No repository matches"
            footer={{ label: 'Open repository…', onSelect: () => void openRepoFromDisk() }}
          />
          <ChevronRight size={14} className="tool-crumb-sep" />
          <Selector
            caption={detached ? 'detached HEAD' : 'branch'}
            value={branchValue}
            title={detached ? `Detached HEAD at ${status?.head ?? ''}` : branchName ?? undefined}
            icon={<GitBranch size={14} />}
            items={branchItems}
            filterPlaceholder="Filter local branches"
            emptyText="No branch matches"
            disabled={locked}
          />
        </div>

        <div className="tool-center">
          <ToolButton
            icon={<Undo2 size={18} />}
            label="Undo"
            title={undoState.undo ? `Undo: ${undoState.undo}` : 'Nothing to undo'}
            disabled={locked || !undoState.undo}
            onClick={undo}
          />
          <ToolButton
            icon={<Redo2 size={18} />}
            label="Redo"
            title={undoState.redo ? `Redo: ${undoState.redo}` : 'Nothing to redo'}
            disabled={locked || !undoState.redo}
            onClick={redo}
          />
          <span className="tool-sep" />
          <div className="tool-split">
            <ToolButton
              icon={<ArrowDownToLine size={18} />}
              label="Pull"
              title={`Pull: fetch and integrate the remote changes, using your pull.rebase setting (merge by default)${noRemoteHint}`}
              badge={current?.behind}
              disabled={locked || !hasRemotes || detached}
              onClick={() => pull()}
            />
            <button
              className="tool-caret"
              title="Pull options"
              disabled={locked || !hasRemotes}
              onClick={(e) =>
                menuBelow(e.currentTarget, [
                  { label: 'Fetch All', onClick: fetchAll },
                  { separator: true },
                  { label: 'Pull (merge)', onClick: () => pull(false), disabled: detached },
                  { label: 'Pull (rebase)', onClick: () => pull(true), disabled: detached }
                ])
              }
            >
              <ChevronDown size={12} />
            </button>
          </div>
          <div className="tool-split">
            <ToolButton
              icon={<ArrowUpFromLine size={18} />}
              label="Push"
              title={`Push: send the current branch to the remote${noRemoteHint}`}
              badge={current?.ahead}
              disabled={locked || !hasRemotes || detached}
              onClick={push}
            />
            <button
              className="tool-caret"
              title="Push options"
              disabled={locked || !hasRemotes || detached || !branchName}
              onClick={(e) =>
                menuBelow(e.currentTarget, [
                  { label: 'Push', onClick: push },
                  { label: 'Force Push (with lease)…', onClick: () => branchName && void forcePush(branchName), danger: true }
                ])
              }
            >
              <ChevronDown size={12} />
            </button>
          </div>
          <span className="tool-sep" />
          <ToolButton
            icon={<GitBranchPlus size={18} />}
            label="Branch"
            title="Create a branch at HEAD and check it out"
            disabled={locked}
            onClick={() => void createBranchAtHead()}
          />
          <span className="tool-sep" />
          <ToolButton
            icon={<Archive size={18} />}
            label="Stash"
            title={hasChanges ? 'Stash the local changes' : 'No changes to stash'}
            disabled={locked || !hasChanges}
            onClick={stash}
          />
          <ToolButton
            icon={<ArchiveRestore size={18} />}
            label="Pop"
            title={stashCount ? 'Apply and drop the most recent stash' : 'No stashes'}
            disabled={locked || stashCount === 0}
            onClick={pop}
          />
        </div>

        <div className="tool-right">
          {busy && <BusyIndicator busy={busy} />}
          <ToolButton
            icon={<SquareTerminal size={18} />}
            label="Terminal"
            title="Open a terminal in the repository"
            onClick={openTerminal}
          />
          <button
            className="tool-icon-btn"
            title="Refresh"
            disabled={locked}
            onClick={() => void useStore.getState().refresh()}
          >
            <RefreshCw size={16} className={loading ? 'tool-spin' : undefined} />
          </button>
        </div>
      </div>
      <OperationBanner />
    </>
  )
}
