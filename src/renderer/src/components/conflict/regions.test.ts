// Pure conflict-region logic: line diff, three-way merge, marker parsing and
// the model the editor works on. The merge is also checked against git itself.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { diffLines, type Hunk } from './lineDiff'
import {
  buildModel,
  dominantEol,
  firstMarkerLine,
  hasConflictMarkers,
  lineBody,
  markerKind,
  merge3,
  parseMarkers,
  renderMarkers,
  resolveMarkers,
  resolvedText,
  sideText,
  splitLines,
  type Chunk,
  type ConflictChunk
} from './regions'

const L = (text: string): string[] => splitLines(text)
const conflictsOf = (chunks: Chunk[]): ConflictChunk[] => chunks.filter((c): c is ConflictChunk => c.kind === 'conflict')
/** Compact picture of a chunk list: `=` common, `<`/`>` auto-merged from ours/theirs, `!` conflict */
const shape = (chunks: Chunk[]): string =>
  chunks
    .map((c) =>
      c.kind === 'same'
        ? `=${c.lines.map(lineBody).join(',')}`
        : c.kind === 'auto'
          ? `${c.from === 'ours' ? '<' : '>'}${c[c.from].map(lineBody).join(',')}`
          : `!${c.ours.map(lineBody).join(',')}|${c.theirs.map(lineBody).join(',')}`
    )
    .join(' ')
const merge = (base: string, ours: string, theirs: string): Chunk[] => merge3(L(base), L(ours), L(theirs))
/** `a b c` -> "a\nb\nc\n" */
const t = (words: string): string => (words === '' ? '' : words.split(' ').join('\n') + '\n')

function applyHunks(a: string[], b: string[], hunks: Hunk[]): string[] {
  const out: string[] = []
  let pos = 0
  for (const h of hunks) {
    out.push(...a.slice(pos, h.a), ...b.slice(h.b, h.b + h.bn))
    pos = h.a + h.an
  }
  return [...out, ...a.slice(pos)]
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0
    return s / 4294967296
  }
}

function mutate(r: () => number, lines: string[], vocab: string[], edits: number): string[] {
  const out = [...lines]
  const word = (): string => vocab[Math.floor(r() * vocab.length)]! + '\n'
  for (let e = 0; e < edits; e++) {
    const kind = r()
    const at = Math.floor(r() * (out.length + 1))
    const n = 1 + Math.floor(r() * 3)
    if (kind < 0.35) out.splice(at, 0, ...Array.from({ length: n }, word))
    else if (kind < 0.65) out.splice(at, n)
    else out.splice(at, n, ...Array.from({ length: 1 + Math.floor(r() * 2) }, word))
  }
  return out
}

/** Random base / ours / theirs. Small vocabularies give many repeated lines, the hard case for a diff. */
function randomCase(seed: number): { base: string[]; ours: string[]; theirs: string[] } {
  const r = rng(seed)
  const vocabSize = [4, 8, 30, 200][seed % 4]!
  const vocab = Array.from({ length: vocabSize }, (_, i) => (i % 5 === 0 ? '}'.repeat(1 + (i % 2)) : `w${i}`))
  const n = seed % 7 === 0 ? 200 + Math.floor(r() * 400) : Math.floor(r() * 60)
  const base = Array.from({ length: n }, () => vocab[Math.floor(r() * vocab.length)]! + '\n')
  const edits = (): number => Math.floor(r() * (seed % 3 === 0 ? 25 : 5))
  return { base, ours: mutate(r, base, vocab, edits()), theirs: mutate(r, base, vocab, edits()) }
}

describe('lines', () => {
  it('splitLines keeps terminators, so joining is exact', () => {
    expect(splitLines('')).toEqual([])
    expect(splitLines('a')).toEqual(['a'])
    expect(splitLines('a\n')).toEqual(['a\n'])
    expect(splitLines('a\nb')).toEqual(['a\n', 'b'])
    expect(splitLines('a\r\n\r\nb\n')).toEqual(['a\r\n', '\r\n', 'b\n'])
    expect(splitLines('\n\n')).toEqual(['\n', '\n'])
    for (const text of ['', 'x', 'x\n', '\n', 'a\r\nb\rc\n\nd']) expect(splitLines(text).join('')).toBe(text)
  })

  it('lineBody strips exactly one terminator', () => {
    expect(lineBody('a\n')).toBe('a')
    expect(lineBody('a\r\n')).toBe('a')
    expect(lineBody('a')).toBe('a')
    expect(lineBody('a\r')).toBe('a\r')
    expect(lineBody('\n')).toBe('')
  })

  it('dominantEol', () => {
    expect(dominantEol('a\nb\n')).toBe('\n')
    expect(dominantEol('a\r\nb\r\nc\n')).toBe('\r\n')
    expect(dominantEol('')).toBe('\n')
  })
})

describe('diffLines', () => {
  const d = (a: string, b: string): Hunk[] => diffLines(a.split(''), b.split(''))

  it('finds insertions, deletions and replacements', () => {
    expect(d('abc', 'abc')).toEqual([])
    expect(d('', '')).toEqual([])
    expect(d('', 'ab')).toEqual([{ a: 0, an: 0, b: 0, bn: 2 }])
    expect(d('ab', '')).toEqual([{ a: 0, an: 2, b: 0, bn: 0 }])
    expect(d('abc', 'aXc')).toEqual([{ a: 1, an: 1, b: 1, bn: 1 }])
    expect(d('abc', 'abXc')).toEqual([{ a: 2, an: 0, b: 2, bn: 1 }])
    expect(d('abcd', 'ad')).toEqual([{ a: 1, an: 2, b: 1, bn: 0 }])
    expect(d('abcdef', 'Xbcdef')).toEqual([{ a: 0, an: 1, b: 0, bn: 1 }])
    expect(d('abcdef', 'abcdeX')).toEqual([{ a: 5, an: 1, b: 5, bn: 1 }])
    expect(d('abc', 'xyz')).toEqual([{ a: 0, an: 3, b: 0, bn: 3 }])
  })

  it('puts an ambiguous insertion as far down as it goes, like git', () => {
    // One more "a": git reports the last one as the new line.
    expect(d('xaay', 'xaaay')).toEqual([{ a: 3, an: 0, b: 3, bn: 1 }])
    expect(d('xaaay', 'xaay')).toEqual([{ a: 3, an: 1, b: 3, bn: 0 }])
    // A repeated block: "}f" inserted after the existing one, not "f}" inside it.
    expect(d('f}g}', 'f}f}g}')).toEqual([{ a: 2, an: 0, b: 2, bn: 2 }])
  })

  it('always describes how to turn one input into the other', () => {
    for (let seed = 1; seed <= 300; seed++) {
      const { base, ours, theirs } = randomCase(seed)
      expect(applyHunks(base, ours, diffLines(base, ours))).toEqual(ours)
      expect(applyHunks(ours, theirs, diffLines(ours, theirs))).toEqual(theirs)
      for (const h of diffLines(base, theirs)) expect(h.an + h.bn).toBeGreaterThan(0)
    }
  })

  it('copes with large and with completely different inputs', () => {
    const a = Array.from({ length: 6000 }, (_, i) => `line ${i}\n`)
    const b = [...a]
    b.splice(100, 5, 'changed\n')
    b.splice(3000, 0, 'new 1\n', 'new 2\n')
    b.splice(5990, 3)
    const started = Date.now()
    const hunks = diffLines(a, b)
    expect(hunks).toHaveLength(3)
    expect(applyHunks(a, b, hunks)).toEqual(b)

    // Nothing in common, and a shuffle (the expensive case for Myers).
    const c = Array.from({ length: 4000 }, (_, i) => `other ${i}\n`)
    expect(diffLines(a, c)).toEqual([{ a: 0, an: 6000, b: 0, bn: 4000 }])
    const r = rng(7)
    const shuffled = [...a].sort(() => r() - 0.5)
    expect(applyHunks(a, shuffled, diffLines(a, shuffled))).toEqual(shuffled)
    expect(Date.now() - started).toBeLessThan(5000)
  })
})

describe('markerKind', () => {
  it('recognises the four markers git writes, with LF or CRLF', () => {
    expect(markerKind('<<<<<<< HEAD\n')).toBe('start')
    expect(markerKind('<<<<<<<\n')).toBe('start')
    expect(markerKind('<<<<<<< HEAD\r\n')).toBe('start')
    expect(markerKind('||||||| merged common ancestors\n')).toBe('base')
    expect(markerKind('|||||||\n')).toBe('base')
    expect(markerKind('=======\n')).toBe('sep')
    expect(markerKind('=======\r\n')).toBe('sep')
    expect(markerKind('=======')).toBe('sep')
    expect(markerKind('>>>>>>> feature/x (some subject)\n')).toBe('end')
    expect(markerKind('>>>>>>>')).toBe('end')
  })

  it('rejects look-alikes', () => {
    expect(markerKind('<<<<<<<HEAD\n')).toBeNull() // no space
    expect(markerKind('<<<<<< HEAD\n')).toBeNull() // six
    expect(markerKind('<<<<<<<< HEAD\n')).toBeNull() // eight
    expect(markerKind('========\n')).toBeNull()
    expect(markerKind('======= \n')).toBeNull()
    expect(markerKind('======= text\n')).toBeNull()
    expect(markerKind(' <<<<<<< HEAD\n')).toBeNull() // indented
    expect(markerKind('>>>>>>>quote\n')).toBeNull()
    expect(markerKind('||||||||\n')).toBeNull()
    expect(markerKind('\n')).toBeNull()
    expect(markerKind('')).toBeNull()
  })
})

describe('parseMarkers', () => {
  it('reads a block without base section', () => {
    const p = parseMarkers('a\n<<<<<<< HEAD\nours 1\nours 2\n=======\ntheirs\n>>>>>>> other\nz\n')
    expect(p.wellFormed).toBe(true)
    expect(p.conflicts).toBe(1)
    expect(p.parts).toEqual([
      { kind: 'text', lines: ['a\n'] },
      { kind: 'conflict', ours: ['ours 1\n', 'ours 2\n'], base: null, theirs: ['theirs\n'], oursLabel: 'HEAD', theirsLabel: 'other' },
      { kind: 'text', lines: ['z\n'] }
    ])
  })

  it('reads a block with base section (diff3 / zdiff3 style)', () => {
    const p = parseMarkers('<<<<<<< HEAD\nours\n||||||| 1234abc\nbase 1\nbase 2\n=======\ntheirs\n>>>>>>> abc1234 (subject with spaces)\n')
    expect(p.parts).toEqual([
      {
        kind: 'conflict',
        ours: ['ours\n'],
        base: ['base 1\n', 'base 2\n'],
        theirs: ['theirs\n'],
        oursLabel: 'HEAD',
        theirsLabel: 'abc1234 (subject with spaces)'
      }
    ])
    expect(p.wellFormed).toBe(true)
  })

  it('reads several blocks, at the very start and the very end, with empty sides', () => {
    const text = '<<<<<<< A\n=======\nt1\n>>>>>>> B\nmid 1\nmid 2\n<<<<<<< A\no2\n=======\n>>>>>>> B\nmid 3\n<<<<<<< A\no3\n||||||| base\n=======\nt3\n>>>>>>> B'
    const p = parseMarkers(text)
    expect(p.conflicts).toBe(3)
    expect(p.wellFormed).toBe(true)
    expect(p.parts.map((x) => x.kind)).toEqual(['conflict', 'text', 'conflict', 'text', 'conflict'])
    expect(p.parts[0]).toMatchObject({ ours: [], theirs: ['t1\n'], base: null })
    expect(p.parts[2]).toMatchObject({ ours: ['o2\n'], theirs: [] })
    // The last marker has no line break after it; the empty base section is kept as such.
    expect(p.parts[4]).toMatchObject({ ours: ['o3\n'], base: [], theirs: ['t3\n'], theirsLabel: 'B' })
    expect(resolveMarkers(p, 'ours')).toBe('mid 1\nmid 2\no2\nmid 3\no3\n')
    expect(resolveMarkers(p, 'theirs')).toBe('t1\nmid 1\nmid 2\nmid 3\nt3\n')
  })

  it('keeps CRLF terminators on every line', () => {
    const p = parseMarkers('a\r\n<<<<<<< HEAD\r\nours\r\n=======\r\ntheirs\r\n>>>>>>> other\r\nz')
    expect(p.parts).toEqual([
      { kind: 'text', lines: ['a\r\n'] },
      { kind: 'conflict', ours: ['ours\r\n'], base: null, theirs: ['theirs\r\n'], oursLabel: 'HEAD', theirsLabel: 'other' },
      { kind: 'text', lines: ['z'] }
    ])
    expect(resolveMarkers(p, 'theirs')).toBe('a\r\ntheirs\r\nz')
  })

  it('text without markers is one text part', () => {
    expect(parseMarkers('a\nb')).toEqual({ parts: [{ kind: 'text', lines: ['a\n', 'b'] }], conflicts: 0, wellFormed: true })
    expect(parseMarkers('')).toEqual({ parts: [], conflicts: 0, wellFormed: true })
  })

  it('marker look-alikes outside a block are content', () => {
    // A reST / Markdown underline, and a block after it.
    const p = parseMarkers('Title\n=======\ntext\n<<<<<<< HEAD\no\n=======\nt\n>>>>>>> x\n||||||| not a marker here\n')
    expect(p.conflicts).toBe(1)
    expect(p.wellFormed).toBe(true)
    expect(p.parts[0]).toEqual({ kind: 'text', lines: ['Title\n', '=======\n', 'text\n'] })
    expect(p.parts[2]).toEqual({ kind: 'text', lines: ['||||||| not a marker here\n'] })
  })

  it('never drops text when the markers are broken', () => {
    const broken = [
      'a\n<<<<<<< HEAD\nours\n=======\ntheirs\n', // never closed
      'a\n<<<<<<< HEAD\nours\n>>>>>>> x\n', // no separator
      'ours\n=======\ntheirs\n>>>>>>> x\n', // start deleted by hand
      '<<<<<<< A\no\n<<<<<<< A\no2\n=======\nt2\n>>>>>>> B\n' // a start inside an open block
    ]
    for (const text of broken) {
      const p = parseMarkers(text)
      expect(p.wellFormed).toBe(false)
      const all = p.parts.flatMap((x) => (x.kind === 'text' ? x.lines : [])).join('')
      if (p.conflicts === 0) expect(all).toBe(text)
    }
    // The inner, complete block of the last case is still found.
    expect(parseMarkers(broken[3]!).conflicts).toBe(1)
    expect(parseMarkers(broken[3]!).parts[0]).toEqual({ kind: 'text', lines: ['<<<<<<< A\n', 'o\n'] })
  })

  it('finds leftover markers in hand-edited text', () => {
    expect(hasConflictMarkers('fine\ntext\n')).toBe(false)
    expect(hasConflictMarkers('a <<<<<<< b\n')).toBe(false)
    expect(firstMarkerLine('a\nb\n>>>>>>> x\n')).toBe(2)
    expect(firstMarkerLine('=======\n')).toBe(0)
    expect(firstMarkerLine('a\r\n<<<<<<< HEAD\r\n')).toBe(1)
    expect(firstMarkerLine('')).toBe(-1)
  })

  it('renderMarkers writes what parseMarkers reads', () => {
    const conflict = { ours: ['o1\n', 'o2\n'], theirs: ['t\n'] }
    const text = renderMarkers(conflict, { ours: 'main', theirs: 'abc1234 Fix the thing' }, '\n').join('')
    expect(text).toBe('<<<<<<< main\no1\no2\n=======\nt\n>>>>>>> abc1234 Fix the thing\n')
    expect(parseMarkers(text).parts).toEqual([{ kind: 'conflict', ...conflict, base: null, oursLabel: 'main', theirsLabel: 'abc1234 Fix the thing' }])
    // CRLF file, a side without final newline, an empty side and an empty label.
    expect(renderMarkers({ ours: ['x'], theirs: [] }, { ours: '', theirs: 'b' }, '\r\n').join('')).toBe('<<<<<<<\r\nx\r\n=======\r\n>>>>>>> b\r\n')
  })
})

describe('merge3', () => {
  it('a change on both sides of the same line is a conflict', () => {
    const chunks = merge(t('a b c'), t('a X c'), t('a Y c'))
    expect(shape(chunks)).toBe('=a !X|Y =c')
    expect(conflictsOf(chunks)[0]).toEqual({ kind: 'conflict', index: 0, ours: ['X\n'], theirs: ['Y\n'], base: ['b\n'] })
  })

  it('changes far apart merge by themselves', () => {
    const chunks = merge(t('a b c d e f g'), t('A b c d e f g'), t('a b c d e f G'))
    expect(shape(chunks)).toBe('<A =b,c,d,e,f >G')
    expect(resolvedText(chunks, 'ours')).toBe(t('A b c d e f G'))
    expect(resolvedText(chunks, 'theirs')).toBe(t('A b c d e f G'))
  })

  it('the same change on both sides is not a conflict', () => {
    expect(shape(merge(t('a b c'), t('a X c'), t('a X c')))).toBe('=a,X,c')
    expect(shape(merge(t('a b c'), t('a c'), t('a c')))).toBe('=a,c')
  })

  it('changes on adjacent lines conflict (git does not guess the order)', () => {
    const chunks = merge(t('a b c d'), t('a B c d'), t('a b C d'))
    expect(shape(chunks)).toBe('=a !B,c|b,C =d')
  })

  it('one side deletes what the other edits', () => {
    expect(shape(merge(t('a b c d e'), t('a e'), t('a b X d e')))).toBe('=a !|b,X,d =e')
  })

  it('insertions at the same point conflict, and identical parts are taken out of the conflict', () => {
    expect(shape(merge(t('a z'), t('a 1 2 z'), t('a 3 4 z')))).toBe('=a !1,2|3,4 =z')
    // Both add the same line plus one of their own after 4+ shared lines.
    expect(shape(merge(t('a z'), t('a s1 s2 s3 s4 X z'), t('a s1 s2 s3 s4 Y z')))).toBe('=a,s1,s2,s3,s4 !X|Y =z')
  })

  it('conflicts with three or fewer common lines between them are joined', () => {
    // Two separate changes with 3 unchanged lines between them: one conflict, as git writes it.
    const base = t('a b c d e f g h i j k')
    expect(shape(merge(base, t('a B c d e F g h i j k'), t('a B2 c d e F2 g h i j k')))).toBe('=a !B,c,d,e,F|B2,c,d,e,F2 =g,h,i,j,k')
    // With 4 they stay apart.
    expect(shape(merge(base, t('a B c d e f G h i j k'), t('a B2 c d e f G2 h i j k')))).toBe('=a !B|B2 =c,d,e,f !G|G2 =h,i,j,k')
    // The same rule applies to the common lines found inside one conflict.
    const one = merge(t('a z'), t('a o1 s1 s2 s3 o2 z'), t('a t1 s1 s2 s3 t2 z'))
    expect(shape(one)).toBe('=a !o1,s1,s2,s3,o2|t1,s1,s2,s3,t2 =z')
    expect(conflictsOf(one)[0]!.base).toBeNull()
    const four = merge(t('a z'), t('a o1 s1 s2 s3 s4 o2 z'), t('a t1 s1 s2 s3 s4 t2 z'))
    expect(shape(four)).toBe('=a !o1|t1 =s1,s2,s3,s4 !o2|t2 =z')
  })

  it('regions at the very start and the very end of the file', () => {
    const chunks = merge(t('a b c d e f g h'), t('A b c d e f g H'), t('A2 b c d e f g H2'))
    expect(shape(chunks)).toBe('!A|A2 =b,c,d,e,f,g !H|H2')
    expect(chunks[0]!.kind).toBe('conflict')
    expect(chunks[chunks.length - 1]!.kind).toBe('conflict')
    // Whole file in conflict
    expect(shape(merge(t('a'), t('b'), t('c')))).toBe('!b|c')
    // One side empties the file
    expect(shape(merge(t('a b'), '', t('a X')))).toBe('!|a,X')
  })

  it('without base (add/add) only the lines that differ are in conflict', () => {
    const chunks = merge('', t('h1 h2 h3 h4 mine t1'), t('h1 h2 h3 h4 yours t1'))
    expect(shape(chunks)).toBe('=h1,h2,h3,h4 !mine|yours =t1')
    expect(conflictsOf(chunks)[0]!.base).toBeNull()
    expect(shape(merge('', t('a'), t('a')))).toBe('=a')
    expect(shape(merge('', '', ''))).toBe('')
  })

  it('CRLF lines are compared and kept as they are', () => {
    const crlf = (words: string): string => words.split(' ').join('\r\n') + '\r\n'
    const chunks = merge(crlf('a b c'), crlf('a X c'), crlf('a Y c'))
    expect(conflictsOf(chunks)[0]).toMatchObject({ ours: ['X\r\n'], theirs: ['Y\r\n'] })
    expect(sideText(chunks, 'ours')).toBe('a\r\nX\r\nc\r\n')
    expect(resolvedText(chunks, 'theirs')).toBe('a\r\nY\r\nc\r\n')
    // A side that converted the file is a different text on every line.
    expect(shape(merge(crlf('a b'), t('a b'), crlf('a X')))).toBe('!a,b|a,X')
  })

  it('a missing final newline is part of the last line', () => {
    // Only theirs touches the last line: clean, and the result has no final newline either.
    const clean = merge('a\nb\nc\nd\ne', 'A\nb\nc\nd\ne', 'a\nb\nc\nd\nE')
    expect(resolvedText(clean, 'ours')).toBe('A\nb\nc\nd\nE')
    // Both change it, one adding the newline: conflict with the exact lines.
    const chunks = merge('a\nb', 'a\nX', 'a\nY\n')
    expect(conflictsOf(chunks)[0]).toMatchObject({ ours: ['X'], theirs: ['Y\n'] })
    expect(resolvedText(chunks, 'ours')).toBe('a\nX')
    expect(resolvedText(chunks, 'theirs')).toBe('a\nY\n')
    // Adding the final newline is a change of that line, on one side only.
    expect(resolvedText(merge('a\nb', 'a\nb\n', 'a\nb'), 'ours')).toBe('a\nb\n')
  })

  it('always splits into chunks that rebuild both sides exactly', () => {
    for (let seed = 1; seed <= 400; seed++) {
      const { base, ours, theirs } = randomCase(seed)
      const chunks = merge3(base, ours, theirs)
      expect(sideText(chunks, 'ours')).toBe(ours.join(''))
      expect(sideText(chunks, 'theirs')).toBe(theirs.join(''))
      conflictsOf(chunks).forEach((c, i) => {
        expect(c.index).toBe(i)
        expect(c.ours.join('')).not.toBe(c.theirs.join(''))
      })
      // No two neighbours of the same kind that should have been one chunk.
      chunks.forEach((c, i) => expect(c.kind === 'same' && chunks[i + 1]?.kind === 'same').toBe(false))
    }
  })

  it('merges a few thousand lines quickly', () => {
    const base = Array.from({ length: 5000 }, (_, i) => `line ${i} ${i % 7 === 0 ? '}' : 'x = ' + i}\n`)
    const ours = [...base]
    const theirs = [...base]
    for (let i = 50; i < 5000; i += 100) {
      ours[i] = `ours ${i}\n`
      theirs[i] = i % 200 === 50 ? `theirs ${i}\n` : base[i]!
      theirs[i + 40] = `theirs only ${i}\n`
    }
    const started = Date.now()
    const chunks = merge3(base, ours, theirs)
    expect(Date.now() - started).toBeLessThan(1500)
    expect(conflictsOf(chunks)).toHaveLength(25)
    expect(chunks.filter((c) => c.kind === 'auto')).toHaveLength(75)
  })
})

describe('merge3 against git itself', () => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gitkroken-merge3-')))
  afterAll(() => rmSync(dir, { recursive: true, force: true }))

  const gitMergeFile = (base: string, ours: string, theirs: string, ...flags: string[]): string => {
    writeFileSync(join(dir, 'base'), base)
    writeFileSync(join(dir, 'ours'), ours)
    writeFileSync(join(dir, 'theirs'), theirs)
    const res = spawnSync('git', ['merge-file', '-p', ...flags, 'ours', 'base', 'theirs'], {
      cwd: dir,
      encoding: 'utf8',
      env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' }
    })
    if (res.status === null || res.status > 127) throw new Error(`git merge-file failed: ${res.stderr}`)
    return res.stdout
  }

  it('produces the same regions and the same merged text as `git merge-file`', () => {
    let withConflicts = 0
    for (let seed = 1; seed <= 250; seed++) {
      const { base, ours, theirs } = randomCase(seed)
      // `git merge-file` joins conflicts across punctuation-only lines; `git merge` does not.
      const chunks = merge3(base, ours, theirs, { joinAcrossPunctuation: true })
      const parsed = parseMarkers(gitMergeFile(base.join(''), ours.join(''), theirs.join('')))
      const fromGit = parsed.parts.flatMap((p) => (p.kind === 'conflict' ? [{ ours: p.ours, theirs: p.theirs }] : []))
      const mine = conflictsOf(chunks).map((c) => ({ ours: c.ours, theirs: c.theirs }))
      expect(mine, `seed ${seed}`).toEqual(fromGit)
      expect(resolvedText(chunks, 'ours'), `seed ${seed}`).toBe(resolveMarkers(parsed, 'ours'))
      expect(resolvedText(chunks, 'theirs'), `seed ${seed}`).toBe(resolveMarkers(parsed, 'theirs'))
      if (mine.length) withConflicts++
    }
    // The comparison is only worth something if conflicts actually happen.
    expect(withConflicts).toBeGreaterThan(80)
  })

  it('base sections match git`s diff3 output when the conflict was not narrowed', () => {
    const base = t('a b c d e')
    const ours = t('a X c d e')
    const theirs = t('a Y c d e')
    const parsed = parseMarkers(gitMergeFile(base, ours, theirs, '--diff3'))
    const mine = conflictsOf(merge(base, ours, theirs))
    expect(parsed.parts.flatMap((p) => (p.kind === 'conflict' ? [p.base] : []))).toEqual(mine.map((c) => c.base))
  })
})

describe('buildModel', () => {
  const base = t('a b c d e f g h')
  const ours = t('A b c X e f g h')
  const theirs = t('a b c Y e f g H')
  const merged = t('A b c') + '<<<<<<< HEAD\nX\n=======\nY\n>>>>>>> other\n' + t('e f g H')

  it('uses the three versions when the file on disk agrees with them', () => {
    const model = buildModel({ base, ours, theirs, merged })
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 1, eol: '\n' })
    // Unlike the markers, the stages show what each side really looks like around the conflict.
    expect(shape(model.chunks)).toBe('<A =b,c !X|Y =e,f,g >H')
    expect(sideText(model.chunks, 'ours')).toBe(ours)
    expect(sideText(model.chunks, 'theirs')).toBe(theirs)
  })

  it('accepts diff3-style markers on disk', () => {
    const diff3 = t('A b c') + '<<<<<<< HEAD\nX\n||||||| base\nd\n=======\nY\n>>>>>>> other\n' + t('e f g H')
    expect(buildModel({ base, ours, theirs, merged: diff3 })).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 1 })
  })

  it('accepts a CRLF worktree over LF stages (core.autocrlf)', () => {
    const model = buildModel({ base, ours, theirs, merged: merged.replace(/\n/g, '\r\n') })
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 1, eol: '\r\n' })
  })

  it('accepts the newline git adds before a marker when a side has no final newline', () => {
    const model = buildModel({ base: 'a\nb', ours: 'a\nX', theirs: 'a\nY\n', merged: 'a\n<<<<<<< HEAD\nX\n=======\nY\n>>>>>>> other\n' })
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 1 })
    expect(conflictsOf(model.chunks)[0]).toMatchObject({ ours: ['X'], theirs: ['Y\n'] })
  })

  it('falls back to the markers when git merged the file differently', () => {
    // As if a merge driver or a merge option had settled the last line in its own way.
    const disk = t('A b c') + '<<<<<<< HEAD\nX\n=======\nY\n>>>>>>> other\n' + t('e f g') + 'H-merged-by-driver\n'
    const model = buildModel({ base, ours, theirs, merged: disk })
    expect(model).toMatchObject({ source: 'markers', diskMatches: true, conflicts: 1 })
    expect(shape(model.chunks)).toBe('=A,b,c !X|Y =e,f,g,H-merged-by-driver')
  })

  it('accepts wider conflicts on disk (diff3 style is not narrowed) as the same merge', () => {
    const b = t('a z')
    const o = t('a s1 s2 s3 s4 X z')
    const th = t('a s1 s2 s3 s4 Y z')
    const disk = 'a\n<<<<<<< HEAD\ns1\ns2\ns3\ns4\nX\n||||||| base\n=======\ns1\ns2\ns3\ns4\nY\n>>>>>>> other\nz\n'
    const model = buildModel({ base: b, ours: o, theirs: th, merged: disk })
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 1 })
    expect(shape(model.chunks)).toBe('=a,s1,s2,s3,s4 !X|Y =z')
  })

  it('markers model restores a missing final newline from the real sides', () => {
    const model = buildModel({
      base: 'a\nb',
      ours: 'a\nX',
      theirs: 'a\nY',
      merged: 'CHANGED\n<<<<<<< HEAD\nX\n=======\nY\n>>>>>>> other\n'
    })
    expect(model.source).toBe('markers')
    expect(conflictsOf(model.chunks)[0]).toMatchObject({ ours: ['X'], theirs: ['Y'] })
  })

  it('flags a file on disk that no longer has its markers', () => {
    const edited = t('A b c X-and-Y e f g H')
    expect(buildModel({ base, ours, theirs, merged: edited })).toMatchObject({ source: 'stages', diskMatches: false, conflicts: 1 })
    const half = t('A b c') + '<<<<<<< HEAD\nX\nY\n>>>>>>> other\n' + t('e f g H')
    expect(buildModel({ base, ours, theirs, merged: half })).toMatchObject({ source: 'stages', diskMatches: false, conflicts: 1 })
    expect(buildModel({ base, ours, theirs, merged: '' })).toMatchObject({ diskMatches: false })
  })

  it('content that legitimately contains marker lines still gets the right regions', () => {
    // A document about git: marker lines are part of all three versions.
    const doc = (word: string): string =>
      `Intro\n<<<<<<< HEAD\nexample ours\n=======\nexample theirs\n>>>>>>> branch\nTitle\n=======\n${word}\nend\n`
    const b = doc('base')
    const o = doc('OURS')
    const th = doc('THEIRS')
    // What git writes: real markers around the changed line, the example ones untouched.
    const disk = doc('<<<<<<< HEAD\nOURS\n=======\nTHEIRS\n>>>>>>> other')
    const model = buildModel({ base: b, ours: o, theirs: th, merged: disk })
    expect(model.source).toBe('stages')
    expect(model.conflicts).toBe(1)
    expect(conflictsOf(model.chunks)[0]).toMatchObject({ ours: ['OURS\n'], theirs: ['THEIRS\n'] })
    expect(sideText(model.chunks, 'ours')).toBe(o)
  })

  it('a file with nothing left to decide matches a clean file on disk', () => {
    // e.g. a conflict of file mode only: the text itself merges cleanly.
    const model = buildModel({ base, ours: t('A b c d e f g h'), theirs: t('a b c d e f g H'), merged: t('A b c d e f g H') })
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 0 })
  })

  it('add/add without base', () => {
    const o = t('h1 h2 h3 h4 mine t')
    const th = t('h1 h2 h3 h4 yours t')
    const disk = t('h1 h2 h3 h4') + '<<<<<<< HEAD\nmine\n=======\nyours\n>>>>>>> other\nt\n'
    const model = buildModel({ base: null, ours: o, theirs: th, merged: disk })
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 1 })
    expect(shape(model.chunks)).toBe('=h1,h2,h3,h4 !mine|yours =t')
  })
})
