// End-to-end tests of the git backend against real temporary repositories.
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreApi as api, repoNameFromUrl } from '../core'
import { cleanupAll, commitFiles, emptyRepo, lines, seededRepo, setupGitEnv, sh, tick, tmpDir, write } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8')
const paths = (list: { path: string }[]): string[] => list.map((f) => f.path).sort()

describe('repositories', () => {
  it('resolveRepo returns the top level, or null outside a repo', async () => {
    const repo = emptyRepo()
    mkdirSync(join(repo, 'sub/dir'), { recursive: true })
    write(repo, 'sub/dir/file.txt', 'x')
    expect(await api.resolveRepo(repo)).toBe(repo)
    expect(await api.resolveRepo(join(repo, 'sub/dir'))).toBe(repo)
    expect(await api.resolveRepo(join(repo, 'sub/dir/file.txt'))).toBe(repo)
    expect(await api.resolveRepo(tmpDir())).toBeNull()
    expect(await api.resolveRepo(join(repo, 'does-not-exist'))).toBeNull()
  })

  it('init creates the folder and a repository', async () => {
    const target = join(tmpDir(), 'nested', 'new-repo')
    const repo = await api.init(target)
    expect(repo).toBe(target)
    expect(existsSync(join(target, '.git'))).toBe(true)
    expect(await api.resolveRepo(target)).toBe(target)
  })

  it('derives the clone folder name from the URL', () => {
    expect(repoNameFromUrl('https://github.com/acme/widgets.git')).toBe('widgets')
    expect(repoNameFromUrl('git@github.com:acme/widgets.git')).toBe('widgets')
    expect(repoNameFromUrl('https://example.com/acme/widgets/')).toBe('widgets')
    expect(repoNameFromUrl('/srv/git/widgets.git/')).toBe('widgets')
    expect(repoNameFromUrl('host:widgets')).toBe('widgets')
    expect(() => repoNameFromUrl('///')).toThrow()
  })
})

describe('empty repository (no commits)', () => {
  it('log / refs / status work', async () => {
    const repo = emptyRepo()
    expect(await api.log(repo)).toEqual([])
    expect(await api.log(repo, { limit: 50, skip: 10 })).toEqual([])
    expect(await api.refs(repo)).toEqual([])
    expect(await api.remotes(repo)).toEqual([])
    expect(await api.status(repo)).toEqual({
      branch: 'main',
      head: null,
      staged: [],
      unstaged: [],
      conflicted: [],
      inProgress: null
    })
  })

  it('stage / diff / unstage / discard / first commit work before HEAD exists', async () => {
    const repo = emptyRepo()
    write(repo, 'new.txt', 'hello\n')
    write(repo, 'other.txt', 'other\n')

    let st = await api.status(repo)
    expect(st.unstaged).toEqual([
      { path: 'new.txt', status: 'untracked' },
      { path: 'other.txt', status: 'untracked' }
    ])

    await api.stage(repo, ['new.txt'])
    st = await api.status(repo)
    expect(st.staged).toEqual([{ path: 'new.txt', status: 'added' }])
    expect(await api.diff(repo, { path: 'new.txt', staged: true })).toContain('+hello')

    await api.unstage(repo, ['new.txt'])
    st = await api.status(repo)
    expect(st.staged).toEqual([])
    expect(paths(st.unstaged)).toEqual(['new.txt', 'other.txt'])

    await api.stageAll(repo)
    expect(paths((await api.status(repo)).staged)).toEqual(['new.txt', 'other.txt'])
    await api.unstageAll(repo)
    expect((await api.status(repo)).staged).toEqual([])

    await api.discard(repo, ['other.txt'])
    expect(existsSync(join(repo, 'other.txt'))).toBe(false)

    await api.stage(repo, ['new.txt'])
    await api.commit(repo, 'initial commit')
    st = await api.status(repo)
    expect(st.head).toMatch(/^[0-9a-f]{40}$/)
    expect(st.staged).toEqual([])
    const log = await api.log(repo)
    expect(log).toHaveLength(1)
    expect(log[0]).toMatchObject({ subject: 'initial commit', parents: [], author: 'Test User', email: 'test@example.com' })
  })

  it('discardAll empties an unborn repository', async () => {
    const repo = emptyRepo()
    write(repo, 'staged.txt', 's\n')
    write(repo, 'dir/untracked.txt', 'u\n')
    await api.stage(repo, ['staged.txt'])
    await api.discardAll(repo)
    expect(existsSync(join(repo, 'staged.txt'))).toBe(false)
    expect(existsSync(join(repo, 'dir'))).toBe(false)
    const st = await api.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([])
  })
})

describe('log', () => {
  it('returns all branches newest first with parents, and paginates', async () => {
    const { repo, first } = seededRepo()
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')
    sh(repo, 'checkout', '-q', '-b', 'feature', first)
    const side = commitFiles(repo, { 'b.txt': 'side\n' }, 'side work')
    sh(repo, 'checkout', '-q', 'main')

    const log = await api.log(repo)
    expect(log.map((c) => c.subject)).toEqual(['side work', 'second', 'first'])
    expect(log.map((c) => c.hash)).toEqual([side, second, first])
    expect(log[0]!.parents).toEqual([first])
    expect(log[2]!.parents).toEqual([])
    expect(log[0]!.date).toBeGreaterThan(log[1]!.date)
    expect(log.every((c) => c.isStash === undefined)).toBe(true)

    expect((await api.log(repo, { limit: 2 })).map((c) => c.subject)).toEqual(['side work', 'second'])
    expect((await api.log(repo, { limit: 2, skip: 1 })).map((c) => c.subject)).toEqual(['second', 'first'])
    expect((await api.log(repo, { limit: 5, skip: 3 })).map((c) => c.subject)).toEqual([])
  })

  it('survives bodies containing separators and odd characters', async () => {
    const { repo } = seededRepo()
    write(repo, 'a.txt', 'changed\n')
    const body = 'line one\n\nsep \x1f unit \x1e record | pipes "quotes" \'single\' %H %x00\n\ttabbed — ünïcödé 🎉\n# not a comment'
    await api.stage(repo, ['a.txt'])
    tick()
    await api.commit(repo, `Weird: subject with %s and \x1f\n\n${body}`)
    commitFiles(repo, { 'c.txt': 'c\n' }, 'after')

    const log = await api.log(repo)
    expect(log.map((c) => c.subject)).toEqual(['after', 'Weird: subject with %s and \x1f', 'first'])
    expect(log[1]!.body).toBe(body)
    expect(log[0]!.body).toBe('')
  })

  it('includes detached HEAD commits and merge parents', async () => {
    const { repo, first } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'topic')
    const topic = commitFiles(repo, { 't.txt': 't\n' }, 'topic commit')
    sh(repo, 'checkout', '-q', 'main')
    const main2 = commitFiles(repo, { 'm.txt': 'm\n' }, 'main commit')
    tick()
    await api.merge(repo, 'topic')
    const log = await api.log(repo)
    expect(log[0]!.subject).toMatch(/^Merge branch 'topic'/)
    expect(log[0]!.parents).toEqual([main2, topic])

    sh(repo, 'checkout', '-q', '--detach', first)
    const detached = commitFiles(repo, { 'd.txt': 'd\n' }, 'detached commit')
    expect((await api.log(repo))[0]!.hash).toBe(detached)
    expect((await api.status(repo)).branch).toBeNull()
  })
})

describe('refs', () => {
  it('lists heads, tags (peeled) and marks the current branch', async () => {
    const { repo, first } = seededRepo()
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')
    await api.createBranch(repo, 'dev', first)
    await api.createTag(repo, 'v1-light', first)
    await api.createTag(repo, 'v2-annotated', second, 'Release two')

    const refs = await api.refs(repo)
    expect(refs).toEqual([
      { name: 'dev', type: 'head', hash: first, isCurrent: false },
      { name: 'main', type: 'head', hash: second, isCurrent: true },
      { name: 'v1-light', type: 'tag', hash: first, isCurrent: false },
      { name: 'v2-annotated', type: 'tag', hash: second, isCurrent: false }
    ])
    // The annotated tag really is a tag object, distinct from the commit.
    expect(sh(repo, 'cat-file', '-t', 'v2-annotated')).toBe('tag')
    expect(sh(repo, 'rev-parse', 'v2-annotated')).not.toBe(second)

    await api.deleteTag(repo, 'v1-light')
    expect((await api.refs(repo)).map((r) => r.name)).toEqual(['dev', 'main', 'v2-annotated'])
  })

  it('checking out a tag detaches HEAD', async () => {
    const { repo, first } = seededRepo()
    commitFiles(repo, { 'a.txt': 'two\n' }, 'second')
    await api.createTag(repo, 'v1', first)
    await api.checkout(repo, 'v1')
    const st = await api.status(repo)
    expect(st.branch).toBeNull()
    expect(st.head).toBe(first)
    expect((await api.refs(repo)).filter((r) => r.isCurrent)).toEqual([])
  })
})

describe('status', () => {
  it('reports staged, unstaged, renamed, deleted and untracked files', async () => {
    const repo = emptyRepo()
    commitFiles(
      repo,
      { 'mod.txt': 'm\n', 'del.txt': 'd\n', 'old name.txt': lines(20), 'staged-del.txt': 's\n', 'both.txt': 'b\n' },
      'base'
    )
    write(repo, 'mod.txt', 'm2\n')
    rmSync(join(repo, 'del.txt'))
    sh(repo, 'mv', 'old name.txt', 'new name.txt')
    sh(repo, 'rm', '-q', 'staged-del.txt')
    write(repo, 'both.txt', 'b staged\n')
    sh(repo, 'add', 'both.txt')
    write(repo, 'both.txt', 'b staged then edited\n')
    write(repo, 'dir with space/ünï côdé.txt', 'u\n')
    write(repo, 'added.txt', 'a\n')
    sh(repo, 'add', 'added.txt')

    const st = await api.status(repo)
    expect(st.branch).toBe('main')
    expect(st.inProgress).toBeNull()
    expect(st.conflicted).toEqual([])
    expect(st.staged.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'added.txt', status: 'added' },
      { path: 'both.txt', status: 'modified' },
      { path: 'new name.txt', oldPath: 'old name.txt', status: 'renamed' },
      { path: 'staged-del.txt', status: 'deleted' }
    ])
    expect(st.unstaged.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'both.txt', status: 'modified' },
      { path: 'del.txt', status: 'deleted' },
      { path: 'dir with space/ünï côdé.txt', status: 'untracked' },
      { path: 'mod.txt', status: 'modified' }
    ])
  })
})

describe('stage / unstage / discard', () => {
  it('stages and unstages modifications, deletions and renames', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n', 'r.txt': lines(20) }, 'base')
    write(repo, 'a.txt', 'a2\n')
    rmSync(join(repo, 'b.txt'))

    await api.stage(repo, ['a.txt', 'b.txt'])
    let st = await api.status(repo)
    expect(st.staged).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'deleted' }
    ])
    expect(st.unstaged).toEqual([])

    await api.unstage(repo, ['b.txt'])
    st = await api.status(repo)
    expect(st.staged).toEqual([{ path: 'a.txt', status: 'modified' }])
    expect(st.unstaged).toEqual([{ path: 'b.txt', status: 'deleted' }])

    // Unstaging only the new name of a rename restores the old name too.
    renameSync(join(repo, 'r.txt'), join(repo, 'renamed.txt'))
    await api.stageAll(repo)
    st = await api.status(repo)
    expect(st.staged).toContainEqual({ path: 'renamed.txt', oldPath: 'r.txt', status: 'renamed' })
    await api.unstage(repo, ['renamed.txt'])
    st = await api.status(repo)
    expect(st.staged.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt'])
    expect(st.unstaged.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'r.txt', status: 'deleted' },
      { path: 'renamed.txt', status: 'untracked' }
    ])

    await api.unstageAll(repo)
    expect((await api.status(repo)).staged).toEqual([])
  })

  it('discard restores tracked files and deletes untracked ones', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'a.txt': 'a\n', 'gone.txt': 'g\n', 'keep.txt': 'k\n' }, 'base')
    write(repo, 'a.txt', 'changed\n')
    rmSync(join(repo, 'gone.txt'))
    write(repo, 'keep.txt', 'keep my edit\n')
    write(repo, 'junk/untracked.txt', 'u\n')
    write(repo, '-dash.txt', 'starts with a dash\n')
    write(repo, 'star*.txt', 'glob chars\n')
    write(repo, 'starX.txt', 'must survive a glob\n')

    await api.discard(repo, ['a.txt', 'gone.txt', 'junk/untracked.txt', '-dash.txt', 'star*.txt'])
    expect(read(repo, 'a.txt')).toBe('a\n')
    expect(read(repo, 'gone.txt')).toBe('g\n')
    expect(existsSync(join(repo, 'junk/untracked.txt'))).toBe(false)
    expect(existsSync(join(repo, '-dash.txt'))).toBe(false)
    expect(existsSync(join(repo, 'star*.txt'))).toBe(false)
    // Paths are literal: `star*.txt` must not have matched `starX.txt`.
    expect(read(repo, 'starX.txt')).toBe('must survive a glob\n')
    expect(read(repo, 'keep.txt')).toBe('keep my edit\n')
    expect(paths((await api.status(repo)).unstaged)).toEqual(['keep.txt', 'starX.txt'])
  })

  it('discard on a staged-new file goes back to the staged content', async () => {
    const { repo } = seededRepo()
    write(repo, 'fresh.txt', 'staged version\n')
    await api.stage(repo, ['fresh.txt'])
    write(repo, 'fresh.txt', 'later scribbles\n')
    expect((await api.status(repo)).unstaged).toEqual([{ path: 'fresh.txt', status: 'modified' }])

    await api.discard(repo, ['fresh.txt'])
    expect(read(repo, 'fresh.txt')).toBe('staged version\n')
    let st = await api.status(repo)
    expect(st.staged).toEqual([{ path: 'fresh.txt', status: 'added' }])
    expect(st.unstaged).toEqual([])

    // Staged-new then deleted from disk: discard brings it back.
    rmSync(join(repo, 'fresh.txt'))
    await api.discard(repo, ['fresh.txt'])
    expect(read(repo, 'fresh.txt')).toBe('staged version\n')

    // No worktree change at all: discard is a harmless no-op.
    await api.discard(repo, ['fresh.txt'])
    st = await api.status(repo)
    expect(st.staged).toEqual([{ path: 'fresh.txt', status: 'added' }])
  })

  it('discardAll resets everything', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'base')
    write(repo, 'a.txt', 'staged change\n')
    await api.stage(repo, ['a.txt'])
    write(repo, 'b.txt', 'unstaged change\n')
    write(repo, 'new/deep/file.txt', 'untracked\n')
    write(repo, 'staged-new.txt', 'n\n')
    await api.stage(repo, ['staged-new.txt'])

    await api.discardAll(repo)
    const st = await api.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([])
    expect(read(repo, 'a.txt')).toBe('a\n')
    expect(read(repo, 'b.txt')).toBe('b\n')
    expect(existsSync(join(repo, 'new'))).toBe(false)
    expect(existsSync(join(repo, 'staged-new.txt'))).toBe(false)
  })

  it('concurrent staging calls do not collide on index.lock', async () => {
    const { repo } = seededRepo()
    const names = Array.from({ length: 12 }, (_, i) => `f${i}.txt`)
    for (const n of names) write(repo, n, `${n}\n`)
    await Promise.all(names.map((n) => api.stage(repo, [n])))
    expect(paths((await api.status(repo)).staged)).toEqual([...names].sort())
  })
})

describe('robustness', () => {
  it('large selections go through stdin, and folders can be discarded', async () => {
    const { repo } = seededRepo()
    const tracked = Array.from({ length: 120 }, (_, i) => `tracked/file ${i}.txt`)
    commitFiles(repo, Object.fromEntries(tracked.map((f) => [f, 'v1\n'])), 'many files')
    for (const f of tracked) write(repo, f, 'v2\n')
    const fresh = Array.from({ length: 120 }, (_, i) => `fresh/deep/new ${i}.txt`)
    for (const f of fresh) write(repo, f, 'new\n')

    await api.stage(repo, [...tracked, ...fresh])
    let st = await api.status(repo)
    expect(st.staged).toHaveLength(240)
    expect(st.unstaged).toEqual([])

    await api.unstage(repo, [...tracked, ...fresh])
    st = await api.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toHaveLength(240)

    // 239 explicit files; `tracked/file 0.txt` is left out and must survive.
    await api.discard(repo, [...tracked.slice(1), ...fresh])
    st = await api.status(repo)
    expect(st.unstaged).toEqual([{ path: 'tracked/file 0.txt', status: 'modified' }])
    expect(existsSync(join(repo, 'fresh/deep/new 5.txt'))).toBe(false)

    // A folder path discards what is inside it.
    write(repo, 'fresh/again.txt', 'x\n')
    await api.discard(repo, ['tracked', 'fresh/'])
    expect((await api.status(repo)).unstaged).toEqual([])
    expect(read(repo, 'tracked/file 0.txt')).toBe('v1\n')
  })

  it('output stays parseable under a hostile user gitconfig', async () => {
    const repo = emptyRepo()
    for (const [key, value] of [
      ['color.ui', 'always'],
      ['color.status', 'always'],
      ['color.diff', 'always'],
      ['diff.noprefix', 'true'],
      ['diff.mnemonicPrefix', 'true'],
      ['diff.external', 'false'],
      ['core.quotepath', 'true'],
      ['log.date', 'iso'],
      ['log.decorate', 'full'],
      ['log.showSignature', 'true'],
      ['format.pretty', 'oneline'],
      ['status.renames', 'false'],
      ['status.showUntrackedFiles', 'no'],
      ['status.short', 'true'],
      ['diff.renames', 'false'],
      ['core.pager', 'less'],
      ['core.editor', 'false'],
      ['merge.ff', 'false']
    ] as const) {
      sh(repo, 'config', key, value)
    }
    commitFiles(repo, { 'ñandú.txt': lines(20), 'old.txt': lines(30, 'row') }, 'base ✓')
    sh(repo, 'mv', 'old.txt', 'moved.txt')
    write(repo, 'ñandú.txt', lines(20).replace('line 2\n', 'line two\n'))
    write(repo, 'untracked ü.txt', 'u\n')

    const st = await api.status(repo)
    expect(st.staged).toEqual([{ path: 'moved.txt', oldPath: 'old.txt', status: 'renamed' }])
    expect(st.unstaged.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'ñandú.txt', status: 'modified' },
      { path: 'untracked ü.txt', status: 'untracked' }
    ])

    const d = await api.diff(repo, { path: 'ñandú.txt' })
    expect(d).toContain('diff --git a/ñandú.txt b/ñandú.txt')
    expect(d).toContain('--- a/ñandú.txt\n+++ b/ñandú.txt')
    // eslint-disable-next-line no-control-regex
    expect(d).not.toMatch(/\x1b\[/)
    expect(await api.diff(repo, { path: 'moved.txt', oldPath: 'old.txt', staged: true })).toContain('rename to moved.txt')
    // The diff is still a patch git can apply.
    await api.applyPatch(repo, d, { cached: true })

    tick()
    await api.stashSave(repo, 'hostile')
    const stashRefs = (await api.refs(repo)).filter((r) => r.type === 'stash')
    expect(stashRefs.map((r) => [r.name, r.message])).toEqual([['stash@{0}', 'On main: hostile']])
    const log = await api.log(repo)
    expect(log.map((c) => [c.subject, c.isStash ?? false])).toEqual([
      ['On main: hostile', true],
      ['base ✓', false]
    ])
    expect(log[0]!.date).toBeGreaterThan(1_700_000_000)

    // merge.ff=false forces a merge commit: it must not wait for an editor.
    sh(repo, 'checkout', '-q', '-b', 'side')
    commitFiles(repo, { 'side.txt': 's\n' }, 'side')
    sh(repo, 'checkout', '-q', 'main')
    tick()
    await api.merge(repo, 'side')
    const [head] = await api.log(repo, { limit: 1 })
    expect(head!.parents).toHaveLength(2)
    const details = await api.commitDetails(repo, head!.hash)
    expect(details.files).toEqual([{ path: 'side.txt', status: 'added' }])
  })
})

describe('commit', () => {
  it('commits staged changes, supports amend and rejects empty messages', async () => {
    const { repo, first } = seededRepo()
    write(repo, 'a.txt', 'two\n')
    await api.stage(repo, ['a.txt'])
    await expect(api.commit(repo, '   ')).rejects.toThrow(/empty/i)
    tick()
    await api.commit(repo, 'second\n\nwith a body')
    let log = await api.log(repo)
    expect(log.map((c) => c.subject)).toEqual(['second', 'first'])
    expect(log[0]!.body).toBe('with a body')

    write(repo, 'b.txt', 'b\n')
    await api.stage(repo, ['b.txt'])
    await api.commit(repo, 'second (amended)', { amend: true })
    log = await api.log(repo)
    expect(log.map((c) => c.subject)).toEqual(['second (amended)', 'first'])
    expect(log[0]!.parents).toEqual([first])

    // Amend with an empty message keeps the message.
    write(repo, 'c.txt', 'c\n')
    await api.stage(repo, ['c.txt'])
    await api.commit(repo, '', { amend: true })
    log = await api.log(repo)
    expect(log[0]!.subject).toBe('second (amended)')
    const details = await api.commitDetails(repo, log[0]!.hash)
    expect(paths(details.files)).toEqual(['a.txt', 'b.txt', 'c.txt'])

    // Nothing staged: git's own message comes through cleanly.
    await expect(api.commit(repo, 'nothing')).rejects.toThrow(/nothing to commit|no changes added/i)
  })
})

describe('diff', () => {
  it('fullContext returns the whole file as one hunk (worktree, staged and commit)', async () => {
    const repo = emptyRepo()
    const body = (changed: string) => Array.from({ length: 60 }, (_, i) => (i === 29 ? changed : `line ${i + 1}`)).join('\n') + '\n'
    commitFiles(repo, { 'a.txt': body('line 30') }, 'base')
    write(repo, 'a.txt', body('LINE 30'))

    const short = await api.diff(repo, { path: 'a.txt' })
    expect(short).toContain('@@ -27,7 +27,7 @@')
    expect(short).not.toContain(' line 1\n')

    const full = await api.diff(repo, { path: 'a.txt', fullContext: true })
    expect(full).toContain('@@ -1,60 +1,60 @@')
    expect(full).toContain(' line 1\n')
    expect(full).toContain('-line 30\n+LINE 30\n')
    expect(full).toContain(' line 60\n')

    await api.stage(repo, ['a.txt'])
    expect(await api.diff(repo, { path: 'a.txt', staged: true, fullContext: true })).toContain('@@ -1,60 +1,60 @@')
    await api.commit(repo, 'change')
    const head = (await api.log(repo))[0]!.hash
    expect(await api.diff(repo, { path: 'a.txt', commit: head, fullContext: true })).toContain('@@ -1,60 +1,60 @@')
  })

  it('unstaged, staged and untracked diffs', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'a.txt': 'one\ntwo\nthree\n' }, 'base')
    write(repo, 'a.txt', 'one\nTWO\nthree\n')

    const unstaged = await api.diff(repo, { path: 'a.txt' })
    expect(unstaged).toContain('diff --git a/a.txt b/a.txt')
    expect(unstaged).toContain('-two\n+TWO')
    expect(await api.diff(repo, { path: 'a.txt', staged: true })).toBe('')

    await api.stage(repo, ['a.txt'])
    expect(await api.diff(repo, { path: 'a.txt', staged: false })).toBe('')
    expect(await api.diff(repo, { path: 'a.txt', staged: true })).toContain('-two\n+TWO')

    write(repo, 'dir/new file.txt', 'brand\nnew\n')
    const untracked = await api.diff(repo, { path: 'dir/new file.txt', untracked: true })
    expect(untracked).toContain('new file mode')
    expect(untracked).toContain('--- /dev/null')
    expect(untracked).toContain('+++ b/dir/new file.txt')
    expect(untracked).toContain('+brand\n+new')
    // Same result when the caller forgets the `untracked` flag.
    expect(await api.diff(repo, { path: 'dir/new file.txt' })).toBe(untracked)
    // And the untracked diff is a valid patch for staging the whole file.
    await api.applyPatch(repo, untracked, { cached: true })
    expect((await api.status(repo)).staged).toContainEqual({ path: 'dir/new file.txt', status: 'added' })

    expect(await api.diff(repo, { path: 'a.txt', untracked: false, staged: false })).toBe('')
    await expect(api.diff(repo, { path: '../outside.txt', untracked: true })).rejects.toThrow(/outside/i)
  })

  it('commit diffs: normal, root and merge (vs first parent)', async () => {
    const repo = emptyRepo()
    const root = commitFiles(repo, { 'a.txt': 'one\n', 'keep.txt': 'k\n' }, 'root')
    const second = commitFiles(repo, { 'a.txt': 'one\ntwo\n' }, 'second')

    const normal = await api.diff(repo, { path: 'a.txt', commit: second })
    expect(normal).toContain('diff --git a/a.txt b/a.txt')
    expect(normal).toContain(' one\n+two')
    expect(await api.diff(repo, { path: 'keep.txt', commit: second })).toBe('')

    const rootDiff = await api.diff(repo, { path: 'a.txt', commit: root })
    expect(rootDiff).toContain('new file mode')
    expect(rootDiff).toContain('+one')
    expect(rootDiff).not.toContain('keep.txt')

    sh(repo, 'checkout', '-q', '-b', 'topic', root)
    commitFiles(repo, { 'topic.txt': 'from topic\n' }, 'topic')
    sh(repo, 'checkout', '-q', 'main')
    tick()
    await api.merge(repo, 'topic')
    const mergeHash = sh(repo, 'rev-parse', 'HEAD')
    expect(sh(repo, 'rev-list', '--parents', '-n', '1', 'HEAD').split(' ')).toHaveLength(3)

    // Against the first parent (main) the merge brought in topic.txt and did not touch a.txt.
    expect(await api.diff(repo, { path: 'topic.txt', commit: mergeHash })).toContain('+from topic')
    expect(await api.diff(repo, { path: 'a.txt', commit: mergeHash })).toBe('')

    const details = await api.commitDetails(repo, mergeHash)
    expect(details.commit.parents).toHaveLength(2)
    expect(details.files).toEqual([{ path: 'topic.txt', status: 'added' }])
    expect((await api.commitDetails(repo, root)).files).toEqual([
      { path: 'a.txt', status: 'added' },
      { path: 'keep.txt', status: 'added' }
    ])
  })

  it('rename detection in status, commitDetails and diff', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'old.txt': lines(30), 'other.txt': 'o\n' }, 'base')
    sh(repo, 'mv', 'old.txt', 'new.txt')
    write(repo, 'new.txt', lines(30).replace('line 15', 'line fifteen'))
    await api.stage(repo, ['new.txt'])

    expect((await api.status(repo)).staged).toEqual([{ path: 'new.txt', oldPath: 'old.txt', status: 'renamed' }])
    const staged = await api.diff(repo, { path: 'new.txt', oldPath: 'old.txt', staged: true })
    expect(staged).toContain('rename from old.txt')
    expect(staged).toContain('rename to new.txt')
    expect(staged).toContain('-line 15\n+line fifteen')
    expect(staged).not.toContain('new file mode')

    tick()
    await api.commit(repo, 'rename it')
    const hash = sh(repo, 'rev-parse', 'HEAD')
    const details = await api.commitDetails(repo, hash)
    expect(details.commit.subject).toBe('rename it')
    expect(details.files).toEqual([{ path: 'new.txt', oldPath: 'old.txt', status: 'renamed' }])

    const inCommit = await api.diff(repo, { path: 'new.txt', oldPath: 'old.txt', commit: hash })
    expect(inCommit).toContain('rename from old.txt')
    expect(inCommit).toContain('similarity index')
    // Without oldPath only the new side is visible: it reads as a new file.
    expect(await api.diff(repo, { path: 'new.txt', commit: hash })).toContain('new file mode')
  })

  it('commitDetails lists added / modified / deleted files', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'a.txt': 'a\n', 'b.txt': 'b\n' }, 'base')
    write(repo, 'a.txt', 'a2\n')
    rmSync(join(repo, 'b.txt'))
    const hash = commitFiles(repo, { 'sub/c.txt': 'c\n' }, 'mixed\n\nbody text')
    const details = await api.commitDetails(repo, hash)
    expect(details.commit).toMatchObject({ hash, subject: 'mixed', body: 'body text', author: 'Test User' })
    expect(details.files).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'b.txt', status: 'deleted' },
      { path: 'sub/c.txt', status: 'added' }
    ])
    await expect(api.commitDetails(repo, 'deadbeef')).rejects.toThrow()
  })
})

describe('applyPatch (hunks)', () => {
  /** Header + the n-th hunk of a single-file diff */
  function hunk(diff: string, n: number): string {
    const start = diff.indexOf('\n@@ ') + 1
    const header = diff.slice(0, start)
    const hunks = diff
      .slice(start)
      .split(/^(?=@@ )/m)
      .filter(Boolean)
    return header + hunks[n]!
  }

  it('stages, unstages and discards a single hunk', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'f.txt': lines(40) }, 'base')
    write(repo, 'f.txt', lines(40).replace('line 3\n', 'line three\n').replace('line 35\n', 'line thirty-five\n'))

    const full = await api.diff(repo, { path: 'f.txt' })
    expect(full.match(/^@@ /gm)).toHaveLength(2)

    // Stage only the first hunk.
    await api.applyPatch(repo, hunk(full, 0), { cached: true })
    let staged = await api.diff(repo, { path: 'f.txt', staged: true })
    expect(staged).toContain('+line three')
    expect(staged).not.toContain('thirty-five')
    let unstaged = await api.diff(repo, { path: 'f.txt' })
    expect(unstaged).toContain('+line thirty-five')
    expect(unstaged).not.toContain('line three')
    let st = await api.status(repo)
    expect(st.staged).toEqual([{ path: 'f.txt', status: 'modified' }])
    expect(st.unstaged).toEqual([{ path: 'f.txt', status: 'modified' }])

    // Unstage that hunk again.
    await api.applyPatch(repo, staged, { cached: true, reverse: true })
    expect(await api.diff(repo, { path: 'f.txt', staged: true })).toBe('')
    expect((await api.diff(repo, { path: 'f.txt' })).match(/^@@ /gm)).toHaveLength(2)

    // Discard the second hunk from the working tree.
    unstaged = await api.diff(repo, { path: 'f.txt' })
    await api.applyPatch(repo, hunk(unstaged, 1), { reverse: true })
    const content = read(repo, 'f.txt')
    expect(content).toContain('line three\n')
    expect(content).toContain('line 35\n')
    expect(content).not.toContain('thirty-five')
    st = await api.status(repo)
    expect(st.staged).toEqual([])

    // A patch that does not apply fails with git's explanation.
    await expect(api.applyPatch(repo, hunk(full, 1), { reverse: true })).rejects.toThrow(/patch (failed|does not apply)/i)
    await expect(api.applyPatch(repo, '', {})).rejects.toThrow(/empty/i)
  })
})

describe('branches', () => {
  it('create, checkout, rename and delete', async () => {
    const { repo, first } = seededRepo()
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')

    await api.createBranch(repo, 'from-first', first)
    expect((await api.status(repo)).branch).toBe('main')
    await api.createBranch(repo, 'work', undefined, true)
    expect((await api.status(repo)).branch).toBe('work')
    expect(sh(repo, 'rev-parse', 'work')).toBe(second)

    await api.checkout(repo, 'from-first')
    let st = await api.status(repo)
    expect(st.branch).toBe('from-first')
    expect(st.head).toBe(first)

    await api.renameBranch(repo, 'work', 'renamed')
    expect((await api.refs(repo)).filter((r) => r.type === 'head').map((r) => r.name)).toEqual(['from-first', 'main', 'renamed'])

    // `renamed` is fully merged into main? No: same commit as main, so -d works from main.
    await api.checkout(repo, 'main')
    await api.deleteBranch(repo, 'renamed')
    sh(repo, 'checkout', '-q', '-b', 'unmerged')
    commitFiles(repo, { 'u.txt': 'u\n' }, 'unmerged work')
    await api.checkout(repo, 'main')
    await expect(api.deleteBranch(repo, 'unmerged')).rejects.toThrow(/not fully merged/)
    await api.deleteBranch(repo, 'unmerged', true)
    expect((await api.refs(repo)).filter((r) => r.type === 'head').map((r) => r.name)).toEqual(['from-first', 'main'])

    // Checking out a raw hash detaches.
    await api.checkout(repo, first)
    st = await api.status(repo)
    expect(st.branch).toBeNull()
    expect(st.head).toBe(first)
  })

  it('reset soft / mixed / hard', async () => {
    const { repo, first } = seededRepo()
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')

    await api.reset(repo, first, 'soft')
    let st = await api.status(repo)
    expect(st.head).toBe(first)
    expect(st.staged).toEqual([{ path: 'a.txt', status: 'modified' }])

    await api.reset(repo, second, 'hard')
    await api.reset(repo, first, 'mixed')
    st = await api.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([{ path: 'a.txt', status: 'modified' }])

    await api.reset(repo, first, 'hard')
    st = await api.status(repo)
    expect(st.unstaged).toEqual([])
    expect(read(repo, 'a.txt')).toBe('one\n')
    await expect(api.reset(repo, first, 'bogus' as never)).rejects.toThrow(/Invalid reset mode/)
  })

  it('rejects refs that look like options, with clean error messages', async () => {
    const { repo } = seededRepo()
    await expect(api.checkout(repo, '--orphan')).rejects.toThrow(/must not start with "-"/)
    await expect(api.createBranch(repo, '-b')).rejects.toThrow(/must not start with "-"/)
    await expect(api.merge(repo, '--abort')).rejects.toThrow(/must not start with "-"/)
    await expect(api.deleteBranch(repo, '-D')).rejects.toThrow(/must not start with "-"/)
    await expect(api.createTag(repo, '-d', 'HEAD')).rejects.toThrow(/must not start with "-"/)
    await expect(api.reset(repo, '--hard', 'soft')).rejects.toThrow(/must not start with "-"/)
    await expect(api.addRemote(repo, 'origin', '--upload-pack=evil')).rejects.toThrow(/must not start with "-"/)
    await expect(api.stashPop(repo, -1)).rejects.toThrow(/Invalid stash index/)
    await expect(api.stashDrop(repo, 1.5)).rejects.toThrow(/Invalid stash index/)

    const err = await api.checkout(repo, 'no-such-branch').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/no-such-branch/)
    expect((err as Error).message).not.toMatch(/^(fatal|error): /)
    expect((err as Error).message).not.toMatch(/Command failed/)

    await expect(api.status(join(repo, 'missing-dir'))).rejects.toThrow(/Folder not found/)
    await expect(api.status(tmpDir())).rejects.toThrow(/not a git repository/i)
  })
})

describe('merge / rebase / cherry-pick / revert', () => {
  /** main and `other` both change a.txt differently -> conflict */
  function conflicting(): { repo: string; mainTip: string; otherTip: string } {
    const { repo } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'other')
    const otherTip = commitFiles(repo, { 'a.txt': 'from other\n', 'other-only.txt': 'o\n' }, 'other change')
    sh(repo, 'checkout', '-q', 'main')
    const mainTip = commitFiles(repo, { 'a.txt': 'from main\n' }, 'main change')
    return { repo, mainTip, otherTip }
  }

  it('fast-forward and clean merges just work', async () => {
    const { repo } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'ff')
    const tip = commitFiles(repo, { 'ff.txt': 'ff\n' }, 'ff work')
    sh(repo, 'checkout', '-q', 'main')
    await api.merge(repo, 'ff')
    const st = await api.status(repo)
    expect(st.head).toBe(tip)
    expect(st.inProgress).toBeNull()
  })

  it('merge conflict -> status -> abort', async () => {
    const { repo, mainTip } = conflicting()
    const err = await api.merge(repo, 'other').catch((e: Error) => e)
    expect(err).toBeInstanceOf(Error)
    expect((err as Error).message).toMatch(/CONFLICT \(content\): Merge conflict in a\.txt/)

    let st = await api.status(repo)
    expect(st.inProgress).toBe('merge')
    expect(st.conflicted).toEqual([{ path: 'a.txt', status: 'conflicted' }])
    expect(st.staged).toEqual([{ path: 'other-only.txt', status: 'added' }])
    expect(read(repo, 'a.txt')).toContain('<<<<<<<')
    // The conflicted file still produces a (combined) diff.
    expect(await api.diff(repo, { path: 'a.txt' })).toContain('from other')

    // Unstaging everything must neither end the merge nor lose the conflict state.
    await api.unstageAll(repo)
    st = await api.status(repo)
    expect(st.inProgress).toBe('merge')
    expect(st.staged).toEqual([])
    expect(st.conflicted).toEqual([{ path: 'a.txt', status: 'conflicted' }])
    expect(st.unstaged).toEqual([{ path: 'other-only.txt', status: 'untracked' }])

    await api.abort(repo)
    st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.conflicted).toEqual([])
    expect(st.head).toBe(mainTip)
    expect(read(repo, 'a.txt')).toBe('from main\n')
    await expect(api.abort(repo)).rejects.toThrow(/No merge, rebase/)
    await expect(api.continueOp(repo)).rejects.toThrow(/No merge, rebase/)
  })

  it('merge conflict -> resolve -> continue (no editor)', async () => {
    const { repo, mainTip, otherTip } = conflicting()
    await expect(api.merge(repo, 'other')).rejects.toThrow(/CONFLICT/)
    // Continuing with unresolved files is refused by git.
    await expect(api.continueOp(repo)).rejects.toThrow(/unmerged|conflict/i)

    write(repo, 'a.txt', 'resolved\n')
    await api.stage(repo, ['a.txt'])
    expect((await api.status(repo)).conflicted).toEqual([])
    tick()
    await api.continueOp(repo)

    const st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    const [head] = await api.log(repo, { limit: 1 })
    expect(head!.parents).toEqual([mainTip, otherTip])
    expect(head!.subject).toMatch(/^Merge branch 'other'/)
    expect(read(repo, 'a.txt')).toBe('resolved\n')
  })

  it('discarding a conflicted file takes our side', async () => {
    const { repo } = conflicting()
    await expect(api.merge(repo, 'other')).rejects.toThrow(/CONFLICT/)
    await api.discard(repo, ['a.txt'])
    expect(read(repo, 'a.txt')).toBe('from main\n')
    const st = await api.status(repo)
    expect(st.conflicted).toEqual([])
    expect(st.inProgress).toBe('merge')
    await api.abort(repo)
  })

  it('rebase conflict -> abort, then resolve -> continue', async () => {
    const { repo, mainTip, otherTip } = conflicting()
    await api.checkout(repo, 'other')
    await expect(api.rebase(repo, 'main')).rejects.toThrow(/CONFLICT|could not apply/i)
    let st = await api.status(repo)
    expect(st.inProgress).toBe('rebase')
    expect(st.branch).toBeNull()
    expect(st.conflicted).toEqual([{ path: 'a.txt', status: 'conflicted' }])

    await api.abort(repo)
    st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.branch).toBe('other')
    expect(st.head).toBe(otherTip)

    await expect(api.rebase(repo, 'main')).rejects.toThrow()
    write(repo, 'a.txt', 'rebased resolution\n')
    await api.stage(repo, ['a.txt'])
    tick()
    await api.continueOp(repo)
    st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.branch).toBe('other')
    const log = await api.log(repo)
    expect(log[0]).toMatchObject({ subject: 'other change', parents: [mainTip] })
    expect(read(repo, 'a.txt')).toBe('rebased resolution\n')
  })

  it('clean rebase replays commits', async () => {
    const { repo } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'topic')
    commitFiles(repo, { 't.txt': 't\n' }, 'topic work')
    sh(repo, 'checkout', '-q', 'main')
    const mainTip = commitFiles(repo, { 'm.txt': 'm\n' }, 'main work')
    await api.checkout(repo, 'topic')
    tick()
    await api.rebase(repo, 'main')
    const log = await api.log(repo)
    expect(log[0]).toMatchObject({ subject: 'topic work', parents: [mainTip] })
  })

  it('cherry-pick: clean, conflict -> abort, conflict -> continue', async () => {
    const { repo, mainTip, otherTip } = conflicting()
    sh(repo, 'checkout', '-q', '-b', 'extra', 'other')
    const clean = commitFiles(repo, { 'extra.txt': 'e\n' }, 'extra file')
    sh(repo, 'checkout', '-q', 'main')

    tick()
    await api.cherryPick(repo, clean)
    let log = await api.log(repo, { limit: 1 })
    expect(log[0]).toMatchObject({ subject: 'extra file', parents: [mainTip] })
    const afterClean = log[0]!.hash

    await expect(api.cherryPick(repo, otherTip)).rejects.toThrow(/CONFLICT|could not apply/i)
    let st = await api.status(repo)
    expect(st.inProgress).toBe('cherry-pick')
    expect(st.conflicted).toEqual([{ path: 'a.txt', status: 'conflicted' }])
    await api.abort(repo)
    st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.head).toBe(afterClean)

    await expect(api.cherryPick(repo, otherTip)).rejects.toThrow()
    write(repo, 'a.txt', 'picked resolution\n')
    await api.stage(repo, ['a.txt'])
    tick()
    await api.continueOp(repo)
    st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    log = await api.log(repo, { limit: 1 })
    expect(log[0]).toMatchObject({ subject: 'other change', parents: [afterClean] })
  })

  it('revert: clean, conflict -> abort, and reverting a merge commit', async () => {
    const { repo } = seededRepo()
    const second = commitFiles(repo, { 'a.txt': 'one\ntwo\n' }, 'second')
    const third = commitFiles(repo, { 'a.txt': 'one\ntwo changed\n' }, 'third')

    // Reverting `second` conflicts with `third`.
    await expect(api.revert(repo, second)).rejects.toThrow(/CONFLICT|could not revert/i)
    let st = await api.status(repo)
    expect(st.inProgress).toBe('revert')
    await api.abort(repo)
    st = await api.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.head).toBe(third)

    tick()
    await api.revert(repo, third)
    expect(read(repo, 'a.txt')).toBe('one\ntwo\n')
    expect((await api.log(repo, { limit: 1 }))[0]!.subject).toBe('Revert "third"')

    // Merge commits need a mainline; we pick the first parent.
    sh(repo, 'checkout', '-q', '-b', 'side', second)
    commitFiles(repo, { 'side.txt': 's\n' }, 'side')
    sh(repo, 'checkout', '-q', 'main')
    tick()
    sh(repo, 'merge', '-q', '--no-ff', '--no-edit', 'side')
    const mergeHash = sh(repo, 'rev-parse', 'HEAD')
    tick()
    await api.revert(repo, mergeHash)
    expect(existsSync(join(repo, 'side.txt'))).toBe(false)
    expect((await api.status(repo)).inProgress).toBeNull()
  })
})

describe('stashes', () => {
  it('save -> appears as one node in log and refs -> pop', async () => {
    const { repo, first } = seededRepo()
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')
    write(repo, 'a.txt', 'work in progress\n')
    write(repo, 'staged.txt', 'staged\n')
    await api.stage(repo, ['staged.txt'])
    write(repo, 'untracked.txt', 'untracked\n')

    tick()
    await api.stashSave(repo, 'my stash')
    let st = await api.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([])
    expect(existsSync(join(repo, 'untracked.txt'))).toBe(false)

    // The raw stash commit has three parents (base, index, untracked)...
    const stashHash = sh(repo, 'rev-parse', 'stash@{0}')
    const rawParents = sh(repo, 'rev-list', '--parents', '-n', '1', stashHash).split(' ').slice(1)
    expect(rawParents).toHaveLength(3)

    // ...but the log shows a single node hanging off the base commit.
    const log = await api.log(repo)
    expect(log.map((c) => c.hash)).toEqual([stashHash, second, first])
    expect(log[0]).toMatchObject({ isStash: true, parents: [second], subject: 'On main: my stash' })
    expect(log.slice(1).every((c) => !c.isStash)).toBe(true)
    for (const helper of rawParents.slice(1)) expect(log.map((c) => c.hash)).not.toContain(helper)

    const stashRefs = (await api.refs(repo)).filter((r) => r.type === 'stash')
    expect(stashRefs).toEqual([{ name: 'stash@{0}', type: 'stash', hash: stashHash, isCurrent: false, message: 'On main: my stash' }])

    // Details show tracked changes and the previously-untracked file.
    const details = await api.commitDetails(repo, stashHash)
    expect(details.commit).toMatchObject({ isStash: true, parents: [second] })
    expect(details.files.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'a.txt', status: 'modified' },
      { path: 'staged.txt', status: 'added' },
      { path: 'untracked.txt', status: 'added' }
    ])
    expect(await api.diff(repo, { path: 'a.txt', commit: stashHash })).toContain('+work in progress')
    expect(await api.diff(repo, { path: 'untracked.txt', commit: stashHash })).toContain('+untracked')

    await api.stashPop(repo, 0)
    expect(read(repo, 'a.txt')).toBe('work in progress\n')
    expect(read(repo, 'untracked.txt')).toBe('untracked\n')
    expect((await api.refs(repo)).filter((r) => r.type === 'stash')).toEqual([])
    expect((await api.log(repo)).map((c) => c.hash)).toEqual([second, first])
  })

  it('several stashes: ordering, pagination, apply and drop', async () => {
    const { repo, first } = seededRepo()
    write(repo, 'a.txt', 'stash one\n')
    tick()
    await api.stashSave(repo, 'one')
    const second = commitFiles(repo, { 'b.txt': 'b\n' }, 'second')
    write(repo, 'new.txt', 'only untracked\n')
    tick()
    await api.stashSave(repo)
    const third = commitFiles(repo, { 'c.txt': 'c\n' }, 'third')

    const s0 = sh(repo, 'rev-parse', 'stash@{0}')
    const s1 = sh(repo, 'rev-parse', 'stash@{1}')
    const stashRefs = (await api.refs(repo)).filter((r) => r.type === 'stash')
    expect(stashRefs.map((r) => [r.name, r.hash])).toEqual([
      ['stash@{0}', s0],
      ['stash@{1}', s1]
    ])
    expect(stashRefs[0]!.message).toMatch(/^WIP on main: [0-9a-f]+ second$/)
    expect(stashRefs[1]!.message).toBe('On main: one')

    const all = await api.log(repo)
    expect(all.map((c) => c.hash)).toEqual([third, s0, second, s1, first])
    expect(all.filter((c) => c.isStash).map((c) => c.parents)).toEqual([[second], [first]])

    // Paging must agree with the full list even though helper commits are hidden.
    const paged: string[] = []
    for (let skip = 0; ; skip += 2) {
      const page = await api.log(repo, { limit: 2, skip })
      paged.push(...page.map((c) => c.hash))
      if (page.length < 2) break
    }
    expect(paged).toEqual(all.map((c) => c.hash))
    expect((await api.log(repo, { limit: 3 })).map((c) => c.hash)).toEqual([third, s0, second])

    // apply keeps the stash, drop removes exactly the one asked for.
    await api.stashApply(repo, 1)
    expect(read(repo, 'a.txt')).toBe('stash one\n')
    expect((await api.refs(repo)).filter((r) => r.type === 'stash')).toHaveLength(2)
    await api.discardAll(repo)

    await api.stashDrop(repo, 1)
    const left = (await api.refs(repo)).filter((r) => r.type === 'stash')
    expect(left.map((r) => [r.name, r.hash])).toEqual([['stash@{0}', s0]])
    expect((await api.log(repo)).map((c) => c.hash)).toEqual([third, s0, second, first])

    await api.stashPop(repo, 0)
    expect(read(repo, 'new.txt')).toBe('only untracked\n')
    await expect(api.stashPop(repo, 0)).rejects.toThrow()
  })

  it('stashSave with nothing to stash reports it', async () => {
    const { repo } = seededRepo()
    await expect(api.stashSave(repo)).rejects.toThrow(/No local changes to save/)
  })
})

describe('remotes (local bare repository)', () => {
  function setup(): { bare: string; repo: string; first: string } {
    const bare = join(tmpDir(), 'origin.git')
    mkdirSync(bare)
    sh(bare, 'init', '-q', '--bare')
    const { repo, first } = seededRepo()
    return { bare, repo, first }
  }

  it('add / list / remove remotes', async () => {
    const { bare, repo } = setup()
    expect(await api.remotes(repo)).toEqual([])
    await api.addRemote(repo, 'origin', bare)
    await api.addRemote(repo, 'backup', 'https://example.com/acme/backup.git')
    expect(await api.remotes(repo)).toEqual([
      { name: 'backup', url: 'https://example.com/acme/backup.git' },
      { name: 'origin', url: bare }
    ])
    await api.removeRemote(repo, 'backup')
    expect(await api.remotes(repo)).toEqual([{ name: 'origin', url: bare }])
    await expect(api.addRemote(repo, 'origin', bare)).rejects.toThrow(/already exists/)
  })

  it('push sets upstream, then ahead / behind, fetch, pull, force push', async () => {
    const { bare, repo, first } = setup()
    await expect(api.push(repo)).rejects.toThrow(/no remote/i)
    const mirror = join(tmpDir(), 'mirror.git')
    mkdirSync(mirror)
    sh(mirror, 'init', '-q', '--bare')
    await api.addRemote(repo, 'a-mirror', mirror)
    await api.addRemote(repo, 'origin', bare)
    expect((await api.remotes(repo)).map((r) => r.name)).toEqual(['a-mirror', 'origin'])

    // No upstream yet: pushes with -u to `origin` (preferred over the first remote).
    await api.push(repo)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(first)
    expect(sh(mirror, 'for-each-ref')).toBe('')
    let main = (await api.refs(repo)).find((r) => r.name === 'main')!
    expect(main).toEqual({ name: 'main', type: 'head', hash: first, isCurrent: true, upstream: 'origin/main', ahead: 0, behind: 0 })
    expect((await api.refs(repo)).filter((r) => r.type === 'remote')).toEqual([
      { name: 'origin/main', type: 'remote', hash: first, isCurrent: false }
    ])

    // Local commits -> ahead.
    const second = commitFiles(repo, { 'a.txt': 'two\n' }, 'second')
    main = (await api.refs(repo)).find((r) => r.name === 'main')!
    expect([main.ahead, main.behind]).toEqual([1, 0])
    await api.push(repo)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(second)

    // A second clone pushes -> we are behind after fetch.
    const parent = tmpDir()
    const other = await api.clone(bare, parent)
    expect(other).toBe(join(parent, 'origin'))
    expect((await api.status(other)).head).toBe(second)
    // The clone has origin/HEAD, which must not be listed as a branch.
    expect(sh(other, 'for-each-ref', '--format=%(refname)', 'refs/remotes')).toContain('refs/remotes/origin/HEAD')
    expect((await api.refs(other)).filter((r) => r.type === 'remote').map((r) => r.name)).toEqual(['origin/main'])
    const third = commitFiles(other, { 'from-other.txt': 'x\n' }, 'third (from other clone)')
    await api.push(other)

    await api.fetch(repo)
    main = (await api.refs(repo)).find((r) => r.name === 'main')!
    expect([main.ahead, main.behind]).toEqual([0, 1])
    expect((await api.log(repo))[0]!.hash).toBe(third)

    // Diverge: one local commit as well.
    const local = commitFiles(repo, { 'local.txt': 'l\n' }, 'local work')
    main = (await api.refs(repo)).find((r) => r.name === 'main')!
    expect([main.ahead, main.behind]).toEqual([1, 1])

    // A plain push is rejected (non fast-forward) with a readable message.
    await expect(api.push(repo)).rejects.toThrow(/rejected|non-fast-forward|fetch first/i)

    tick()
    await api.pull(repo, { rebase: true })
    main = (await api.refs(repo)).find((r) => r.name === 'main')!
    expect([main.ahead, main.behind]).toEqual([1, 0])
    const log = await api.log(repo)
    expect(log[0]).toMatchObject({ subject: 'local work', parents: [third] })
    expect(log[0]!.hash).not.toBe(local)
    await api.push(repo)

    // Rewrite history locally, then force push (with lease).
    await api.reset(repo, third, 'hard')
    const rewritten = commitFiles(repo, { 'local.txt': 'rewritten\n' }, 'rewritten work')
    await expect(api.push(repo)).rejects.toThrow()
    await api.push(repo, { force: true })
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(rewritten)
  })

  it('pull merges by default when branches diverged', async () => {
    const { bare, repo } = setup()
    await api.addRemote(repo, 'origin', bare)
    await api.push(repo)
    const other = await api.clone(bare, tmpDir())
    const remoteTip = commitFiles(other, { 'remote.txt': 'r\n' }, 'remote work')
    await api.push(other)
    const localTip = commitFiles(repo, { 'local.txt': 'l\n' }, 'local work')

    tick()
    await api.pull(repo)
    const [head] = await api.log(repo, { limit: 1 })
    expect(head!.parents).toEqual([localTip, remoteTip])
    expect((await api.status(repo)).inProgress).toBeNull()

    // Fast-forward pull on the other side.
    await api.push(repo)
    await api.pull(other, { rebase: false })
    expect((await api.status(other)).head).toBe(head!.hash)
  })

  it('pushes a named branch, checks out remote branches, deletes remote branches', async () => {
    const { bare, repo, first } = setup()
    await api.addRemote(repo, 'origin', bare)
    await api.push(repo)

    // Push a branch that is not checked out.
    await api.createBranch(repo, 'feature/login', first)
    sh(repo, 'checkout', '-q', 'feature/login')
    const featureTip = commitFiles(repo, { 'login.txt': 'l\n' }, 'login work')
    sh(repo, 'checkout', '-q', 'main')
    await api.push(repo, { branch: 'feature/login' })
    expect(sh(bare, 'rev-parse', 'refs/heads/feature/login')).toBe(featureTip)
    expect((await api.refs(repo)).find((r) => r.name === 'feature/login')).toMatchObject({ upstream: 'origin/feature/login', ahead: 0, behind: 0 })
    expect((await api.status(repo)).branch).toBe('main')

    // In another clone: checking out origin/feature/login creates a tracking branch.
    const other = await api.clone(bare, tmpDir())
    expect((await api.refs(other)).filter((r) => r.type === 'head').map((r) => r.name)).toEqual(['main'])
    await api.checkout(other, 'origin/feature/login')
    let st = await api.status(other)
    expect(st.branch).toBe('feature/login')
    expect(st.head).toBe(featureTip)
    expect((await api.refs(other)).find((r) => r.name === 'feature/login')).toMatchObject({
      isCurrent: true,
      upstream: 'origin/feature/login',
      ahead: 0,
      behind: 0
    })

    // Local branch already exists: checking out the remote ref just switches to it.
    const localOnly = commitFiles(other, { 'more.txt': 'm\n' }, 'more login work')
    await api.checkout(other, 'main')
    await api.checkout(other, 'origin/feature/login')
    st = await api.status(other)
    expect(st.branch).toBe('feature/login')
    expect(st.head).toBe(localOnly)
    expect((await api.refs(other)).find((r) => r.name === 'feature/login')).toMatchObject({ ahead: 1, behind: 0 })

    // A branch created from a remote ref does not inherit it as push target.
    await api.createBranch(other, 'experiment', 'origin/main', true)
    expect((await api.refs(other)).find((r) => r.name === 'experiment')!.upstream).toBeUndefined()
    commitFiles(other, { 'exp.txt': 'e\n' }, 'experiment')
    await api.push(other)
    expect(sh(bare, 'rev-parse', 'refs/heads/main')).toBe(first)
    expect(sh(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')).toEqual(['experiment', 'feature/login', 'main'])

    // Delete the remote branch; the tracking ref goes away, and upstream is reported as gone.
    await api.deleteRemoteBranch(repo, 'origin', 'feature/login')
    expect(sh(bare, 'for-each-ref', '--format=%(refname:short)', 'refs/heads').split('\n')).toEqual(['experiment', 'main'])
    expect((await api.refs(repo)).filter((r) => r.type === 'remote').map((r) => r.name)).toEqual(['origin/main'])
    const gone = (await api.refs(repo)).find((r) => r.name === 'feature/login')!
    expect(gone.upstream).toBe('origin/feature/login')
    expect(gone.ahead).toBeUndefined()

    // fetch --prune removes stale tracking refs in the other clone and picks up new ones.
    await api.fetch(repo)
    expect((await api.refs(repo)).filter((r) => r.type === 'remote').map((r) => r.name)).toEqual(['origin/experiment', 'origin/main'])
    await api.fetch(other)
    expect((await api.refs(other)).filter((r) => r.type === 'remote').map((r) => r.name)).toEqual(['origin/experiment', 'origin/main'])
  })

  it('network failures reject instead of hanging', async () => {
    const { repo } = setup()
    await api.addRemote(repo, 'origin', join(tmpDir(), 'does-not-exist.git'))
    await expect(api.fetch(repo)).rejects.toThrow(/does not appear to be a git repository|Could not read from remote/i)
    await expect(api.push(repo)).rejects.toThrow()
    await expect(api.pull(repo)).rejects.toThrow()
    await expect(api.clone(join(tmpDir(), 'nope.git'), tmpDir())).rejects.toThrow(/does not exist/i)
    await expect(api.clone('--upload-pack=touch /tmp/pwned', tmpDir())).rejects.toThrow(/Invalid repository URL/)
  })

  it('push refuses on detached HEAD', async () => {
    const { bare, repo, first } = setup()
    await api.addRemote(repo, 'origin', bare)
    await api.checkout(repo, first)
    await expect(api.push(repo)).rejects.toThrow(/detached/i)
  })
})
