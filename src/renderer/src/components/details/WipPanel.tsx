// Staging area (WIP mode of the right panel): conflicted / unstaged / staged
// file lists plus the commit form.
import { useState, type MouseEvent, type ReactNode } from 'react'
import { FolderTree, GitMerge, List, Trash2, TriangleAlert } from 'lucide-react'
import type { FileChange, Status } from '@shared/types'
import { useStore, type SelectedFile } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog, showContextMenu, toast, type MenuItem } from '../ui/overlays'
import { CommitForm } from './CommitForm'
import { FILE_VIEWS, FILE_VIEW_KEY, FileList, type FileViewMode } from './FileList'
import { Segmented, copyText, plural, readPref, writePref } from './common'

type Section = 'conflicted' | 'unstaged' | 'staged'

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

const run = (label: string, fn: (repo: string) => Promise<unknown>, ok?: string) =>
  useStore.getState().run(label, fn, ok)

/** Paths git needs to see to (un)stage a file; a rename involves both names */
const pathsOf = (files: FileChange[]) => [...new Set(files.flatMap((f) => (f.oldPath ? [f.path, f.oldPath] : [f.path])))]

const stage = (files: FileChange[]) => run('Stage', (r) => git.stage(r, files.map((f) => f.path)))
const unstage = (files: FileChange[]) => run('Unstage', (r) => git.unstage(r, pathsOf(files)))

const IN_PROGRESS: Record<NonNullable<Status['inProgress']>, string> = {
  merge: 'Merge en curso',
  rebase: 'Rebase en curso',
  'cherry-pick': 'Cherry-pick en curso',
  revert: 'Revert en curso'
}

function revealLabel(): string {
  const p = window.bridge.platform
  return p === 'darwin' ? 'Mostrar en Finder' : p === 'win32' ? 'Mostrar en el Explorador' : 'Mostrar en el gestor de archivos'
}

async function discard(file: FileChange, section: Section): Promise<void> {
  const untracked = file.status === 'untracked'
  const ok = await confirmDialog({
    title: untracked ? 'Eliminar archivo sin seguimiento' : 'Descartar cambios',
    message: untracked
      ? `Se eliminará "${file.path}" del disco. Esta acción no se puede deshacer.`
      : section === 'staged'
        ? `Se descartarán todos los cambios de "${file.path}", tanto los que están en stage como los que no. Esta acción no se puede deshacer.`
        : `Se descartarán los cambios sin stage de "${file.path}". Esta acción no se puede deshacer.`,
    confirmLabel: untracked ? 'Eliminar' : 'Descartar',
    danger: true
  })
  if (!ok) return
  const paths = pathsOf([file])
  await run('Descartar cambios', async (r) => {
    if (section === 'staged') await git.unstage(r, paths)
    await git.discard(r, section === 'staged' ? paths : [file.path])
  })
}

export function WipPanel({ repo, status }: { repo: string; status: Status }) {
  const selectedFile = useStore((s) => s.selectedFile)
  const busy = useStore((s) => s.busy !== null)
  const [view, setViewState] = useState<FileViewMode>(() => readPref(FILE_VIEW_KEY, FILE_VIEWS, 'path'))
  const setView = (v: FileViewMode) => {
    setViewState(v)
    writePref(FILE_VIEW_KEY, v)
  }

  const { staged, unstaged, conflicted } = status
  const total = new Set([...staged, ...unstaged, ...conflicted].map((f) => f.path)).size

  const open = (file: FileChange, section: Section) => {
    const next: SelectedFile = { path: file.path, staged: section === 'staged' }
    if (file.oldPath) next.oldPath = file.oldPath
    if (section !== 'staged' && file.status === 'untracked') next.untracked = true
    useStore.getState().selectFile(next)
  }

  const isSelected = (file: FileChange, section: Section) =>
    !!selectedFile &&
    !selectedFile.commit &&
    selectedFile.path === file.path &&
    !!selectedFile.staged === (section === 'staged')

  const menu = (e: MouseEvent, file: FileChange, section: Section) => {
    const items: MenuItem[] = [
      { label: 'Ver cambios', onClick: () => open(file, section) },
      section === 'staged'
        ? { label: 'Unstage', onClick: () => void unstage([file]) }
        : {
            label: section === 'conflicted' ? 'Marcar como resuelto (Stage)' : 'Stage',
            onClick: () => void stage([file])
          },
      {
        label: file.status === 'untracked' ? 'Eliminar archivo…' : 'Descartar cambios…',
        danger: true,
        disabled: section === 'conflicted',
        onClick: () => void discard(file, section)
      },
      { separator: true },
      {
        label: revealLabel(),
        disabled: file.status === 'deleted',
        onClick: () => {
          git.reveal(`${repo}/${file.path}`).catch((err) => toast(errText(err), 'error'))
        }
      },
      { label: 'Copiar ruta', onClick: () => copyText(file.path, 'Ruta') },
      { label: 'Copiar ruta absoluta', onClick: () => copyText(`${repo}/${file.path}`, 'Ruta') }
    ]
    showContextMenu(e, items)
  }

  const stageBtn = (files: FileChange[], title: string) => (
    <button className="gd-mini-btn green" disabled={busy} title={title} onClick={() => void stage(files)}>
      Stage
    </button>
  )
  const unstageBtn = (files: FileChange[], title: string) => (
    <button className="gd-mini-btn red" disabled={busy} title={title} onClick={() => void unstage(files)}>
      Unstage
    </button>
  )

  const list = (section: Section, files: FileChange[], emptyText: string) => (
    <FileList
      files={files}
      view={view}
      emptyText={emptyText}
      isSelected={(f) => isSelected(f, section)}
      onOpen={(f) => open(f, section)}
      onContextMenu={(e, f) => menu(e, f, section)}
      actions={(f) =>
        section === 'staged'
          ? unstageBtn([f], 'Quitar del stage')
          : stageBtn([f], section === 'conflicted' ? 'Marcar como resuelto' : 'Añadir al stage')
      }
      folderActions={(fs) =>
        section === 'staged'
          ? unstageBtn(fs, 'Quitar la carpeta del stage')
          : stageBtn(fs, 'Añadir la carpeta al stage')
      }
    />
  )

  const discardAll = async () => {
    const ok = await confirmDialog({
      title: 'Descartar todos los cambios',
      message:
        'Se descartarán todos los cambios del directorio de trabajo, incluidos los archivos sin seguimiento. Esta acción no se puede deshacer.',
      confirmLabel: 'Descartar todo',
      danger: true
    })
    if (ok) await run('Descartar todo', (r) => git.discardAll(r), 'Cambios descartados')
  }

  return (
    <div className="rp-wip">
      <div className="rp-head">
        <span className="rp-head-title">
          {total === 0 ? 'Sin cambios' : plural(total, 'cambio', 'cambios')}
          {status.branch ? (
            <>
              {' en '}
              <span className="rp-branch">{status.branch}</span>
            </>
          ) : (
            status.head && <span className="rp-detached"> (HEAD separado)</span>
          )}
        </span>
        <span className="rp-spring" />
        <button
          className="gd-icon-btn"
          title="Descartar todos los cambios"
          aria-label="Descartar todos los cambios"
          disabled={busy || total === 0}
          onClick={() => void discardAll()}
        >
          <Trash2 size={14} />
        </button>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'path', label: 'Path', icon: <List size={12} />, title: 'Lista plana de rutas' },
            { value: 'tree', label: 'Tree', icon: <FolderTree size={12} />, title: 'Árbol de carpetas' }
          ]}
        />
      </div>

      {status.inProgress && <InProgress status={status} busy={busy} />}

      <div className="rp-sections">
        {conflicted.length > 0 && (
          <SectionBox
            className="conflicted"
            title="Archivos en conflicto"
            icon={<TriangleAlert size={13} />}
            count={conflicted.length}
          >
            {list('conflicted', conflicted, '')}
          </SectionBox>
        )}
        <SectionBox
          title="Archivos sin stage"
          count={unstaged.length}
          action={
            <button
              className="gd-mini-btn green"
              disabled={busy || unstaged.length === 0}
              title="Añadir todos los cambios al stage"
              onClick={() => void run('Stage', (r) => git.stageAll(r))}
            >
              Stage de todo
            </button>
          }
        >
          {list('unstaged', unstaged, 'No hay cambios sin stage')}
        </SectionBox>
        <SectionBox
          title="Archivos en stage"
          count={staged.length}
          action={
            <button
              className="gd-mini-btn red"
              disabled={busy || staged.length === 0}
              title="Quitar todos los cambios del stage"
              onClick={() => void run('Unstage', (r) => git.unstageAll(r))}
            >
              Unstage de todo
            </button>
          }
        >
          {list('staged', staged, 'Aún no hay nada en stage')}
        </SectionBox>
      </div>

      <CommitForm repo={repo} status={status} />
    </div>
  )
}

function SectionBox(props: {
  title: string
  count: number
  className?: string
  icon?: ReactNode
  action?: ReactNode
  children: ReactNode
}) {
  return (
    <section className={`rp-section${props.className ? ' ' + props.className : ''}`}>
      <header className="rp-section-head">
        {props.icon}
        <span className="rp-section-title">
          {props.title} <span className="rp-section-count">({props.count})</span>
        </span>
        <span className="rp-spring" />
        {props.action}
      </header>
      <div className="rp-section-body">{props.children}</div>
    </section>
  )
}

function InProgress({ status, busy }: { status: Status; busy: boolean }) {
  const op = status.inProgress
  if (!op) return null
  const pending = status.conflicted.length
  const abort = async () => {
    const ok = await confirmDialog({
      title: `Abortar ${op}`,
      message: `Se cancelará el ${op} en curso y se volverá al estado anterior.`,
      confirmLabel: 'Abortar',
      danger: true
    })
    if (ok) await run(`Abortar ${op}`, (r) => git.abort(r))
  }
  return (
    <div className="rp-progress">
      <span className="rp-progress-text">
        <GitMerge size={14} />
        <span>
          {IN_PROGRESS[op]}
          {pending > 0 && ` · ${plural(pending, 'conflicto pendiente', 'conflictos pendientes')}`}
        </span>
      </span>
      <span className="rp-progress-actions">
        <button className="gd-mini-btn" disabled={busy} onClick={() => void abort()}>
          Abortar
        </button>
        <button
          className="gd-mini-btn green"
          disabled={busy || pending > 0}
          title={pending > 0 ? 'Resuelve los conflictos antes de continuar' : undefined}
          onClick={() => void run(`Continuar ${op}`, (r) => git.continueOp(r))}
        >
          Continuar
        </button>
      </span>
    </div>
  )
}
