// Toolbar logic that needs no browser: the force-push plan and its wording, the
// "is this a network operation" rule, and a static render of the buttons.
import { renderToString } from 'react-dom/server'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ref, Remote, Status } from '@shared/types'

// A server render of the real zustand store only ever sees its initial state,
// so the components read from this plain stand-in instead.
const fake = vi.hoisted(() => {
  const box: { state: Record<string, unknown> } = { state: {} }
  const useStore = Object.assign((selector: (s: Record<string, unknown>) => unknown) => selector(box.state), {
    getState: () => box.state,
    setState: (patch: Record<string, unknown>) => {
      box.state = { ...box.state, ...patch }
    }
  })
  return { useStore }
})
vi.mock('../../store', () => ({ useStore: fake.useStore, WIP: 'WIP' }))
const useStore = fake.useStore

import { forcePushMessage, isNetworkOp, planForcePush } from './actions'
import { Toolbar } from './Toolbar'

const SHA = (c: string): string => c.repeat(40)
const head = (name: string, extra: Partial<Ref> = {}): Ref => ({ name, type: 'head', hash: SHA('a'), isCurrent: false, ...extra })
const remoteRef = (name: string, hash: string): Ref => ({ name, type: 'remote', hash, isCurrent: false })
const remotes: Remote[] = [
  { name: 'origin', url: 'https://example.com/acme/app.git' },
  { name: 'team/fork', url: 'https://example.com/team/app.git' }
]

describe('isNetworkOp', () => {
  it('is true for transfers and false for local operations', () => {
    for (const label of ['Pull', 'Pull (rebase)', 'Pull (merge)', 'Push', 'Force push', 'Fetch', 'Delete remote branch']) {
      expect(isNetworkOp(label), label).toBe(true)
    }
    for (const label of ['Stash', 'Pop', 'Checkout', 'Create branch', 'Undo', 'Add remote', 'Remove remote', 'Delete branch']) {
      expect(isNetworkOp(label), label).toBe(false)
    }
    expect(isNetworkOp(null)).toBe(false)
  })
})

describe('planForcePush', () => {
  it('targets the upstream and counts the remote commits that would be discarded', () => {
    const refs = [head('main', { upstream: 'origin/main', ahead: 2, behind: 3 }), remoteRef('origin/main', SHA('b'))]
    const plan = planForcePush('main', refs, remotes)
    expect(plan).toEqual({ remote: 'origin', remoteBranch: 'main', lease: SHA('b'), discarded: 3 })
    const text = forcePushMessage('main', plan!)
    expect(text).toContain('"main" on remote "origin"')
    expect(text).toContain('3 commits on the remote branch that are not in your local branch will be discarded')
    expect(forcePushMessage('main', { ...plan!, discarded: 1 })).toContain('1 commit on the remote branch that is not in your local branch will be discarded')
    expect(forcePushMessage('main', { ...plan!, discarded: 0 })).toContain('has no commits that your local branch lacks')
  })

  it('understands remote names with a slash', () => {
    const refs = [head('topic', { upstream: 'team/fork/topic', behind: 1 }), remoteRef('team/fork/topic', SHA('c'))]
    expect(planForcePush('topic', refs, remotes)).toEqual({ remote: 'team/fork', remoteBranch: 'topic', lease: SHA('c'), discarded: 1 })
  })

  it('without an upstream: same name on origin, and an unknown number of commits', () => {
    const refs = [head('topic'), remoteRef('origin/topic', SHA('d'))]
    const plan = planForcePush('topic', refs, remotes)
    expect(plan).toEqual({ remote: 'origin', remoteBranch: 'topic', lease: SHA('d'), discarded: undefined })
    expect(forcePushMessage('topic', plan!)).toContain('Any commits on the remote branch that are not in your local branch will be discarded')
  })

  it('a branch the remote does not have: the lease says "must not exist"', () => {
    const plan = planForcePush('new', [head('new')], [{ name: 'backup', url: 'x' }])
    expect(plan).toEqual({ remote: 'backup', remoteBranch: 'new', lease: '', discarded: 0 })
    expect(forcePushMessage('new', plan!)).toContain('does not exist on "backup" yet')
    expect(planForcePush('new', [head('new')], [])).toBeNull()
  })

  it('reports an upstream with another name as it is (the backend refuses that push)', () => {
    const refs = [head('feature', { upstream: 'origin/main', behind: 0 }), remoteRef('origin/main', SHA('e'))]
    expect(planForcePush('feature', refs, remotes)).toMatchObject({ remote: 'origin', remoteBranch: 'main' })
  })
})

describe('Toolbar (static render)', () => {
  const status: Status = { branch: 'main', head: SHA('a'), staged: [], unstaged: [], conflicted: [], inProgress: null }
  beforeEach(() => {
    useStore.setState({
      recent: [],
      loading: false,
      activeRepo: '/repos/app',
      tabs: [{ path: '/repos/app', name: 'app' }],
      refs: [head('main', { isCurrent: true, upstream: 'origin/main', ahead: 1, behind: 2 }), remoteRef('origin/main', SHA('b'))],
      remotes,
      status,
      busy: null
    })
  })

  it('shows Undo / Redo (disabled until the state is known), Pull and Push with their menus', () => {
    const html = renderToString(<Toolbar />)
    for (const label of ['Undo', 'Redo', 'Pull', 'Push', 'Branch', 'Stash', 'Pop', 'Terminal']) {
      expect(html, label).toContain(`<span class="tool-btn-label">${label}</span>`)
    }
    expect(html).not.toContain('no remotes configured')
    expect(html).toContain('<span class="tool-sel-text">main</span>')
    expect(html).toMatch(/<button class="tool-btn" title="Nothing to undo" disabled="">/)
    expect(html).toMatch(/<button class="tool-btn" title="Nothing to redo" disabled="">/)
    expect(html).toContain('title="Pull options"')
    expect(html).toContain('title="Push options"')
    expect(html).toContain('pull.rebase')
    // Undo and Redo come first in the centre group.
    expect(html.indexOf('>Undo<')).toBeLessThan(html.indexOf('>Redo<'))
    expect(html.indexOf('>Redo<')).toBeLessThan(html.indexOf('>Pull<'))
    expect(html).not.toContain('tool-cancel')
  })

  it('offers Cancel next to the spinner only while a network operation runs', () => {
    useStore.setState({ busy: 'Push' })
    const pushing = renderToString(<Toolbar />)
    expect(pushing).toContain('tool-spin')
    expect(pushing).toMatch(/<button class="tool-cancel" title="Cancel Push">/)

    useStore.setState({ busy: 'Stash' })
    const stashing = renderToString(<Toolbar />)
    expect(stashing).toContain('tool-spin')
    expect(stashing).not.toContain('tool-cancel')
  })
})
