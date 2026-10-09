// Context menus and git mutations triggered from the graph. Every write goes
// through the store's `run()` so it gets busy state, error toasts and a refresh.
import type { Commit, Ref } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { confirmRebase } from '../../lib/refs'
import { confirmDialog, formDialog, promptDialog, toast, type MenuItem } from '../ui/overlays'
import { rebaseFromCommit, rebaseOnto, type RebaseTarget } from '../rebase/plan'
import { splitRemoteRef, stashIndex, type RefLabel } from './refLabels'

const SEP: MenuItem = { separator: true }

const run = (label: string, fn: (repo: string) => Promise<unknown>, successMsg?: string): Promise<boolean> =>
  useStore.getState().run(label, fn, successMsg)

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim()

function copyText(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copied to the clipboard`, 'success'),
    () => toast(`Could not copy the ${what.toLowerCase()}`, 'error')
  )
}

/** Name to hand to git for a branch pill */
const gitName = (label: RefLabel): string => (label.kind === 'remote' && label.remote ? label.remote.name : label.name)

// --- commits ---------------------------------------------------------------

async function createBranchAt(hash: string): Promise<void> {
  const name = await promptDialog({
    title: 'Create branch',
    label: `Name of the new branch (from ${hash.slice(0, 7)})`,
    placeholder: 'feature/my-branch',
    confirmLabel: 'Create branch'
  })
  if (!name) return
  await run('Create branch', (repo) => git.createBranch(repo, name, hash, true), `Branch "${name}" created`)
}

async function createTagAt(hash: string): Promise<void> {
  const r = await formDialog({
    title: 'Create tag',
    message: `It will be created at commit ${hash.slice(0, 7)}.`,
    fields: [
      { name: 'name', label: 'Tag name', placeholder: 'v1.0.0' },
      { name: 'message', label: 'Message (optional: creates an annotated tag)' }
    ],
    confirmLabel: 'Create tag'
  })
  if (!r) return
  const name = r.name.trim()
  const message = r.message.trim()
  if (!name) {
    toast('The tag name is required', 'error')
    return
  }
  await run('Create tag', (repo) => git.createTag(repo, name, hash, message || undefined), `Tag "${name}" created`)
}

async function resetTo(hash: string, mode: 'soft' | 'mixed' | 'hard', target: string): Promise<void> {
  if (mode === 'hard') {
    const ok = await confirmDialog({
      title: 'Reset hard',
      message:
        `${target} will move to ${hash.slice(0, 7)} and ALL uncommitted changes in the working directory ` +
        'and the index will be discarded, and untracked files that the target commit also contains are overwritten. ' +
        `Commits after ${hash.slice(0, 7)} are no longer part of ${target}.\n\n` +
        'Undo can move the branch back, but the discarded changes cannot be recovered.',
      confirmLabel: 'Discard changes and reset',
      danger: true
    })
    if (!ok) return
  } else if (useStore.getState().status?.head !== hash) {
    const ok = await confirmDialog({
      title: `Reset ${mode}`,
      message:
        `${target} will move to ${hash.slice(0, 7)}. Commits after it are no longer part of ${target}; ` +
        (mode === 'soft' ? 'their changes stay staged.' : 'their changes stay in the working directory, unstaged.') +
        '\n\nUndo can move the branch back.',
      confirmLabel: `Reset ${mode}`
    })
    if (!ok) return
  }
  await run(`Reset ${mode}`, (repo) => git.reset(repo, hash, mode))
}

/** Opens the interactive rebase view, or explains in the label why it cannot start. */
function interactiveItem(label: string, target: RebaseTarget): MenuItem {
  const { base, reason } = target
  if (!base) return { label: `${label} (${reason})`, disabled: true, onClick: () => {} }
  return { label: `${label}…`, onClick: () => useStore.getState().openView({ kind: 'rebase', base }) }
}

export function commitMenu(commit: Commit): MenuItem[] {
  if (commit.isStash) return stashMenu(findStash(commit.hash))

  const { status, commits } = useStore.getState()
  const branch = status?.branch ?? null
  const target = branch ?? 'HEAD'
  const isHead = status?.head === commit.hash
  const { hash } = commit
  const interactive = rebaseFromCommit(commit, commits, status)

  return [
    { label: 'Checkout this commit', onClick: () => void run('Checkout', (repo) => git.checkout(repo, hash)) },
    { label: 'Create branch here…', onClick: () => void createBranchAt(hash) },
    { label: 'Create tag here…', onClick: () => void createTagAt(hash) },
    SEP,
    {
      label: 'Cherry pick commit',
      disabled: isHead,
      onClick: () => void run('Cherry pick', (repo) => git.cherryPick(repo, hash))
    },
    { label: 'Revert commit', onClick: () => void run('Revert', (repo) => git.revert(repo, hash)) },
    SEP,
    {
      label: `Reset ${target} to this commit: Soft (keep all changes staged)`,
      onClick: () => void resetTo(hash, 'soft', target)
    },
    {
      label: `Reset ${target} to this commit: Mixed (keep changes in the working directory)`,
      onClick: () => void resetTo(hash, 'mixed', target)
    },
    {
      label: `Reset ${target} to this commit: Hard (discard all changes)`,
      danger: true,
      onClick: () => void resetTo(hash, 'hard', target)
    },
    SEP,
    interactiveItem('Interactive rebase from here', interactive),
    SEP,
    { label: 'Copy commit SHA', onClick: () => copyText(hash, 'SHA') }
  ]
}

// --- stashes ---------------------------------------------------------------

const findStash = (hash: string): Ref | undefined =>
  useStore.getState().refs.find((r) => r.type === 'stash' && r.hash === hash)

async function dropStash(ref: Ref, index: number): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete stash',
    message: `Delete ${ref.name}${ref.message ? ` "${ref.message}"` : ''}? The changes saved in it will be lost.`,
    confirmLabel: 'Delete stash',
    danger: true
  })
  if (ok) {
    await run(
      'Delete stash',
      (repo) => git.stashDrop(repo, index, ref.hash),
      `Stash deleted. To recover it: git stash apply ${ref.hash.slice(0, 10)}`
    )
  }
}

/** The stash commit hash goes along: the backend refuses if stash@{N} is no longer that stash */
export function stashMenu(ref: Ref | undefined): MenuItem[] {
  const index = ref ? stashIndex(ref.name) : null
  if (!ref || index === null) {
    const off = { disabled: true, onClick: () => {} }
    return [{ label: 'Apply stash', ...off }, { label: 'Pop stash', ...off }, SEP, { label: 'Delete stash…', ...off }]
  }
  return [
    { label: 'Apply stash', onClick: () => void run('Apply stash', (repo) => git.stashApply(repo, index, ref.hash)) },
    { label: 'Pop stash', onClick: () => void run('Pop stash', (repo) => git.stashPop(repo, index, ref.hash)) },
    SEP,
    { label: 'Delete stash…', danger: true, onClick: () => void dropStash(ref, index) }
  ]
}

// --- WIP -------------------------------------------------------------------

async function stashChanges(): Promise<void> {
  const r = await formDialog({
    title: 'Stash changes',
    fields: [{ name: 'message', label: 'Message (optional)', placeholder: 'WIP' }],
    confirmLabel: 'Stash'
  })
  if (!r) return
  const message = r.message.trim()
  await run('Stash', (repo) => git.stashSave(repo, message || undefined))
}

async function discardAll(): Promise<void> {
  const status = useStore.getState().status
  const untracked = status?.unstaged.filter((f) => f.status === 'untracked').length ?? 0
  const ok = await confirmDialog({
    title: 'Discard all changes',
    message:
      'Every change in the working directory and the index will be discarded.' +
      (untracked > 0 ? `\n\n${untracked} untracked file${untracked === 1 ? '' : 's'} will be DELETED from disk.` : '') +
      (status?.head ? '' : '\n\nThis repository has no commits yet: every file that is not ignored will be deleted.') +
      '\n\nThis cannot be undone.',
    confirmLabel: 'Discard all changes',
    danger: true
  })
  if (ok) await run('Discard changes', (repo) => git.discardAll(repo))
}

export function wipMenu(): MenuItem[] {
  const op = useStore.getState().status?.inProgress ?? null
  return [
    { label: op ? `Stash changes (not during a ${op})` : 'Stash changes…', disabled: !!op, onClick: () => void stashChanges() },
    SEP,
    {
      label: op ? `Discard all changes (abort the ${op} instead)` : 'Discard all changes…',
      disabled: !!op,
      danger: true,
      onClick: () => void discardAll()
    }
  ]
}

// --- branches & tags -------------------------------------------------------

/** Unambiguous git name of the ref behind a pill (a short name may be a branch and a tag at once) */
function fullName(label: RefLabel): string {
  if (label.kind === 'local') return `refs/heads/${label.name}`
  if (label.kind === 'remote') return `refs/remotes/${gitName(label)}`
  if (label.kind === 'tag') return `refs/tags/${label.name}`
  return label.name
}

async function rebaseCurrentOnto(current: string, onto: RefLabel): Promise<void> {
  if (!(await confirmRebase(current, gitName(onto)))) return
  await run('Rebase', (repo) => git.rebase(repo, fullName(onto)))
}

/** Double click on a pill */
export function checkoutLabel(label: RefLabel): void {
  if (label.kind === 'local') {
    if (!label.isCurrent) void run('Checkout', (repo) => git.checkout(repo, fullName(label)))
  } else if (label.kind === 'remote') {
    // the backend creates / reuses the local tracking branch
    void run('Checkout', (repo) => git.checkout(repo, fullName(label)))
  }
}

async function renameBranch(name: string): Promise<void> {
  const next = await promptDialog({
    title: 'Rename branch',
    label: `New name for ${name}`,
    defaultValue: name,
    confirmLabel: 'Rename'
  })
  if (!next || next === name) return
  await run('Rename branch', (repo) => git.renameBranch(repo, name, next))
}

async function deleteLocalBranch(name: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete branch',
    message: `Delete the local branch ${name}?`,
    confirmLabel: 'Delete branch',
    danger: true
  })
  if (!ok) return

  // run() swallows errors, so the failure of the safe delete is captured here
  // to be able to offer the forced one.
  const result = { error: null as string | null }
  const ran = await run('Delete branch', async (repo) => {
    try {
      await git.deleteBranch(repo, name, false)
    } catch (e) {
      result.error = errText(e)
    }
  })
  if (!ran || result.error === null) return
  if (/checked out|worktree/i.test(result.error)) {
    toast(`Delete branch: ${result.error}`, 'error')
    return
  }
  const force = await confirmDialog({
    title: `Could not delete ${name}`,
    message:
      `${result.error}\n\nThe branch may have commits that are not merged anywhere else. ` +
      'Force the deletion? Those commits could be lost.',
    confirmLabel: 'Force delete',
    danger: true
  })
  if (force) await run('Delete branch', (repo) => git.deleteBranch(repo, name, true))
}

async function deleteRemoteBranch(fullName: string): Promise<void> {
  const remoteNames = useStore.getState().remotes.map((r) => r.name)
  const { remote, branch } = splitRemoteRef(fullName, remoteNames)
  if (!remote || !branch) {
    toast(`Could not work out the remote of ${fullName}`, 'error')
    return
  }
  const ok = await confirmDialog({
    title: 'Delete remote branch',
    message: `Delete the branch ${branch} from the remote ${remote}?\n\nIt will no longer be available to anyone on the team.`,
    confirmLabel: 'Delete from remote',
    danger: true
  })
  if (ok) await run('Delete remote branch', (repo) => git.deleteRemoteBranch(repo, remote, branch))
}

async function deleteTag(name: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Delete tag',
    message: `Delete the local tag ${name}?`,
    confirmLabel: 'Delete tag',
    danger: true
  })
  if (ok) await run('Delete tag', (repo) => git.deleteTag(repo, name))
}

export function labelMenu(label: RefLabel): MenuItem[] {
  const { status, commits } = useStore.getState()
  const current = status?.branch ?? null
  const into = current ?? 'HEAD'

  switch (label.kind) {
    case 'local': {
      const name = label.name
      const items: MenuItem[] = [
        {
          label: label.isCurrent ? `${name} is the current branch` : `Checkout ${name}`,
          disabled: label.isCurrent,
          onClick: () => void run('Checkout', (repo) => git.checkout(repo, fullName(label)))
        },
        SEP
      ]
      if (!label.isCurrent) {
        items.push(
          { label: `Merge ${name} into ${into}`, onClick: () => void run('Merge', (repo) => git.merge(repo, fullName(label))) },
          { label: `Rebase ${into} onto ${name}`, onClick: () => void rebaseCurrentOnto(into, label) },
          interactiveItem(`Interactive rebase ${into} onto ${name}`, rebaseOnto(label.local?.hash ?? '', commits, status)),
          SEP
        )
      }
      items.push(
        { label: `Push ${name}`, onClick: () => void run('Push', (repo) => git.push(repo, { branch: name })) },
        { label: 'Rename…', onClick: () => void renameBranch(name) },
        {
          label: `Delete ${name}…`,
          danger: true,
          disabled: label.isCurrent,
          onClick: () => void deleteLocalBranch(name)
        }
      )
      if (label.remote) {
        const remoteName = label.remote.name
        items.push({
          label: `Delete remote branch ${remoteName}…`,
          danger: true,
          onClick: () => void deleteRemoteBranch(remoteName)
        })
      }
      items.push(SEP, { label: 'Copy branch name', onClick: () => copyText(name, 'Branch name') })
      return items
    }
    case 'remote': {
      const name = gitName(label)
      return [
        { label: `Checkout ${name}`, onClick: () => void run('Checkout', (repo) => git.checkout(repo, fullName(label))) },
        SEP,
        { label: `Merge ${name} into ${into}`, onClick: () => void run('Merge', (repo) => git.merge(repo, fullName(label))) },
        { label: `Rebase ${into} onto ${name}`, onClick: () => void rebaseCurrentOnto(into, label) },
        interactiveItem(`Interactive rebase ${into} onto ${name}`, rebaseOnto(label.remote?.hash ?? '', commits, status)),
        SEP,
        { label: `Delete remote branch ${name}…`, danger: true, onClick: () => void deleteRemoteBranch(name) },
        SEP,
        { label: 'Copy branch name', onClick: () => copyText(name, 'Branch name') }
      ]
    }
    case 'tag': {
      const name = label.name
      return [
        { label: `Checkout tag ${name}`, onClick: () => void run('Checkout', (repo) => git.checkout(repo, fullName(label))) },
        SEP,
        { label: `Delete tag ${name}…`, danger: true, onClick: () => void deleteTag(name) },
        SEP,
        { label: 'Copy tag name', onClick: () => copyText(name, 'Tag name') }
      ]
    }
    case 'stash':
      return stashMenu(label.ref)
    case 'detached':
      return []
  }
}

// --- drag a branch pill onto another one -----------------------------------

export const isBranchLabel = (label: RefLabel): boolean => label.kind === 'local' || label.kind === 'remote'

/** Menu shown when `src` is dropped on `dst` */
export function dropMenu(src: RefLabel, dst: RefLabel): MenuItem[] {
  const srcName = gitName(src)
  const dstName = gitName(dst)
  const current = useStore.getState().status?.branch ?? null
  // merging needs the target checked out, rebasing needs the source checked out
  const canMerge = dst.kind === 'local'
  const canRebase = src.kind === 'local'

  return [
    {
      label: `Merge ${srcName} into ${dstName}`,
      disabled: !canMerge,
      onClick: () =>
        void run('Merge', async (repo) => {
          if (current !== dstName) await git.checkout(repo, fullName(dst))
          await git.merge(repo, fullName(src))
        })
    },
    {
      label: `Rebase ${srcName} onto ${dstName}`,
      disabled: !canRebase,
      onClick: async () => {
        if (!(await confirmRebase(srcName, dstName))) return
        await run('Rebase', async (repo) => {
          if (current !== srcName) await git.checkout(repo, fullName(src))
          await git.rebase(repo, fullName(dst))
        })
      }
    }
  ]
}
