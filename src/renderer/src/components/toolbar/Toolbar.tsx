import type { ReactNode } from 'react'
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
  RefreshCw,
  SquareTerminal,
  TriangleAlert
} from 'lucide-react'
import type { Status } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog, toast } from '../ui/overlays'
import { Selector, type SelectorItem } from './Selector'
import { checkoutRef, createBranchAtHead, errText, menuBelow, openRepoFromDisk, run, shortSha } from './actions'
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

function OperationBanner() {
  const status = useStore((s) => s.status)
  const busy = useStore((s) => s.busy)
  const op = status?.inProgress
  if (!status || !op) return null

  const label = OP_LABEL[op]
  const n = status.conflicted.length
  const conflicts = n === 0 ? 'sin conflictos pendientes' : n === 1 ? '1 conflicto' : `${n} conflictos`

  const onContinue = async () => {
    const ok = await run(`Continuar ${label}`, (repo) => git.continueOp(repo))
    // a rebase may stop again on the next commit, so only announce it when it really ended
    if (ok && !useStore.getState().status?.inProgress) toast(`${label} completado`, 'success')
  }
  const onAbort = async () => {
    const yes = await confirmDialog({
      title: `Abortar ${label}`,
      message: `Se descartará el ${label} en curso y se volverá al estado anterior.`,
      confirmLabel: 'Abortar',
      danger: true
    })
    if (yes) await run(`Abortar ${label}`, (repo) => git.abort(repo), `${label} abortado`)
  }

  return (
    <div className={`tool-banner${n > 0 ? ' conflicts' : ''}`} role="alert">
      <TriangleAlert size={16} />
      <span className="tool-banner-text">
        <strong>{label} en curso</strong> — {conflicts}
      </span>
      <button
        className="btn btn-primary"
        disabled={!!busy || n > 0}
        title={n > 0 ? 'Resuelve y prepara los archivos en conflicto para continuar' : `Continuar ${label}`}
        onClick={() => void onContinue()}
      >
        Continuar
      </button>
      <button className="btn btn-danger" disabled={!!busy} onClick={() => void onAbort()}>
        Abortar
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
      group: 'Abiertos',
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
        group: 'Recientes',
        onSelect: () => void useStore.getState().openRepo(r.path)
      }))
  ]

  const branchItems: SelectorItem[] = locals.map((r) => ({
    key: r.name,
    label: r.name,
    hint: [r.ahead ? `↑${r.ahead}` : '', r.behind ? `↓${r.behind}` : ''].filter(Boolean).join(' ') || undefined,
    current: r.isCurrent,
    onSelect: () => {
      if (!r.isCurrent) void checkoutRef(r.name)
    }
  }))

  const branchValue = branchName ?? (status?.head ? shortSha(status.head) : status ? 'sin commits' : '…')

  // ----- actions -----------------------------------------------------------
  const pull = (rebase: boolean) =>
    void run(rebase ? 'Pull (rebase)' : 'Pull', (repo) => git.pull(repo, { rebase }), 'Pull completado')
  const fetchAll = () => void run('Fetch', (repo) => git.fetch(repo), 'Fetch completado')
  const push = () => void run('Push', (repo) => git.push(repo), 'Push completado')
  const stash = () => void run('Stash', (repo) => git.stashSave(repo), 'Cambios guardados en el stash')
  const pop = () => void run('Pop', (repo) => git.stashPop(repo, 0), 'Stash aplicado')
  const openTerminal = () => {
    if (activeRepo) git.openInTerminal(activeRepo).catch((e) => toast(`Terminal: ${errText(e)}`, 'error'))
  }

  const noRemoteHint = hasRemotes ? '' : ' (no hay remotos configurados)'

  return (
    <>
      <div className="tool">
        <div className="tool-left">
          <Selector
            caption="repositorio"
            value={repoName}
            title={activeRepo ?? undefined}
            icon={<FolderGit2 size={14} />}
            items={repoItems}
            filterPlaceholder="Filtrar repositorios"
            emptyText="Ningún repositorio coincide"
            footer={{ label: 'Abrir repositorio…', onSelect: () => void openRepoFromDisk() }}
          />
          <ChevronRight size={14} className="tool-crumb-sep" />
          <Selector
            caption={detached ? 'HEAD separado' : 'rama'}
            value={branchValue}
            title={detached ? `HEAD separado en ${status?.head ?? ''}` : branchName ?? undefined}
            icon={<GitBranch size={14} />}
            items={branchItems}
            filterPlaceholder="Filtrar ramas locales"
            emptyText="Ninguna rama coincide"
            disabled={locked}
          />
        </div>

        <div className="tool-center">
          <div className="tool-split">
            <ToolButton
              icon={<ArrowDownToLine size={18} />}
              label="Pull"
              title={`Pull: traer y fusionar los cambios del remoto${noRemoteHint}`}
              badge={current?.behind}
              disabled={locked || !hasRemotes || detached}
              onClick={() => pull(false)}
            />
            <button
              className="tool-caret"
              title="Opciones de pull"
              disabled={locked || !hasRemotes}
              onClick={(e) =>
                menuBelow(e.currentTarget, [
                  { label: 'Fetch de todos los remotos', onClick: fetchAll },
                  { separator: true },
                  { label: 'Pull (merge)', onClick: () => pull(false), disabled: detached },
                  { label: 'Pull (rebase)', onClick: () => pull(true), disabled: detached }
                ])
              }
            >
              <ChevronDown size={12} />
            </button>
          </div>
          <ToolButton
            icon={<ArrowUpFromLine size={18} />}
            label="Push"
            title={`Push: enviar la rama actual al remoto${noRemoteHint}`}
            badge={current?.ahead}
            disabled={locked || !hasRemotes || detached}
            onClick={push}
          />
          <span className="tool-sep" />
          <ToolButton
            icon={<GitBranchPlus size={18} />}
            label="Rama"
            title="Crear una rama en HEAD y cambiar a ella"
            disabled={locked}
            onClick={() => void createBranchAtHead()}
          />
          <span className="tool-sep" />
          <ToolButton
            icon={<Archive size={18} />}
            label="Stash"
            title={hasChanges ? 'Guardar los cambios locales en el stash' : 'No hay cambios que guardar'}
            disabled={locked || !hasChanges}
            onClick={stash}
          />
          <ToolButton
            icon={<ArchiveRestore size={18} />}
            label="Pop"
            title={stashCount ? 'Aplicar y eliminar el stash más reciente' : 'No hay stashes'}
            disabled={locked || stashCount === 0}
            onClick={pop}
          />
        </div>

        <div className="tool-right">
          {busy && (
            <span className="tool-busy" title={busy}>
              <LoaderCircle size={15} className="tool-spin" />
              <span className="tool-busy-label">{busy}…</span>
            </span>
          )}
          <ToolButton
            icon={<SquareTerminal size={18} />}
            label="Terminal"
            title="Abrir una terminal en el repositorio"
            onClick={openTerminal}
          />
          <button
            className="tool-icon-btn"
            title="Actualizar"
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
