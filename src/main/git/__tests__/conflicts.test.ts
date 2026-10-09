// Conflict backend against real temporary repositories.
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conflictsApi as api, dominantEol, toCrlf } from '../conflicts'
import { coreApi as core } from '../core'
import { cleanupAll, commitFiles, emptyRepo, setupGitEnv, sh, tick, tmpDir, write } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8')
const short = (repo: string, rev: string): string => sh(repo, 'rev-parse', '--short', rev)
const isExec = (repo: string, file: string): boolean => (statSync(join(repo, file)).mode & 0o111) !== 0
const conflicted = async (repo: string): Promise<string[]> => (await core.status(repo)).conflicted.map((f) => f.path).sort()

interface Fixture {
  repo: string
  base: string
  mainTip: string
  otherTip: string
}

/**
 * `main` and `other` diverge from a common commit. Each map gives the files of
 * that commit; `null` deletes the file.
 */
function diverged(
  base: Record<string, string | Buffer>,
  main: Record<string, string | Buffer | null>,
  other: Record<string, string | Buffer | null>,
  prepare?: (repo: string) => void
): Fixture {
  const repo = emptyRepo()
  prepare?.(repo)
  const commit = (files: Record<string, string | Buffer | null>, message: string): string => {
    for (const [file, content] of Object.entries(files)) {
      if (content === null) sh(repo, 'rm', '-q', '--', file)
      else {
        mkdirSync(join(repo, file, '..'), { recursive: true })
        writeFileSync(join(repo, file), content)
      }
    }
    tick()
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '--allow-empty', '-m', message)
    return sh(repo, 'rev-parse', 'HEAD')
  }
  const baseTip = commit(base, 'base')
  sh(repo, 'checkout', '-q', '-b', 'other')
  const otherTip = commit(other, 'other change')
  sh(repo, 'checkout', '-q', 'main')
  const mainTip = commit(main, 'main change')
  return { repo, base: baseTip, mainTip, otherTip }
}

const simple = (): Fixture =>
  diverged({ 'a.txt': 'one\ntwo\nthree\n' }, { 'a.txt': 'one\nMAIN\nthree\n' }, { 'a.txt': 'one\nOTHER\nthree\n' })

const failMerge = async (repo: string, ref = 'other'): Promise<void> => {
  await expect(core.merge(repo, ref)).rejects.toThrow(/CONFLICT/)
}

describe('conflictFile', () => {
  it('returns the three stages, the worktree text and the names of a merge', async () => {
    const { repo } = simple()
    await failMerge(repo)
    const file = await api.conflictFile(repo, 'a.txt')
    expect(file).toEqual({
      path: 'a.txt',
      base: 'one\ntwo\nthree\n',
      ours: 'one\nMAIN\nthree\n',
      theirs: 'one\nOTHER\nthree\n',
      merged: read(repo, 'a.txt'),
      binary: false,
      oursLabel: 'main',
      theirsLabel: 'other'
    })
    // The worktree text is the file with git's markers (their label is however the ref was given to git).
    expect(file.merged).toMatch(/^one\n<<<<<<< HEAD\nMAIN\n=======\nOTHER\n>>>>>>> (refs\/heads\/)?other\nthree\n$/)
  })

  it('rejects files that are not in conflict and paths outside the repository', async () => {
    const { repo } = diverged(
      { 'a.txt': 'one\n', 'clean.txt': 'c\n' },
      { 'a.txt': 'main\n' },
      { 'a.txt': 'other\n' }
    )
    await failMerge(repo)
    await expect(api.conflictFile(repo, 'clean.txt')).rejects.toThrow(/Not a conflicted file/)
    await expect(api.conflictFile(repo, 'missing.txt')).rejects.toThrow(/Not a conflicted file/)
    await expect(api.conflictFile(repo, '')).rejects.toThrow(/Invalid path/)
    for (const bad of ['../a.txt', '/etc/hosts', 'sub/../../a.txt']) {
      await expect(api.conflictFile(repo, bad)).rejects.toThrow(/outside the repository|Not a conflicted file/)
      await expect(api.resolveConflict(repo, bad, 'x')).rejects.toThrow(/outside the repository|Not a conflicted file/)
      await expect(api.resolveWith(repo, bad, 'ours')).rejects.toThrow(/outside the repository|Not a conflicted file/)
    }
    await expect(api.resolveConflict(repo, 'clean.txt', 'x\n')).rejects.toThrow(/Not a conflicted file/)
    await expect(api.resolveWith(repo, 'clean.txt', 'theirs')).rejects.toThrow(/Not a conflicted file/)
    await expect(api.resolveWith(repo, 'a.txt', 'both' as 'ours')).rejects.toThrow(/Invalid side/)
    expect(read(repo, 'clean.txt')).toBe('c\n')
    expect(await conflicted(repo)).toEqual(['a.txt'])
  })

  it('add/add: there is no base', async () => {
    const { repo } = diverged({ 'seed.txt': 's\n' }, { 'new.txt': 'from main\n' }, { 'new.txt': 'from other\n' })
    await failMerge(repo)
    const file = await api.conflictFile(repo, 'new.txt')
    expect(file.base).toBeNull()
    expect(file.ours).toBe('from main\n')
    expect(file.theirs).toBe('from other\n')
    expect(file.merged).toContain('<<<<<<<')
    expect(file.binary).toBe(false)
  })

  it('delete/modify: the deleting side is null', async () => {
    const { repo } = diverged(
      { 'gone-theirs.txt': 'x\n', 'gone-ours.txt': 'y\n' },
      { 'gone-theirs.txt': 'x\nmain edit\n', 'gone-ours.txt': null },
      { 'gone-theirs.txt': null, 'gone-ours.txt': 'y\nother edit\n' }
    )
    await failMerge(repo)
    expect(await conflicted(repo)).toEqual(['gone-ours.txt', 'gone-theirs.txt'])

    const a = await api.conflictFile(repo, 'gone-theirs.txt')
    expect(a).toMatchObject({ base: 'x\n', ours: 'x\nmain edit\n', theirs: null, binary: false })
    // git leaves the surviving version on disk
    expect(a.merged).toBe('x\nmain edit\n')

    const b = await api.conflictFile(repo, 'gone-ours.txt')
    expect(b).toMatchObject({ base: 'y\n', ours: null, theirs: 'y\nother edit\n', merged: 'y\nother edit\n', binary: false })
  })

  it('binary files are flagged and their bytes are not sent', async () => {
    const bin = (n: number): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, n, 0xff, 0xfe])
    const { repo } = diverged({ 'img.png': bin(1) }, { 'img.png': bin(2) }, { 'img.png': bin(3) })
    await failMerge(repo)
    expect(await api.conflictFile(repo, 'img.png')).toMatchObject({ base: '', ours: '', theirs: '', merged: '', binary: true })
  })

  it('text that is not valid UTF-8 is treated as binary (it could not be saved back intact)', async () => {
    const latin1 = (word: string): Buffer => Buffer.from(`se\xf1al ${word}\n`, 'latin1')
    const { repo } = diverged({ 'l.txt': latin1('uno') }, { 'l.txt': latin1('main') }, { 'l.txt': latin1('other') })
    await failMerge(repo)
    expect((await api.conflictFile(repo, 'l.txt')).binary).toBe(true)
  })

  it('keeps CRLF line endings and missing final newlines exactly', async () => {
    const { repo } = diverged(
      { 'w.txt': 'one\r\ntwo\r\nthree' },
      { 'w.txt': 'one\r\nMAIN\r\nthree' },
      { 'w.txt': 'one\r\nOTHER\r\nthree' }
    )
    await failMerge(repo)
    const file = await api.conflictFile(repo, 'w.txt')
    expect(file.ours).toBe('one\r\nMAIN\r\nthree')
    expect(file.theirs).toBe('one\r\nOTHER\r\nthree')
    expect(file.base).toBe('one\r\ntwo\r\nthree')
    expect(file.merged).toMatch(/<<<<<<< HEAD\r\nMAIN\r\n=======\r\nOTHER\r\n>>>>>>> \S*other\r\n/)
    expect(file.merged.endsWith('three')).toBe(true)
  })
})

describe('labels per operation', () => {
  it('merge: current branch vs the merged ref (branch, remote branch, plain commit, detached HEAD)', async () => {
    const { repo, otherTip, mainTip } = simple()

    await expect(core.merge(repo, otherTip)).rejects.toThrow(/CONFLICT/)
    // Merged by hash, but a branch points there: the branch name is the useful one.
    expect(await api.conflictFile(repo, 'a.txt')).toMatchObject({ oursLabel: 'main', theirsLabel: 'other' })
    await core.abort(repo)

    sh(repo, 'update-ref', 'refs/remotes/origin/topic', otherTip)
    sh(repo, 'branch', '-q', '-D', 'other')
    await expect(core.merge(repo, 'origin/topic')).rejects.toThrow(/CONFLICT/)
    expect(await api.conflictFile(repo, 'a.txt')).toMatchObject({ oursLabel: 'main', theirsLabel: 'origin/topic' })
    await core.abort(repo)

    sh(repo, 'update-ref', '-d', 'refs/remotes/origin/topic')
    await expect(core.merge(repo, otherTip)).rejects.toThrow(/CONFLICT/)
    expect((await api.conflictFile(repo, 'a.txt')).theirsLabel).toBe(`${short(repo, otherTip)} other change`)
    await core.abort(repo)

    sh(repo, 'checkout', '-q', '--detach', mainTip)
    await expect(core.merge(repo, otherTip)).rejects.toThrow(/CONFLICT/)
    expect((await api.conflictFile(repo, 'a.txt')).oursLabel).toBe(`${short(repo, mainTip)} (detached HEAD)`)
  })

  it('merge after a pull-style message names the ref that is really being merged', async () => {
    const { repo, otherTip } = simple()
    sh(repo, 'update-ref', 'refs/remotes/origin/main', otherTip)
    sh(repo, 'branch', '-q', '-D', 'other')
    await expect(core.merge(repo, 'origin/main')).rejects.toThrow(/CONFLICT/)
    // What `git pull` writes: the *remote's* branch name, which here is also the local one.
    writeFileSync(join(repo, '.git', 'MERGE_MSG'), "Merge branch 'main' of example.com:acme/repo\n")
    expect(await api.conflictFile(repo, 'a.txt')).toMatchObject({ oursLabel: 'main', theirsLabel: 'origin/main' })
  })

  it('rebase: "ours" is the branch rebased onto, "theirs" the commit being replayed', async () => {
    const { repo, otherTip } = simple()
    await core.checkout(repo, 'other')
    await expect(core.rebase(repo, 'main')).rejects.toThrow()
    const file = await api.conflictFile(repo, 'a.txt')
    // The contents confirm the swap: stage 2 is main's text although `other` is "our" branch.
    expect(file.ours).toBe('one\nMAIN\nthree\n')
    expect(file.theirs).toBe('one\nOTHER\nthree\n')
    expect(file.oursLabel).toBe('main (rebasing onto)')
    expect(file.theirsLabel).toBe(`${short(repo, otherTip)} other change (from other)`)
  })

  it('rebase with the apply backend is labelled the same way', async () => {
    const { repo, otherTip } = simple()
    sh(repo, 'checkout', '-q', 'other')
    expect(() => sh(repo, 'rebase', '--apply', 'main')).toThrow()
    expect((await core.status(repo)).inProgress).toBe('rebase')
    expect(await api.conflictFile(repo, 'a.txt')).toMatchObject({
      ours: 'one\nMAIN\nthree\n',
      oursLabel: 'main (rebasing onto)',
      theirsLabel: `${short(repo, otherTip)} other change (from other)`
    })
  })

  it('cherry-pick: current branch vs the picked commit', async () => {
    const { repo, otherTip } = simple()
    await expect(core.cherryPick(repo, otherTip)).rejects.toThrow()
    expect(await api.conflictFile(repo, 'a.txt')).toMatchObject({
      ours: 'one\nMAIN\nthree\n',
      theirs: 'one\nOTHER\nthree\n',
      oursLabel: 'main',
      theirsLabel: `${short(repo, otherTip)} other change (cherry-pick)`
    })
  })

  it('revert: "theirs" is the state before the reverted commit', async () => {
    const { repo, mainTip } = simple()
    commitFiles(repo, { 'a.txt': 'one\nMAIN again\nthree\n' }, 'main again')
    await expect(core.revert(repo, mainTip)).rejects.toThrow()
    expect(await api.conflictFile(repo, 'a.txt')).toMatchObject({
      base: 'one\nMAIN\nthree\n',
      ours: 'one\nMAIN again\nthree\n',
      theirs: 'one\ntwo\nthree\n',
      oursLabel: 'main',
      theirsLabel: `Before ${short(repo, mainTip)} main change (revert)`
    })
  })

  it('stash pop: current branch vs the stash entry', async () => {
    const { repo } = simple()
    commitFiles(repo, { 'pad.txt': 'p\n' }, 'padding')
    write(repo, 'pad.txt', 'older stash\n')
    await core.stashSave(repo, 'another stash')
    write(repo, 'a.txt', 'one\nSTASHED\nthree\n')
    await core.stashSave(repo, 'my work')
    commitFiles(repo, { 'a.txt': 'one\nMOVED ON\nthree\n' }, 'moved on')
    await expect(core.stashPop(repo, 0)).rejects.toThrow(/CONFLICT|conflict/i)

    const st = await core.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.conflicted.map((f) => f.path)).toEqual(['a.txt'])
    const file = await api.conflictFile(repo, 'a.txt')
    expect(file).toMatchObject({ ours: 'one\nMOVED ON\nthree\n', theirs: 'one\nSTASHED\nthree\n', oursLabel: 'main' })
    expect(file.theirsLabel).toBe('stash@{0} (On main: my work)')
  })
})

describe('resolveConflict', () => {
  it('writes the text, stages it, and the merge can then be completed', async () => {
    const { repo, mainTip, otherTip } = diverged(
      { 'a.txt': 'one\n', 'b.txt': 'uno\n' },
      { 'a.txt': 'main a\n', 'b.txt': 'main b\n' },
      { 'a.txt': 'other a\n', 'b.txt': 'other b\n' }
    )
    await failMerge(repo)
    expect(await conflicted(repo)).toEqual(['a.txt', 'b.txt'])

    await api.resolveConflict(repo, 'a.txt', 'main a\nother a\n')
    expect(await conflicted(repo)).toEqual(['b.txt'])
    await expect(core.continueOp(repo)).rejects.toThrow()

    await api.resolveConflict(repo, 'b.txt', 'resolved b\n')
    const st = await core.status(repo)
    expect(st.conflicted).toEqual([])
    expect(st.inProgress).toBe('merge')
    expect(st.staged.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt'])
    expect(st.unstaged).toEqual([])

    tick()
    await core.continueOp(repo)
    expect((await core.status(repo)).inProgress).toBeNull()
    const [head] = await core.log(repo, { limit: 1 })
    expect(head!.parents).toEqual([mainTip, otherTip])
    expect(read(repo, 'a.txt')).toBe('main a\nother a\n')
    expect(sh(repo, 'show', 'HEAD:b.txt')).toBe('resolved b')
  })

  it('completes a rebase', async () => {
    const { repo, mainTip } = simple()
    await core.checkout(repo, 'other')
    await expect(core.rebase(repo, 'main')).rejects.toThrow()
    await api.resolveConflict(repo, 'a.txt', 'one\nMAIN + OTHER\nthree\n')
    expect(await conflicted(repo)).toEqual([])
    tick()
    await core.continueOp(repo)
    const st = await core.status(repo)
    expect(st.inProgress).toBeNull()
    expect(st.branch).toBe('other')
    const [head] = await core.log(repo, { limit: 1 })
    expect(head).toMatchObject({ subject: 'other change', parents: [mainTip] })
    expect(read(repo, 'a.txt')).toBe('one\nMAIN + OTHER\nthree\n')
  })

  it('completes a cherry-pick and a revert', async () => {
    const { repo, mainTip, otherTip } = simple()
    await expect(core.cherryPick(repo, otherTip)).rejects.toThrow()
    await api.resolveConflict(repo, 'a.txt', 'one\nPICKED\nthree\n')
    tick()
    await core.continueOp(repo)
    let [head] = await core.log(repo, { limit: 1 })
    expect(head).toMatchObject({ subject: 'other change', parents: [mainTip] })

    await expect(core.revert(repo, mainTip)).rejects.toThrow()
    await api.resolveConflict(repo, 'a.txt', 'one\nREVERTED\nthree\n')
    expect(await conflicted(repo)).toEqual([])
    tick()
    await core.continueOp(repo)
    ;[head] = await core.log(repo, { limit: 1 })
    expect(head!.subject).toBe('Revert "main change"')
    expect((await core.status(repo)).inProgress).toBeNull()
    expect(read(repo, 'a.txt')).toBe('one\nREVERTED\nthree\n')
  })

  it('resolves a stash-pop conflict', async () => {
    const { repo } = simple()
    write(repo, 'a.txt', 'one\nSTASHED\nthree\n')
    await core.stashSave(repo)
    commitFiles(repo, { 'a.txt': 'one\nMOVED ON\nthree\n' }, 'moved on')
    await expect(core.stashPop(repo, 0)).rejects.toThrow()
    await api.resolveConflict(repo, 'a.txt', 'one\nBOTH\nthree\n')
    const st = await core.status(repo)
    expect(st.conflicted).toEqual([])
    expect(st.staged).toEqual([{ path: 'a.txt', status: 'modified' }])
    expect(read(repo, 'a.txt')).toBe('one\nBOTH\nthree\n')
  })

  it('keeps CRLF files CRLF even when the editor hands back LF', async () => {
    const { repo } = diverged(
      { 'w.txt': 'one\r\ntwo\r\nthree\r\n', 'u.txt': 'one\ntwo\nthree\n' },
      { 'w.txt': 'one\r\nMAIN\r\nthree\r\n', 'u.txt': 'one\nMAIN\nthree\n' },
      { 'w.txt': 'one\r\nOTHER\r\nthree\r\n', 'u.txt': 'one\nOTHER\nthree\n' }
    )
    await failMerge(repo)
    // A <textarea> normalises every line break to LF.
    await api.resolveConflict(repo, 'w.txt', 'one\nMAIN\nOTHER\nthree\n')
    expect(read(repo, 'w.txt')).toBe('one\r\nMAIN\r\nOTHER\r\nthree\r\n')
    // Already-CRLF text is not doubled, and a missing final newline stays missing.
    sh(repo, 'checkout', '--merge', '--', 'w.txt')
    await api.resolveConflict(repo, 'w.txt', 'one\r\nMAIN\nthree')
    expect(read(repo, 'w.txt')).toBe('one\r\nMAIN\r\nthree')
    expect(sh(repo, 'ls-files', '--eol', 'w.txt')).toMatch(/i\/crlf\s+w\/crlf/)

    await api.resolveConflict(repo, 'u.txt', 'one\nMAIN\nOTHER\nthree\n')
    expect(read(repo, 'u.txt')).toBe('one\nMAIN\nOTHER\nthree\n')
    expect(await conflicted(repo)).toEqual([])
  })

  it('with core.autocrlf the worktree stays CRLF and the index LF', async () => {
    const { repo } = diverged(
      { 'a.txt': 'one\ntwo\nthree\n' },
      { 'a.txt': 'one\nMAIN\nthree\n' },
      { 'a.txt': 'one\nOTHER\nthree\n' },
      (r) => sh(r, 'config', 'core.autocrlf', 'true')
    )
    // Re-checkout so the worktree has the converted line endings.
    sh(repo, 'rm', '-q', '--cached', '-r', '.')
    sh(repo, 'reset', '-q', '--hard')
    expect(read(repo, 'a.txt')).toBe('one\r\nMAIN\r\nthree\r\n')
    await failMerge(repo)

    const file = await api.conflictFile(repo, 'a.txt')
    expect(file.ours).toBe('one\nMAIN\nthree\n')
    expect(file.merged).toContain('<<<<<<< HEAD\r\n')
    await api.resolveConflict(repo, 'a.txt', 'one\nMAIN\nOTHER\nthree\n')
    expect(read(repo, 'a.txt')).toBe('one\r\nMAIN\r\nOTHER\r\nthree\r\n')
    expect(sh(repo, 'ls-files', '--eol', 'a.txt')).toMatch(/i\/lf\s+w\/crlf/)
    expect(await conflicted(repo)).toEqual([])
  })

  it('keeps the executable bit', async () => {
    const { repo } = diverged(
      { 'run.sh': '#!/bin/sh\necho base\n' },
      { 'run.sh': '#!/bin/sh\necho main\n' },
      { 'run.sh': '#!/bin/sh\necho other\n' },
      (r) => {
        write(r, 'run.sh', '')
        chmodSync(join(r, 'run.sh'), 0o755)
      }
    )
    expect(sh(repo, 'ls-files', '-s', 'run.sh')).toMatch(/^100755 /)
    await failMerge(repo)
    await api.resolveConflict(repo, 'run.sh', '#!/bin/sh\necho both\n')
    expect(isExec(repo, 'run.sh')).toBe(true)
    expect(sh(repo, 'ls-files', '-s', 'run.sh')).toMatch(/^100755 \S+ 0\t/)
  })

  it('recreates a file missing from disk with the mode of the surviving side', async () => {
    const { repo } = diverged(
      { 'gone.sh': '#!/bin/sh\necho base\n' },
      { 'gone.sh': null },
      { 'gone.sh': '#!/bin/sh\necho other\n' },
      (r) => {
        write(r, 'gone.sh', '')
        chmodSync(join(r, 'gone.sh'), 0o755)
      }
    )
    await failMerge(repo)
    // The user (or a tool) removed the version git had left on disk.
    rmSync(join(repo, 'gone.sh'))
    await api.resolveConflict(repo, 'gone.sh', '#!/bin/sh\necho kept\n')
    expect(read(repo, 'gone.sh')).toBe('#!/bin/sh\necho kept\n')
    expect(isExec(repo, 'gone.sh')).toBe(true)
    expect(sh(repo, 'ls-files', '-s', 'gone.sh')).toMatch(/^100755 \S+ 0\t/)
  })

  it('never writes through a symlink that leaves the repository', async () => {
    const { repo } = diverged(
      { 'dir/a.txt': 'one\n' },
      { 'dir/a.txt': 'main\n' },
      { 'dir/a.txt': 'other\n' }
    )
    await failMerge(repo)
    const outside = tmpDir()
    write(outside, 'a.txt', 'untouched\n')
    renameSync(join(repo, 'dir'), join(repo, 'dir.bak'))
    symlinkSync(outside, join(repo, 'dir'))

    await expect(api.resolveConflict(repo, 'dir/a.txt', 'pwned\n')).rejects.toThrow(/outside the repository/)
    await expect(api.resolveWith(repo, 'dir/a.txt', 'ours')).rejects.toThrow(/outside the repository/)
    await expect(api.conflictFile(repo, 'dir/a.txt')).rejects.toThrow(/outside the repository/)
    expect(read(outside, 'a.txt')).toBe('untouched\n')
  })

  it('concurrent resolutions and stagings do not trip over index.lock', async () => {
    const names = Array.from({ length: 8 }, (_, i) => `f${i}.txt`)
    const files = (tag: string): Record<string, string> => Object.fromEntries(names.map((n) => [n, `${tag} ${n}\n`]))
    const { repo } = diverged(files('base'), files('main'), files('other'))
    await failMerge(repo)
    write(repo, 'extra.txt', 'x\n')
    await Promise.all([
      ...names.slice(0, 4).map((n) => api.resolveConflict(repo, n, `resolved ${n}\n`)),
      core.stage(repo, ['extra.txt']),
      ...names.slice(4).map((n, i) => api.resolveWith(repo, n, i % 2 ? 'ours' : 'theirs'))
    ])
    const st = await core.status(repo)
    expect(st.conflicted).toEqual([])
    expect(read(repo, 'f0.txt')).toBe('resolved f0.txt\n')
    expect(read(repo, 'f4.txt')).toBe('other f4.txt\n')
    expect(read(repo, 'f5.txt')).toBe('main f5.txt\n')
    tick()
    await core.continueOp(repo)
    expect((await core.status(repo)).inProgress).toBeNull()
  })
})

describe('resolveWith', () => {
  it('takes one whole side of a content conflict', async () => {
    const { repo } = diverged(
      { 'a.txt': 'one\n', 'b.txt': 'uno\n' },
      { 'a.txt': 'main a\n', 'b.txt': 'main b\n' },
      { 'a.txt': 'other a\n', 'b.txt': 'other b\n' }
    )
    await failMerge(repo)
    await api.resolveWith(repo, 'a.txt', 'ours')
    await api.resolveWith(repo, 'b.txt', 'theirs')
    expect(read(repo, 'a.txt')).toBe('main a\n')
    expect(read(repo, 'b.txt')).toBe('other b\n')
    const st = await core.status(repo)
    expect(st.conflicted).toEqual([])
    // "ours" leaves nothing to commit for that file; "theirs" is a staged change.
    expect(st.staged).toEqual([{ path: 'b.txt', status: 'modified' }])
    tick()
    await core.continueOp(repo)
    expect((await core.status(repo)).inProgress).toBeNull()
  })

  it('delete/modify: keeping the deleting side removes the file, the other keeps it', async () => {
    const make = (): Fixture =>
      diverged(
        { 'gone-theirs.txt': 'x\n', 'gone-ours.txt': 'y\n' },
        { 'gone-theirs.txt': 'x\nmain edit\n', 'gone-ours.txt': null },
        { 'gone-theirs.txt': null, 'gone-ours.txt': 'y\nother edit\n' }
      )

    // Take "theirs" everywhere: one deletion, one surviving file.
    let { repo } = make()
    await failMerge(repo)
    await api.resolveWith(repo, 'gone-theirs.txt', 'theirs')
    await api.resolveWith(repo, 'gone-ours.txt', 'theirs')
    expect(existsSync(join(repo, 'gone-theirs.txt'))).toBe(false)
    expect(read(repo, 'gone-ours.txt')).toBe('y\nother edit\n')
    let st = await core.status(repo)
    expect(st.conflicted).toEqual([])
    expect(st.staged.sort((a, b) => a.path.localeCompare(b.path))).toEqual([
      { path: 'gone-ours.txt', status: 'added' },
      { path: 'gone-theirs.txt', status: 'deleted' }
    ])
    tick()
    await core.continueOp(repo)
    expect(sh(repo, 'ls-files')).toBe('gone-ours.txt')

    // Take "ours" everywhere: the mirror image.
    ;({ repo } = make())
    await failMerge(repo)
    await api.resolveWith(repo, 'gone-theirs.txt', 'ours')
    await api.resolveWith(repo, 'gone-ours.txt', 'ours')
    expect(read(repo, 'gone-theirs.txt')).toBe('x\nmain edit\n')
    expect(existsSync(join(repo, 'gone-ours.txt'))).toBe(false)
    st = await core.status(repo)
    expect(st.conflicted).toEqual([])
    expect(st.staged).toEqual([])
    tick()
    await core.continueOp(repo)
    expect(sh(repo, 'ls-files')).toBe('gone-theirs.txt')
  })

  it('binary files: the chosen side lands byte for byte', async () => {
    const bin = (n: number): Buffer => Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, n, 0xff, 0xfe, 13, 10])
    const { repo } = diverged({ 'img.png': bin(1), 'pic.png': bin(1) }, { 'img.png': bin(2), 'pic.png': bin(2) }, { 'img.png': bin(3), 'pic.png': bin(3) })
    await failMerge(repo)
    await api.resolveWith(repo, 'img.png', 'theirs')
    await api.resolveWith(repo, 'pic.png', 'ours')
    expect(readFileSync(join(repo, 'img.png')).equals(bin(3))).toBe(true)
    expect(readFileSync(join(repo, 'pic.png')).equals(bin(2))).toBe(true)
    expect(await conflicted(repo)).toEqual([])
  })

  it('add/add and the executable bit of the chosen side', async () => {
    const { repo } = diverged({ 'seed.txt': 's\n' }, { 'tool.sh': 'main\n' }, { 'tool.sh': 'other\n' })
    // Make only the incoming version executable.
    sh(repo, 'checkout', '-q', 'other')
    chmodSync(join(repo, 'tool.sh'), 0o755)
    tick()
    sh(repo, 'commit', '-q', '-am', 'exec')
    sh(repo, 'checkout', '-q', 'main')
    await failMerge(repo)
    await api.resolveWith(repo, 'tool.sh', 'theirs')
    expect(read(repo, 'tool.sh')).toBe('other\n')
    expect(isExec(repo, 'tool.sh')).toBe(true)
    expect(sh(repo, 'ls-files', '-s', 'tool.sh')).toMatch(/^100755 \S+ 0\t/)
  })

  it('rename/rename: every path of the conflict can be settled', async () => {
    const body = Array.from({ length: 12 }, (_, i) => `line ${i}`).join('\n') + '\n'
    const repo = emptyRepo()
    commitFiles(repo, { 'orig.txt': body }, 'base')
    sh(repo, 'checkout', '-q', '-b', 'other')
    sh(repo, 'mv', 'orig.txt', 'theirs-name.txt')
    tick()
    sh(repo, 'commit', '-q', '-m', 'other rename')
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'mv', 'orig.txt', 'ours-name.txt')
    tick()
    sh(repo, 'commit', '-q', '-m', 'main rename')
    await failMerge(repo)
    expect(await conflicted(repo)).toEqual(['orig.txt', 'ours-name.txt', 'theirs-name.txt'])

    expect(await api.conflictFile(repo, 'orig.txt')).toMatchObject({ base: body, ours: null, theirs: null })
    expect(await api.conflictFile(repo, 'ours-name.txt')).toMatchObject({ base: null, ours: body, theirs: null })

    await api.resolveWith(repo, 'orig.txt', 'ours') // both sides dropped the old name
    await api.resolveWith(repo, 'ours-name.txt', 'ours') // keep our name
    await api.resolveWith(repo, 'theirs-name.txt', 'ours') // which does not have theirs
    expect(await conflicted(repo)).toEqual([])
    tick()
    await core.continueOp(repo)
    expect(sh(repo, 'ls-files')).toBe('ours-name.txt')
  })
})

describe('line-ending helpers', () => {
  it('dominantEol', () => {
    expect(dominantEol('')).toBe('\n')
    expect(dominantEol('a\nb\n')).toBe('\n')
    expect(dominantEol('a\r\nb\r\n')).toBe('\r\n')
    expect(dominantEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(dominantEol('a\r\nb\nc\n')).toBe('\n')
    expect(dominantEol('no newline')).toBe('\n')
  })

  it('toCrlf', () => {
    expect(toCrlf('a\nb\r\nc')).toBe('a\r\nb\r\nc')
    expect(toCrlf('')).toBe('')
  })
})
