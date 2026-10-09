import { describe, expect, it } from 'vitest'
import { findDiffFile, parseDiff, unquotePath } from './parseDiff'

const MODIFIED = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -1,5 +1,6 @@
 import a from 'a'
-const x = 1
+const x = 2
+const y = 3

 export default x
 // end
@@ -20,4 +21,3 @@ function tail() {
   return 1
-  // removed
 }

`

describe('parseDiff', () => {
  it('returns no files for an empty diff', () => {
    expect(parseDiff('')).toEqual([])
    expect(parseDiff('\n')).toEqual([])
  })

  it('parses file header, hunks and line numbers', () => {
    const [f, ...rest] = parseDiff(MODIFIED)
    expect(rest).toHaveLength(0)
    expect(f.oldPath).toBe('src/app.ts')
    expect(f.newPath).toBe('src/app.ts')
    expect(f.status).toBe('modified')
    expect(f.binary).toBe(false)
    expect(f.oldMode).toBe('100644')
    expect(f.additions).toBe(2)
    expect(f.deletions).toBe(2)
    expect(f.headerLines).toEqual([
      'diff --git a/src/app.ts b/src/app.ts',
      'index 1111111..2222222 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts'
    ])
    expect(f.hunks).toHaveLength(2)

    const [h1, h2] = f.hunks
    expect(h1).toMatchObject({ oldStart: 1, oldLines: 5, newStart: 1, newLines: 6, section: '' })
    expect(h1.lines.map((l) => [l.type, l.oldNo, l.newNo, l.text])).toEqual([
      ['context', 1, 1, "import a from 'a'"],
      ['del', 2, null, 'const x = 1'],
      ['add', null, 2, 'const x = 2'],
      ['add', null, 3, 'const y = 3'],
      ['context', 3, 4, ''],
      ['context', 4, 5, 'export default x'],
      ['context', 5, 6, '// end']
    ])

    expect(h2).toMatchObject({ oldStart: 20, oldLines: 4, newStart: 21, newLines: 3, section: 'function tail() {' })
    expect(h2.header).toBe('@@ -20,4 +21,3 @@ function tail() {')
    expect(h2.lines.map((l) => [l.type, l.oldNo, l.newNo])).toEqual([
      ['context', 20, 21],
      ['del', 21, null],
      ['context', 22, 22],
      ['context', 23, 23]
    ])
  })

  it('survives output whose trailing whitespace was trimmed', () => {
    const [f] = parseDiff(MODIFIED.trimEnd())
    // the last blank context line lost its single space: it is simply missing
    expect(f.hunks[1].lines.map((l) => l.type)).toEqual(['context', 'del', 'context'])
    const [g] = parseDiff(MODIFIED.replace(/^ $/gm, ''))
    expect(g.hunks[0].lines[4]).toMatchObject({ type: 'context', text: '', oldNo: 3, newNo: 4 })
    expect(g.hunks[1].lines).toHaveLength(4)
  })

  it('defaults omitted hunk counts to 1', () => {
    const [f] = parseDiff(`diff --git a/one b/one
--- a/one
+++ b/one
@@ -1 +1 @@
-old
+new
`)
    expect(f.hunks[0]).toMatchObject({ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1 })
    expect(f.hunks[0].lines).toHaveLength(2)
  })

  it('marks lines followed by "\\ No newline at end of file"', () => {
    const [f] = parseDiff(`diff --git a/x b/x
index 1..2 100644
--- a/x
+++ b/x
@@ -1,2 +1,2 @@
 keep
-old end
\\ No newline at end of file
+new end
\\ No newline at end of file
`)
    const lines = f.hunks[0].lines
    expect(lines).toHaveLength(3)
    expect(lines[0].noNewline).toBeUndefined()
    expect(lines[1]).toMatchObject({ type: 'del', text: 'old end', noNewline: true })
    expect(lines[2]).toMatchObject({ type: 'add', text: 'new end', noNewline: true })
  })

  it('does not confuse removed/added lines that look like headers', () => {
    const [f, ...rest] = parseDiff(`diff --git a/q.sql b/q.sql
index 1..2 100644
--- a/q.sql
+++ b/q.sql
@@ -1,3 +1,3 @@
--- a comment
-diff --git a/fake b/fake
+++ plus
+@@ -1 +1 @@
 select 1
`)
    expect(rest).toHaveLength(0)
    expect(f.newPath).toBe('q.sql')
    expect(f.hunks).toHaveLength(1)
    expect(f.hunks[0].lines.map((l) => [l.type, l.text])).toEqual([
      ['del', '-- a comment'],
      ['del', 'diff --git a/fake b/fake'],
      ['add', '++ plus'],
      ['add', '@@ -1 +1 @@'],
      ['context', 'select 1']
    ])
  })

  it('parses new files', () => {
    const [f] = parseDiff(`diff --git a/new.txt b/new.txt
new file mode 100755
index 0000000..3333333
--- /dev/null
+++ b/new.txt
@@ -0,0 +1,2 @@
+one
+two
`)
    expect(f.status).toBe('added')
    expect(f.oldPath).toBeNull()
    expect(f.newPath).toBe('new.txt')
    expect(f.newMode).toBe('100755')
    expect(f.hunks[0]).toMatchObject({ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2 })
    expect(f.hunks[0].lines.map((l) => [l.oldNo, l.newNo])).toEqual([
      [null, 1],
      [null, 2]
    ])
  })

  it('parses deleted files', () => {
    const [f] = parseDiff(`diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 3333333..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-one
-two
`)
    expect(f.status).toBe('deleted')
    expect(f.oldPath).toBe('gone.txt')
    expect(f.newPath).toBeNull()
    expect(f.oldMode).toBe('100644')
    expect(f.deletions).toBe(2)
    expect(f.hunks[0].lines.map((l) => [l.oldNo, l.newNo])).toEqual([
      [1, null],
      [2, null]
    ])
  })

  it('parses an empty new file (no hunks, no ---/+++ lines)', () => {
    const [f] = parseDiff(`diff --git a/dir/empty file.txt b/dir/empty file.txt
new file mode 100644
index 0000000..e69de29
`)
    expect(f.status).toBe('added')
    expect(f.newPath).toBe('dir/empty file.txt')
    expect(f.hunks).toHaveLength(0)
  })

  it('parses renames with and without content changes', () => {
    const [pure, edited] = parseDiff(`diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/lib/a.ts b/lib/b.ts
similarity index 87%
rename from lib/a.ts
rename to lib/b.ts
index 1..2 100644
--- a/lib/a.ts
+++ b/lib/b.ts
@@ -1,2 +1,2 @@
-a
+b
 same
`)
    expect(pure).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', newPath: 'new name.txt', similarity: 100 })
    expect(pure.hunks).toHaveLength(0)
    expect(edited).toMatchObject({ status: 'renamed', oldPath: 'lib/a.ts', newPath: 'lib/b.ts', similarity: 87 })
    expect(edited.hunks).toHaveLength(1)
  })

  it('parses copies and mode changes', () => {
    const [copy, mode] = parseDiff(`diff --git a/a.sh b/b.sh
similarity index 100%
copy from a.sh
copy to b.sh
diff --git a/run.sh b/run.sh
old mode 100644
new mode 100755
`)
    expect(copy).toMatchObject({ status: 'copied', oldPath: 'a.sh', newPath: 'b.sh' })
    expect(mode).toMatchObject({ status: 'modified', oldMode: '100644', newMode: '100755', newPath: 'run.sh' })
  })

  it('flags binary files', () => {
    const [mod, added, literal] = parseDiff(`diff --git a/img.png b/img.png
index 1..2 100644
Binary files a/img.png and b/img.png differ
diff --git a/new.bin b/new.bin
new file mode 100644
index 0000000..2
Binary files /dev/null and b/new.bin differ
diff --git a/lit.bin b/lit.bin
index 1..2 100644
GIT binary patch
literal 4
LcmZQzU|?VY00IC2

literal 3
KcmZQzU|;|M00aO5

`)
    expect(mod).toMatchObject({ binary: true, status: 'modified', newPath: 'img.png' })
    expect(mod.hunks).toHaveLength(0)
    expect(added).toMatchObject({ binary: true, status: 'added', newPath: 'new.bin', oldPath: null })
    expect(literal).toMatchObject({ binary: true, newPath: 'lit.bin' })
  })

  it('parses several files in one diff', () => {
    const files = parseDiff(MODIFIED + MODIFIED.replaceAll('src/app.ts', 'src/other.ts'))
    expect(files.map((f) => f.newPath)).toEqual(['src/app.ts', 'src/other.ts'])
    expect(files.map((f) => f.hunks.length)).toEqual([2, 2])
    expect(findDiffFile(files, 'src/other.ts')).toBe(files[1])
    expect(findDiffFile(files, 'nope')).toBe(files[0])
    expect(findDiffFile([], 'nope')).toBeNull()
  })

  it('handles quoted paths, paths with spaces and custom prefixes', () => {
    const [quoted, spaced, mnemonic] = parseDiff(`diff --git "a/sp\\303\\244ce\\t.txt" "b/sp\\303\\244ce\\t.txt"
index 1..2 100644
--- "a/sp\\303\\244ce\\t.txt"
+++ "b/sp\\303\\244ce\\t.txt"
@@ -1 +1 @@
-a
+b
diff --git a/my file.txt b/my file.txt
index 1..2 100644
--- a/my file.txt\t
+++ b/my file.txt\t
@@ -1 +1 @@
-a
+b
diff --git i/x.txt w/x.txt
index 1..2 100644
--- i/x.txt
+++ w/x.txt
@@ -1 +1 @@
-a
+b
`)
    expect(quoted.newPath).toBe('späce\t.txt')
    expect(spaced.oldPath).toBe('my file.txt')
    expect(spaced.newPath).toBe('my file.txt')
    expect(mnemonic.oldPath).toBe('x.txt')
    expect(mnemonic.newPath).toBe('x.txt')
  })

  it('keeps CR characters of CRLF files in the line text', () => {
    const [f] = parseDiff('diff --git a/w b/w\n--- a/w\n+++ b/w\n@@ -1 +1 @@\n-a\r\n+b\r\n')
    expect(f.hunks[0].lines.map((l) => l.text)).toEqual(['a\r', 'b\r'])
  })

  it('flattens combined diffs of unmerged files', () => {
    const [f] = parseDiff(`diff --cc conflict.txt
index 1111111,2222222..0000000
--- a/conflict.txt
+++ b/conflict.txt
@@@ -1,3 -1,3 +1,7 @@@
  first
++<<<<<<< HEAD
 +ours
++=======
+ theirs
++>>>>>>> branch
- gone-from-ours
  last
`)
    expect(f.combined).toBe(true)
    expect(f.newPath).toBe('conflict.txt')
    expect(f.hunks).toHaveLength(1)
    expect(f.hunks[0].lines.map((l) => [l.type, l.text, l.newNo])).toEqual([
      ['context', 'first', 1],
      ['add', '<<<<<<< HEAD', 2],
      ['add', 'ours', 3],
      ['add', '=======', 4],
      ['add', 'theirs', 5],
      ['add', '>>>>>>> branch', 6],
      ['del', 'gone-from-ours', null],
      ['context', 'last', 7]
    ])
  })
})

describe('unquotePath', () => {
  it('leaves plain paths alone', () => {
    expect(unquotePath('a/b c.txt')).toBe('a/b c.txt')
  })
  it('decodes escapes and UTF-8 octal sequences', () => {
    expect(unquotePath('"a\\\\b\\"c\\n"')).toBe('a\\b"c\n')
    expect(unquotePath('"\\346\\227\\245\\346\\234\\254.txt"')).toBe('日本.txt')
  })
})
