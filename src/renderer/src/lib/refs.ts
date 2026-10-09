import type { Ref } from '@shared/types'
import { useStore } from '../store'
import { confirmDialog } from '../components/ui/overlays'

/**
 * The unambiguous name to send to the backend. A short name such as `v1` can
 * be a branch and a tag at once; the full name always means the ref clicked.
 */
export function fullRefName(ref: Pick<Ref, 'name' | 'type'>): string {
  switch (ref.type) {
    case 'head':
      return `refs/heads/${ref.name}`
    case 'remote':
      return `refs/remotes/${ref.name}`
    case 'tag':
      return `refs/tags/${ref.name}`
    default:
      return ref.name
  }
}

/** The stash that is `stash@{0}` right now, as currently shown */
export const topStash = (): Ref | undefined => useStore.getState().refs.find((r) => r.type === 'stash' && r.name === 'stash@{0}')

/**
 * Rebasing rewrites the commits of the current branch. Says so, and warns when
 * some of them are already on the upstream (a force push will be needed).
 */
export function confirmRebase(current: string, onto: string): Promise<boolean> {
  const branch = useStore.getState().refs.find((r) => r.type === 'head' && r.name === current)
  const pushed = branch?.upstream
    ? `\n\n"${current}" tracks ${branch.upstream}: commits that were already pushed get new hashes, so the next push will have to be a force push.`
    : ''
  return confirmDialog({
    title: 'Rebase',
    message:
      `Rebase "${current}" onto "${onto}"?\n\n` +
      `The commits of "${current}" that are not in "${onto}" are re-created on top of it (history is rewritten).` +
      pushed +
      '\n\nIf it stops on conflicts you can resolve them and continue, or abort to get the branch back as it was.',
    confirmLabel: 'Rebase'
  })
}
