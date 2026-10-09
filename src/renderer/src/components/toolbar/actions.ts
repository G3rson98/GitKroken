// Git actions shared by the toolbar, the sidebar and the welcome screen.
// Every mutation goes through the store's `run` (busy state + toast + refresh).
import type { Ref, Remote } from '@shared/types'
import { git } from '../../lib/git'
import { useStore } from '../../store'
import { confirmDialog, promptDialog, showContextMenu, toast, type MenuItem } from '../ui/overlays'

export const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const run = (label: string, fn: (repo: string) => Promise<unknown>, successMsg?: string): Promise<boolean> =>
  useStore.getState().run(label, fn, successMsg)

export const shortSha = (hash: string | null | undefined): string => (hash ? hash.slice(0, 7) : '')

/** Opens the shared context menu anchored under an element (dropdown-button style). */
export function menuBelow(el: Element, items: MenuItem[]): void {
  const r = el.getBoundingClientRect()
  showContextMenu(new MouseEvent('click', { clientX: Math.round(r.left), clientY: Math.round(r.bottom + 4) }), items)
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copied to clipboard')
  } catch {
    toast('Could not copy to the clipboard', 'error')
  }
}

export const checkoutRef = (ref: string): Promise<boolean> => run('Checkout', (repo) => git.checkout(repo, ref))

/** Prompts for a name, creates the branch at HEAD and checks it out. */
export async function createBranchAtHead(): Promise<void> {
  const typed = await promptDialog({
    title: 'New branch',
    label: 'Branch name (created at HEAD)',
    placeholder: 'feature/my-branch',
    confirmLabel: 'Create branch'
  })
  if (!typed) return
  const name = typed.replace(/\s+/g, '-')
  await run('Create branch', (repo) => git.createBranch(repo, name, undefined, true), `Branch "${name}" created`)
}

export async function openRepoFromDisk(): Promise<void> {
  try {
    const dir = await git.pickDirectory('Open repository')
    if (dir) await useStore.getState().openRepo(dir)
  } catch (e) {
    toast(errText(e), 'error')
  }
}

// ----- network operations ---------------------------------------------------

/** What the backend rejects with when an operation is cancelled (see main/git/net.ts) */
export const CANCELLED = 'Operation cancelled'

/** `run` labels of the operations that talk to a remote and can be cancelled */
const NETWORK_OP = /^(pull|push|force push|fetch|delete remote branch)\b/i

export const isNetworkOp = (label: string | null): boolean => label !== null && NETWORK_OP.test(label)

/** Kills the fetch / pull / push running for the active repository. */
export async function cancelNetworkOp(): Promise<void> {
  const repo = useStore.getState().activeRepo
  if (!repo) return
  try {
    // False when the transfer is already over (e.g. a pull that is now merging).
    if (!(await git.cancel(repo))) toast('Nothing to cancel: no transfer is in progress')
  } catch (e) {
    toast(`Cancel: ${errText(e)}`, 'error')
  }
}

export const pushBranch = (branch?: string): Promise<boolean> =>
  run('Push', (repo) => git.push(repo, branch ? { branch } : undefined), branch ? `Pushed "${branch}"` : 'Push complete')

export interface ForcePushPlan {
  /** Remote the push goes to */
  remote: string
  /** Branch name on that remote */
  remoteBranch: string
  /** Commit of the remote branch as the app currently shows it; '' when it has none */
  lease: string
  /** Commits on the remote branch that the local branch lacks; undefined when unknown */
  discarded: number | undefined
}

/**
 * Where a force push of `branch` goes and what it would overwrite, from what
 * is on screen (the same rule as the backend: the upstream, else a branch of
 * the same name on `origin` / the first remote).
 */
export function planForcePush(branch: string, refs: Ref[], remotes: Remote[]): ForcePushPlan | null {
  const local = refs.find((r) => r.type === 'head' && r.name === branch)
  const upstream = local?.upstream
  const upstreamRemote = upstream
    ? remotes
        .map((r) => r.name)
        .filter((name) => upstream.startsWith(`${name}/`))
        .sort((a, b) => b.length - a.length)[0]
    : undefined
  const remote = upstreamRemote ?? (remotes.some((r) => r.name === 'origin') ? 'origin' : remotes[0]?.name)
  if (!remote) return null
  const remoteBranch = upstream && upstreamRemote ? upstream.slice(upstreamRemote.length + 1) : branch
  const tracking = refs.find((r) => r.type === 'remote' && r.name === `${remote}/${remoteBranch}`)
  let discarded: number | undefined
  if (!tracking) discarded = 0
  else if (upstream === tracking.name) discarded = local?.behind
  return { remote, remoteBranch, lease: tracking?.hash ?? '', discarded }
}

export function forcePushMessage(branch: string, plan: ForcePushPlan): string {
  const { remote, remoteBranch, discarded } = plan
  const where = `"${remoteBranch}" on remote "${remote}"`
  let effect: string
  if (plan.lease === '') effect = `As of the last fetch, "${remoteBranch}" does not exist on "${remote}" yet, so nothing would be discarded.`
  else if (discarded === undefined) effect = 'Any commits on the remote branch that are not in your local branch will be discarded.'
  else if (discarded === 0) effect = 'As of the last fetch, the remote branch has no commits that your local branch lacks.'
  else {
    effect = `${discarded === 1 ? '1 commit' : `${discarded} commits`} on the remote branch that ${discarded === 1 ? 'is' : 'are'} not in your local branch will be discarded.`
  }
  return (
    `This overwrites ${where} with your local branch "${branch}".\n\n${effect}\n\n` +
    'Remote commits that are not in your local branch are lost for everyone using the remote. ' +
    'The push is rejected if the remote branch has changed from what you see now (with lease).'
  )
}

/** Force push (with lease) of `branch`, after a confirmation that says what will be lost. */
export async function forcePush(branch: string): Promise<void> {
  const { refs, remotes } = useStore.getState()
  const plan = planForcePush(branch, refs, remotes)
  if (!plan) {
    toast('Force push: this repository has no remote', 'error')
    return
  }
  if (plan.remoteBranch !== branch) {
    // The backend never pushes onto a branch with another name; let it explain.
    await run('Force push', (repo) => git.push(repo, { branch, force: true }))
    return
  }
  const yes = await confirmDialog({
    title: `Force push "${branch}" to ${plan.remote}`,
    message: forcePushMessage(branch, plan),
    confirmLabel: 'Force Push',
    danger: true
  })
  if (!yes) return
  // `lease` pins the push to the remote commit shown in this confirmation: if
  // the remote moved in the meantime the backend refuses instead of overwriting.
  // (The backend accepts it; it is not part of the shared GitApi type yet.)
  const opts = { branch, force: true, lease: plan.lease }
  await run('Force push', (repo) => git.push(repo, opts), `Force pushed "${branch}"`)
}
