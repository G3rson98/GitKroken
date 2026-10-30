// Blame, file history, file content and commit search against real temporary repositories.
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  historyApi as api,
  isUncommitted,
  mergeHits,
  parseBlame,
  parseFileHistory,
  UNCOMMITTED_HASH,
  type BlameEntry,
  type FileHistoryItem
} from '../history'
import { coreApi } from '../core'
import { cleanupAll, commitFiles, emptyRepo, lines, seededRepo, setupGitEnv, sh, tick, write } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

/** Commits as another author (the helpers always commit as "Test User"). */
function commitAs(repo: string, name: string, email: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) write(repo, file, content)
  tick()
  sh(repo, 'add', '-A')
  sh(repo, '-c', `user.name=${name}`, '-c', `user.email=${email}`, 'commit', '-q', '-m', message)
  return sh(repo, 'rev-parse', 'HEAD')
}

const statusOf = (repo: string): string => sh(repo, 'status', '--porcelain=v1', '--untracked-files=all')

// --- blame -----------------------------------------------------------------------

describe('blame', () => {
  it('attributes every line to the commit that last changed it', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'f.txt': 'one\ntwo\nthree\n' }, 'add f')
    const b = commitAs(repo, 'Ada Lovelace', 'ada@example.com', { 'f.txt': 'one\nTWO\nthree\nfour\n' }, 'edit two, add four')

    const out = await api.blame(repo, 'f.txt')
    expect(out.map((l) => [l.lineNo, l.hash, l.text])).toEqual([
      [1, a, 'one'],
      [2, b, 'TWO'],
      [3, a, 'three'],
      [4, b, 'four']
    ])
    expect(out[0]).toMatchObject({ author: 'Test User', summary: 'add f' })
    expect(out[1]).toMatchObject({ author: 'Ada Lovelace', summary: 'edit two, add four' })
    // author time is what the helpers stamp on every commit
    expect(out[1]!.date).toBe(Number(sh(repo, 'log', '-1', '--format=%at', b)))
    expect(out[0]!.date).toBeLessThan(out[1]!.date)
  })

  it('reports lines that are not committed yet with the all-zero hash', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'f.txt': 'one\ntwo\n' }, 'add f')
    write(repo, 'f.txt', 'one\nchanged\ntwo\nextra\n')

    const out = (await api.blame(repo, 'f.txt')) as BlameEntry[]
    expect(out.map((l) => l.text)).toEqual(['one', 'changed', 'two', 'extra'])
    expect(out.map((l) => isUncommitted(l.hash))).toEqual([false, true, false, true])
    expect(out[1]).toMatchObject({ hash: UNCOMMITTED_HASH, author: 'Not Committed Yet', summary: 'Uncommitted changes', lineNo: 2 })
    expect(out[0]!.hash).toBe(a)
    // "before the uncommitted changes" is HEAD
    expect(out[1]!.previous).toEqual({ hash: a, path: 'f.txt' })

    // ...while blaming a revision ignores the working tree
    const atHead = await api.blame(repo, 'f.txt', 'HEAD')
    expect(atHead.map((l) => l.text)).toEqual(['one', 'two'])
    expect(atHead.every((l) => l.hash === a)).toBe(true)
  })

  it('blames a file that is staged but was never committed', async () => {
    const { repo } = seededRepo()
    write(repo, 'new.txt', 'x\ny\n')
    sh(repo, 'add', 'new.txt')
    const out = await api.blame(repo, 'new.txt')
    expect(out.map((l) => l.text)).toEqual(['x', 'y'])
    expect(out.every((l) => isUncommitted(l.hash))).toBe(true)
  })

  it('blames the given revision', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'f.txt': 'one\ntwo\n' }, 'v1')
    const b = commitFiles(repo, { 'f.txt': 'one\n2\n' }, 'v2')
    commitFiles(repo, { 'f.txt': 'uno\n2\n' }, 'v3')

    const out = await api.blame(repo, 'f.txt', b)
    expect(out.map((l) => [l.hash, l.text])).toEqual([
      [a, 'one'],
      [b, '2']
    ])
    expect((await api.blame(repo, 'f.txt', `${b}^`)).map((l) => l.text)).toEqual(['one', 'two'])
    expect((await api.blame(repo, 'f.txt', a.slice(0, 8))).map((l) => l.hash)).toEqual([a, a])
  })

  it('follows a renamed file and says where to continue before each commit', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'old name.txt': lines(6) }, 'add')
    sh(repo, 'mv', 'old name.txt', 'new name.txt')
    const b = commitFiles(repo, { 'new name.txt': lines(6) + 'tail\n' }, 'rename and append')

    const out = (await api.blame(repo, 'new name.txt')) as BlameEntry[]
    expect(out).toHaveLength(7)
    expect(out.slice(0, 6).every((l) => l.hash === a)).toBe(true)
    expect(out[6]).toMatchObject({ hash: b, text: 'tail', lineNo: 7 })
    // lines from before the rename know the name the file had back then
    expect(out[0]!.path).toBe('old name.txt')
    expect(out[0]!.previous).toBeUndefined() // `a` created the file
    expect(out[6]!.path).toBe('new name.txt')
    expect(out[6]!.previous).toEqual({ hash: a, path: 'old name.txt' })

    // the pair in `previous` is directly usable for "blame before this commit"
    const before = await api.blame(repo, out[6]!.previous!.path, out[6]!.previous!.hash)
    expect(before.map((l) => l.text)).toEqual(lines(6).trimEnd().split('\n'))
  })

  it('handles CRLF files and a missing final newline', async () => {
    const repo = emptyRepo()
    sh(repo, 'config', 'core.autocrlf', 'false')
    const a = commitFiles(repo, { 'crlf.txt': 'one\r\ntwo\r\nthree' }, 'crlf')
    const out = await api.blame(repo, 'crlf.txt')
    expect(out.map((l) => l.text)).toEqual(['one', 'two', 'three'])
    expect(out.map((l) => l.lineNo)).toEqual([1, 2, 3])
    expect(out.every((l) => l.hash === a)).toBe(true)

    commitFiles(repo, { 'crlf.txt': 'one\r\ntwo\r\nthree\r\nfour' }, 'more')
    expect((await api.blame(repo, 'crlf.txt')).map((l) => l.text)).toEqual(['one', 'two', 'three', 'four'])
  })

  it('keeps content that looks like blame headers, tabs and empty lines intact', async () => {
    const repo = emptyRepo()
    const content = [
      'author Mallory',
      '',
      '\tindented with a tab',
      `${'a'.repeat(40)} 1 1 1`,
      'filename other.txt',
      '  trailing spaces  ',
      'ñandú 日本語'
    ]
    commitFiles(repo, { 'weird.txt': content.join('\n') + '\n' }, 'weird')
    const out = await api.blame(repo, 'weird.txt')
    expect(out.map((l) => l.text)).toEqual(content)
    expect(out.every((l) => l.author === 'Test User' && l.summary === 'weird')).toBe(true)
  })

  it('works for paths with spaces, brackets and non-ASCII characters', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'dir with space/[id] añadir *.txt': 'x\n', 'dir with space/a.txt': 'no\n' }, 'odd names')
    const out = await api.blame(repo, 'dir with space/[id] añadir *.txt')
    expect(out).toEqual([{ hash: a, author: 'Test User', date: expect.any(Number), summary: 'odd names', lineNo: 1, text: 'x', path: 'dir with space/[id] añadir *.txt' }])
  })

  it('rejects binary files, unknown paths and unknown revisions', async () => {
    const repo = emptyRepo()
    write(repo, 'text.txt', 'hello\n')
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2, 3, 0x0a, 0, 0, 0x0a]))
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'files')

    await expect(api.blame(repo, 'bin.dat')).rejects.toThrow(/binary file/)
    await expect(api.blame(repo, 'nope.txt')).rejects.toThrow(/no such path/)
    await expect(api.blame(repo, 'text.txt', 'no-such-rev')).rejects.toThrow(/bad revision/)
    await expect(api.blame(repo, 'text.txt', '--output=/tmp/x')).rejects.toThrow(/must not start with "-"/)
    await expect(api.blame(repo, '')).rejects.toThrow(/Invalid path/)
  })

  it('an empty file has no lines', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'empty.txt': '' }, 'empty')
    expect(await api.blame(repo, 'empty.txt')).toEqual([])
  })

  it('blames a 10 000 line file', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'big.txt': lines(10_000) }, 'big')
    const edited = lines(10_000).split('\n')
    edited[4999] = 'changed in the middle'
    const b = commitFiles(repo, { 'big.txt': edited.join('\n') }, 'touch the middle')

    const out = await api.blame(repo, 'big.txt')
    expect(out).toHaveLength(10_000)
    expect(out[4999]).toMatchObject({ hash: b, lineNo: 5000, text: 'changed in the middle' })
    expect(out.filter((l) => l.hash === a)).toHaveLength(9_999)
    expect(out[9999]).toMatchObject({ hash: a, lineNo: 10_000, text: 'line 10000' })
  })

  it('never writes to the repository', async () => {
    const { repo } = seededRepo()
    write(repo, 'a.txt', 'one\nlocal\n')
    const before = statusOf(repo)
    const head = sh(repo, 'rev-parse', 'HEAD')
    await api.blame(repo, 'a.txt')
    await api.fileHistory(repo, 'a.txt')
    await api.fileAt(repo, 'a.txt', 'HEAD')
    await api.searchCommits(repo, 'first')
    expect(statusOf(repo)).toBe(before)
    expect(sh(repo, 'rev-parse', 'HEAD')).toBe(head)
  })
})

describe('parseBlame', () => {
  const H1 = '1'.repeat(40)
  const H2 = '2'.repeat(40)

  it('reuses the commit data announced the first time a hash appears', () => {
    const out = [
      `${H1} 1 1 2`,
      'author Ada',
      'author-mail <ada@example.com>',
      'author-time 100',
      'author-tz +0000',
      'committer Bob',
      'committer-time 999',
      'summary first',
      'boundary',
      'filename a.txt',
      '\tone',
      `${H1} 2 2`,
      '\ttwo',
      `${H2} 3 3 1`,
      'author Bob',
      'author-time 200',
      'summary second: with colon',
      `previous ${H1} old name.txt`,
      'filename "tab\\there.txt"',
      '\t',
      `${H1} 3 4 1`,
      '\tfour\r',
      ''
    ].join('\n')
    expect(parseBlame(out)).toEqual([
      { hash: H1, author: 'Ada', date: 100, summary: 'first', lineNo: 1, text: 'one', path: 'a.txt' },
      { hash: H1, author: 'Ada', date: 100, summary: 'first', lineNo: 2, text: 'two', path: 'a.txt' },
      {
        hash: H2,
        author: 'Bob',
        date: 200,
        summary: 'second: with colon',
        lineNo: 3,
        text: '',
        path: 'tab\there.txt',
        previous: { hash: H1, path: 'old name.txt' }
      },
      { hash: H1, author: 'Ada', date: 100, summary: 'first', lineNo: 4, text: 'four', path: 'a.txt' }
    ])
  })

  it('tolerates empty and truncated output', () => {
    expect(parseBlame('')).toEqual([])
    expect(parseBlame(`${H1} 1 1 1\nauthor Ada\n`)).toEqual([])
  })
})

// --- file history ----------------------------------------------------------------

describe('fileHistory', () => {
  /** a.txt -> b.txt -> c.txt with edits in between; other files change too */
  function renamedRepo() {
    const repo = emptyRepo()
    const c1 = commitFiles(repo, { 'a.txt': lines(8), 'other.txt': 'x\n' }, 'add a')
    const c2 = commitFiles(repo, { 'a.txt': lines(8) + 'second\n' }, 'edit a')
    const noise1 = commitFiles(repo, { 'other.txt': 'y\n' }, 'unrelated 1')
    sh(repo, 'mv', 'a.txt', 'b.txt')
    const c3 = commitFiles(repo, {}, 'rename a to b')
    const c4 = commitFiles(repo, { 'b.txt': lines(8) + 'second\nthird\n' }, 'edit b')
    const noise2 = commitFiles(repo, { 'other.txt': 'z\n' }, 'unrelated 2')
    mkdirSync(join(repo, 'dir'))
    sh(repo, 'mv', 'b.txt', 'dir/c.txt')
    const c5 = commitFiles(repo, { 'dir/c.txt': lines(8) + 'second\nthird\nfourth\n' }, 'rename b to c and edit')
    const c6 = commitFiles(repo, { 'dir/c.txt': lines(8) + 'second\nthird\nfourth\nfifth\n' }, 'edit c')
    return { repo, c1, c2, c3, c4, c5, c6, noise1, noise2 }
  }

  it('follows renames and reports the path and status in each commit', async () => {
    const r = renamedRepo()
    const out = (await api.fileHistory(r.repo, 'dir/c.txt')) as FileHistoryItem[]
    expect(out.map((e) => [e.commit.hash, e.path, e.status, e.oldPath])).toEqual([
      [r.c6, 'dir/c.txt', 'modified', undefined],
      [r.c5, 'dir/c.txt', 'renamed', 'b.txt'],
      [r.c4, 'b.txt', 'modified', undefined],
      [r.c3, 'b.txt', 'renamed', 'a.txt'],
      [r.c2, 'a.txt', 'modified', undefined],
      [r.c1, 'a.txt', 'added', undefined]
    ])
    // full commit objects, as in the log
    expect(out[0]!.commit).toMatchObject({ subject: 'edit c', author: 'Test User', email: 'test@example.com', parents: [r.c5], body: '' })
    expect(out[5]!.commit.parents).toEqual([])
    // the entry is exactly what `diff` needs to show the change of that commit
    const diff = await coreApi.diff(r.repo, { path: out[1]!.path, oldPath: out[1]!.oldPath, commit: out[1]!.commit.hash })
    expect(diff).toContain('rename from b.txt')
    expect(diff).toContain('+fourth')
  })

  it('pages without losing the commits before a rename', async () => {
    const r = renamedRepo()
    const all = [r.c6, r.c5, r.c4, r.c3, r.c2, r.c1]
    const page = async (limit: number, skip: number) =>
      (await api.fileHistory(r.repo, 'dir/c.txt', { limit, skip })).map((e) => `${e.commit.hash} ${e.path}`)
    const whole = (await api.fileHistory(r.repo, 'dir/c.txt')).map((e) => `${e.commit.hash} ${e.path}`)

    expect((await page(2, 0)).map((s) => s.slice(0, 40))).toEqual(all.slice(0, 2))
    // both renames are inside the skipped part: `git log --follow --skip` returns nothing here
    expect(await page(2, 4)).toEqual(whole.slice(4, 6))
    expect(await page(3, 2)).toEqual(whole.slice(2, 5))
    expect([...(await page(4, 0)), ...(await page(4, 4))]).toEqual(whole)
    expect(await page(10, 6)).toEqual([])
    expect(await page(0, 0)).toEqual([])
    expect((await api.fileHistory(r.repo, 'dir/c.txt', { skip: 5 })).map((e) => e.commit.hash)).toEqual([r.c1])
  })

  it('includes the commit that deleted the file', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'gone.txt': 'x\n', 'keep.txt': 'k\n' }, 'add')
    sh(repo, 'rm', '-q', 'gone.txt')
    const b = commitFiles(repo, {}, 'remove gone')
    const out = await api.fileHistory(repo, 'gone.txt')
    expect(out.map((e) => [e.commit.hash, e.path, e.status])).toEqual([
      [b, 'gone.txt', 'deleted'],
      [a, 'gone.txt', 'added']
    ])
  })

  it('keeps multi-line bodies and paths with spaces apart', async () => {
    const repo = emptyRepo()
    write(repo, 'my file.txt', 'one\n')
    tick()
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'subject line', '-m', 'body line 1\nbody line 2\n\nM\tnot-a-status.txt')
    const a = sh(repo, 'rev-parse', 'HEAD')
    const b = commitFiles(repo, { 'my file.txt': 'one\ntwo\n' }, 'second')
    const out = await api.fileHistory(repo, 'my file.txt')
    expect(out.map((e) => [e.commit.hash, e.path, e.status])).toEqual([
      [b, 'my file.txt', 'modified'],
      [a, 'my file.txt', 'added']
    ])
    expect(out[1]!.commit.subject).toBe('subject line')
    expect(out[1]!.commit.body).toBe('body line 1\nbody line 2\n\nM\tnot-a-status.txt')
  })

  it('reports a merge that changed the file relative to its first parent', async () => {
    const repo = emptyRepo()
    const base = commitFiles(repo, { 'f.txt': lines(10) }, 'base')
    sh(repo, 'checkout', '-q', '-b', 'side')
    const side = commitFiles(repo, { 'f.txt': lines(10) + 'side\n' }, 'side change')
    sh(repo, 'checkout', '-q', 'main')
    const top = commitFiles(repo, { 'f.txt': 'main\n' + lines(10) }, 'main change')
    tick()
    sh(repo, 'merge', '-q', '--no-edit', 'side')
    const merge = sh(repo, 'rev-parse', 'HEAD')

    const out = await api.fileHistory(repo, 'f.txt')
    const hashes = out.map((e) => e.commit.hash)
    expect(hashes).toContain(side)
    expect(hashes).toContain(top)
    expect(hashes[hashes.length - 1]).toBe(base)
    for (const e of out) expect(e.path).toBe('f.txt')
    const m = out.find((e) => e.commit.hash === merge)
    if (m) expect(m.status).toBe('modified')
  })

  it('falls back to every ref for a file that never existed in HEAD', async () => {
    const { repo } = seededRepo()
    sh(repo, 'checkout', '-q', '-b', 'feature')
    const f = commitFiles(repo, { 'only-here.txt': 'x\n' }, 'feature file')
    sh(repo, 'checkout', '-q', 'main')
    const out = await api.fileHistory(repo, 'only-here.txt')
    expect(out.map((e) => [e.commit.hash, e.path, e.status])).toEqual([[f, 'only-here.txt', 'added']])
    expect(await api.fileHistory(repo, 'never-existed.txt')).toEqual([])
  })

  it('is empty in a repository without commits and validates the path', async () => {
    const repo = emptyRepo()
    expect(await api.fileHistory(repo, 'a.txt')).toEqual([])
    await expect(api.fileHistory(repo, '')).rejects.toThrow(/Invalid path/)
  })

  it('does not treat the path as a glob', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'a.txt': '1\n', 'b.txt': '1\n' }, 'two files')
    const star = commitFiles(repo, { '*.txt': 'literal star\n' }, 'star file')
    commitFiles(repo, { 'a.txt': '2\n' }, 'edit a')
    expect((await api.fileHistory(repo, '*.txt')).map((e) => e.commit.hash)).toEqual([star])
  })
})

describe('parseFileHistory', () => {
  const H = (c: string) => c.repeat(40)
  const rec = (hash: string, subject: string, body: string, status: string[]) =>
    [hash, '', 'Ada', 'ada@example.com', '100', subject, body].join('\0') + '\0' + (status.length ? '\n' + status.join('\0') + '\0' : '')

  it('reads the name-status entry that follows each commit', () => {
    const out =
      rec(H('a'), 'edit', 'body\n', ['M', 'new.txt']) +
      rec(H('b'), 'rename', '', ['R087', 'old.txt', 'new.txt']) +
      rec(H('c'), 'merge without diff', '', []) +
      rec(H('d'), 'add', '', ['A', 'old.txt'])
    expect(parseFileHistory(out, 'new.txt').map((e) => [e.commit.hash, e.commit.subject, e.path, e.status, e.oldPath])).toEqual([
      [H('a'), 'edit', 'new.txt', 'modified', undefined],
      [H('b'), 'rename', 'new.txt', 'renamed', 'old.txt'],
      [H('c'), 'merge without diff', 'old.txt', 'modified', undefined],
      [H('d'), 'add', 'old.txt', 'added', undefined]
    ])
  })

  it('returns nothing for empty output', () => {
    expect(parseFileHistory('', 'a.txt')).toEqual([])
  })
})

// --- file content ----------------------------------------------------------------

describe('fileAt', () => {
  it('returns the content at a revision, or null when the file is not there', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'f.txt': 'v1\n', 'dir/x.txt': 'x\n' }, 'v1')
    sh(repo, 'mv', 'f.txt', 'g.txt')
    const b = commitFiles(repo, { 'g.txt': 'v2\r\nno newline' }, 'v2')
    write(repo, 'g.txt', 'uncommitted\n')

    expect(await api.fileAt(repo, 'f.txt', a)).toBe('v1\n')
    expect(await api.fileAt(repo, 'g.txt', a)).toBeNull()
    expect(await api.fileAt(repo, 'f.txt', b)).toBeNull()
    expect(await api.fileAt(repo, 'g.txt', b)).toBe('v2\r\nno newline')
    expect(await api.fileAt(repo, 'g.txt', 'HEAD')).toBe('v2\r\nno newline')
    expect(await api.fileAt(repo, 'f.txt', 'HEAD^')).toBe('v1\n')
    expect(await api.fileAt(repo, 'g.txt', 'main')).toBe('v2\r\nno newline')
    // a folder is not a file
    expect(await api.fileAt(repo, 'dir', 'HEAD')).toBeNull()
    expect(await api.fileAt(repo, 'dir/x.txt', 'HEAD')).toBe('x\n')
  })

  it('handles empty files and unusual names', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'empty.txt': '', 'a b/[x] ñ.txt': 'ñandú\n', 'a:b.txt': 'colon\n' }, 'files')
    expect(await api.fileAt(repo, 'empty.txt', 'HEAD')).toBe('')
    expect(await api.fileAt(repo, 'a b/[x] ñ.txt', 'HEAD')).toBe('ñandú\n')
    expect(await api.fileAt(repo, 'a:b.txt', 'HEAD')).toBe('colon\n')
  })

  it('rejects binary content, huge files and unknown revisions', async () => {
    const repo = emptyRepo()
    writeFileSync(join(repo, 'bin.dat'), Buffer.from([1, 2, 0, 3, 4]))
    writeFileSync(join(repo, 'huge.txt'), 'x'.repeat(1024).concat('\n').repeat(9 * 1024))
    write(repo, 'ok.txt', 'ok\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'files')

    await expect(api.fileAt(repo, 'bin.dat', 'HEAD')).rejects.toThrow(/binary file/)
    await expect(api.fileAt(repo, 'huge.txt', 'HEAD')).rejects.toThrow(/too large/)
    await expect(api.fileAt(repo, 'ok.txt', 'no-such-rev')).rejects.toThrow(/Revision not found/)
    await expect(api.fileAt(repo, 'ok.txt', '-p')).rejects.toThrow(/must not start with "-"/)
    await expect(api.fileAt(repo, 'ok.txt', '')).rejects.toThrow(/Missing revision/)
    expect(await api.fileAt(repo, 'ok.txt', 'HEAD')).toBe('ok\n')
  })
})

describe('listFiles', () => {
  it('lists the whole tree of a revision, not only what it changed', async () => {
    const repo = emptyRepo()
    const a = commitFiles(repo, { 'a.txt': 'a\n', 'src/b.ts': 'b\n', 'src/deep/c.ts': 'c\n' }, 'first')
    const b = commitFiles(repo, { 'a.txt': 'a2\n', 'a b/ñ [x].txt': 'n\n' }, 'second')
    sh(repo, 'rm', '-q', 'src/b.ts')
    commitFiles(repo, {}, 'remove b')
    write(repo, 'untracked.txt', 'u\n')

    expect(await api.listFiles(repo, a)).toEqual(['a.txt', 'src/b.ts', 'src/deep/c.ts'])
    expect(await api.listFiles(repo, b)).toEqual(['a b/ñ [x].txt', 'a.txt', 'src/b.ts', 'src/deep/c.ts'])
    expect(await api.listFiles(repo, 'HEAD')).toEqual(['a b/ñ [x].txt', 'a.txt', 'src/deep/c.ts'])
  })

  it('lists the root tree even when the repository is opened from a subfolder', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'top.txt': 't\n', 'sub/x.txt': 'x\n' }, 'files')
    expect(await api.listFiles(join(repo, 'sub'), 'HEAD')).toEqual(['sub/x.txt', 'top.txt'])
  })

  it('rejects unknown and option-like revisions', async () => {
    const repo = emptyRepo()
    commitFiles(repo, { 'a.txt': 'a\n' }, 'first')
    await expect(api.listFiles(repo, 'nope')).rejects.toThrow(/Revision not found/)
    await expect(api.listFiles(repo, '--all')).rejects.toThrow(/must not start with "-"/)
  })
})

// --- commit search ---------------------------------------------------------------

describe('searchCommits', () => {
  function searchRepo() {
    const repo = emptyRepo()
    const c: Record<string, string> = {}
    c.init = commitAs(repo, 'Ada Lovelace', 'ada@example.com', { 'a.txt': '1\n' }, 'Initial commit')
    c.login = commitAs(repo, 'Bob Stone', 'bob@corp.io', { 'a.txt': '2\n' }, 'Fix login redirect')
    c.special = commitAs(repo, 'Ada Lovelace', 'ada@example.com', { 'a.txt': '3\n' }, 'Handle a[0].b* and v1.0 (regex chars)')
    c.dots = commitAs(repo, 'Ada Lovelace', 'ada@example.com', { 'a.txt': '4\n' }, 'Bump to v1x0, see a0b')
    c.body = commitAs(repo, 'Carol [Bot]', 'carol+bot@corp.io', { 'a.txt': '5\n' }, 'Refactor parser\n\nMentions the LOGIN flow in the body')
    c.accent = commitAs(repo, 'Ñandú Pérez', 'nandu@example.com', { 'a.txt': '6\n' }, 'CORRECCIÓN de la sesión')
    c.bobName = commitAs(repo, 'Ada Lovelace', 'ada@example.com', { 'a.txt': '7\n' }, 'Thanks bob for the review')
    return { repo, c }
  }

  it('matches the message (subject and body), case-insensitively, newest first', async () => {
    const { repo, c } = searchRepo()
    expect(await api.searchCommits(repo, 'login')).toEqual([c.body, c.login])
    expect(await api.searchCommits(repo, 'LoGiN')).toEqual([c.body, c.login])
    expect(await api.searchCommits(repo, 'initial commit')).toEqual([c.init])
    expect(await api.searchCommits(repo, 'nothing matches this')).toEqual([])
  })

  it('matches the author name or email', async () => {
    const { repo, c } = searchRepo()
    expect(await api.searchCommits(repo, 'stone')).toEqual([c.login])
    expect(await api.searchCommits(repo, 'CORP.IO')).toEqual([c.body, c.login])
    expect(await api.searchCommits(repo, 'carol+bot@')).toEqual([c.body])
    // name and email as git shows them together
    expect(await api.searchCommits(repo, 'stone <bob@')).toEqual([c.login])
  })

  it('is message OR author, not AND', async () => {
    const { repo, c } = searchRepo()
    // "bob" is the author of one commit and appears in the message of another:
    // `git log --grep=bob --author=bob` (AND) would find neither.
    expect(sh(repo, 'log', '--all', '--format=%H', '-i', '--grep=bob', '--author=bob')).toBe('')
    expect(await api.searchCommits(repo, 'bob')).toEqual([c.bobName, c.login])
    // one commit matching on both sides is reported once
    const both = commitAs(repo, 'Lo Gin', 'login@example.com', { 'a.txt': '8\n' }, 'login again')
    expect(await api.searchCommits(repo, 'login')).toEqual([both, c.body, c.login])
  })

  it('treats the query literally, not as a regular expression', async () => {
    const { repo, c } = searchRepo()
    expect(await api.searchCommits(repo, 'a[0].b*')).toEqual([c.special])
    expect(await api.searchCommits(repo, '[')).toEqual([c.body, c.special]) // message "a[0]" and author "Carol [Bot]"
    expect(await api.searchCommits(repo, '[bot]')).toEqual([c.body])
    expect(await api.searchCommits(repo, 'v1.0')).toEqual([c.special]) // "." does not match the "x" of v1x0
    expect(await api.searchCommits(repo, 'a.b')).toEqual([]) // nor the "0" of a0b
    expect(await api.searchCommits(repo, 'b*')).toEqual([c.special])
    expect(await api.searchCommits(repo, '.*')).toEqual([])
    expect(await api.searchCommits(repo, '(regex')).toEqual([c.special])
    expect(await api.searchCommits(repo, '\\')).toEqual([])
    expect(await api.searchCommits(repo, '^Fix')).toEqual([])
    expect(await api.searchCommits(repo, 'redirect$')).toEqual([])
    // a query that looks like an option is still just text
    expect(await api.searchCommits(repo, '--all')).toEqual([])
    expect(await api.searchCommits(repo, '-v')).toEqual([])
  })

  it('folds the case of non-ASCII letters too', async () => {
    const { repo, c } = searchRepo()
    expect(await api.searchCommits(repo, 'CORRECCIÓN')).toEqual([c.accent])
    expect(await api.searchCommits(repo, 'Ñandú')).toEqual([c.accent])
    // Folding Ó/ó needs a UTF-8 locale in the C library; without one git only folds ASCII.
    const wanted = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
    let locales = ''
    try {
      locales = execFileSync('locale', ['-a'], { encoding: 'utf8' })
    } catch {
      /* no `locale` tool: assume the locale is missing */
    }
    if (!locales.split('\n').some((l) => l.trim().toLowerCase().replace('utf8', 'utf-8') === wanted.toLowerCase())) return
    expect(await api.searchCommits(repo, 'corrección')).toEqual([c.accent])
    expect(await api.searchCommits(repo, 'ñandú')).toEqual([c.accent])
    expect(await api.searchCommits(repo, 'ÑANDÚ')).toEqual([c.accent])
    expect(await api.searchCommits(repo, 'Sesión')).toEqual([c.accent])
  })

  it('matches a full or abbreviated SHA when the query is hexadecimal', async () => {
    const { repo, c } = searchRepo()
    expect(await api.searchCommits(repo, c.login!)).toEqual([c.login])
    expect(await api.searchCommits(repo, c.login!.slice(0, 7))).toEqual([c.login])
    expect(await api.searchCommits(repo, c.login!.slice(0, 10).toUpperCase())).toEqual([c.login])
    expect(await api.searchCommits(repo, ` ${c.login!.slice(0, 12)} `)).toEqual([c.login])
    // not a prefix: the middle of a SHA does not match
    expect(await api.searchCommits(repo, c.login!.slice(8, 20))).toEqual([])
    // fewer than 4 hex digits is only ever text
    const three = c.login!.slice(0, 3)
    const textual = await api.searchCommits(repo, three)
    expect(textual).not.toContain(c.login)
  })

  it('a hexadecimal word matches SHAs and text alike', async () => {
    const repo = emptyRepo()
    const first = commitFiles(repo, { 'a.txt': '1\n' }, 'feed the cache')
    const second = commitFiles(repo, { 'a.txt': '2\n' }, 'other')
    expect(await api.searchCommits(repo, 'feed')).toEqual([first])
    // SHA hit and message hit together, still in graph order
    expect(await api.searchCommits(repo, second.slice(0, 6))).toEqual([second])
    const third = commitFiles(repo, { 'a.txt': '3\n' }, `revert ${second.slice(0, 6)}`)
    expect(await api.searchCommits(repo, second.slice(0, 6))).toEqual([third, second])
  })

  it('searches every ref, like the graph', async () => {
    const { repo, c } = searchRepo()
    sh(repo, 'checkout', '-q', '-b', 'feature', c.login!)
    const side = commitFiles(repo, { 'side.txt': 'x\n' }, 'Side branch login work')
    sh(repo, 'tag', 'v-side')
    sh(repo, 'checkout', '-q', 'main')
    sh(repo, 'branch', '-D', '-q', 'feature') // now only reachable through the tag
    expect(await api.searchCommits(repo, 'login')).toEqual([side, c.body, c.login])

    // a commit no ref reaches is not in the graph, so it is not found either
    sh(repo, 'checkout', '-q', '--detach')
    const dangling = commitFiles(repo, { 'd.txt': 'x\n' }, 'Dangling login commit')
    sh(repo, 'checkout', '-q', 'main')
    expect(await api.searchCommits(repo, 'dangling')).toEqual([])
    expect(await api.searchCommits(repo, dangling.slice(0, 10))).toEqual([])
  })

  it('finds stashes but not their helper commits', async () => {
    const { repo } = seededRepo()
    write(repo, 'a.txt', 'changed\n')
    write(repo, 'untracked.txt', 'u\n')
    tick()
    sh(repo, 'stash', 'push', '--include-untracked', '-m', 'needle in a stash')
    write(repo, 'a.txt', 'changed again\n')
    tick()
    sh(repo, 'stash', 'push', '-m', 'second needle')
    const stashes = sh(repo, 'stash', 'list', '--format=%H').split('\n')
    expect(stashes).toHaveLength(2)

    const found = await api.searchCommits(repo, 'needle')
    expect(found).toEqual(stashes)
    // the same commits the graph shows
    const graph = (await coreApi.log(repo)).map((k) => k.hash)
    for (const h of found) expect(graph).toContain(h)
    // "index on main: ..." / "untracked files on main: ..." are helper commits
    expect(await api.searchCommits(repo, 'index on')).toEqual([])
    expect(await api.searchCommits(repo, 'untracked files on')).toEqual([])
    const helper = sh(repo, 'rev-parse', 'stash@{0}^2')
    expect(await api.searchCommits(repo, helper.slice(0, 12))).toEqual([])
  })

  it('honours the limit, keeping the newest matches', async () => {
    const repo = emptyRepo()
    const all: string[] = []
    for (let i = 0; i < 12; i++) all.unshift(commitFiles(repo, { 'a.txt': `${i}\n` }, `step ${i}`))
    expect(await api.searchCommits(repo, 'step')).toEqual(all)
    expect(await api.searchCommits(repo, 'step', { limit: 5 })).toEqual(all.slice(0, 5))
    expect(await api.searchCommits(repo, 'step', { limit: 1 })).toEqual(all.slice(0, 1))
    expect(await api.searchCommits(repo, 'step', { limit: 0 })).toEqual([])
    // message and author hits share the limit
    expect(await api.searchCommits(repo, 'e', { limit: 3 })).toEqual(all.slice(0, 3))
    expect(await api.searchCommits(repo, 'test user', { limit: 4 })).toEqual(all.slice(0, 4))
  })

  it('returns nothing for an empty query or an empty repository', async () => {
    const { repo } = seededRepo()
    expect(await api.searchCommits(repo, '')).toEqual([])
    expect(await api.searchCommits(repo, '   ')).toEqual([])
    expect(await api.searchCommits(repo, '\n')).toEqual([])
    expect(await api.searchCommits(emptyRepo(), 'anything')).toEqual([])
    expect(await api.searchCommits(emptyRepo(), 'abcd')).toEqual([])
  })

  it('returns hashes in the order of the graph', async () => {
    const { repo, c } = searchRepo()
    const graph = (await coreApi.log(repo)).map((k) => k.hash)
    const found = await api.searchCommits(repo, 'a') // nearly everything, through message or author
    expect(found.length).toBeGreaterThan(4)
    expect(found).toEqual(graph.filter((h) => found.includes(h)))
    expect(found).toContain(c.init)
  })
})

describe('mergeHits', () => {
  it('interleaves by time, keeps each list in order and drops duplicates', () => {
    const a = [
      { hash: 'a5', time: 50 },
      { hash: 'a3', time: 30 },
      { hash: 'x', time: 20 }
    ]
    const b = [
      { hash: 'b4', time: 40 },
      { hash: 'x', time: 20 },
      { hash: 'b1', time: 10 }
    ]
    expect(mergeHits([a, b]).map((h) => h.hash)).toEqual(['a5', 'b4', 'a3', 'x', 'b1'])
    expect(mergeHits([[], b, []]).map((h) => h.hash)).toEqual(['b4', 'x', 'b1'])
    expect(mergeHits([])).toEqual([])
  })

  it('never reorders a list whose times are not monotonic (topological order wins)', () => {
    // a child committed with an older clock than its parent still comes first
    const a = [
      { hash: 'child', time: 10 },
      { hash: 'parent', time: 90 }
    ]
    const b = [{ hash: 'other', time: 50 }]
    const order = mergeHits([a, b]).map((h) => h.hash)
    expect(order.indexOf('child')).toBeLessThan(order.indexOf('parent'))
    expect(order).toHaveLength(3)
  })
})
