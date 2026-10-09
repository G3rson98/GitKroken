import { describe, expect, it } from 'vitest'
import { parseDiff } from './parseDiff'
import { ROW_HEIGHT, buildRows, displayWidth, maxWidths, rowAt, rowOffsets, skippedBefore, visibleRange } from './rows'
import { tokenize, wordDiff } from './wordDiff'

const [file] = parseDiff(`diff --git a/f b/f
--- a/f
+++ b/f
@@ -3,6 +3,7 @@ head
 ctx 3
-old 4
-old 5
+new 4
+new 5
+new 6
 ctx 6
-old 7
 ctx 8
@@ -20,2 +21,3 @@
 ctx 20
+\tnew 22
 ctx 21
`)

describe('buildRows', () => {
  it('hunk view: a header row per hunk, then unified lines with their pairs', () => {
    const rows = buildRows(file, 'hunk')
    expect(rows.map((r) => r.kind)).toEqual([
      'hunk', 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line', 'line',
      'hunk', 'line', 'line', 'line'
    ])
    const lines = rows.flatMap((r) => (r.kind === 'line' ? [r] : []))
    expect(lines[1].line.text).toBe('old 4')
    expect(lines[1].pair?.text).toBe('new 4')
    expect(lines[3].line.text).toBe('new 4')
    expect(lines[3].pair?.text).toBe('old 4')
    expect(lines[5].line.text).toBe('new 6')
    expect(lines[5].pair).toBeNull()
    expect(lines[7].line.text).toBe('old 7')
    expect(lines[7].pair).toBeNull()
  })

  it('inline view: gap rows instead of headers, with the hidden line count', () => {
    const rows = buildRows(file, 'inline')
    const gaps = rows.flatMap((r) => (r.kind === 'gap' ? [r] : []))
    expect(gaps.map((g) => [g.hunkIndex, g.skipped])).toEqual([
      [0, 2],
      [1, 11]
    ])
    expect(rows.filter((r) => r.kind === 'hunk')).toHaveLength(0)
    expect(skippedBefore(file.hunks, 0)).toBe(2)
  })

  it('omits the gap when the first hunk starts at the top of the file', () => {
    const [top] = parseDiff('diff --git a/t b/t\n--- a/t\n+++ b/t\n@@ -1,2 +1,2 @@\n-a\n+b\n c\n')
    expect(buildRows(top, 'inline').map((r) => r.kind)).toEqual(['line', 'line', 'line'])
    const [created] = parseDiff('diff --git a/t b/t\nnew file mode 100644\n--- /dev/null\n+++ b/t\n@@ -0,0 +1 @@\n+a\n')
    expect(buildRows(created, 'split').map((r) => r.kind)).toEqual(['split'])
  })

  it('split view: aligns removed and added lines side by side', () => {
    const rows = buildRows(file, 'split').flatMap((r) => (r.kind === 'split' ? [r] : []))
    expect(rows.map((r) => [r.left?.text ?? null, r.right?.text ?? null])).toEqual([
      ['ctx 3', 'ctx 3'],
      ['old 4', 'new 4'],
      ['old 5', 'new 5'],
      [null, 'new 6'],
      ['ctx 6', 'ctx 6'],
      ['old 7', null],
      ['ctx 8', 'ctx 8'],
      ['ctx 20', 'ctx 20'],
      [null, '\tnew 22'],
      ['ctx 21', 'ctx 21']
    ])
    expect(rows[0].left?.oldNo).toBe(3)
    expect(rows[1].left?.oldNo).toBe(4)
    expect(rows[1].right?.newNo).toBe(4)
  })
})

describe('virtual list geometry', () => {
  const rows = buildRows(file, 'hunk')
  const offsets = rowOffsets(rows)

  it('computes prefix sums of row heights', () => {
    expect(offsets).toHaveLength(rows.length + 1)
    expect(offsets[0]).toBe(0)
    expect(offsets[1]).toBe(ROW_HEIGHT.hunk)
    expect(offsets[2]).toBe(ROW_HEIGHT.hunk + ROW_HEIGHT.line)
    expect(offsets[rows.length]).toBe(2 * ROW_HEIGHT.hunk + 12 * ROW_HEIGHT.line)
  })

  it('finds the row at a vertical position', () => {
    expect(rowAt(offsets, 0)).toBe(0)
    expect(rowAt(offsets, ROW_HEIGHT.hunk - 1)).toBe(0)
    expect(rowAt(offsets, ROW_HEIGHT.hunk)).toBe(1)
    expect(rowAt(offsets, 1e9)).toBe(rows.length - 1)
    expect(rowAt([0], 10)).toBe(0)
  })

  it('returns a chunk-aligned window that covers the viewport', () => {
    const many = rowOffsets(Array.from({ length: 5000 }, () => rows[1]))
    const r = visibleRange(many, 40_000, 600)
    expect(r.start % 20).toBe(0)
    expect(r.start).toBeLessThanOrEqual(2000 - 30)
    expect(r.end).toBeGreaterThanOrEqual(2030 + 30)
    expect(r.end - r.start).toBeLessThan(160)
    expect(visibleRange(many, 0, 600).start).toBe(0)
    expect(visibleRange(many, 1e9, 600).end).toBe(5000)
    expect(visibleRange([0], 0, 600)).toEqual({ start: 0, end: 0 })
    // scrolling a few pixels keeps the same window
    expect(visibleRange(many, 40_010, 600)).toEqual(r)
  })

  it('measures line widths with tabs expanded', () => {
    expect(displayWidth('abc')).toBe(3)
    expect(displayWidth('\tx')).toBe(5)
    expect(displayWidth('ab\tx')).toBe(5)
    expect(maxWidths(file)).toEqual({ old: 6, new: 10, all: 10 })
  })
})

describe('wordDiff', () => {
  const text = (segs: { text: string; changed: boolean }[]) =>
    segs.map((s) => (s.changed ? `[${s.text}]` : s.text)).join('')

  it('tokenizes into words, whitespace and punctuation', () => {
    expect(tokenize('const x = foo(1);')).toEqual(['const', ' ', 'x', ' ', '=', ' ', 'foo', '(', '1', ')', ';'])
    expect(tokenize('')).toEqual([])
  })

  it('highlights only the tokens that changed', () => {
    const d = wordDiff('const x = foo(1);', 'const x = bar(1, 2);')!
    expect(text(d.old)).toBe('const x = [foo](1);')
    expect(text(d.new)).toBe('const x = [bar](1[, 2]);')
    expect(d.old.map((s) => s.text).join('')).toBe('const x = foo(1);')
    expect(d.new.map((s) => s.text).join('')).toBe('const x = bar(1, 2);')
  })

  it('handles pure insertions and indentation changes', () => {
    const d = wordDiff('return value', 'return await value')!
    expect(text(d.old)).toBe('return value')
    expect(text(d.new)).toBe('return [await ]value')
    const indent = wordDiff('  foo()', '    foo()')!
    expect(text(indent.new)).toBe('[    ]foo()')
  })

  it('gives up on identical, unrelated or huge lines', () => {
    expect(wordDiff('same', 'same')).toBeNull()
    expect(wordDiff('import { a } from "b"', 'export default function main() {}')).toBeNull()
    expect(wordDiff('x'.repeat(5000), 'y')).toBeNull()
    expect(wordDiff('', 'abc')).toBeNull()
  })

  it('stays fast on long lines', () => {
    const a = Array.from({ length: 900 }, (_, i) => `w${i}`).join(' ')
    const b = Array.from({ length: 900 }, (_, i) => `w${i * 2}`).join(' ')
    const t = Date.now()
    wordDiff(a, b)
    expect(Date.now() - t).toBeLessThan(500)
  })
})
