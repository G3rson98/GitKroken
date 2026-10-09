// Staging area (WIP mode of the right panel): conflicted / unstaged / staged
// file lists plus the commit form.
import { useState, type MouseEvent, type ReactNode } from 'react'
import { FolderTree, GitMerge, List, Trash2, TriangleAlert } from 'lucide-react'
import type { FileChange, Status } from '@shared/types'
import { useStore, type SelectedFile } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog, showContextMenu, toast, type MenuItem } from '../ui/overlays'
import { hasHistory, openBlame, openFileHistory } from '../history/entry'
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
  merge: 'Merge in progress',
  rebase: 'Rebase in progress',
  'cherry-pick': 'Cherry-pick in progress',
  revert: 'Revert in progress'
}

function revealLabel(): string {
  const p = window.bridge.platform
  return p === 'darwin' ? 'Reveal in Finder' : p === 'win32' ? 'Show in Explorer' : 'Show in file manager'
}

const openConflict = (path: string) => useStore.getState().openView({ kind: 'conflict', path })

/** Resolves a conflicted file with one whole side, after saying exactly what that does to it. */
async function takeSide(repo: string, file: FileChange, side: 'ours' | 'theirs'): Promise<void> {
  // The names of the sides, and whether that side still has the file at all
  const info = await git.conflictFile(repo, file.path).catch(() => null)
  const label = info ? (side === 'ours' ? info.oursLabel : info.theirsLabel) : null
  const deletes = !!info && (side === 'ours' ? info.ours : info.theirs) === null
  const from = label ? ` (${label})` : ''
  const ok = await confirmDialog({
    title: side === 'ours' ? 'Take ours' : 'Take theirs',
    message: deletes
      ? `"${file.path}" does not exist on ${side === 'ours' ? 'our' : 'their'} side${from}, so taking it deletes the file and marks the conflict as resolved.`
      : `"${file.path}" is replaced by ${side === 'ours' ? 'our' : 'their'} version${from} and marked as resolved. Everything from the other side, and any edit made to the conflicted file, is dropped.`,
    confirmLabel: deletes ? 'Delete file' : side === 'ours' ? 'Take ours' : 'Take theirs',
    danger: true
  })
  if (ok) await run(side === 'ours' ? 'Take ours' : 'Take theirs', (r) => git.resolveWith(r, file.path, side))
}

async function discard(file: FileChange, section: Section): Promise<void> {
  // A new file has no earlier version to go back to: discarding it deletes it
  const untracked = file.status === 'untracked' || (section === 'staged' && file.status === 'added')
  const ok = await confirmDialog({
    title: untracked ? (file.status === 'untracked' ? 'Delete untracked file' : 'Delete new file') : 'Discard changes',
    message: untracked
      ? `"${file.path}" is a new file: it will be deleted from disk. This cannot be undone.`
      : section === 'staged'
        ? `All changes to "${file.path}" will be discarded, staged and unstaged alike. This cannot be undone.`
        : `The unstaged changes to "${file.path}" will be discarded. This cannot be undone.`,
    confirmLabel: untracked ? 'Delete' : 'Discard',
    danger: true
  })
  if (!ok) return
  const paths = pathsOf([file])
  await run('Discard changes', async (r) => {
    if (section === 'staged') await git.unstage(r, paths)
    await git.discard(r, section === 'staged' ? paths : [file.path])
  })
}

export function WipPanel({ repo, status }: { repo: string; status: Status }) {
  const selectedFile = useStore((s) => s.selectedFile)
  /** Path of the file open in the conflict editor, if any */
  const inEditor = useStore((s) => (s.view.kind === 'conflict' ? s.view.path : null))
  const busy = useStore((s) => s.busy !== null)
  const [view, setViewState] = useState<FileViewMode>(() => readPref(FILE_VIEW_KEY, FILE_VIEWS, 'path'))
  const setView = (v: FileViewMode) => {
    setViewState(v)
    writePref(FILE_VIEW_KEY, v)
  }

  const { staged, unstaged, conflicted } = status
  const total = new Set([...staged, ...unstaged, ...conflicted].map((f) => f.path)).size

  /** The plain diff of a file (for a conflicted one: git's combined diff) */
  const showDiff = (file: FileChange, section: Section) => {
    const next: SelectedFile = { path: file.path, staged: section === 'staged' }
    if (file.oldPath) next.oldPath = file.oldPath
    if (section !== 'staged' && file.status === 'untracked') next.untracked = true
    useStore.getState().selectFile(next)
  }

  // A conflicted file opens in the conflict editor, everything else in the diff viewer
  const open = (file: FileChange, section: Section) =>
    section === 'conflicted' ? openConflict(file.path) : showDiff(file, section)

  const isSelected = (file: FileChange, section: Section) =>
    (section === 'conflicted' && inEditor === file.path) ||
    (!!selectedFile &&
      !selectedFile.commit &&
      selectedFile.path === file.path &&
      !!selectedFile.staged === (section === 'staged'))

  const menu = (e: MouseEvent, file: FileChange, section: Section) => {
    const location: MenuItem[] = [
      {
        label: revealLabel(),
        disabled: file.status === 'deleted',
        onClick: () => {
          git.reveal(`${repo}/${file.path}`).catch((err) => toast(errText(err), 'error'))
        }
      },
      { label: 'Copy path', onClick: () => copyText(file.path, 'Path') },
      { label: 'Copy absolute path', onClick: () => copyText(`${repo}/${file.path}`, 'Path') }
    ]

    if (section === 'conflicted') {
      showContextMenu(e, [
        { label: 'Open in conflict editor', onClick: () => openConflict(file.path) },
        { label: 'View diff', onClick: () => showDiff(file, section) },
        { separator: true },
        { label: 'Take ours…', disabled: busy, onClick: () => void takeSide(repo, file, 'ours') },
        { label: 'Take theirs…', disabled: busy, onClick: () => void takeSide(repo, file, 'theirs') },
        { label: 'Mark as resolved', disabled: busy, onClick: () => void stage([file]) },
        { separator: true },
        ...location
      ])
      return
    }

    const ref = { path: file.path, status: file.status }
    const items: MenuItem[] = [
      { label: 'View changes', onClick: () => showDiff(file, section) },
      section === 'staged'
        ? { label: 'Unstage', onClick: () => void unstage([file]) }
        : { label: 'Stage', onClick: () => void stage([file]) },
      {
        label: file.status === 'untracked' ? 'Delete file…' : 'Discard changes…',
        danger: true,
        onClick: () => void discard(file, section)
      },
      { separator: true },
      // An untracked file has no history and nothing to blame
      ...(hasHistory(ref)
        ? ([
            { label: 'File History', onClick: () => openFileHistory(ref) },
            { label: 'Blame', onClick: () => openBlame(ref) },
            { separator: true }
          ] satisfies MenuItem[])
        : []),
      ...location
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
          ? unstageBtn([f], 'Unstage file')
          : stageBtn([f], section === 'conflicted' ? 'Mark as resolved' : 'Stage file')
      }
      folderActions={(fs) =>
        section === 'staged'
          ? unstageBtn(fs, 'Unstage folder')
          : stageBtn(fs, 'Stage folder')
      }
    />
  )

  const untrackedCount = status.unstaged.filter((f) => f.status === 'untracked').length
  const discardAll = async () => {
    const ok = await confirmDialog({
      title: 'Discard all changes',
      message:
        'Every change in the working directory and the index will be discarded.' +
        (untrackedCount > 0 ? `\n\n${plural(untrackedCount, 'untracked file', 'untracked files')} will be DELETED from disk.` : '') +
        (status.head ? '' : '\n\nThis repository has no commits yet: every file that is not ignored will be deleted.') +
        '\n\nThis cannot be undone.',
      confirmLabel: 'Discard all',
      danger: true
    })
    if (ok) await run('Discard all changes', (r) => git.discardAll(r), 'Changes discarded')
  }

  return (
    <div className="rp-wip">
      <div className="rp-head">
        <span className="rp-head-title">
          {total === 0 ? 'No changes' : plural(total, 'file change', 'file changes')}
          {status.branch ? (
            <>
              {' on '}
              <span className="rp-branch">{status.branch}</span>
            </>
          ) : (
            status.head && <span className="rp-detached"> (detached HEAD)</span>
          )}
        </span>
        <span className="rp-spring" />
        <button
          className="gd-icon-btn"
          title={status.inProgress ? `Abort the ${status.inProgress} instead of discarding everything` : 'Discard all changes'}
          aria-label="Discard all changes"
          disabled={busy || total === 0 || !!status.inProgress}
          onClick={() => void discardAll()}
        >
          <Trash2 size={14} />
        </button>
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'path', label: 'Path', icon: <List size={12} />, title: 'Flat list of paths' },
            { value: 'tree', label: 'Tree', icon: <FolderTree size={12} />, title: 'Folder tree' }
          ]}
        />
      </div>

      {status.inProgress && <InProgress status={status} busy={busy} />}

      <div className="rp-sections">
        {conflicted.length > 0 && (
          <SectionBox
            className="conflicted"
            title="Conflicted Files"
            icon={<TriangleAlert size={13} />}
            count={conflicted.length}
          >
            {list('conflicted', conflicted, '')}
          </SectionBox>
        )}
        <SectionBox
          title="Unstaged Files"
          count={unstaged.length}
          action={
            <button
              className="gd-mini-btn green"
              disabled={busy || unstaged.length === 0}
              title="Stage all changes"
              onClick={() => void run('Stage', (r) => git.stageAll(r))}
            >
              Stage all changes
            </button>
          }
        >
          {list('unstaged', unstaged, 'No unstaged changes')}
        </SectionBox>
        <SectionBox
          title="Staged Files"
          count={staged.length}
          action={
            <button
              className="gd-mini-btn red"
              disabled={busy || staged.length === 0}
              title="Unstage all changes"
              onClick={() => void run('Unstage', (r) => git.unstageAll(r))}
            >
              Unstage all changes
            </button>
          }
        >
          {list('staged', staged, 'Nothing staged yet')}
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
      title: `Abort ${op}`,
      message: `The ${op} in progress is cancelled and the repository goes back to how it was before it started.`,
      confirmLabel: 'Abort',
      danger: true
    })
    if (ok) await run(`Abort ${op}`, (r) => git.abort(r))
  }
  return (
    <div className="rp-progress">
      <span className="rp-progress-text">
        <GitMerge size={14} />
        <span>
          {IN_PROGRESS[op]}
          {pending > 0 && ` · ${plural(pending, 'conflicted file', 'conflicted files')}`}
        </span>
      </span>
      <span className="rp-progress-actions">
        <button className="gd-mini-btn" disabled={busy} onClick={() => void abort()}>
          Abort
        </button>
        <button
          className="gd-mini-btn green"
          disabled={busy || pending > 0}
          title={pending > 0 ? 'Resolve the conflicts before continuing' : undefined}
          onClick={() => void run(`Continue ${op}`, (r) => git.continueOp(r))}
        >
          Continue
        </button>
      </span>
    </div>
  )
}
