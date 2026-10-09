// Submodules, worktrees and LFS against real temporary repositories.
//
// Submodule remotes are local paths: git >= 2.38.1 only clones those when
// `protocol.file.allow=always`, which the throw-away global config written by
// `setupGitEnv()` sets — for the tests only. The application never sets it.
//
// Git LFS: the "not installed" tests call the real `git lfs` and are skipped on
// a machine that has git-lfs. The "fake git-lfs" tests put a shell script named
// `git-lfs` first in PATH; they check what this module asks git-lfs to do and
// how it reads the results, not git-lfs itself.
import { spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { basename, join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreApi } from '../core'
import { extrasApi as api, parseLfsPatterns, parseSubmoduleStatus, parseWorktreeList } from '../extras'
import { cleanupAll, commitFiles, seededRepo, setupGitEnv, sh, tmpDir, write } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

const realLfs = spawnSync('git', ['lfs', 'version'], { stdio: 'ignore' }).status === 0
const globalConfig = (): string => readFileSync(process.env['GIT_CONFIG_GLOBAL']!, 'utf8')
const byPath = <T extends { path: string }>(list: T[], path: string): T => {
  const found = list.find((x) => x.path === path)
  if (!found) throw new Error(`no entry for ${path} in ${JSON.stringify(list.map((x) => x.path))}`)
  return found
}

// --- submodules ------------------------------------------------------------------

/** `lib`: main = A, plus two divergent branches b1 = B and b2 = C. */
function libRepo(): { lib: string; a: string; b: string; c: string } {
  const { repo: lib, first: a } = seededRepo()
  sh(lib, 'checkout', '-q', '-b', 'b1')
  const b = commitFiles(lib, { 'b.txt': 'b\n' }, 'B')
  sh(lib, 'checkout', '-q', '-b', 'b2', 'main')
  const c = commitFiles(lib, { 'c.txt': 'c\n' }, 'C')
  sh(lib, 'checkout', '-q', 'main')
  return { lib, a, b, c }
}

/** A superproject with `lib` committed as the submodule `deps/lib`. */
async function superRepo(): Promise<{ repo: string; lib: string; a: string; b: string; c: string }> {
  const l = libRepo()
  const { repo } = seededRepo()
  await api.submoduleAdd(repo, l.lib, 'deps/lib')
  sh(repo, 'commit', '-q', '-m', 'add submodule')
  return { repo, ...l }
}

describe('submodules', () => {
  it('lists nothing in a repository without submodules', async () => {
    const { repo } = seededRepo()
    expect(await api.submodules(repo)).toEqual([])
  })

  it('submoduleAdd clones the submodule and stages .gitmodules + the gitlink', async () => {
    const { lib, a } = libRepo()
    const { repo } = seededRepo()
    await api.submoduleAdd(repo, lib, 'deps/lib')

    expect(existsSync(join(repo, 'deps/lib/a.txt'))).toBe(true)
    expect(await api.submodules(repo)).toEqual([{ path: 'deps/lib', url: lib, hash: a, status: 'ok', branch: 'main' }])
    const st = await coreApi.status(repo)
    expect(st.staged.map((f) => f.path).sort()).toEqual(['.gitmodules', 'deps/lib'])
    expect(st.unstaged).toEqual([])
  })

  it('reports uninitialized -> ok -> modified, with the recorded hash', async () => {
    const { repo, lib, a, b } = await superRepo()
    const clone = join(tmpDir(), 'clone')
    sh(tmpDir(), 'clone', '-q', repo, clone)

    // A plain clone leaves the submodule empty.
    expect(await api.submodules(clone)).toEqual([{ path: 'deps/lib', url: lib, hash: a, status: 'uninitialized' }])

    await api.submoduleUpdate(clone, 'deps/lib')
    expect(existsSync(join(clone, 'deps/lib/a.txt'))).toBe(true)
    // `submodule update` checks the recorded commit out detached: no branch.
    expect(await api.submodules(clone)).toEqual([{ path: 'deps/lib', url: lib, hash: a, status: 'ok' }])

    // Move the submodule to another commit: git prints that commit, we report the recorded one.
    sh(join(clone, 'deps/lib'), 'checkout', '-q', '-b', 'work', b)
    expect(sh(clone, 'submodule', 'status')).toMatch(new RegExp(`^\\+${b} deps/lib`))
    expect(await api.submodules(clone)).toEqual([{ path: 'deps/lib', url: lib, hash: a, status: 'modified', branch: 'work' }])

    // Updating puts the recorded commit back.
    await api.submoduleUpdate(clone)
    expect(sh(join(clone, 'deps/lib'), 'rev-parse', 'HEAD')).toBe(a)
    expect(byPath(await api.submodules(clone), 'deps/lib').status).toBe('ok')
  })

  it('reports a submodule merge conflict', async () => {
    const { repo, b, c } = await superRepo()
    const sub = join(repo, 'deps/lib')

    sh(repo, 'checkout', '-q', '-b', 'x')
    sh(sub, 'checkout', '-q', b)
    sh(repo, 'commit', '-q', '-am', 'lib at B')
    sh(repo, 'checkout', '-q', '-b', 'y', 'main')
    sh(sub, 'checkout', '-q', c)
    sh(repo, 'commit', '-q', '-am', 'lib at C')
    // B and C diverge: git cannot pick one.
    expect(spawnSync('git', ['merge', '--no-edit', 'x'], { cwd: repo, encoding: 'utf8' }).status).not.toBe(0)
    expect(sh(repo, 'submodule', 'status')).toMatch(/^U0{40} deps\/lib$/)

    const [entry, ...others] = await api.submodules(repo)
    expect(others).toEqual([])
    // "ours" (the commit recorded by the branch being merged into), not the zeros git prints
    expect(entry).toMatchObject({ path: 'deps/lib', status: 'conflict', hash: c })
  })

  it('handles nested submodules: listing, update all, update one nested path', async () => {
    const { lib, a, b } = libRepo()
    // mid contains lib at "vendor/my lib" (a path with a space); top contains mid.
    const { repo: mid } = seededRepo()
    await api.submoduleAdd(mid, lib, 'vendor/my lib')
    sh(mid, 'commit', '-q', '-m', 'add lib')
    const midHead = sh(mid, 'rev-parse', 'HEAD')
    const { repo: top } = seededRepo()
    await api.submoduleAdd(top, mid, 'mods/mid')
    sh(top, 'commit', '-q', '-m', 'add mid')

    const clone = join(tmpDir(), 'clone')
    sh(tmpDir(), 'clone', '-q', top, clone)
    // Not initialised yet: git cannot see inside mods/mid.
    expect(await api.submodules(clone)).toEqual([{ path: 'mods/mid', url: mid, hash: midHead, status: 'uninitialized' }])

    await api.submoduleUpdate(clone)
    expect(existsSync(join(clone, 'mods/mid/vendor/my lib/a.txt'))).toBe(true)
    expect(await api.submodules(clone)).toEqual([
      { path: 'mods/mid', url: mid, hash: midHead, status: 'ok' },
      // url comes from the .gitmodules of mods/mid, not from the top one
      { path: 'mods/mid/vendor/my lib', url: lib, hash: a, status: 'ok' }
    ])

    // Move only the nested one, then update it by its path from the top repository.
    const nested = join(clone, 'mods/mid/vendor/my lib')
    sh(nested, 'checkout', '-q', b)
    const moved = await api.submodules(clone)
    expect(byPath(moved, 'mods/mid/vendor/my lib')).toMatchObject({ status: 'modified', hash: a })
    await api.submoduleUpdate(clone, 'mods/mid/vendor/my lib')
    expect(sh(nested, 'rev-parse', 'HEAD')).toBe(a)
    expect(byPath(await api.submodules(clone), 'mods/mid/vendor/my lib').status).toBe('ok')
  })

  it('submoduleUpdate of one path leaves the others alone', async () => {
    const { lib } = libRepo()
    const { repo } = seededRepo()
    await api.submoduleAdd(repo, lib, 'one')
    await api.submoduleAdd(repo, lib, 'two')
    sh(repo, 'commit', '-q', '-m', 'two submodules')
    const clone = join(tmpDir(), 'clone')
    sh(tmpDir(), 'clone', '-q', repo, clone)

    await api.submoduleUpdate(clone, 'two')
    const list = await api.submodules(clone)
    expect(byPath(list, 'one').status).toBe('uninitialized')
    expect(byPath(list, 'two').status).toBe('ok')
    await expect(api.submoduleUpdate(clone, 'nope')).rejects.toThrow()
  })

  it('rejects URLs and paths that could be read as options or leave the repository', async () => {
    const { lib } = libRepo()
    const { repo } = seededRepo()
    const bad: [string, string][] = [
      ['--upload-pack=touch pwned', 'x'],
      ['-u', 'x'],
      ['', 'x'],
      [lib, ''],
      [lib, '-b'],
      [lib, '--name=x'],
      [lib, '../outside'],
      [lib, 'a/../../outside'],
      [lib, '/absolute/path'],
      [lib, '.git/hooks'],
      [lib, 'a\nb'],
      [`${lib}\n--force`, 'x']
    ]
    for (const [url, path] of bad) {
      await expect(api.submoduleAdd(repo, url, path), `${JSON.stringify(url)} ${JSON.stringify(path)}`).rejects.toThrow(
        /Missing|Invalid/
      )
    }
    await expect(api.submoduleUpdate(repo, '--init')).rejects.toThrow(/Invalid/)
    await expect(api.submoduleUpdate(repo, '../x')).rejects.toThrow(/Invalid/)
    expect(existsSync(join(repo, '.gitmodules'))).toBe(false)
    expect((await coreApi.status(repo)).staged).toEqual([])
  })

  it('does not unlock the file transport by itself: git refuses a local path and the error explains why', async () => {
    const { lib } = libRepo()
    const { repo } = seededRepo()
    const saved = process.env['GIT_CONFIG_GLOBAL']!
    // Same identity, but without `protocol.file.allow`: what a real user has.
    const strict = join(tmpDir(), 'gitconfig')
    writeFileSync(strict, globalConfig().replace(/\[protocol "file"\]\n\tallow = always\n/, ''))
    expect(readFileSync(strict, 'utf8')).not.toMatch(/protocol/)
    process.env['GIT_CONFIG_GLOBAL'] = strict
    try {
      await expect(api.submoduleAdd(repo, lib, 'deps/lib')).rejects.toThrow(/protocol\.file\.allow[\s\S]*transport 'file' not allowed/)
      expect(readFileSync(strict, 'utf8')).not.toMatch(/protocol/)
      expect(spawnSync('git', ['config', '--get', 'protocol.file.allow'], { cwd: repo }).status).toBe(1)
    } finally {
      process.env['GIT_CONFIG_GLOBAL'] = saved
    }
  })

  it('parses `git submodule status` output', () => {
    const sha = (ch: string): string => ch.repeat(40)
    const out = [
      ` ${sha('a')} libs/core (v1.2.0-3-gabcdef0)`,
      `-${sha('b')} libs/not initialised`,
      `+${sha('c')} vendor/with (parens) inside (heads/main)`,
      `U${sha('0')} libs/conflicted`,
      ` ${sha('d')} no-describe`,
      ` ${'e'.repeat(64)} sha256/sub (heads/main)`,
      'garbage line',
      ''
    ].join('\n')
    expect(parseSubmoduleStatus(out)).toEqual([
      { flag: ' ', hash: sha('a'), path: 'libs/core' },
      { flag: '-', hash: sha('b'), path: 'libs/not initialised' },
      { flag: '+', hash: sha('c'), path: 'vendor/with (parens) inside' },
      { flag: 'U', hash: sha('0'), path: 'libs/conflicted' },
      { flag: ' ', hash: sha('d'), path: 'no-describe' },
      { flag: ' ', hash: 'e'.repeat(64), path: 'sha256/sub' }
    ])
  })
})

// --- worktrees ---------------------------------------------------------------------

/** main (2 commits) + branch `feature` + tag `v1` on the first commit. */
function branchyRepo(): { repo: string; first: string; second: string } {
  const { repo, first } = seededRepo()
  sh(repo, 'tag', 'v1')
  sh(repo, 'branch', 'feature')
  const second = commitFiles(repo, { 'b.txt': 'two\n' }, 'second')
  return { repo, first, second }
}

describe('worktrees', () => {
  it('lists the main worktree of a plain repository', async () => {
    const { repo, second } = branchyRepo()
    expect(await api.worktrees(repo)).toEqual([
      { path: repo, head: second, branch: 'main', isMain: true, locked: false, prunable: false }
    ])
  })

  it('adds a worktree on an existing branch (missing folder, and existing empty folder)', async () => {
    const { repo, first, second } = branchyRepo()
    const base = tmpDir()
    const target = join(base, 'nested', 'wt-feature')
    await api.worktreeAdd(repo, target, 'feature')
    expect(existsSync(join(target, 'a.txt'))).toBe(true)
    expect(existsSync(join(target, 'b.txt'))).toBe(false)
    expect(sh(target, 'symbolic-ref', '--short', 'HEAD')).toBe('feature')

    const empty = join(base, 'empty')
    mkdirSync(empty)
    sh(repo, 'branch', 'other')
    await api.worktreeAdd(repo, empty, 'other')

    const list = await api.worktrees(repo)
    // The main worktree comes first; git orders the linked ones.
    expect(list[0]).toEqual({ path: repo, head: second, branch: 'main', isMain: true, locked: false, prunable: false })
    expect(list).toHaveLength(3)
    expect(byPath(list, target)).toEqual({ path: target, head: first, branch: 'feature', isMain: false, locked: false, prunable: false })
    expect(byPath(list, empty)).toEqual({ path: empty, head: second, branch: 'other', isMain: false, locked: false, prunable: false })
    // Seen from a linked worktree, the main one is still the main one.
    expect(await api.worktrees(target)).toEqual(list)
  })

  it('creates a new branch from a ref, without an upstream', async () => {
    const { repo, first } = branchyRepo()
    const origin = join(tmpDir(), 'origin.git')
    sh(tmpDir(), 'clone', '-q', '--bare', repo, origin)
    sh(repo, 'remote', 'add', 'origin', origin)
    sh(repo, 'fetch', '-q', 'origin')

    const target = join(tmpDir(), 'wt-new')
    await api.worktreeAdd(repo, target, 'origin/feature', 'topic/new')
    expect(byPath(await api.worktrees(repo), target)).toMatchObject({ branch: 'topic/new', head: first, isMain: false })
    expect(sh(repo, 'rev-parse', 'topic/new')).toBe(first)
    expect(spawnSync('git', ['config', '--get', 'branch.topic/new.remote'], { cwd: repo }).status).toBe(1)

    // The name is taken now.
    await expect(api.worktreeAdd(repo, join(tmpDir(), 'wt-dup'), 'main', 'topic/new')).rejects.toThrow(
      /A branch named "topic\/new" already exists/
    )
  })

  it('checks a tag or commit out detached', async () => {
    const { repo, first } = branchyRepo()
    const target = join(tmpDir(), 'wt-tag')
    await api.worktreeAdd(repo, target, 'v1')
    expect(byPath(await api.worktrees(repo), target)).toMatchObject({ branch: null, head: first })
  })

  it('explains that a branch is already checked out elsewhere', async () => {
    const { repo } = branchyRepo()
    const target = join(tmpDir(), 'wt-main')
    const err = await api.worktreeAdd(repo, target, 'main').then(
      () => null,
      (e: Error) => e
    )
    expect(err?.message).toMatch(/Branch "main" is already checked out in the worktree/)
    expect(err?.message).toContain(repo)
    expect(existsSync(target)).toBe(false)
    expect(await api.worktrees(repo)).toHaveLength(1)

    // Same for a branch held by a linked worktree.
    const first = join(tmpDir(), 'wt-a')
    await api.worktreeAdd(repo, first, 'feature')
    await expect(api.worktreeAdd(repo, join(tmpDir(), 'wt-b'), 'feature')).rejects.toThrow(/is already checked out in the worktree/)
  })

  it('refuses a destination that is relative, a file, or a non-empty folder', async () => {
    const { repo } = branchyRepo()
    const base = tmpDir()
    write(base, 'full/keep.txt', 'mine\n')
    write(base, 'a-file', 'x')

    await expect(api.worktreeAdd(repo, 'relative/path', 'feature')).rejects.toThrow(/absolute path/)
    await expect(api.worktreeAdd(repo, join(base, 'full'), 'feature')).rejects.toThrow(/is not empty/)
    await expect(api.worktreeAdd(repo, join(base, 'a-file'), 'feature')).rejects.toThrow(/is not a folder/)
    await expect(api.worktreeAdd(repo, join(base, 'a-file', 'below'), 'feature')).rejects.toThrow(/is not a folder/)
    await expect(api.worktreeAdd(repo, '', 'feature')).rejects.toThrow(/Missing/)
    await expect(api.worktreeAdd(repo, join(base, 'ok'), '--detach')).rejects.toThrow(/Invalid/)
    await expect(api.worktreeAdd(repo, join(base, 'ok'), 'feature', '--force')).rejects.toThrow(/Invalid/)
    await expect(api.worktreeAdd(repo, join(base, 'ok'), 'does-not-exist')).rejects.toThrow()

    expect(readFileSync(join(base, 'full/keep.txt'), 'utf8')).toBe('mine\n')
    expect(await api.worktrees(repo)).toHaveLength(1)
  })

  it('reports locked, prunable and bare', async () => {
    const { repo } = branchyRepo()
    const locked = join(tmpDir(), 'wt-locked')
    const gone = join(tmpDir(), 'wt-gone')
    await api.worktreeAdd(repo, locked, 'feature')
    await api.worktreeAdd(repo, gone, 'v1')
    sh(repo, 'worktree', 'lock', '--reason', 'on a usb\ndisk', locked)
    rmSync(gone, { recursive: true, force: true })

    const list = await api.worktrees(repo)
    expect(byPath(list, locked)).toMatchObject({ locked: true, prunable: false, branch: 'feature' })
    expect(byPath(list, gone)).toMatchObject({ locked: false, prunable: true, branch: null })
    expect(byPath(list, repo)).toMatchObject({ locked: false, prunable: false, isMain: true })

    const bare = join(tmpDir(), 'bare.git')
    sh(tmpDir(), 'clone', '-q', '--bare', repo, bare)
    expect(await api.worktrees(bare)).toEqual([
      { path: bare, head: '', branch: null, isMain: true, locked: false, prunable: false }
    ])
  })

  it('removes a clean worktree', async () => {
    const { repo } = branchyRepo()
    const target = join(tmpDir(), 'wt')
    await api.worktreeAdd(repo, target, 'feature')
    await api.worktreeRemove(repo, target)
    expect(existsSync(target)).toBe(false)
    expect(await api.worktrees(repo)).toHaveLength(1)
    // The branch itself is untouched.
    expect(sh(repo, 'rev-parse', '--verify', 'feature')).toMatch(/^[0-9a-f]{40}$/)
  })

  it('refuses to remove a worktree with changes unless forced', async () => {
    const { repo } = branchyRepo()
    const untracked = join(tmpDir(), 'wt-untracked')
    const modified = join(tmpDir(), 'wt-modified')
    await api.worktreeAdd(repo, untracked, 'feature')
    await api.worktreeAdd(repo, modified, 'v1')
    write(untracked, 'new.txt', 'work in progress\n')
    write(modified, 'a.txt', 'edited\n')

    for (const target of [untracked, modified]) {
      await expect(api.worktreeRemove(repo, target)).rejects.toThrow(/contains modified or untracked files, use --force/)
      await expect(api.worktreeRemove(repo, target, false)).rejects.toThrow(/--force/)
    }
    expect(readFileSync(join(untracked, 'new.txt'), 'utf8')).toBe('work in progress\n')
    expect(readFileSync(join(modified, 'a.txt'), 'utf8')).toBe('edited\n')
    expect(await api.worktrees(repo)).toHaveLength(3)

    await api.worktreeRemove(repo, untracked, true)
    await api.worktreeRemove(repo, modified, true)
    expect(existsSync(untracked)).toBe(false)
    expect(existsSync(modified)).toBe(false)
    expect(await api.worktrees(repo)).toHaveLength(1)
  })

  it('never removes the main worktree, the open one, a locked one or a foreign folder', async () => {
    const { repo } = branchyRepo()
    const linked = join(tmpDir(), 'wt')
    const locked = join(tmpDir(), 'wt-locked')
    await api.worktreeAdd(repo, linked, 'feature')
    await api.worktreeAdd(repo, locked, 'v1')
    sh(repo, 'worktree', 'lock', locked)
    const stranger = tmpDir()

    for (const force of [false, true]) {
      await expect(api.worktreeRemove(repo, repo, force)).rejects.toThrow(/main worktree/)
      // ...also when asked from a linked worktree
      await expect(api.worktreeRemove(linked, repo, force)).rejects.toThrow(/main worktree/)
      await expect(api.worktreeRemove(linked, linked, force)).rejects.toThrow(/open repository/)
      await expect(api.worktreeRemove(repo, stranger, force)).rejects.toThrow(/is not a worktree/)
      await expect(api.worktreeRemove(repo, locked, force)).rejects.toThrow(/locked/)
    }
    await expect(api.worktreeRemove(repo, '--force')).rejects.toThrow(/Invalid/)
    expect(existsSync(join(repo, 'a.txt'))).toBe(true)
    expect(existsSync(join(linked, 'a.txt'))).toBe(true)
    expect(existsSync(join(locked, 'a.txt'))).toBe(true)
    expect(await api.worktrees(repo)).toHaveLength(3)
  })

  it('removes the entry of a worktree whose folder is gone', async () => {
    const { repo } = branchyRepo()
    const gone = join(tmpDir(), 'wt-gone')
    await api.worktreeAdd(repo, gone, 'feature')
    rmSync(gone, { recursive: true, force: true })
    expect(byPath(await api.worktrees(repo), gone).prunable).toBe(true)
    await api.worktreeRemove(repo, gone)
    expect(await api.worktrees(repo)).toHaveLength(1)
  })

  it('concurrent adds and removes on one repository all succeed', async () => {
    const { repo } = branchyRepo()
    const base = tmpDir()
    const names = ['w1', 'w2', 'w3', 'w4', 'w5']
    await Promise.all(names.map((n) => api.worktreeAdd(repo, join(base, n), 'main', `topic/${n}`)))
    const list = await api.worktrees(repo)
    expect(list.map((w) => basename(w.path)).slice(1).sort()).toEqual(names)
    await Promise.all(names.map((n) => api.worktreeRemove(repo, join(base, n))))
    expect(await api.worktrees(repo)).toHaveLength(1)
  })

  it('parses the line-based porcelain format too (git < 2.36 has no -z)', () => {
    const out = [
      'worktree /repos/app',
      'HEAD 1111111111111111111111111111111111111111',
      'branch refs/heads/main',
      '',
      'worktree /repos/app wt/hotfix',
      'HEAD 2222222222222222222222222222222222222222',
      'detached',
      'locked',
      '',
      'worktree /mnt/usb/app',
      'HEAD 3333333333333333333333333333333333333333',
      'branch refs/heads/feature/x',
      'locked usb stick',
      'prunable gitdir file points to non-existent location',
      ''
    ].join('\n')
    expect(parseWorktreeList(out)).toEqual([
      { path: '/repos/app', head: '1'.repeat(40), branch: 'main', isMain: true, locked: false, prunable: false },
      { path: '/repos/app wt/hotfix', head: '2'.repeat(40), branch: null, isMain: false, locked: true, prunable: false },
      { path: '/mnt/usb/app', head: '3'.repeat(40), branch: 'feature/x', isMain: false, locked: true, prunable: true }
    ])
    expect(parseWorktreeList('worktree /srv/app.git\nbare\n')).toEqual([
      { path: '/srv/app.git', head: '', branch: null, isMain: true, locked: false, prunable: false }
    ])
    expect(parseWorktreeList('')).toEqual([])
  })
})

// --- LFS -----------------------------------------------------------------------------

const ATTRS = '*.psd filter=lfs diff=lfs merge=lfs -text\nassets/**/*.bin filter=lfs diff=lfs merge=lfs -text\n*.txt text\n'

describe('LFS patterns in .gitattributes', () => {
  it('keeps only filter=lfs entries and undoes git-lfs escaping', () => {
    const text = [
      '# comment',
      '',
      '*.psd filter=lfs diff=lfs merge=lfs -text',
      '*.txt text eol=lf',
      'big[[:space:]]file.bin filter=lfs diff=lfs merge=lfs -text',
      'docs/\\#1.pdf\tfilter=lfs',
      '"quoted name.zip" filter=lfs diff=lfs merge=lfs -text',
      '*.png -filter',
      '*.gif filter=other',
      '[attr]binary -diff -merge -text',
      '*.psd filter=lfs diff=lfs merge=lfs -text',
      '  *.mov   filter=lfs   -text  '
    ].join('\r\n')
    expect(parseLfsPatterns(text)).toEqual(['*.psd', 'big file.bin', 'docs/#1.pdf', 'quoted name.zip', '*.mov'])
    expect(parseLfsPatterns('')).toEqual([])
  })
})

describe.skipIf(realLfs)('LFS when git-lfs is not installed (real calls)', () => {
  it('lfsInfo does not throw: installed false, nothing to show', async () => {
    const { repo } = seededRepo()
    expect(await api.lfsInfo(repo)).toEqual({ installed: false, enabled: false, patterns: [], files: [] })
  })

  it('lfsInfo still reads the patterns and the files they cover', async () => {
    const { repo } = seededRepo()
    commitFiles(
      repo,
      { '.gitattributes': ATTRS, 'art/logo.psd': 'psd', 'assets/a/b/data.bin': 'bin', 'notes.txt': 'n', 'data.bin': 'not under assets' },
      'binary files'
    )
    // Uncommitted pattern: the work tree file is what counts.
    write(repo, '.gitattributes', `${ATTRS}*.mov filter=lfs diff=lfs merge=lfs -text\n`)
    expect(await api.lfsInfo(repo)).toEqual({
      installed: false,
      enabled: false,
      patterns: ['*.psd', 'assets/**/*.bin', '*.mov'],
      files: ['art/logo.psd', 'assets/a/b/data.bin']
    })
  })

  it('every LFS write rejects explaining how to install git-lfs, and changes nothing', async () => {
    const { repo } = seededRepo()
    commitFiles(repo, { '.gitattributes': ATTRS }, 'attrs')
    const before = globalConfig()
    const message = /Git LFS is not installed on this computer[\s\S]*git-lfs/

    await expect(api.lfsInstall(repo)).rejects.toThrow(message)
    await expect(api.lfsTrack(repo, '*.zip')).rejects.toThrow(message)
    await expect(api.lfsUntrack(repo, '*.psd')).rejects.toThrow(message)
    await expect(api.lfsPull(repo)).rejects.toThrow(message)

    expect(readFileSync(join(repo, '.gitattributes'), 'utf8')).toBe(ATTRS)
    expect(globalConfig()).toBe(before)
    // exit code 1 = no such key
    expect(spawnSync('git', ['config', '--local', '--get-regexp', '^filter\\.'], { cwd: repo }).status).toBe(1)
    const st = await coreApi.status(repo)
    expect([...st.staged, ...st.unstaged]).toEqual([])
  })

  it('a missing repository folder is reported as such, not as missing LFS', async () => {
    await expect(api.lfsInstall(join(tmpDir(), 'nope'))).rejects.toThrow(/Folder not found/)
  })
})

describe('LFS wiring with a FAKE git-lfs script first in PATH', () => {
  let savedPath: string | undefined
  let log = ''
  const calls = (): string[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .split('\n')
          .filter((l) => l && !l.endsWith('|version'))
      : []

  beforeAll(() => {
    const bin = tmpDir('gitkroken-fakelfs-')
    log = join(bin, 'calls.log')
    // Output texts copied from git-lfs 3.x; the script only imitates the side
    // effects this module depends on (.gitattributes lines, local config, hook).
    const script = `#!/bin/sh
echo "$PWD|$*" >> "$FAKE_LFS_LOG"
case "$1" in
  version) echo "git-lfs/3.5.1 (GitHub; darwin arm64; go 1.22.1)" ;;
  install)
    if [ "$#" -ne 2 ] || [ "$2" != "--local" ]; then echo "fake git-lfs: expected exactly: install --local" >&2; exit 2; fi
    git config --local filter.lfs.clean "git-lfs clean -- %f"
    git config --local filter.lfs.smudge "git-lfs smudge -- %f"
    hook=$(git rev-parse --git-path hooks/pre-push)
    mkdir -p "$(dirname "$hook")"
    printf '#!/bin/sh\\ncommand -v git-lfs >/dev/null 2>&1 || exit 2\\ngit lfs pre-push "$@"\\n' > "$hook"
    echo "Updated Git hooks."
    echo "Git LFS initialized." ;;
  track)
    if [ "$2" = "*.boom" ]; then echo "Error: something went wrong inside git-lfs" >&2; exit 2; fi
    # Detects two writers at once: the write queue must never let that happen.
    if ! mkdir .fake-lfs-busy 2>/dev/null; then echo "fake git-lfs: concurrent write" >&2; exit 3; fi
    sleep 0.1
    rmdir .fake-lfs-busy
    printf '%s filter=lfs diff=lfs merge=lfs -text\\n' "$2" >> .gitattributes
    echo "Tracking \\"$2\\"" ;;
  untrack)
    grep -v -F -- "$2 filter=lfs" .gitattributes > .gitattributes.tmp
    mv .gitattributes.tmp .gitattributes
    echo "Untracking \\"$2\\"" ;;
  ls-files)
    if [ "$2" != "-n" ]; then echo "fake git-lfs: expected ls-files -n" >&2; exit 2; fi
    printf 'art/logo.psd\\nbig file.bin\\n' ;;
  pull) echo "Downloading LFS objects: 100% (2/2), 2.1 MB | 1.0 MB/s" ;;
  clean|smudge) cat ;;
  *) echo "fake git-lfs: unexpected command: $*" >&2; exit 2 ;;
esac
`
    const file = join(bin, 'git-lfs')
    writeFileSync(file, script)
    chmodSync(file, 0o755)
    savedPath = process.env['PATH']
    process.env['PATH'] = `${bin}:${savedPath ?? ''}`
    process.env['FAKE_LFS_LOG'] = log
  })

  afterAll(() => {
    process.env['PATH'] = savedPath
    delete process.env['FAKE_LFS_LOG']
  })

  it('install is repo-local, then the repository reports as enabled', async () => {
    const { repo } = seededRepo()
    const before = globalConfig()
    expect(await api.lfsInfo(repo)).toEqual({ installed: true, enabled: false, patterns: [], files: [] })

    await api.lfsInstall(repo)
    expect(calls()).toContain(`${repo}|install --local`)
    expect(calls().filter((c) => c.includes('|install'))).toEqual([`${repo}|install --local`])
    expect(globalConfig()).toBe(before)
    expect(sh(repo, 'config', '--local', '--get', 'filter.lfs.clean')).toBe('git-lfs clean -- %f')

    expect(await api.lfsInfo(repo)).toEqual({
      installed: true,
      enabled: true,
      patterns: [],
      files: ['art/logo.psd', 'big file.bin']
    })
  })

  it('filters configured globally but no hook in the repository is not "enabled"', async () => {
    const { repo } = seededRepo()
    sh(repo, 'config', 'filter.lfs.clean', 'git-lfs clean -- %f')
    expect((await api.lfsInfo(repo)).enabled).toBe(false)
    // a pre-push hook from something else does not count either
    write(repo, '.git/hooks/pre-push', '#!/bin/sh\nnpm test\n')
    expect((await api.lfsInfo(repo)).enabled).toBe(false)
  })

  it('track / untrack edit .gitattributes and leave the change unstaged', async () => {
    const { repo } = seededRepo()
    await api.lfsTrack(repo, '*.psd')
    await api.lfsTrack(repo, '  assets/**/*.bin ')
    expect(calls()).toContain(`${repo}|track *.psd`)
    expect(calls()).toContain(`${repo}|track assets/**/*.bin`)
    expect((await api.lfsInfo(repo)).patterns).toEqual(['*.psd', 'assets/**/*.bin'])

    let st = await coreApi.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([{ path: '.gitattributes', status: 'untracked' }])

    sh(repo, 'add', '.gitattributes')
    sh(repo, 'commit', '-q', '-m', 'track')
    await api.lfsUntrack(repo, '*.psd')
    expect(calls()).toContain(`${repo}|untrack *.psd`)
    expect((await api.lfsInfo(repo)).patterns).toEqual(['assets/**/*.bin'])
    st = await coreApi.status(repo)
    expect(st.staged).toEqual([])
    expect(st.unstaged).toEqual([{ path: '.gitattributes', status: 'modified' }])

    await expect(api.lfsUntrack(repo, '*.nope')).rejects.toThrow(/is not in the \.gitattributes/)
    expect(calls().filter((c) => c.includes('*.nope'))).toEqual([])
  })

  it('writes on one repository are queued, not run at the same time', async () => {
    const { repo } = seededRepo()
    const other = seededRepo().repo
    const patterns = ['*.a', '*.b', '*.c', '*.d']
    // The fake fails with "concurrent write" if two `track` overlap in one repository.
    await Promise.all([...patterns.map((p) => api.lfsTrack(repo, p)), api.lfsTrack(other, '*.z')])
    expect((await api.lfsInfo(repo)).patterns).toEqual(patterns)
    expect((await api.lfsInfo(other)).patterns).toEqual(['*.z'])
    // A failed write does not block the ones queued behind it.
    const results = await Promise.allSettled([api.lfsTrack(repo, '*.boom'), api.lfsTrack(repo, '*.e')])
    expect(results.map((r) => r.status)).toEqual(['rejected', 'fulfilled'])
    expect((await api.lfsInfo(repo)).patterns).toEqual([...patterns, '*.e'])
  })

  it('rejects patterns that could be read as options', async () => {
    const { repo } = seededRepo()
    const seen = calls().length
    for (const bad of ['--filename', '-v', '', '   ', 'a\nb', '"*.psd"', 'dir\\*.psd']) {
      await expect(api.lfsTrack(repo, bad), JSON.stringify(bad)).rejects.toThrow(/Missing|Invalid/)
      await expect(api.lfsUntrack(repo, bad), JSON.stringify(bad)).rejects.toThrow(/Missing|Invalid/)
    }
    expect(calls().length).toBe(seen)
    expect(existsSync(join(repo, '.gitattributes'))).toBe(false)
  })

  it('pull runs `git lfs pull` in the repository', async () => {
    const { repo } = seededRepo()
    await api.lfsPull(repo)
    expect(calls()).toContain(`${repo}|pull`)
  })

  it('surfaces a git-lfs failure as the error', async () => {
    const { repo } = seededRepo()
    await expect(api.lfsTrack(repo, '*.boom')).rejects.toThrow(/something went wrong inside git-lfs/)
  })
})
