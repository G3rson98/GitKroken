// Dialogs, context menus and git calls behind the SUBMODULES / WORKTREES / LFS sections.
// Every mutation goes through the store's `run` (busy state + error toast + refresh).
import type { LfsInfo, Submodule, Worktree } from '@shared/types'
import { git } from '../../lib/git'
import { useStore } from '../../store'
import { confirmDialog, formDialog, promptDialog, toast, type MenuItem } from '../ui/overlays'
import { copyText, errText, run } from '../toolbar/actions'

export const baseName = (path: string): string => path.split(/[\\/]/).filter(Boolean).pop() ?? path

/** Name of the OS file manager, for "Reveal in …" */
const fileManager = (): string => {
  const platform = window.bridge?.platform
  return platform === 'darwin' ? 'Finder' : platform === 'win32' ? 'File Explorer' : 'file manager'
}

async function reveal(path: string): Promise<void> {
  try {
    await git.reveal(path)
  } catch (e) {
    toast(errText(e), 'error')
  }
}

const openTab = (path: string): Promise<void> => useStore.getState().openRepo(path)

// ----- submodules ------------------------------------------------------------

export const SUBMODULE_STATE: Record<Submodule['status'], string> = {
  ok: 'up to date',
  uninitialized: 'not initialized',
  modified: 'on a different commit',
  conflict: 'in conflict'
}

/** Absolute path of a submodule of the active repository */
const submoduleDir = (sub: Submodule): string | null => {
  const repo = useStore.getState().activeRepo
  return repo ? `${repo.replace(/[\\/]+$/, '')}/${sub.path}` : null
}

export const updateSubmodule = (sub: Submodule): Promise<boolean> =>
  run(
    sub.status === 'uninitialized' ? 'Initialize submodule' : 'Update submodule',
    (repo) => git.submoduleUpdate(repo, sub.path),
    sub.status === 'uninitialized' ? `Submodule "${sub.path}" initialized` : `Submodule "${sub.path}" updated`
  )

export const updateAllSubmodules = (): Promise<boolean> =>
  run('Update submodules', (repo) => git.submoduleUpdate(repo), 'Submodules updated')

export async function openSubmodule(sub: Submodule): Promise<void> {
  const dir = submoduleDir(sub)
  if (!dir) return
  if (sub.status === 'uninitialized') {
    // An uninitialised submodule is an empty folder: there is no repository to open yet.
    const yes = await confirmDialog({
      title: 'Submodule not initialized',
      message: `"${sub.path}" has not been downloaded yet.\n\nInitialize and update it now?`,
      confirmLabel: 'Initialize'
    })
    if (yes) await updateSubmodule(sub)
    return
  }
  await openTab(dir)
}

/** `https://host/a/b.git`, `git@host:a/b.git`, `/path/to/b` -> `b` */
const nameFromUrl = (url: string): string =>
  /([^\\/:]+)$/.exec(url.replace(/[\\/]+$/, '').replace(/\.git$/i, ''))?.[1] ?? ''

export async function addSubmodule(): Promise<void> {
  const values = await formDialog({
    title: 'Add submodule',
    message: 'The repository is cloned inside this one and the change is staged for the next commit.',
    confirmLabel: 'Add submodule',
    fields: [
      { name: 'url', label: 'Repository URL', placeholder: 'https://host/user/repository.git' },
      { name: 'path', label: 'Path inside this repository (empty: the repository name)', placeholder: 'libs/repository' }
    ]
  })
  if (!values) return
  const url = values.url.trim()
  if (!url) {
    toast('Enter the submodule URL', 'error')
    return
  }
  const path = values.path.trim() || nameFromUrl(url)
  if (!path) {
    toast('Enter the submodule path', 'error')
    return
  }
  await run('Add submodule', (repo) => git.submoduleAdd(repo, url, path), `Submodule "${path}" added`)
}

export function submoduleMenu(sub: Submodule): MenuItem[] {
  const dir = submoduleDir(sub)
  const fresh = sub.status === 'uninitialized'
  return [
    {
      label: fresh ? 'Initialize and update' : 'Update to the recorded commit',
      onClick: () => void updateSubmodule(sub)
    },
    { label: 'Open in a tab', onClick: () => void openSubmodule(sub), disabled: fresh },
    { label: `Reveal in ${fileManager()}`, onClick: () => dir && void reveal(dir), disabled: !dir },
    { separator: true },
    { label: 'Copy path', onClick: () => void copyText(dir ?? sub.path) },
    { label: 'Copy URL', onClick: () => void copyText(sub.url), disabled: !sub.url }
  ]
}

// ----- worktrees ---------------------------------------------------------------

const samePath = (a: string, b: string | null): boolean => b !== null && a.replace(/[\\/]+$/, '') === b.replace(/[\\/]+$/, '')

/** True for the worktree that is the repository open in the active tab */
export const isOpenWorktree = (wt: Worktree): boolean => samePath(wt.path, useStore.getState().activeRepo)

export async function openWorktree(wt: Worktree): Promise<void> {
  if (isOpenWorktree(wt)) return
  if (wt.prunable) {
    toast(`The folder of this worktree no longer exists: ${wt.path}`, 'error')
    return
  }
  await openTab(wt.path)
}

export async function addWorktree(): Promise<void> {
  let dir: string | null
  try {
    dir = await git.pickDirectory('Destination folder for the new worktree')
  } catch (e) {
    toast(errText(e), 'error')
    return
  }
  if (!dir) return
  const current = useStore.getState().status?.branch ?? null
  const values = await formDialog({
    title: 'New worktree',
    message:
      'The destination folder must be empty or not exist yet (you can append a name to the path).\n\n' +
      'A branch can only be checked out in one worktree at a time: to start from a branch that is already checked out, enter a new branch name.',
    confirmLabel: 'Create worktree',
    fields: [
      { name: 'path', label: 'Destination folder', defaultValue: dir },
      { name: 'ref', label: 'Branch, tag or commit', placeholder: current ? `${current}, origin/${current}, v1.0…` : 'main, origin/main, v1.0…' },
      { name: 'branch', label: 'New branch from that ref (optional)', placeholder: 'feature/my-branch' }
    ]
  })
  if (!values) return
  const path = values.path.trim()
  const branch = values.branch.trim().replace(/\s+/g, '-')
  // Only a new branch name: it starts at the current commit.
  const ref = values.ref.trim() || (branch ? 'HEAD' : '')
  if (!path) {
    toast('Enter the destination folder of the worktree', 'error')
    return
  }
  if (!ref) {
    toast('Enter the branch, tag or commit of the worktree, or a new branch name', 'error')
    return
  }
  await run(
    'Create worktree',
    (repo) => git.worktreeAdd(repo, path, ref, branch || undefined),
    `Worktree created at ${path}`
  )
}

/** git's refusal to remove a worktree that has modified or untracked files */
const DIRTY_WORKTREE = /contains modified or untracked files|use --force to delete/i

export async function removeWorktree(wt: Worktree): Promise<void> {
  const name = baseName(wt.path)
  if (wt.locked) {
    toast(`The worktree "${name}" is locked (git worktree lock). Unlock it before removing it.`, 'error')
    return
  }
  const yes = await confirmDialog({
    title: 'Remove worktree',
    message:
      `Remove the worktree "${name}"?\n\nThe folder ${wt.path} will be deleted.` +
      (wt.branch ? `\nThe branch "${wt.branch}" and its commits are kept.` : ''),
    confirmLabel: 'Remove worktree',
    danger: true
  })
  if (!yes) return

  // `run` only reports success/failure, so git's "has changes" refusal is detected here
  const result = { removed: false, dirty: false }
  await run('Remove worktree', async (repo) => {
    try {
      await git.worktreeRemove(repo, wt.path)
      result.removed = true
    } catch (e) {
      if (!DIRTY_WORKTREE.test(errText(e))) throw e
      result.dirty = true
    }
  })
  if (result.removed) {
    toast(`Worktree "${name}" removed`, 'success')
    return
  }
  if (!result.dirty) return

  const force = await confirmDialog({
    title: 'The worktree has uncommitted changes',
    message:
      `${wt.path} contains modified or untracked files.\n\n` +
      'Forcing the removal deletes the whole folder and that uncommitted work will be lost for good: this cannot be undone.\n\n' +
      'Force remove?',
    confirmLabel: 'Force remove',
    danger: true
  })
  if (force) await run('Remove worktree', (repo) => git.worktreeRemove(repo, wt.path, true), `Worktree "${name}" removed`)
}

export function worktreeMenu(wt: Worktree): MenuItem[] {
  const open = isOpenWorktree(wt)
  return [
    { label: open ? 'Open in this tab' : 'Open in a tab', onClick: () => void openWorktree(wt), disabled: open || wt.prunable },
    { label: `Reveal in ${fileManager()}`, onClick: () => void reveal(wt.path), disabled: wt.prunable },
    { label: 'Copy path', onClick: () => void copyText(wt.path) },
    { separator: true },
    {
      label: wt.isMain ? 'Remove (this is the main worktree)' : open ? 'Remove (it is open in this tab)' : 'Remove worktree…',
      onClick: () => void removeWorktree(wt),
      disabled: wt.isMain || open,
      danger: true
    }
  ]
}

// ----- LFS -----------------------------------------------------------------------

export const lfsInstallHint = (): string => {
  const platform = window.bridge?.platform
  return platform === 'darwin'
    ? 'Install it with "brew install git-lfs" and come back to this window.'
    : platform === 'win32'
      ? 'It ships with Git for Windows; alternatively: "winget install GitHub.GitLFS".'
      : 'Install the "git-lfs" package of your distribution and come back to this window.'
}

export const initLfs = (): Promise<boolean> =>
  run('Initialize LFS', (repo) => git.lfsInstall(repo), 'Git LFS initialized in this repository')

export const pullLfs = (): Promise<boolean> => run('LFS pull', (repo) => git.lfsPull(repo), 'LFS pull completed')

export async function trackLfsPattern(): Promise<void> {
  const pattern = await promptDialog({
    title: 'Track files with LFS',
    label: 'File pattern (added to .gitattributes)',
    placeholder: '*.psd',
    confirmLabel: 'Track'
  })
  if (!pattern) return
  await run(
    'LFS track',
    (repo) => git.lfsTrack(repo, pattern),
    `"${pattern}" is now tracked with LFS. The change to .gitattributes is unstaged: commit it to share it.`
  )
}

export const untrackLfsPattern = (pattern: string): Promise<boolean> =>
  run(
    'LFS untrack',
    (repo) => git.lfsUntrack(repo, pattern),
    `"${pattern}" is no longer tracked with LFS. The change to .gitattributes is unstaged.`
  )

export function lfsPatternMenu(pattern: string, info: LfsInfo): MenuItem[] {
  return [
    { label: 'Stop tracking', onClick: () => void untrackLfsPattern(pattern), disabled: !info.installed, danger: true },
    { label: 'Copy pattern', onClick: () => void copyText(pattern) }
  ]
}

export function lfsFileMenu(file: string): MenuItem[] {
  const repo = useStore.getState().activeRepo
  const full = repo ? `${repo.replace(/[\\/]+$/, '')}/${file}` : file
  return [
    { label: `Reveal in ${fileManager()}`, onClick: () => void reveal(full), disabled: !repo },
    { label: 'Copy path', onClick: () => void copyText(file) }
  ]
}
