// What the DiffView / staging area do, end to end, against the real git
// backend (src/main/git/core.ts, which has no Electron imports) and real
// temporary repositories: api.diff -> parseDiff -> buildHunkPatch -> api.applyPatch.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreApi as api } from '../../../../main/git/core'
import { findDiffFile, parseDiff, type DiffFile } from './parseDiff'
import { buildHunkPatch } from './patch'
import { buildRows } from './rows'

const roots: string[] = []
const saved: Record<string, string | undefined> = {}
const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

const tmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gitkroken-ui-')))
  roots.push(dir)
  return dir
}
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
const write = (repo: string, file: string, content: string | Buffer): void => {
  mkdirSync(dirname(join(repo, file)), { recursive: true })
  writeFileSync(join(repo, file), content)
}
const read = (repo: string, file: string): string => readFileSync(join(repo, file), 'utf8')
const numbered = (n: number, edit: (line: string, no: number) => string | string[] | null = (l) => l): string =>
  Array.from({ length: n }, (_, i) => edit(`line ${i + 1}`, i + 1))
    .flat()
    .filter((l): l is string => l !== null)
    .join('\n') + '\n'

function newRepo(files: Record<string, string>): string {
  const repo = tmp()
  sh(repo, 'init', '-q', '-b', 'main')
  for (const [file, content] of Object.entries(files)) write(repo, file, content)
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', 'init')
  return repo
}

/** Same as DiffView: fetch, parse, pick the entry of the selected path */
async function load(repo: string, req: Parameters<typeof api.diff>[1]): Promise<DiffFile | null> {
  return findDiffFile(parseDiff(await api.diff(repo, req)), req.path)
}

beforeAll(() => {
  const home = tmp()
  for (const [k, v] of Object.entries({ ...ENV, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'none') })) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const EDIT = (l: string, no: number) =>
  no === 4 ? [l, 'added A', 'added B'] : no === 40 ? 'line forty' : no === 75 ? null : l
const only = (which: number) =>
  numbered(80, (l, no) => ((no === 4 ? 0 : no === 40 ? 1 : no === 75 ? 2 : -1) === which ? EDIT(l, no) : l))

describe('hunk staging through the backend', () => {
  it('Stage Hunk / Unstage Hunk / Discard Hunk', async () => {
    const repo = newRepo({ 'src/f.txt': numbered(80) })
    write(repo, 'src/f.txt', numbered(80, EDIT))

    // Stage Hunk (the middle one)
    let unstaged = (await load(repo, { path: 'src/f.txt' }))!
    expect(unstaged.hunks).toHaveLength(3)
    await api.applyPatch(repo, buildHunkPatch(unstaged, 1), { cached: true })
    expect(sh(repo, 'show', ':src/f.txt')).toBe(only(1))

    let status = await api.status(repo)
    expect(status.staged.map((f) => f.path)).toEqual(['src/f.txt'])
    expect(status.unstaged.map((f) => f.path)).toEqual(['src/f.txt'])

    // The view refetches after the status change: two hunks left on this side
    unstaged = (await load(repo, { path: 'src/f.txt' }))!
    expect(unstaged.hunks).toHaveLength(2)

    // Discard Hunk (the deletion near the end)
    await api.applyPatch(repo, buildHunkPatch(unstaged, 1, { reverse: true }), { reverse: true })
    expect(read(repo, 'src/f.txt')).toBe(numbered(80, (l, no) => (no === 75 ? l : EDIT(l, no))))
    expect(sh(repo, 'show', ':src/f.txt')).toBe(only(1))

    // Unstage Hunk
    const staged = (await load(repo, { path: 'src/f.txt', staged: true }))!
    expect(staged.hunks).toHaveLength(1)
    await api.applyPatch(repo, buildHunkPatch(staged, 0, { reverse: true }), { cached: true, reverse: true })
    status = await api.status(repo)
    expect(status.staged).toEqual([])
    expect(status.unstaged.map((f) => f.path)).toEqual(['src/f.txt'])
    expect((await load(repo, { path: 'src/f.txt', staged: true }))).toBeNull()
  })

  it('stages hunks one by one until nothing is left unstaged', async () => {
    const repo = newRepo({ 'f.txt': numbered(80) })
    write(repo, 'f.txt', numbered(80, EDIT))
    for (let i = 0; i < 3; i++) {
      const file = (await load(repo, { path: 'f.txt' }))!
      await api.applyPatch(repo, buildHunkPatch(file, file.hunks.length - 1), { cached: true })
    }
    expect(await load(repo, { path: 'f.txt' })).toBeNull()
    expect(sh(repo, 'show', ':f.txt')).toBe(numbered(80, EDIT))
    expect((await api.status(repo)).unstaged).toEqual([])
  })

  it('unstages one hunk of a staged rename and keeps the rename', async () => {
    const repo = newRepo({ 'old name.txt': numbered(50) })
    sh(repo, 'mv', 'old name.txt', 'new name.txt')
    write(repo, 'new name.txt', numbered(50, (l, no) => (no === 5 ? 'five' : no === 45 ? 'forty-five' : l)))
    sh(repo, 'add', '-A')

    const [entry] = (await api.status(repo)).staged
    expect(entry).toMatchObject({ status: 'renamed', path: 'new name.txt', oldPath: 'old name.txt' })
    const file = (await load(repo, { path: entry.path, oldPath: entry.oldPath, staged: true }))!
    expect(file).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', newPath: 'new name.txt' })
    expect(file.hunks).toHaveLength(2)

    await api.applyPatch(repo, buildHunkPatch(file, 0, { reverse: true }), { cached: true, reverse: true })
    expect(sh(repo, 'show', ':new name.txt')).toBe(numbered(50, (l, no) => (no === 45 ? 'forty-five' : l)))
    expect((await api.status(repo)).staged[0]).toMatchObject({ status: 'renamed', path: 'new name.txt' })
  })

  it('handles files without a trailing newline and CRLF files', async () => {
    const repo = newRepo({ 'n.txt': 'one\ntwo\nthree', 'w.txt': 'a\r\nb\r\nc\r\n' })
    write(repo, 'n.txt', 'one\ntwo\nTHREE')
    write(repo, 'w.txt', 'a\r\nB\r\nc\r\n')
    const n = (await load(repo, { path: 'n.txt' }))!
    await api.applyPatch(repo, buildHunkPatch(n, 0), { cached: true })
    expect(sh(repo, 'show', ':n.txt')).toBe('one\ntwo\nTHREE')
    const w = (await load(repo, { path: 'w.txt' }))!
    expect(w.hunks[0].lines.find((l) => l.type === 'add')?.text).toBe('B\r')
    await api.applyPatch(repo, buildHunkPatch(w, 0), { cached: true })
    expect(sh(repo, 'show', ':w.txt')).toBe('a\r\nB\r\nc\r\n')
    await api.applyPatch(repo, buildHunkPatch((await load(repo, { path: 'w.txt', staged: true }))!, 0, { reverse: true }), {
      cached: true,
      reverse: true
    })
    expect(sh(repo, 'show', ':w.txt')).toBe('a\r\nb\r\nc\r\n')
  })
})

describe('what the backend returns for each kind of file', () => {
  it('untracked text, untracked binary and empty files', async () => {
    const repo = newRepo({ 'a.txt': 'a\n' })
    write(repo, 'docs/nuevo archivo.md', '# título\n\ntexto\n')
    write(repo, 'img.bin', Buffer.from([0, 1, 2, 3, 0, 255, 254]))
    write(repo, 'empty.txt', '')

    const text = (await load(repo, { path: 'docs/nuevo archivo.md', untracked: true }))!
    expect(text).toMatchObject({ status: 'added', newPath: 'docs/nuevo archivo.md', oldPath: null, binary: false })
    expect(text.hunks[0].lines.map((l) => [l.type, l.newNo, l.text])).toEqual([
      ['add', 1, '# título'],
      ['add', 2, ''],
      ['add', 3, 'texto']
    ])

    const bin = (await load(repo, { path: 'img.bin', untracked: true }))!
    expect(bin).toMatchObject({ binary: true, status: 'added' })
    expect(bin.hunks).toHaveLength(0)

    const empty = await load(repo, { path: 'empty.txt', untracked: true })
    expect(empty === null || empty.hunks.length === 0).toBe(true)
  })

  it('deleted, mode-only and commit diffs', async () => {
    const repo = newRepo({ 'gone.txt': 'x\ny\n', 'run.sh': 'echo\n', 'keep.txt': numbered(30) })
    rmSync(join(repo, 'gone.txt'))
    const gone = (await load(repo, { path: 'gone.txt' }))!
    expect(gone).toMatchObject({ status: 'deleted', oldPath: 'gone.txt', newPath: null, deletions: 2 })
    // Stage Hunk on a deletion stages the deletion
    await api.applyPatch(repo, buildHunkPatch(gone, 0), { cached: true })
    expect((await api.status(repo)).staged).toEqual([{ path: 'gone.txt', status: 'deleted' }])

    sh(repo, 'mv', 'keep.txt', 'kept.txt')
    write(repo, 'kept.txt', numbered(30, (l, no) => (no === 10 ? 'ten' : l)))
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'second')
    const head = sh(repo, 'rev-parse', 'HEAD').trim()
    const details = await api.commitDetails(repo, head)
    const renamed = details.files.find((f) => f.path === 'kept.txt')!
    expect(renamed).toMatchObject({ status: 'renamed', oldPath: 'keep.txt' })

    const inCommit = (await load(repo, { path: renamed.path, oldPath: renamed.oldPath, commit: head }))!
    expect(inCommit).toMatchObject({ status: 'renamed', oldPath: 'keep.txt', newPath: 'kept.txt', additions: 1, deletions: 1 })
    const removed = (await load(repo, { path: 'gone.txt', commit: head }))!
    expect(removed.status).toBe('deleted')

    // every view mode can lay the commit diff out
    expect(buildRows(inCommit, 'hunk')[0].kind).toBe('hunk')
    expect(buildRows(inCommit, 'inline')[0]).toMatchObject({ kind: 'gap', skipped: 6 })
    expect(buildRows(inCommit, 'split').filter((r) => r.kind === 'split' && r.left && r.right && r.left !== r.right)).toHaveLength(1)
  })

  it('conflicted files come back as a combined diff (no hunk actions)', async () => {
    const repo = newRepo({ 'c.txt': 'one\ntwo\nthree\n' })
    sh(repo, 'checkout', '-q', '-b', 'other')
    write(repo, 'c.txt', 'one\nTHEIRS\nthree\n')
    sh(repo, 'commit', '-q', '-am', 'theirs')
    sh(repo, 'checkout', '-q', 'main')
    write(repo, 'c.txt', 'one\nOURS\nthree\n')
    sh(repo, 'commit', '-q', '-am', 'ours')
    expect(() => sh(repo, 'merge', 'other')).toThrow()

    const status = await api.status(repo)
    expect(status.conflicted.map((f) => f.path)).toEqual(['c.txt'])
    const file = (await load(repo, { path: 'c.txt' }))!
    expect(file.combined).toBe(true)
    expect(file.newPath).toBe('c.txt')
    const texts = file.hunks.flatMap((h) => h.lines.map((l) => l.text))
    expect(texts).toContain('<<<<<<< HEAD')
    expect(texts).toContain('OURS')
    expect(texts).toContain('THEIRS')
    expect(() => buildHunkPatch(file, 0)).toThrow()
  })
})

describe('discarding from the staging area', () => {
  it('a staged rename: unstage both names, then discard both', async () => {
    const repo = newRepo({ 'a.txt': numbered(20), 'b.txt': 'b\n' })
    sh(repo, 'mv', 'a.txt', 'renamed.txt')
    write(repo, 'renamed.txt', numbered(20, (l, no) => (no === 3 ? 'three' : l)))
    sh(repo, 'add', '-A')
    const [entry] = (await api.status(repo)).staged
    const paths = [entry.path, entry.oldPath!]
    await api.unstage(repo, paths)
    await api.discard(repo, paths)
    const after = await api.status(repo)
    expect([...after.staged, ...after.unstaged, ...after.conflicted]).toEqual([])
    expect(read(repo, 'a.txt')).toBe(numbered(20))
  })
})
