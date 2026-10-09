// Regression tests for the data-loss / wrong-target findings of the safety review.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreApi as api } from '../core'
import { cleanupAll, commitFiles, emptyRepo, seededRepo, setupGitEnv, sh, tmpDir, write } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8')
const branch = (repo: string): string => sh(repo, 'branch', '--show-current').trim()
const subject = (repo: string, rev = 'HEAD'): string => sh(repo, 'log', '-1', '--format=%s', rev).trim()

/** main with a conflicting branch `f`; leaves a merge of `f` in conflict on a.txt */
function conflictedMerge(): string {
  const repo = emptyRepo()
  commitFiles(repo, { 'a.txt': 'base\n' }, 'base')
  sh(repo, 'checkout', '-q', '-b', 'f')
  commitFiles(repo, { 'a.txt': 'theirs\n' }, 'f')
  sh(repo, 'checkout', '-q', 'main')
  commitFiles(repo, { 'a.txt': 'ours\n' }, 'm')
  return repo
}

describe('a folder that stopped being a repository', () => {
  it('writes are refused instead of acting on the parent repository', async () => {
    const parent = emptyRepo()
    commitFiles(parent, { 'parent-file.txt': 'committed\n', 'projects/myapp/app.txt': 'app\n' }, 'base')
    write(parent, 'parent-file.txt', 'uncommitted parent work\n')
    write(parent, 'projects/myapp/new.txt', 'new\n')
    const stale = join(parent, 'projects/myapp') // was once its own repo, has no .git any more

    await expect(api.discardAll(stale)).rejects.toThrow(/not the root of a Git repository/)
    await expect(api.stageAll(stale)).rejects.toThrow(/not the root/)
    await expect(api.stashSave(stale)).rejects.toThrow(/not the root/)
    expect(read(parent, 'parent-file.txt')).toBe('uncommitted parent work\n')
    expect(existsSync(join(stale, 'new.txt'))).toBe(true)
  })
})

describe('discard', () => {
  it('discarding a file never deletes untracked files of a folder that replaced it', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { config: 'old config\n', 'keep.txt': 'k\n' }, 'base')
    rmSync(join(repo, 'config'))
    mkdirSync(join(repo, 'config'))
    write(repo, 'config/prod.yml', 'prod\n')
    write(repo, 'config/dev.yml', 'dev\n')

    await expect(api.discard(repo, ['config'])).rejects.toThrow(/folder with the same name is in the way/)
    expect(read(repo, 'config/prod.yml')).toBe('prod\n')
    expect(read(repo, 'config/dev.yml')).toBe('dev\n')

    // Once the folder is out of the way the file is restored
    rmSync(join(repo, 'config'), { recursive: true })
    await api.discard(repo, ['config'])
    expect(read(repo, 'config')).toBe('old config\n')
  })

  it('a folder path still discards everything inside it', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'src/a.txt': 'a\n', 'other.txt': 'o\n' }, 'base')
    write(repo, 'src/a.txt', 'changed\n')
    write(repo, 'src/new.txt', 'new\n')
    write(repo, 'other.txt', 'changed\n')
    await api.discard(repo, ['src'])
    expect(read(repo, 'src/a.txt')).toBe('a\n')
    expect(existsSync(join(repo, 'src/new.txt'))).toBe(false)
    expect(read(repo, 'other.txt')).toBe('changed\n')
  })

  it('discardAll is refused while a merge is in progress', async () => {
    const repo = conflictedMerge()
    await expect(api.merge(repo, 'f')).rejects.toThrow()
    await expect(api.discardAll(repo)).rejects.toThrow(/while a merge is in progress/)
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(true)
    expect((await api.status(repo)).inProgress).toBe('merge')
  })
})

describe('operations that would silently drop a merge in progress', () => {
  it('stash, checkout, new branch and reset are refused; abort still works', async () => {
    const repo = conflictedMerge()
    await expect(api.merge(repo, 'f')).rejects.toThrow()
    write(repo, 'a.txt', 'resolved\n')
    await api.stage(repo, ['a.txt'])

    await expect(api.stashSave(repo)).rejects.toThrow(/while a merge is in progress/)
    await expect(api.checkout(repo, 'f')).rejects.toThrow(/while a merge is in progress/)
    await expect(api.createBranch(repo, 'x', undefined, true)).rejects.toThrow(/while a merge is in progress/)
    await expect(api.reset(repo, 'HEAD', 'hard')).rejects.toThrow(/while a merge is in progress/)
    expect(existsSync(join(repo, '.git/MERGE_HEAD'))).toBe(true)

    await api.continueOp(repo)
    expect(sh(repo, 'log', '-1', '--format=%P').trim().split(' ')).toHaveLength(2)
    expect(sh(repo, 'log', '-1', '--format=%B')).not.toMatch(/^#/m)
  })
})

describe('hunk patches of files that are not UTF-8', () => {
  it('are refused instead of writing replacement characters', async () => {
    const repo = emptyRepo()
    writeFileSync(join(repo, 'latin1.txt'), Buffer.from('uno\ndos\n', 'latin1'))
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'base')
    writeFileSync(join(repo, 'latin1.txt'), Buffer.concat([Buffer.from('uno\ncaf', 'latin1'), Buffer.from([0xe9]), Buffer.from(' nuevo\ndos\n', 'latin1')]))

    const patch = await api.diff(repo, { path: 'latin1.txt' })
    expect(patch).toContain('�')
    await expect(api.applyPatch(repo, patch, { cached: true })).rejects.toThrow(/not valid UTF-8/)
    expect(sh(repo, 'diff', '--cached', '--name-only').trim()).toBe('')
    // Whole-file staging keeps the original bytes
    await api.stage(repo, ['latin1.txt'])
    expect(readFileSync(join(repo, 'latin1.txt')).includes(Buffer.from([0x63, 0x61, 0x66, 0xe9]))).toBe(true)
  })
})

describe('names that are both a branch and a tag', () => {
  function ambiguous(): string {
    const { repo } = seededRepo()
    commitFiles(repo, { 'one.txt': '1\n' }, 'first')
    sh(repo, 'tag', 'v1')
    commitFiles(repo, { 'two.txt': '2\n' }, 'second')
    sh(repo, 'branch', 'other')
    commitFiles(repo, { 'three.txt': '3\n' }, 'third')
    sh(repo, 'branch', 'v1') // branch v1 at "third", tag v1 at "first"
    sh(repo, 'checkout', '-q', 'other')
    return repo
  }

  it('short names are rejected as ambiguous, full names hit the right ref', async () => {
    const repo = ambiguous()
    await expect(api.checkout(repo, 'v1')).rejects.toThrow(/ambiguous/)
    await expect(api.merge(repo, 'v1')).rejects.toThrow(/ambiguous/)
    await expect(api.rebase(repo, 'v1')).rejects.toThrow(/ambiguous/)
    await expect(api.createBranch(repo, 'from-v1', 'v1')).rejects.toThrow(/ambiguous/)
    expect(branch(repo)).toBe('other')
    expect(subject(repo)).toBe('second')

    await api.checkout(repo, 'refs/tags/v1')
    expect(branch(repo)).toBe('')
    expect(subject(repo)).toBe('first')

    await api.checkout(repo, 'refs/heads/v1')
    expect(branch(repo)).toBe('v1')
    expect(subject(repo)).toBe('third')

    await api.createBranch(repo, 'from-tag', 'refs/tags/v1')
    expect(subject(repo, 'refs/heads/from-tag')).toBe('first')
  })

  it('creating a tag named like a branch (or the reverse) is refused', async () => {
    const { repo } = seededRepo()
    sh(repo, 'tag', 'release')
    await expect(api.createTag(repo, 'main', 'HEAD')).rejects.toThrow(/already exists/)
    await expect(api.createBranch(repo, 'release')).rejects.toThrow(/already exists/)
    await expect(api.createBranch(repo, 'refs/heads/main')).rejects.toThrow(/Invalid branch name/)
    await expect(api.renameBranch(repo, 'main', 'release')).rejects.toThrow(/already exists/)
  })
})

describe('checkout', () => {
  function withRemoteFoo(): { repo: string; remote: string } {
    const { repo } = seededRepo()
    const remote = join(tmpDir(), 'remote.git')
    sh(repo, 'init', '-q', '--bare', remote)
    sh(repo, 'remote', 'add', 'origin', remote)
    sh(repo, 'checkout', '-q', '-b', 'foo')
    commitFiles(repo, { 'foo.txt': '1\n' }, 'foo1')
    sh(repo, 'push', '-q', '-u', 'origin', 'main', 'foo')
    return { repo, remote }
  }

  it('of origin/foo fast-forwards an older local foo', async () => {
    const { repo } = withRemoteFoo()
    commitFiles(repo, { 'foo.txt': '2\n' }, 'foo2')
    sh(repo, 'push', '-q')
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1') // local foo is now behind origin/foo
    sh(repo, 'checkout', '-q', 'main')
    await api.checkout(repo, 'origin/foo')
    expect(branch(repo)).toBe('foo')
    expect(subject(repo)).toBe('foo2')
  })

  it('of origin/foo is refused when the local foo has diverged', async () => {
    const { repo } = withRemoteFoo()
    commitFiles(repo, { 'foo.txt': '2\n' }, 'foo2')
    sh(repo, 'push', '-q')
    sh(repo, 'reset', '-q', '--hard', 'HEAD~1')
    commitFiles(repo, { 'local.txt': 'x\n' }, 'local only') // diverged from origin/foo
    sh(repo, 'checkout', '-q', 'main')
    await expect(api.checkout(repo, 'origin/foo')).rejects.toThrow(/already exists and has diverged from origin\/foo/)
    expect(branch(repo)).toBe('main')
  })

  it('away from a detached HEAD is refused while its commits are on no branch', async () => {
    const { repo, first } = seededRepo()
    await api.checkout(repo, first)
    commitFiles(repo, { 'detached.txt': 'x\n' }, 'important detached work')
    await expect(api.checkout(repo, 'main')).rejects.toThrow(/not on any branch/)
    expect(subject(repo)).toBe('important detached work')
    await api.createBranch(repo, 'rescued')
    await api.checkout(repo, 'main')
    expect(subject(repo, 'rescued')).toBe('important detached work')
  })
})

describe('stashes addressed by a stale index', () => {
  it('drop / pop / apply are refused when stash@{N} is no longer the stash shown', async () => {
    const { repo } = seededRepo()
    write(repo, 'junk.txt', 'junk\n')
    await api.stashSave(repo, 'junk to delete')
    const shown = (await api.refs(repo)).find((r) => r.type === 'stash')!
    // Meanwhile another stash is created outside the app and takes index 0
    write(repo, 'precious.txt', 'precious\n')
    sh(repo, 'stash', 'push', '-q', '--include-untracked', '-m', 'precious')

    await expect(api.stashDrop(repo, 0, shown.hash)).rejects.toThrow(/stash list changed/)
    await expect(api.stashPop(repo, 0, shown.hash)).rejects.toThrow(/stash list changed/)
    await expect(api.stashApply(repo, 0, shown.hash)).rejects.toThrow(/stash list changed/)
    expect(sh(repo, 'stash', 'list')).toMatch(/precious/)
    expect(sh(repo, 'stash', 'list').trim().split('\n')).toHaveLength(2)

    await api.stashDrop(repo, 1, shown.hash)
    expect(sh(repo, 'stash', 'list').trim().split('\n')).toHaveLength(1)
    expect(sh(repo, 'stash', 'list')).toMatch(/precious/)
  })
})
