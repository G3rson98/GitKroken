import { rmSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { coreApi as api } from '../core'
import { isNoise, onRepoChanged, unwatchAll } from '../watcher'
import { cleanupAll, commitFiles, seededRepo, setupGitEnv, sh, tmpDir, write } from './helpers'

beforeAll(() => setupGitEnv())
afterEach(() => unwatchAll())
afterAll(() => cleanupAll())

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

/** Collects change notifications for one repo. */
function recorder(repo: string): { count: () => number; reset: () => void; next: (timeout?: number) => Promise<boolean>; stop: () => void } {
  let events = 0
  const stop = onRepoChanged((r) => {
    if (r === repo) events++
  })
  return {
    count: () => events,
    reset: () => {
      events = 0
    },
    async next(timeout = 4000) {
      const deadline = Date.now() + timeout
      while (Date.now() < deadline) {
        if (events > 0) return true
        await sleep(25)
      }
      return events > 0
    },
    stop
  }
}

/** Lets FSEvents settle so earlier writes are not reported late. */
const settle = (): Promise<void> => sleep(700)

describe('isNoise', () => {
  it('ignores lock churn, objects and node_modules', () => {
    expect(isNoise('.git/index.lock')).toBe(true)
    expect(isNoise('.git/refs/heads/main.lock')).toBe(true)
    expect(isNoise('.git/HEAD.lock')).toBe(true)
    expect(isNoise('.git/objects/ab/cdef0123')).toBe(true)
    expect(isNoise('.git/objects/pack/tmp_pack_x')).toBe(true)
    expect(isNoise('.git')).toBe(true)
    expect(isNoise('node_modules/react/index.js')).toBe(true)
    expect(isNoise('packages/app/node_modules/x/y.js')).toBe(true)
    expect(isNoise('vendor/lib/.git/index')).toBe(true)
    expect(isNoise('.DS_Store')).toBe(true)
    expect(isNoise('src/.DS_Store')).toBe(true)
    expect(isNoise('src/.main.ts.swp')).toBe(true)
  })

  it('lets worktree edits and ref / index / HEAD changes through', () => {
    expect(isNoise('src/main.ts')).toBe(false)
    expect(isNoise('README.md')).toBe(false)
    expect(isNoise('.gitignore')).toBe(false)
    expect(isNoise('.git/index')).toBe(false)
    expect(isNoise('.git/HEAD')).toBe(false)
    expect(isNoise('.git/refs/heads/main')).toBe(false)
    expect(isNoise('.git/refs/remotes/origin/main')).toBe(false)
    expect(isNoise('.git/refs/tags/v1')).toBe(false)
    expect(isNoise('.git/packed-refs')).toBe(false)
    expect(isNoise('.git/logs/refs/stash')).toBe(false)
    expect(isNoise('.git/MERGE_HEAD')).toBe(false)
    expect(isNoise('.git/rebase-merge/done')).toBe(false)
    // Relative to a git dir that lives outside the worktree.
    expect(isNoise('refs/heads/main', true)).toBe(false)
    expect(isNoise('index.lock', true)).toBe(true)
    expect(isNoise('objects/ab/cd', true)).toBe(true)
  })
})

describe('watch / unwatch', () => {
  it('fires (debounced) on worktree edits and on ref changes, ignores noise, stops on unwatch', async () => {
    const { repo } = seededRepo()
    write(repo, 'node_modules/pkg/index.js', 'x\n')
    await settle()

    const rec = recorder(repo)
    await api.watch(repo)
    await api.watch(repo) // idempotent
    await settle()
    rec.reset()

    // 1. Worktree edit: a burst of writes collapses into few notifications.
    for (let i = 0; i < 5; i++) write(repo, 'a.txt', `edit ${i}\n`)
    expect(await rec.next()).toBe(true)
    await settle()
    expect(rec.count()).toBeLessThanOrEqual(2)

    // 2. Noise only: nothing.
    rec.reset()
    write(repo, 'node_modules/pkg/index.js', 'changed\n')
    write(repo, '.git/index.lock', '')
    rmSync(join(repo, '.git/index.lock'))
    write(repo, '.git/objects/zz/loose', 'x')
    await sleep(1200)
    expect(rec.count()).toBe(0)

    // 3. Ref-only change (no worktree file touched): a new branch and a tag.
    rec.reset()
    sh(repo, 'branch', 'watched-branch')
    expect(await rec.next()).toBe(true)
    await settle()
    rec.reset()
    sh(repo, 'tag', 'watched-tag')
    expect(await rec.next()).toBe(true)

    // 4. Index change through our own API.
    await settle()
    rec.reset()
    await api.stage(repo, ['a.txt'])
    expect(await rec.next()).toBe(true)

    // 5. A commit made outside the app.
    await settle()
    rec.reset()
    commitFiles(repo, { 'b.txt': 'b\n' }, 'outside commit')
    expect(await rec.next()).toBe(true)

    // 6. Reading state must not itself trigger a notification loop.
    await settle()
    rec.reset()
    await Promise.all([api.status(repo), api.log(repo), api.refs(repo), api.remotes(repo)])
    await api.diff(repo, { path: 'a.txt' })
    await sleep(1200)
    expect(rec.count()).toBe(0)

    // 7. After unwatch: silence.
    await api.unwatch(repo)
    rec.reset()
    write(repo, 'a.txt', 'after unwatch\n')
    sh(repo, 'branch', 'unwatched-branch')
    await sleep(1200)
    expect(rec.count()).toBe(0)
    rec.stop()
  }, 30_000)

  it('never throws for missing folders, non-repos or repeated unwatch', async () => {
    await expect(api.watch(join(tmpDir(), 'missing'))).resolves.toBeUndefined()
    await expect(api.unwatch(join(tmpDir(), 'missing'))).resolves.toBeUndefined()
    const plain = tmpDir()
    await expect(api.watch(plain)).resolves.toBeUndefined()
    await expect(api.unwatch(plain)).resolves.toBeUndefined()
    await expect(api.unwatch(plain)).resolves.toBeUndefined()
    await expect(api.unwatch('never-watched')).resolves.toBeUndefined()
    await expect(api.watch(undefined as unknown as string)).resolves.toBeUndefined()
  })

  it('a throwing listener does not break other listeners', async () => {
    const { repo } = seededRepo()
    const stopBad = onRepoChanged(() => {
      throw new Error('listener bug')
    })
    const rec = recorder(repo)
    await api.watch(repo)
    await settle()
    rec.reset()
    write(repo, 'a.txt', 'changed\n')
    expect(await rec.next()).toBe(true)
    stopBad()
    rec.stop()
  }, 15_000)
})
