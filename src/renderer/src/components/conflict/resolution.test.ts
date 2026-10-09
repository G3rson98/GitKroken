// Checkbox state -> result text, hand edits, progress and the pane rows.
import { describe, expect, it } from 'vitest'
import { buildModel, type ConflictChunk, type ConflictModel } from './regions'
import {
  applyEdit,
  buildRows,
  chosenLines,
  emptyChoice,
  finalText,
  isResolved,
  joinBlocks,
  outputBlocks,
  progress,
  sideRank,
  sideState,
  takeSide,
  toggleLine,
  toggleNone,
  toggleSide,
  type Choice,
  type ManualEdits
} from './resolution'

const LABELS = { ours: 'main', theirs: 'other' }
const NONE: ManualEdits = new Map()
const t = (words: string): string => (words === '' ? '' : words.split(' ').join('\n') + '\n')

/** Model straight from the three versions (the file on disk does not matter here) */
const modelOf = (base: string, ours: string, theirs: string): ConflictModel => buildModel({ base, ours, theirs, merged: '' })
const conflictsOf = (model: ConflictModel): ConflictChunk[] =>
  model.chunks.filter((c): c is ConflictChunk => c.kind === 'conflict')
const fresh = (model: ConflictModel): Choice[] => conflictsOf(model).map(emptyChoice)
const text = (model: ConflictModel, choices: Choice[], manual: ManualEdits = NONE): string =>
  joinBlocks(outputBlocks(model, choices, manual, LABELS))

// Two conflicts (b and i) and one automatic merge (theirs changed e... far enough from both).
const two = (): ConflictModel =>
  modelOf(
    t('a b c d e f g h i j k l m n o p'),
    t('a B1 B2 c d e f g h i j k l m O p'),
    t('a Y c d e f g H i j k l m Z p')
  )

describe('choices', () => {
  const conflict: ConflictChunk = { kind: 'conflict', index: 0, ours: ['o1\n', 'o2\n'], theirs: ['t1\n'], base: null }

  it('starts unresolved', () => {
    const c = emptyChoice(conflict)
    expect(c).toEqual({ order: [], ours: [false, false], theirs: [false], none: false })
    expect(isResolved(c)).toBe(false)
    expect(sideState(c, 'ours')).toBe('none')
    expect(chosenLines(conflict, c)).toEqual([])
  })

  it('ticking a side takes all its lines; unticking drops it', () => {
    let c = toggleSide(emptyChoice(conflict), 'theirs')
    expect(c.order).toEqual(['theirs'])
    expect(sideState(c, 'theirs')).toBe('all')
    expect(isResolved(c)).toBe(true)
    expect(chosenLines(conflict, c)).toEqual(['t1\n'])
    c = toggleSide(c, 'theirs')
    expect(c).toEqual(emptyChoice(conflict))
  })

  it('both sides come out in the order they were ticked', () => {
    let c = toggleSide(toggleSide(emptyChoice(conflict), 'theirs'), 'ours')
    expect(c.order).toEqual(['theirs', 'ours'])
    expect(chosenLines(conflict, c)).toEqual(['t1\n', 'o1\n', 'o2\n'])
    expect([sideRank(c, 'theirs'), sideRank(c, 'ours')]).toEqual([1, 2])
    // Unticking and ticking again moves a side to the end.
    c = toggleSide(toggleSide(c, 'theirs'), 'theirs')
    expect(c.order).toEqual(['ours', 'theirs'])
    expect(chosenLines(conflict, c)).toEqual(['o1\n', 'o2\n', 't1\n'])
    expect(sideRank(toggleSide(emptyChoice(conflict), 'ours'), 'ours')).toBe(0)
  })

  it('single lines can be picked; lines of a side keep their file order', () => {
    let c = toggleLine(emptyChoice(conflict), 'ours', 1)
    expect(c.order).toEqual(['ours'])
    expect(sideState(c, 'ours')).toBe('some')
    expect(chosenLines(conflict, c)).toEqual(['o2\n'])
    c = toggleLine(c, 'theirs', 0)
    c = toggleLine(c, 'ours', 0)
    expect(sideState(c, 'ours')).toBe('all')
    expect(chosenLines(conflict, c)).toEqual(['o1\n', 'o2\n', 't1\n'])
    // The last line of a side leaving takes the side out of the order.
    c = toggleLine(toggleLine(c, 'ours', 0), 'ours', 1)
    expect(c.order).toEqual(['theirs'])
    c = toggleLine(c, 'theirs', 0)
    expect(isResolved(c)).toBe(false)
    expect(toggleLine(c, 'ours', 7)).toBe(c)
  })

  it('a partly ticked side is completed by its checkbox, then cleared', () => {
    let c = toggleLine(emptyChoice(conflict), 'ours', 0)
    c = toggleSide(c, 'ours')
    expect(sideState(c, 'ours')).toBe('all')
    c = toggleSide(c, 'ours')
    expect(sideState(c, 'ours')).toBe('none')
  })

  it('"neither" settles the conflict with nothing, and any tick undoes it', () => {
    let c = toggleNone(toggleSide(emptyChoice(conflict), 'ours'))
    expect(c).toEqual({ order: [], ours: [false, false], theirs: [false], none: true })
    expect(isResolved(c)).toBe(true)
    expect(chosenLines(conflict, c)).toEqual([])
    expect(toggleNone(c).none).toBe(false)
    c = toggleLine(c, 'theirs', 0)
    expect(c.none).toBe(false)
    expect(c.order).toEqual(['theirs'])
    expect(toggleSide(toggleNone(emptyChoice(conflict)), 'ours').none).toBe(false)
  })

  it('a side with no lines (it deleted them) can still be chosen', () => {
    const del: ConflictChunk = { kind: 'conflict', index: 0, ours: [], theirs: ['t\n'], base: ['b\n'] }
    const c = takeSide(del, 'ours')
    expect(c.order).toEqual(['ours'])
    expect(isResolved(c)).toBe(true)
    expect(sideState(c, 'ours')).toBe('all')
    expect(chosenLines(del, c)).toEqual([])
  })
})

describe('result', () => {
  it('shows unresolved conflicts with markers and resolved ones with the chosen lines', () => {
    const model = two()
    expect(model.conflicts).toBe(2)
    const choices = fresh(model)
    expect(text(model, choices)).toBe(
      'a\n<<<<<<< main\nB1\nB2\n=======\nY\n>>>>>>> other\nc\nd\ne\nf\ng\nH\ni\nj\nk\nl\nm\n<<<<<<< main\nO\n=======\nZ\n>>>>>>> other\np\n'
    )
    choices[0] = toggleSide(choices[0]!, 'theirs')
    expect(text(model, choices)).toBe('a\nY\nc\nd\ne\nf\ng\nH\ni\nj\nk\nl\nm\n<<<<<<< main\nO\n=======\nZ\n>>>>>>> other\np\n')
    choices[0] = toggleSide(choices[0]!, 'ours')
    choices[1] = toggleNone(choices[1]!)
    expect(text(model, choices)).toBe(t('a Y B1 B2 c d e f g H i j k l m p'))
    expect(finalText(model, choices, NONE, LABELS)).toBe(t('a Y B1 B2 c d e f g H i j k l m p'))
  })

  it('blocks know where they start', () => {
    const model = two()
    const blocks = outputBlocks(model, fresh(model), NONE, LABELS)
    expect(blocks.map((b) => [model.chunks[b.chunk]!.kind, b.line, b.breaks])).toEqual([
      ['same', 0, 1],
      ['conflict', 1, 6],
      ['same', 7, 5],
      ['auto', 12, 1],
      ['same', 13, 5],
      ['conflict', 18, 5],
      ['same', 23, 1]
    ])
    expect(blocks.every((b) => !b.manual)).toBe(true)
  })

  it('CRLF files: "\\n" on screen, the original terminators on disk', () => {
    const crlf = (words: string): string => words.split(' ').join('\r\n') + '\r\n'
    const model = modelOf(crlf('a b c'), crlf('a X c'), crlf('a Y c'))
    expect(model.eol).toBe('\r\n')
    const choices = fresh(model)
    expect(text(model, choices)).toBe('a\n<<<<<<< main\nX\n=======\nY\n>>>>>>> other\nc\n')
    expect(finalText(model, choices, NONE, LABELS)).toBe('a\r\n<<<<<<< main\r\nX\r\n=======\r\nY\r\n>>>>>>> other\r\nc\r\n')
    choices[0] = toggleSide(toggleSide(choices[0]!, 'ours'), 'theirs')
    expect(text(model, choices)).toBe('a\nX\nY\nc\n')
    expect(finalText(model, choices, NONE, LABELS)).toBe('a\r\nX\r\nY\r\nc\r\n')
  })

  it('a missing final newline is kept, and added only where a line is no longer last', () => {
    const model = modelOf('a\nb', 'a\nX', 'a\nY\n')
    const [conflict] = conflictsOf(model)
    expect(conflict).toMatchObject({ ours: ['X'], theirs: ['Y\n'] })
    expect(finalText(model, [takeSide(conflict!, 'ours')], NONE, LABELS)).toBe('a\nX')
    expect(finalText(model, [takeSide(conflict!, 'theirs')], NONE, LABELS)).toBe('a\nY\n')
    // ours then theirs: "X" is not the last line any more
    expect(finalText(model, [toggleSide(takeSide(conflict!, 'ours'), 'theirs')], NONE, LABELS)).toBe('a\nX\nY\n')
    expect(finalText(model, [toggleSide(takeSide(conflict!, 'theirs'), 'ours')], NONE, LABELS)).toBe('a\nY\nX')
    // unresolved: markers on their own lines, like git
    expect(finalText(model, [emptyChoice(conflict!)], NONE, LABELS)).toBe('a\n<<<<<<< main\nX\n=======\nY\n>>>>>>> other\n')

    // The unterminated line is common text followed by nothing: stays as it is.
    const tail = modelOf('a\nb\nc\nd\ne\nend', 'A\nb\nc\nd\ne\nend', 'A2\nb\nc\nd\ne\nend')
    expect(finalText(tail, [takeSide(conflictsOf(tail)[0]!, 'theirs')], NONE, LABELS)).toBe('A2\nb\nc\nd\ne\nend')
  })

  it('conflicts at the first and at the last line', () => {
    const model = modelOf(t('a b c d e f g h'), t('A b c d e f g H'), t('A2 b c d e f g H2'))
    const choices = fresh(model)
    expect(text(model, choices).startsWith('<<<<<<< main\nA\n')).toBe(true)
    expect(text(model, choices).endsWith('H2\n>>>>>>> other\n')).toBe(true)
    choices[0] = toggleSide(choices[0]!, 'ours')
    choices[1] = toggleSide(choices[1]!, 'theirs')
    expect(text(model, choices)).toBe(t('A b c d e f g H2'))
  })
})

describe('hand edits', () => {
  const edit = (model: ConflictModel, choices: Choice[], manual: ManualEdits, change: (s: string) => string): ManualEdits => {
    const blocks = outputBlocks(model, choices, manual, LABELS)
    return applyEdit(blocks, manual, change(joinBlocks(blocks)))
  }
  const kinds = (model: ConflictModel, manual: ManualEdits): string[] =>
    [...manual.keys()].sort((a, b) => a - b).map((i) => model.chunks[i]!.kind)

  it('typing inside a block makes just that block manual', () => {
    const model = two()
    const choices = fresh(model)
    choices[0] = toggleSide(choices[0]!, 'theirs')
    const manual = edit(model, choices, NONE, (s) => s.replace('Y\n', 'Y edited\n'))
    expect(kinds(model, manual)).toEqual(['conflict'])
    expect(text(model, choices, manual)).toContain('a\nY edited\nc\n')
    const blocks = outputBlocks(model, choices, manual, LABELS)
    expect(blocks.filter((b) => b.manual).map((b) => b.text)).toEqual(['Y edited\n'])
  })

  it('ticking another conflict afterwards keeps the edit', () => {
    const model = two()
    const choices = fresh(model)
    choices[0] = toggleSide(choices[0]!, 'theirs')
    const manual = edit(model, choices, NONE, (s) => s.replace('Y\n', 'Y edited\n'))
    choices[1] = toggleSide(choices[1]!, 'ours')
    expect(text(model, choices, manual)).toBe(t('a Yedited c d e f g H i j k l m O p').replace('Yedited', 'Y edited'))
    // ... and so does ticking a box of the edited conflict itself, until the caller drops the edit.
    choices[0] = toggleSide(choices[0]!, 'ours')
    expect(text(model, choices, manual)).toContain('Y edited\n')
    const dropped = new Map(manual)
    dropped.delete(1)
    expect(text(model, choices, dropped)).toBe(t('a Y B1 B2 c d e f g H i j k l m O p'))
  })

  it('edits in common text are kept through every checkbox change', () => {
    const model = two()
    let choices = fresh(model)
    const manual = edit(model, choices, NONE, (s) => s.replace('\nj\n', '\nj // nota\n'))
    expect(kinds(model, manual)).toEqual(['same'])
    choices = choices.map((c) => toggleSide(c, 'ours'))
    expect(text(model, choices, manual)).toBe(t('a B1 B2 c d e f g H i j//nota k l m O p').replace('j//nota', 'j // nota'))
    expect(finalText(model, choices, manual, LABELS)).toContain('j // nota\n')
  })

  it('resolving a conflict by hand: the markers are simply deleted', () => {
    const model = two()
    const choices = fresh(model)
    const manual = edit(model, choices, NONE, (s) => s.replace('<<<<<<< main\nB1\nB2\n=======\nY\n>>>>>>> other\n', 'B1 + Y\n'))
    expect(kinds(model, manual)).toEqual(['conflict'])
    const blocks = outputBlocks(model, choices, manual, LABELS)
    const p = progress(model, choices, blocks)
    expect(p).toMatchObject({ total: 2, resolved: 1, done: [true, false] })
    // The other conflict still shows its markers, at the right line.
    expect(p.markerLine).toBe(13)
    expect(joinBlocks(blocks).split('\n')[13]).toBe('<<<<<<< main')
  })

  it('an edit across several blocks leaves the text in the first and the rest of the last', () => {
    const model = two()
    const choices = fresh(model)
    // Select from the middle of the first common block to the middle of the block after the conflict.
    const manual = edit(model, choices, NONE, (s) => s.replace(/^a\n<<<<<<< main[\s\S]*?>>>>>>> other\nc\nd\n/, 'REPLACED\n'))
    expect(kinds(model, manual)).toEqual(['same', 'conflict', 'same'])
    const blocks = outputBlocks(model, choices, manual, LABELS)
    expect(blocks.slice(0, 3).map((b) => b.text)).toEqual(['REPLACED', '', '\ne\nf\ng\n'])
    expect(progress(model, choices, blocks).done).toEqual([true, false])
    expect(joinBlocks(blocks).startsWith('REPLACED\ne\nf\ng\nH\n')).toBe(true)
  })

  it('typing at a block boundary and at the ends of the text', () => {
    const model = two()
    const choices = fresh(model).map((c) => toggleNone(c))
    expect(text(model, choices)).toBe(t('a c d e f g H i j k l m p'))
    // Start of the text
    let manual = edit(model, choices, NONE, (s) => 'first\n' + s)
    expect(text(model, choices, manual)).toBe('first\n' + t('a c d e f g H i j k l m p'))
    // End of the text
    manual = edit(model, choices, manual, (s) => s + 'last\n')
    expect(text(model, choices, manual).endsWith('p\nlast\n')).toBe(true)
    // Right where an emptied conflict sits (between "a" and "c"): goes to the next block with text
    manual = edit(model, choices, manual, (s) => s.replace('a\nc\n', 'a\nbetween\nc\n'))
    expect(text(model, choices, manual)).toBe('first\na\nbetween\nc\nd\ne\nf\ng\nH\ni\nj\nk\nl\nm\np\nlast\n')
    // Bringing the conflict back does not disturb any of it
    choices[0] = takeSide(conflictsOf(model)[0]!, 'theirs')
    expect(text(model, choices, manual)).toBe('first\na\nY\nbetween\nc\nd\ne\nf\ng\nH\ni\nj\nk\nl\nm\np\nlast\n')
  })

  it('deleting everything and typing from scratch', () => {
    const model = two()
    const choices = fresh(model)
    let manual = edit(model, choices, NONE, () => '')
    expect(text(model, choices, manual)).toBe('')
    expect(progress(model, choices, outputBlocks(model, choices, manual, LABELS))).toMatchObject({ resolved: 2, markerLine: -1 })
    manual = edit(model, choices, manual, () => 'all new\n')
    expect(text(model, choices, manual)).toBe('all new\n')
    expect(finalText(model, choices, manual, LABELS)).toBe('all new\n')
  })

  it('no change, no edit', () => {
    const model = two()
    const choices = fresh(model)
    expect(edit(model, choices, NONE, (s) => s)).toBe(NONE)
  })

  it('a random sequence of edits always reproduces what was typed', () => {
    const model = two()
    const choices = fresh(model)
    let manual: ManualEdits = NONE
    let seed = 42
    const rnd = (n: number): number => {
      seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
      return seed % n
    }
    for (let step = 0; step < 400; step++) {
      const blocks = outputBlocks(model, choices, manual, LABELS)
      const before = joinBlocks(blocks)
      const at = rnd(before.length + 1)
      const del = rnd(4) === 0 ? rnd(30) : rnd(3)
      const ins = ['', 'x', '\n', 'word\n', '<<<<<<< x\n', 'a'][rnd(6)]!
      const after = before.slice(0, at) + ins + before.slice(at + del)
      manual = applyEdit(blocks, manual, after)
      expect(text(model, choices, manual)).toBe(after)
      if (step % 50 === 49) {
        // A checkbox change in between must not move hand-typed text of other blocks.
        choices[step % 2] = toggleSide(choices[step % 2]!, 'ours')
      }
    }
  })

  it('hand-edited blocks keep "\\n"; untouched ones keep CRLF', () => {
    const crlf = (words: string): string => words.split(' ').join('\r\n') + '\r\n'
    const model = modelOf(crlf('a b c'), crlf('a X c'), crlf('a Y c'))
    const choices = [takeSide(conflictsOf(model)[0]!, 'ours')]
    const manual = edit(model, choices, NONE, (s) => s.replace('X\n', 'X!\nmore\n'))
    // The backend turns the "\n" of the edited block into the file's CRLF when it writes.
    expect(finalText(model, choices, manual, LABELS)).toBe('a\r\nX!\nmore\nc\r\n')
  })
})

describe('progress', () => {
  it('counts conflicts settled by boxes, by "neither" or by hand', () => {
    const model = two()
    const choices = fresh(model)
    const at = (manual: ManualEdits = NONE) => progress(model, choices, outputBlocks(model, choices, manual, LABELS))
    expect(at()).toEqual({ total: 2, resolved: 0, done: [false, false], markerLine: 1 })
    choices[0] = toggleLine(choices[0]!, 'ours', 1)
    expect(at()).toEqual({ total: 2, resolved: 1, done: [true, false], markerLine: 13 })
    choices[1] = toggleNone(choices[1]!)
    expect(at()).toEqual({ total: 2, resolved: 2, done: [true, true], markerLine: -1 })
  })

  it('generated text is never scanned for markers, hand-typed text is', () => {
    // The file legitimately contains marker-looking lines on both sides.
    const doc = (word: string): string => `intro\n=======\n<<<<<<< sample\n${word}\n>>>>>>> sample\nend\n`
    const model = modelOf(doc('base'), doc('OURS'), doc('THEIRS'))
    const choices = [takeSide(conflictsOf(model)[0]!, 'ours')]
    let blocks = outputBlocks(model, choices, NONE, LABELS)
    expect(joinBlocks(blocks)).toBe(doc('OURS'))
    expect(progress(model, choices, blocks)).toMatchObject({ resolved: 1, markerLine: -1 })

    // The user pastes a marker into common text: now it is reported, with its line.
    const manual = applyEdit(blocks, NONE, joinBlocks(blocks).replace('end\n', 'end\n>>>>>>> oops\n'))
    blocks = outputBlocks(model, choices, manual, LABELS)
    const p = progress(model, choices, blocks)
    expect(p.resolved).toBe(1)
    expect(joinBlocks(blocks).split('\n')[p.markerLine]).toBe('>>>>>>> oops')
  })

  it('a file without conflicts is complete', () => {
    const model = modelOf(t('a b c d e'), t('A b c d e'), t('a b c d E'))
    expect(progress(model, [], outputBlocks(model, [], NONE, LABELS))).toEqual({ total: 0, resolved: 0, done: [], markerLine: -1 })
  })
})

describe('buildRows', () => {
  it('aligns both panes row by row, with each side`s own line numbers', () => {
    // conflict (2 lines vs 1), then an automatic change from theirs, common text around
    const model = two()
    const { rows, headRow, oursLines, theirsLines, maxChars } = buildRows(model)
    const brief = rows.map((r) =>
      r.kind === 'head'
        ? `#${r.conflict}`
        : `${r.type[0]}${r.conflict >= 0 ? r.conflict : ''} ${r.ours ? r.ours.no + ':' + r.ours.text : '-'} | ${r.theirs ? r.theirs.no + ':' + r.theirs.text : '-'}`
    )
    expect(brief.slice(0, 5)).toEqual(['s 1:a | 1:a', '#0', 'c0 2:B1 | 2:Y', 'c0 3:B2 | -', 's 4:c | 3:c'])
    expect(brief).toContain('a 9:h | 8:H')
    expect(brief.slice(-3)).toEqual(['#1', 'c1 15:O | 14:Z', 's 16:p | 15:p'])
    expect(headRow).toEqual([1, brief.length - 3])
    expect(oursLines).toBe(16)
    expect(theirsLines).toBe(15)
    expect(maxChars).toBe(2)
    const auto = rows.find((r) => r.kind === 'line' && r.type === 'auto')
    expect(auto).toMatchObject({ from: 'theirs', conflict: -1 })
    // The per-line checkboxes address lines by their index inside the conflict.
    expect(rows.filter((r) => r.kind === 'line' && r.conflict === 0).map((r) => (r.kind === 'line' ? r.index : -1))).toEqual([0, 1])
  })

  it('marks an unterminated last line and handles empty sides', () => {
    const model = modelOf('a\nb\nc', 'a\nc', 'a\nB\nc\n')
    const { rows } = buildRows(model)
    const lines = rows.flatMap((r) => (r.kind === 'line' ? [r] : []))
    expect(lines.some((r) => r.ours?.noEol)).toBe(true)
    expect(lines.every((r) => !r.theirs?.noEol)).toBe(true)
    expect(buildRows(modelOf('', '', ''))).toEqual({ rows: [], headRow: [], oursLines: 0, theirsLines: 0, maxChars: 0 })
  })
})
