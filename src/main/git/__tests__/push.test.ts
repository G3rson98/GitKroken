// Push destination, force push with an explicit lease, rejection messages, and
// pull honouring the user's configuration. Local bare repositories as remotes.
import { mkdirSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreApi as api } from '../core'
import { GitError } from '../exec'
import { cleanupAll, commitFiles, seededRepo, setupGitEnv, sh, tick, tmpDir } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

function bareRepo(name = 'origin.git'): string {
  const bare = join(tmpDir(), name)
  mkdirSync(bare)
  sh(bare, 'init', '-q', '--bare')
  return bare
}

/** `repo` has pushed `main` to the bare `origin`; `other` is a second clone of it. */
async function setup(): Promise<{ bare: string; repo: string; other: string; first: string }> {
  const bare = bareRepo()
  const { repo, first } = seededRepo()
  await api.addRemote(repo, 'origin', bare)
  await api.push(repo)
  const other = await api.clone(bare, tmpDir())
  return { bare, repo, other, first }
}

/** `push` accepts the commit the user was shown as an explicit lease (see core.ts). */
const forcePush = (repo: string, lease?: string): Promise<void> => {
  const opts: { force: boolean; lease?: string } = lease === undefined ? { force: true } : { force: true, lease }
  return api.push(repo, opts)
}

const failure = async (p: Promise<unknown>): Promise<GitError> => {
  const err = await p.then(
    () => null,
    (e: unknown) => e
  )
  expect(err).toBeInstanceOf(Error)
  return err as GitError
}

describe('push rejected as non-fast-forward', () => {
  it('says what to do, without transfer noise, and leaves the remote alone', async () => {
    const { bare, repo, other } = await setup()
    const theirs = commitFiles(other, { 'theirs.txt': 't\n' }, 'their work')
    await api.push(other)
    commitFiles(repo, { 'mine.txt': 'm\n' }, 'my work')

    const err = await failure(api.push(repo))
    expect(err).toBeInstanceOf(GitError)
    expect(err.message).toMatch(/Push of "main" was rejected by "origin" \(non-fast-forward\)/)
    expect(err.message).toMatch(/Pull to integrate them/)
    expect(err.message).toMatch(/Force Push \(with lease\)/)
    expect(err.message).not.toMatch(/Enumerating|Counting|Writing objects|hint:/)
    expect(err.stderr).toMatch(/\[rejected\]/)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(theirs)

    // Same after a fetch (git then words the rejection differently).
    await api.fetch(repo)
    expect((await failure(api.push(repo))).message).toMatch(/non-fast-forward/)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(theirs)
  })
})

describe('force push (with lease)', () => {
  it('replaces the remote branch when the remote is where we last saw it', async () => {
    const { bare, repo, first } = await setup()
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')
    await api.push(repo)
    await api.reset(repo, first, 'hard')
    const rewritten = commitFiles(repo, { 'a.txt': 'rewritten\n' }, 'rewritten')
    await expect(api.push(repo)).rejects.toThrow(/non-fast-forward/)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(second)

    await forcePush(repo)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(rewritten)
    expect(sh(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(rewritten)
  })

  it('is rejected when someone pushed in the meantime, and their commit survives', async () => {
    const { bare, repo, other } = await setup()
    const theirs = commitFiles(other, { 'theirs.txt': 't\n' }, 'their work')
    await api.push(other)
    sh(repo, 'commit', '-q', '--amend', '-m', 'first, amended')

    const err = await failure(forcePush(repo))
    expect(err.message).toMatch(/Force push rejected \(stale info\)/)
    expect(err.message).toMatch(/"main" on "origin"/)
    expect(err.message).toMatch(/Fetch, review the remote commits/)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(theirs)
  })

  it('holds the lease on the commit the user was shown, even if a fetch moved the tracking ref since', async () => {
    const { bare, repo, other, first } = await setup()
    // The user opens the confirmation while origin/main is at `first`...
    const shown = sh(repo, 'rev-parse', 'refs/remotes/origin/main')
    expect(shown).toBe(first)
    // ...someone pushes, and a background fetch updates origin/main behind the dialog.
    const theirs = commitFiles(other, { 'theirs.txt': 't\n' }, 'their work')
    await api.push(other)
    await api.fetch(repo)
    expect(sh(repo, 'rev-parse', 'refs/remotes/origin/main')).toBe(theirs)
    sh(repo, 'commit', '-q', '--amend', '-m', 'first, amended')
    const mine = sh(repo, 'rev-parse', 'HEAD')

    // A bare --force-with-lease would now happily discard `theirs`.
    expect((await failure(forcePush(repo, shown))).message).toMatch(/stale info/)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(theirs)

    // '' = "the remote branch must not exist".
    expect((await failure(forcePush(repo, ''))).message).toMatch(/stale info/)
    await expect(forcePush(repo, 'not-a-sha')).rejects.toThrow(/Invalid lease/)
    await expect(forcePush(repo, '--exec=evil')).rejects.toThrow(/Invalid lease/)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(theirs)

    // Having seen their commit, the user confirms again.
    await forcePush(repo, theirs)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(mine)
  })

  it('force-pushing a branch the remote does not have yet just creates it', async () => {
    const { bare, repo } = await setup()
    await api.createBranch(repo, 'topic', undefined, true)
    const tip = commitFiles(repo, { 't.txt': 't\n' }, 'topic work')
    await forcePush(repo)
    expect(sh(bare, 'rev-parse', 'refs/heads/topic')).toBe(tip)
    expect((await api.refs(repo)).find((r) => r.name === 'topic')?.upstream).toBe('origin/topic')
  })
})

describe('push destination', () => {
  it('refuses to push a branch onto a remote branch with another name', async () => {
    const { bare, repo, first } = await setup()
    // What `git checkout -b feature origin/main` leaves behind: feature tracks origin/main.
    sh(repo, 'checkout', '-q', '-b', 'feature', 'origin/main')
    expect((await api.refs(repo)).find((r) => r.name === 'feature')?.upstream).toBe('origin/main')
    const tip = commitFiles(repo, { 'feature.txt': 'f\n' }, 'feature work')

    for (const attempt of [() => api.push(repo), () => api.push(repo, { branch: 'feature' }), () => forcePush(repo)]) {
      const err = await failure(attempt())
      expect(err.message).toMatch(/^Push refused/)
      expect(err.message).toContain('"feature"')
      expect(err.message).toContain('"main"')
      expect(err.message).toContain('"origin"')
    }
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(first)
    expect(sh(bare, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main')

    // Following the advice in the message publishes it under its own name.
    sh(repo, 'branch', '--unset-upstream', 'feature')
    await api.push(repo)
    expect(sh(bare, 'rev-parse', 'refs/heads/feature')).toBe(tip)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(first)
    expect((await api.refs(repo)).find((r) => r.name === 'feature')?.upstream).toBe('origin/feature')
  })

  it('honours remote.pushDefault and branch.<name>.pushRemote', async () => {
    const { bare, repo, first } = await setup()
    const fork = bareRepo('fork.git')
    await api.addRemote(repo, 'fork', fork)
    sh(repo, 'config', 'remote.pushDefault', 'fork')

    // main pulls from origin but is pushed to the fork; its upstream stays put.
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')
    await api.push(repo)
    expect(sh(fork, 'rev-parse', 'refs/heads/main')).toBe(second)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(first)
    expect((await api.refs(repo)).find((r) => r.name === 'main')?.upstream).toBe('origin/main')

    // A new branch goes to the fork too.
    await api.createBranch(repo, 'topic', undefined, true)
    const topic = commitFiles(repo, { 't.txt': 't\n' }, 'topic work')
    await api.push(repo)
    expect(sh(fork, 'rev-parse', 'refs/heads/topic')).toBe(topic)
    expect(sh(bare, 'for-each-ref', '--format=%(refname)')).toBe('refs/heads/main')

    // branch.<name>.pushRemote wins over remote.pushDefault.
    await api.createBranch(repo, 'release', undefined, true)
    sh(repo, 'config', 'branch.release.pushRemote', 'origin')
    const release = commitFiles(repo, { 'r.txt': 'r\n' }, 'release work')
    await api.push(repo)
    expect(sh(bare, 'rev-parse', 'refs/heads/release')).toBe(release)
    expect(sh(fork, 'for-each-ref', '--format=%(refname)').split('\n')).toEqual(['refs/heads/main', 'refs/heads/topic'])

    // A force push to the fork leases the fork's branch, not origin's.
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'commit', '-q', '--amend', '-m', 'second, amended')
    await forcePush(repo)
    expect(sh(fork, 'rev-parse', 'refs/heads/main')).toBe(sh(repo, 'rev-parse', 'HEAD'))
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(first)
  })
})

describe('pull without an explicit mode', () => {
  async function diverged(): Promise<{ repo: string; theirs: string; mine: string }> {
    const { repo, other } = await setup()
    const theirs = commitFiles(other, { 'theirs.txt': 't\n' }, 'their work')
    await api.push(other)
    const mine = commitFiles(repo, { 'mine.txt': 'm\n' }, 'my work')
    tick()
    return { repo, theirs, mine }
  }

  it('merges when nothing is configured', async () => {
    const { repo, theirs, mine } = await diverged()
    await api.pull(repo)
    expect((await api.log(repo, { limit: 1 }))[0]!.parents).toEqual([mine, theirs])
  })

  it('rebases when pull.rebase says so', async () => {
    const { repo, theirs } = await diverged()
    sh(repo, 'config', 'pull.rebase', 'true')
    await api.pull(repo)
    const [head] = await api.log(repo, { limit: 1 })
    expect(head).toMatchObject({ subject: 'my work', parents: [theirs] })
  })

  it('rebases when branch.<name>.rebase says so, and an explicit choice still wins', async () => {
    const { repo, theirs, mine } = await diverged()
    sh(repo, 'config', 'branch.main.rebase', 'true')
    await api.pull(repo, { rebase: false })
    expect((await api.log(repo, { limit: 1 }))[0]!.parents).toEqual([mine, theirs])

    const again = await diverged()
    sh(again.repo, 'config', 'branch.main.rebase', 'true')
    await api.pull(again.repo)
    expect((await api.log(again.repo, { limit: 1 }))[0]).toMatchObject({ subject: 'my work', parents: [again.theirs] })
  })

  it('explains a branch whose upstream was deleted on the remote, or that has none', async () => {
    const { repo, other } = await setup()
    await api.createBranch(repo, 'topic', undefined, true)
    commitFiles(repo, { 't.txt': 't\n' }, 'topic work')
    await api.push(repo)
    await api.deleteRemoteBranch(other, 'origin', 'topic')
    sh(repo, 'config', 'fetch.prune', 'true')
    await expect(api.pull(repo)).rejects.toThrow(/the remote branch "origin\/topic" no longer exists/)

    await api.createBranch(repo, 'local-only', undefined, true)
    await expect(api.pull(repo)).rejects.toThrow(/no tracking information/i)
    expect((await api.status(repo)).inProgress).toBeNull()
  })
})
