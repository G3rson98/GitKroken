// Context-menu definitions and the dialogs behind them for every sidebar item.
import type { Ref, Remote } from '@shared/types'
import { git } from '../../lib/git'
import { useStore } from '../../store'
import { confirmDialog, formDialog, promptDialog, toast, type MenuItem } from '../ui/overlays'
import { checkoutRef, copyText, errText, forcePush, pushBranch, run } from '../toolbar/actions'
import { splitRemoteRef } from './tree'
import { confirmRebase, fullRefName } from '../../lib/refs'

const UNMERGED = /not fully merged/i

/** Current branch name, or null when HEAD is detached / unknown */
const currentBranch = (): string | null => {
  const s = useStore.getState()
  return s.status?.branch ?? s.refs.find((r) => r.type === 'head' && r.isCurrent)?.name ?? null
}

/**
 * Merge / rebase may stop on conflicts without failing, so success is only
 * announced when no operation is left in progress after the refresh.
 */
async function runOp(label: string, fn: (repo: string) => Promise<unknown>, doneMsg: string): Promise<void> {
  const ok = await run(label, fn)
  if (ok && !useStore.getState().status?.inProgress) toast(doneMsg, 'success')
}

const mergeInto = (ref: Ref, current: string) =>
  runOp('Merge', (repo) => git.merge(repo, fullRefName(ref)), `Merged "${ref.name}" into "${current}"`)

async function rebaseOnto(ref: Ref, current: string): Promise<void> {
  if (!(await confirmRebase(current, ref.name))) return
  await runOp('Rebase', (repo) => git.rebase(repo, fullRefName(ref)), `Rebased "${current}" onto "${ref.name}"`)
}

// ----- local branches -------------------------------------------------------

export async function deleteLocalBranch(name: string): Promise<void> {
  const yes = await confirmDialog({
    title: 'Delete branch',
    message: `Delete the local branch "${name}"?`,
    confirmLabel: 'Delete',
    danger: true
  })
  if (!yes) return

  // `run` only reports success/failure, so the "not fully merged" case is detected here
  const result = { deleted: false, unmerged: false }
  await run('Delete branch', async (repo) => {
    try {
      await git.deleteBranch(repo, name)
      result.deleted = true
    } catch (e) {
      if (!UNMERGED.test(errText(e))) throw e
      result.unmerged = true
    }
  })
  if (result.deleted) {
    toast(`Branch "${name}" deleted`, 'success')
    return
  }
  if (!result.unmerged) return

  const force = await confirmDialog({
    title: 'Branch is not fully merged',
    message: `"${name}" has commits that are not merged into any other branch. Deleting it could lose them.\n\nDelete it anyway?`,
    confirmLabel: 'Force delete',
    danger: true
  })
  if (force) await run('Delete branch', (repo) => git.deleteBranch(repo, name, true), `Branch "${name}" deleted`)
}

async function renameBranch(name: string): Promise<void> {
  const typed = await promptDialog({
    title: 'Rename branch',
    label: `New name for "${name}"`,
    defaultValue: name,
    confirmLabel: 'Rename'
  })
  const next = typed?.replace(/\s+/g, '-')
  if (!next || next === name) return
  await run('Rename branch', (repo) => git.renameBranch(repo, name, next), `Branch renamed to "${next}"`)
}

export function localBranchMenu(ref: Ref): MenuItem[] {
  const current = currentBranch()
  const name = ref.name
  const other = !ref.isCurrent && current !== null
  const hasRemotes = useStore.getState().remotes.length > 0
  return [
    { label: `Checkout ${name}`, onClick: () => void checkoutRef(fullRefName(ref)), disabled: ref.isCurrent },
    { separator: true },
    {
      label: other ? `Merge ${name} into ${current}` : 'Merge into the current branch',
      onClick: () => current && void mergeInto(ref, current),
      disabled: !other
    },
    {
      label: other ? `Rebase ${current} onto ${name}` : 'Rebase the current branch onto this one',
      onClick: () => current && void rebaseOnto(ref, current),
      disabled: !other
    },
    { separator: true },
    { label: ref.upstream ? `Push to ${ref.upstream}` : 'Push', onClick: () => void pushBranch(name), disabled: !hasRemotes },
    { label: 'Force Push (with lease)…', onClick: () => void forcePush(name), disabled: !hasRemotes, danger: true },
    { separator: true },
    { label: 'Rename…', onClick: () => void renameBranch(name) },
    { label: 'Copy branch name', onClick: () => void copyText(name) },
    { separator: true },
    { label: `Delete ${name}`, onClick: () => void deleteLocalBranch(name), disabled: ref.isCurrent, danger: true }
  ]
}

// ----- remotes --------------------------------------------------------------

export function remoteBranchMenu(ref: Ref, remotes: Remote[]): MenuItem[] {
  const current = currentBranch()
  const name = ref.name
  const { remote, branch } = splitRemoteRef(name, remotes)
  const onDelete = async () => {
    const yes = await confirmDialog({
      title: 'Delete remote branch',
      message: `Delete the branch "${branch}" from remote "${remote}"?\n\nThis removes it on the server for everyone.`,
      confirmLabel: 'Delete from remote',
      danger: true
    })
    if (yes)
      await run(
        'Delete remote branch',
        (repo) => git.deleteRemoteBranch(repo, remote, branch),
        `Deleted "${name}" from the remote`
      )
  }
  return [
    { label: `Checkout ${name}`, onClick: () => void checkoutRef(fullRefName(ref)) },
    {
      label: current ? `Merge ${name} into ${current}` : 'Merge into the current branch',
      onClick: () => current && void mergeInto(ref, current),
      disabled: !current
    },
    { label: 'Copy branch name', onClick: () => void copyText(name) },
    { separator: true },
    { label: `Delete ${name}`, onClick: () => void onDelete(), danger: true }
  ]
}

export async function addRemote(): Promise<void> {
  const hasOrigin = useStore.getState().remotes.some((r) => r.name === 'origin')
  const values = await formDialog({
    title: 'Add remote',
    confirmLabel: 'Add remote',
    fields: [
      { name: 'name', label: 'Name', defaultValue: hasOrigin ? '' : 'origin', placeholder: 'origin' },
      { name: 'url', label: 'URL', placeholder: 'https://host/user/repository.git' }
    ]
  })
  if (!values) return
  const name = values.name.trim()
  const url = values.url.trim()
  if (!name || !url) {
    toast('Enter the name and the URL of the remote', 'error')
    return
  }
  await run('Add remote', (repo) => git.addRemote(repo, name, url), `Remote "${name}" added`)
}

export function remoteMenu(name: string, url: string | undefined): MenuItem[] {
  const onRemove = async () => {
    const yes = await confirmDialog({
      title: 'Remove remote',
      message: `Remove the remote "${name}"${url ? ` (${url})` : ''}?\n\nIts local remote-tracking branches are removed too.`,
      confirmLabel: 'Remove remote',
      danger: true
    })
    if (yes) await run('Remove remote', (repo) => git.removeRemote(repo, name), `Remote "${name}" removed`)
  }
  return [
    { label: 'Fetch', onClick: () => void run('Fetch', (repo) => git.fetch(repo), 'Fetch complete') },
    { label: 'Copy URL', onClick: () => url && void copyText(url), disabled: !url },
    { separator: true },
    { label: `Remove ${name}`, onClick: () => void onRemove(), danger: true }
  ]
}

// ----- stashes --------------------------------------------------------------

export function stashMenu(ref: Ref, index: number): MenuItem[] {
  const title = ref.message || ref.name
  const onDrop = async () => {
    const yes = await confirmDialog({
      title: 'Drop stash',
      message: `Drop the stash "${title}"?\n\nThe changes saved in it will be lost.`,
      confirmLabel: 'Drop',
      danger: true
    })
    if (yes) {
      // The hash makes the backend refuse if stash@{index} is no longer this stash
      await run(
        'Drop stash',
        (repo) => git.stashDrop(repo, index, ref.hash),
        `Stash dropped. To recover it: git stash apply ${ref.hash.slice(0, 10)}`
      )
    }
  }
  return [
    {
      label: 'Apply Stash',
      onClick: () => void run('Apply stash', (repo) => git.stashApply(repo, index, ref.hash), 'Stash applied')
    },
    {
      label: 'Pop Stash',
      onClick: () => void run('Pop', (repo) => git.stashPop(repo, index, ref.hash), 'Stash applied and dropped')
    },
    { separator: true },
    { label: 'Delete Stash', onClick: () => void onDrop(), danger: true }
  ]
}

// ----- tags -----------------------------------------------------------------

export function tagMenu(ref: Ref): MenuItem[] {
  const name = ref.name
  const onDelete = async () => {
    const yes = await confirmDialog({
      title: 'Delete tag',
      message: `Delete the local tag "${name}"?`,
      confirmLabel: 'Delete',
      danger: true
    })
    if (yes) await run('Delete tag', (repo) => git.deleteTag(repo, name), `Tag "${name}" deleted`)
  }
  return [
    { label: `Checkout ${name}`, onClick: () => void checkoutRef(fullRefName(ref)) },
    { label: 'Copy tag name', onClick: () => void copyText(name) },
    { separator: true },
    { label: `Delete ${name}`, onClick: () => void onDelete(), danger: true }
  ]
}
