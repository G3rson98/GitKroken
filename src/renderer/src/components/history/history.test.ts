// Pure helpers of the blame view and of the commit search of the graph.
import { describe, expect, it } from 'vitest'
import type { Commit } from '@shared/types'
import { blameBefore, blockIndex, commitAges, groupBlame, isUncommitted, revLabel, type BlameLineX } from './blameModel'
import { countLabel, createMatcher, firstMatchFrom, orderMatches, splitByRanges, stepMatch } from './commitSearch'
import { blameRev, hasHistory } from './entry'

const ZERO = '0'.repeat(40)
const line = (hash: string, lineNo: number, date = 100, extra: Partial<BlameLineX> = {}): BlameLineX => ({
  hash,
  author: 'Ada',
  date,
  summary: `commit ${hash}`,
  lineNo,
  text: `line ${lineNo}`,
  ...extra
})

describe('groupBlame', () => {
  it('collapses consecutive lines of the same commit into one block', () => {
    const lines = ['a', 'a', 'b', 'a', 'a', 'a', 'c'].map((h, i) => line(h, i + 1))
    expect(groupBlame(lines)).toEqual([
      { start: 0, end: 2, hash: 'a' },
      { start: 2, end: 3, hash: 'b' },
      { start: 3, end: 6, hash: 'a' },
      { start: 6, end: 7, hash: 'c' }
    ])
  })

  it('handles empty and single-commit files', () => {
    expect(groupBlame([])).toEqual([])
    expect(groupBlame([line('a', 1), line('a', 2), line('a', 3)])).toEqual([{ start: 0, end: 3, hash: 'a' }])
    expect(groupBlame([line('a', 1)])).toEqual([{ start: 0, end: 1, hash: 'a' }])
  })

  it('keeps uncommitted lines in their own blocks', () => {
    const lines = [line('a', 1), line(ZERO, 2), line(ZERO, 3), line('a', 4)]
    expect(groupBlame(lines).map((b) => [b.start, b.end, isUncommitted(b.hash)])).toEqual([
      [0, 1, false],
      [1, 3, true],
      [3, 4, false]
    ])
  })

  it('blockIndex maps every line to its block', () => {
    const lines = ['a', 'a', 'b', 'a', 'c', 'c'].map((h, i) => line(h, i + 1))
    const blocks = groupBlame(lines)
    expect([...blockIndex(blocks, lines.length)]).toEqual([0, 0, 1, 2, 3, 3])
    // every block covers exactly its lines, with no gap between blocks
    expect(blocks[0].start).toBe(0)
    blocks.forEach((b, i) => expect(b.start).toBe(i === 0 ? 0 : blocks[i - 1].end))
    expect(blocks[blocks.length - 1].end).toBe(lines.length)
  })

  it('groups a 10 000 line file quickly', () => {
    const lines = Array.from({ length: 10_000 }, (_, i) => line(String(Math.floor(i / 7) % 50), i + 1))
    const blocks = groupBlame(lines)
    expect(blocks).toHaveLength(Math.ceil(10_000 / 7))
    expect(blockIndex(blocks, lines.length)[9_999]).toBe(blocks.length - 1)
  })
})

describe('commitAges', () => {
  it('ranks commits from the oldest (0) to the newest (1)', () => {
    const lines = [line('old', 1, 100), line('mid', 2, 5_000), line('new', 3, 5_100), line('old', 4, 100)]
    const ages = commitAges(lines)
    expect(ages.get('old')).toBe(0)
    expect(ages.get('mid')).toBe(0.5)
    expect(ages.get('new')).toBe(1)
  })

  it('treats a single commit and uncommitted lines as the newest', () => {
    expect(commitAges([line('a', 1)]).get('a')).toBe(1)
    const ages = commitAges([line('a', 1, 10), line('b', 2, 20), line(ZERO, 3, 999)])
    expect(ages.get(ZERO)).toBe(1)
    // the uncommitted pseudo-commit does not take part in the ranking
    expect(ages.get('a')).toBe(0)
    expect(ages.get('b')).toBe(1)
  })

  it('gives commits with the same date the same age', () => {
    const ages = commitAges([line('a', 1, 10), line('b', 2, 10), line('c', 3, 30)])
    expect(ages.get('a')).toBe(ages.get('b'))
    expect(ages.get('c')).toBe(1)
  })
})

describe('blame navigation helpers', () => {
  it('isUncommitted recognises the all-zero hash only', () => {
    expect(isUncommitted(ZERO)).toBe(true)
    expect(isUncommitted('0'.repeat(64))).toBe(true)
    expect(isUncommitted('0'.repeat(39) + '1')).toBe(false)
    expect(isUncommitted('')).toBe(false)
  })

  it('revLabel abbreviates full hashes and keeps names', () => {
    const full = 'a1b2c3d4'.repeat(5)
    expect(revLabel(undefined)).toBe('Working tree')
    expect(revLabel('')).toBe('Working tree')
    expect(revLabel(full)).toBe('a1b2c3d')
    expect(revLabel(`${full}^`)).toBe('a1b2c3d^')
    expect(revLabel(`${full}~2`)).toBe('a1b2c3d~2')
    expect(revLabel('HEAD')).toBe('HEAD')
    expect(revLabel('feature/login')).toBe('feature/login')
  })

  it('blameBefore follows `previous`, including a rename', () => {
    const renamed = line('b', 1, 100, { path: 'new.txt', previous: { hash: 'a', path: 'old.txt' } })
    expect(blameBefore(renamed, 'new.txt')).toEqual({ path: 'old.txt', rev: 'a' })
    // the commit that created the file has nothing before it
    expect(blameBefore(line('a', 1, 100, { path: 'old.txt' }), 'new.txt')).toBeNull()
    // uncommitted lines: the committed version
    expect(blameBefore(line(ZERO, 1), 'f.txt')).toEqual({ path: 'f.txt', rev: 'HEAD' })
    expect(blameBefore(line(ZERO, 1, 100, { previous: { hash: 'h', path: 'f.txt' } }), 'f.txt')).toEqual({ path: 'f.txt', rev: 'h' })
    // a backend that sends only the shared contract: the parent, same name
    expect(blameBefore(line('c', 1), 'f.txt')).toEqual({ path: 'f.txt', rev: 'c^' })
  })

  it('blameRev picks the revision to blame for each kind of file', () => {
    expect(blameRev({ path: 'f', commit: 'abc', status: 'modified' })).toBe('abc')
    expect(blameRev({ path: 'f', commit: 'abc', status: 'deleted' })).toBe('abc^')
    expect(blameRev({ path: 'f', status: 'modified' })).toBeUndefined()
    expect(blameRev({ path: 'f', status: 'deleted' })).toBe('HEAD')
    expect(hasHistory({ path: 'f', status: 'untracked' })).toBe(false)
    expect(hasHistory({ path: 'f', status: 'added' })).toBe(true)
  })
})

// --- commit search -----------------------------------------------------------------

const commit = (hash: string, subject: string, extra: Partial<Commit> = {}): Commit => ({
  hash,
  parents: [],
  author: 'Ada Lovelace',
  email: 'ada@example.com',
  date: 0,
  subject,
  body: '',
  ...extra
})

describe('createMatcher', () => {
  it('returns null when there is nothing to search for', () => {
    expect(createMatcher('')).toBeNull()
    expect(createMatcher('   ')).toBeNull()
    expect(createMatcher('\n')).toBeNull()
  })

  it('matches subject, body, author name and email, ignoring case', () => {
    const m = createMatcher('LoGin')!
    expect(m.test(commit('1', 'Fix login redirect'))).toBe(true)
    expect(m.test(commit('2', 'Refactor', { body: 'first line\nMentions the LOGIN flow' }))).toBe(true)
    expect(m.test(commit('3', 'Other', { author: 'Lo Gin', email: 'login@example.com' }))).toBe(true)
    expect(m.test(commit('4', 'Other'))).toBe(false)
    expect(createMatcher('lovelace')!.test(commit('5', 'x'))).toBe(true)
    expect(createMatcher('ADA@EXAMPLE')!.test(commit('6', 'x'))).toBe(true)
    // name and email together, as git matches the author header
    expect(createMatcher('lovelace <ada@')!.test(commit('7', 'x'))).toBe(true)
    // but a match never straddles two different fields
    expect(createMatcher('x Ada')!.test(commit('8', 'x'))).toBe(false)
  })

  it('treats the query literally, not as a regular expression', () => {
    const special = commit('1', 'Handle a[0].b* and v1.0 (regex chars)')
    const plain = commit('2', 'Bump to v1x0, see a0b')
    for (const q of ['a[0].b*', '[', 'v1.0', 'b*', '(regex', '.b']) {
      expect(createMatcher(q)!.test(special), q).toBe(true)
      expect(createMatcher(q)!.test(plain), q).toBe(false)
    }
    for (const q of ['.*', '^Handle', 'chars)$', '\\', 'a|b', 'x{2}', '[a-z]+']) {
      expect(createMatcher(q)!.test(special), q).toBe(false)
    }
    expect(createMatcher('\\d')!.test(commit('3', 'path C:\\dir'))).toBe(true)
  })

  it('folds the case of non-ASCII letters', () => {
    const c = commit('1', 'CORRECCIÓN de la sesión', { author: 'Ñandú Pérez' })
    for (const q of ['corrección', 'CORRECCIÓN', 'Sesión', 'ñandú', 'ÑANDÚ']) expect(createMatcher(q)!.test(c), q).toBe(true)
    expect(createMatcher('correccion')!.test(c)).toBe(false) // accents are not folded (nor does git)
  })

  it('matches the start of the SHA for hexadecimal queries of 4+ characters', () => {
    const c = commit('abcdef0123456789abcdef0123456789abcdef01', 'unrelated')
    expect(createMatcher('abcd')!.test(c)).toBe(true)
    expect(createMatcher('ABCDEF01')!.test(c)).toBe(true)
    expect(createMatcher(' abcdef0 ')!.test(c)).toBe(true)
    expect(createMatcher(c.hash)!.test(c)).toBe(true)
    expect(createMatcher('abc')!.test(c)).toBe(false) // too short to be a SHA
    expect(createMatcher('bcde')!.test(c)).toBe(false) // not a prefix
    expect(createMatcher('abcx')!.shaPrefix).toBeNull()
    expect(createMatcher('abcd')!.shaPrefix).toBe('abcd')
    // a hexadecimal word is still searched as text
    expect(createMatcher('feed')!.test(commit('1234', 'feed the cache'))).toBe(true)
  })
})

describe('match highlighting', () => {
  it('finds every occurrence with offsets into the original text', () => {
    const m = createMatcher('fix')!
    expect(m.ranges('Fix: prefix and FIXME, no more')).toEqual([
      [0, 3],
      [8, 11],
      [16, 19]
    ])
    expect(m.ranges('nothing here')).toEqual([])
    expect(m.ranges('')).toEqual([])
  })

  it('highlights special characters literally and does not overlap', () => {
    expect(createMatcher('a.b')!.ranges('a.b axb a.b')).toEqual([
      [0, 3],
      [8, 11]
    ])
    expect(createMatcher('[x]')!.ranges('see [x] and x')).toEqual([[4, 7]])
    expect(createMatcher('aa')!.ranges('aaaaa')).toEqual([
      [0, 2],
      [2, 4]
    ])
    expect(createMatcher('*')!.ranges('a*b**')).toEqual([
      [1, 2],
      [3, 4],
      [4, 5]
    ])
  })

  it('keeps offsets right around non-ASCII text', () => {
    const text = 'Añadir CORRECCIÓN — sesión 日本語 sesión'
    const ranges = createMatcher('SESIÓN')!.ranges(text)
    expect(ranges.map(([a, b]) => text.slice(a, b))).toEqual(['sesión', 'sesión'])
    expect(createMatcher('ó')!.ranges('ÓóO')).toEqual([
      [0, 1],
      [1, 2]
    ])
  })

  it('splitByRanges cuts the text into marked and unmarked pieces', () => {
    const text = 'Fix: prefix'
    const m = createMatcher('fix')!
    const parts = splitByRanges(text, m.ranges(text))
    expect(parts).toEqual([
      { text: 'Fix', hit: true },
      { text: ': pre', hit: false },
      { text: 'fix', hit: true }
    ])
    expect(parts.map((p) => p.text).join('')).toBe(text)
    expect(splitByRanges('plain', [])).toEqual([{ text: 'plain', hit: false }])
    expect(splitByRanges('', [])).toEqual([])
    // overlapping or empty ranges are ignored rather than duplicating text
    expect(splitByRanges('abcdef', [[0, 3], [2, 4], [4, 4], [5, 6]]).map((p) => p.text).join('')).toBe('abcdef')
  })

  it('shaRange marks the matched start of an abbreviated SHA', () => {
    const m = createMatcher('ABCDEF0123')!
    expect(m.shaRange('abcdef0')).toEqual([0, 7]) // the cell shows 7 characters
    expect(m.shaRange('abcdef0123456789')).toEqual([0, 10])
    expect(m.shaRange('1234567')).toBeNull()
    expect(createMatcher('abcd')!.shaRange('abcdef0')).toEqual([0, 4])
    expect(createMatcher('login')!.shaRange('abcdef0')).toBeNull()
  })
})

describe('walking the matches', () => {
  // rows of the loaded commits; x and y are matches the backend found further down
  const rows: Record<string, number> = { a: 0, b: 3, c: 7, d: 9 }
  const indexOf = (h: string) => rows[h]

  it('orderMatches sorts loaded matches by row and appends the rest', () => {
    expect(orderMatches(['c', 'a'], ['x', 'a', 'd', 'y'], indexOf)).toEqual(['a', 'c', 'd', 'x', 'y'])
    expect(orderMatches([], ['y', 'x'], indexOf)).toEqual(['y', 'x'])
    expect(orderMatches([], [], indexOf)).toEqual([])
    expect(orderMatches(['a', 'a'], ['a'], indexOf)).toEqual(['a'])
  })

  it('firstMatchFrom starts at the given row and wraps to the top', () => {
    const matches = ['a', 'c', 'x']
    expect(firstMatchFrom(matches, indexOf, 0)).toBe('a')
    expect(firstMatchFrom(matches, indexOf, 1)).toBe('c')
    expect(firstMatchFrom(matches, indexOf, 7)).toBe('c')
    expect(firstMatchFrom(matches, indexOf, 8)).toBe('x') // not loaded yet, but further down
    expect(firstMatchFrom(['a', 'c'], indexOf, 8)).toBe('a')
    expect(firstMatchFrom([], indexOf, 0)).toBeNull()
  })

  it('stepMatch moves from the current match, wrapping around', () => {
    const matches = ['a', 'c', 'x']
    expect(stepMatch(matches, indexOf, 'a', 0, 1)).toBe('c')
    expect(stepMatch(matches, indexOf, 'c', 7, 1)).toBe('x')
    expect(stepMatch(matches, indexOf, 'x', -1, 1)).toBe('a')
    expect(stepMatch(matches, indexOf, 'a', 0, -1)).toBe('x')
    expect(stepMatch(matches, indexOf, 'c', 7, -1)).toBe('a')
    expect(stepMatch(['a'], indexOf, 'a', 0, 1)).toBe('a')
    expect(stepMatch([], indexOf, 'a', 0, 1)).toBeNull()
  })

  it('stepMatch starts from the selection when it is not a match', () => {
    const matches = ['a', 'c', 'x']
    // "b" (row 3) is selected
    expect(stepMatch(matches, indexOf, 'b', 3, 1)).toBe('c')
    expect(stepMatch(matches, indexOf, 'b', 3, -1)).toBe('a')
    // "d" (row 9) is below every loaded match
    expect(stepMatch(matches, indexOf, 'd', 9, 1)).toBe('x')
    expect(stepMatch(['a', 'c'], indexOf, 'd', 9, 1)).toBe('a')
    expect(stepMatch(matches, indexOf, 'd', 9, -1)).toBe('c')
    // nothing selected
    expect(stepMatch(matches, indexOf, null, -1, 1)).toBe('a')
    expect(stepMatch(matches, indexOf, null, -1, -1)).toBe('x')
  })

  it('countLabel', () => {
    expect(countLabel(2, 27, false)).toBe('3 of 27')
    expect(countLabel(0, 500, true)).toBe('1 of 500+')
    expect(countLabel(-1, 27, false)).toBe('27 results')
    expect(countLabel(-1, 1, false)).toBe('1 result')
    expect(countLabel(-1, 500, true)).toBe('500+ results')
    expect(countLabel(-1, 0, false)).toBe('No results')
  })
})
