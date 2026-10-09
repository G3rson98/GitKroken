import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { parseDiff, type DiffFile } from './parseDiff'
import { buildHunkPatch, formatHunkHeader, serializeHunk } from './patch'

const SAMPLE = `diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,5 @@
 a
+inserted
 b
 c
 d
@@ -10,4 +11,3 @@ section
 j
-k
 l
 m
@@ -20,3 +20,3 @@
 t
-u
+U
\\ No newline at end of file
`

describe('formatHunkHeader', () => {
  it('uses the short form when a count is 1', () => {
    expect(formatHunkHeader(3, 1, 3, 1)).toBe('@@ -3 +3 @@')
    expect(formatHunkHeader(0, 0, 1, 2)).toBe('@@ -0,0 +1,2 @@')
    expect(formatHunkHeader(5, 3, 6, 4, 'fn()')).toBe('@@ -5,3 +6,4 @@ fn()')
  })
})

describe('buildHunkPatch', () => {
  const [file] = parseDiff(SAMPLE)

  it('emits the file header followed by only the requested hunk', () => {
    expect(buildHunkPatch(file, 0)).toBe(`diff --git a/f.txt b/f.txt
index 1111111..2222222 100644
--- a/f.txt
+++ b/f.txt
@@ -1,4 +1,5 @@
 a
+inserted
 b
 c
 d
`)
  })

  it('rebases the new-side start on the old side for forward patches', () => {
    // in the full diff this hunk starts at +11 because of the first hunk
    expect(buildHunkPatch(file, 1).split('\n')[4]).toBe('@@ -10,4 +10,3 @@ section')
  })

  it('rebases the old-side start on the new side for reverse patches', () => {
    expect(buildHunkPatch(file, 1, { reverse: true }).split('\n')[4]).toBe('@@ -11,4 +11,3 @@ section')
  })

  it('keeps the no-newline marker and ends with a newline', () => {
    const patch = buildHunkPatch(file, 2)
    expect(patch.endsWith('+U\n\\ No newline at end of file\n')).toBe(true)
    expect(patch).toContain('@@ -20,2 +20,2 @@')
  })

  it('recomputes counts from the lines actually present', () => {
    const [trimmed] = parseDiff(SAMPLE.replace(' l\n m\n', ' l\n'))
    expect(serializeHunk(trimmed.hunks[1]).split('\n')[0]).toBe('@@ -10,3 +10,2 @@ section')
  })

  it('addresses empty sides by the preceding line', () => {
    const [added] = parseDiff('diff --git a/n b/n\nnew file mode 100644\n--- /dev/null\n+++ b/n\n@@ -0,0 +1,2 @@\n+x\n+y\n')
    expect(serializeHunk(added.hunks[0])).toMatch(/^@@ -0,0 \+1,2 @@/)
    expect(serializeHunk(added.hunks[0], { reverse: true })).toMatch(/^@@ -0,0 \+1,2 @@/)
    const [gone] = parseDiff('diff --git a/n b/n\ndeleted file mode 100644\n--- a/n\n+++ /dev/null\n@@ -1,2 +0,0 @@\n-x\n-y\n')
    expect(serializeHunk(gone.hunks[0])).toMatch(/^@@ -1,2 \+0,0 @@/)
    expect(serializeHunk(gone.hunks[0], { reverse: true })).toMatch(/^@@ -1,2 \+0,0 @@/)
  })

  it('drops the rename from the header of reverse patches', () => {
    const [renamed] = parseDiff(`diff --git a/old name.txt b/new name.txt
similarity index 80%
rename from old name.txt
rename to new name.txt
index 1..2 100644
--- a/old name.txt\t
+++ b/new name.txt\t
@@ -1,2 +1,2 @@
-a
+b
 c
`)
    expect(buildHunkPatch(renamed, 0)).toContain('rename from old name.txt')
    expect(buildHunkPatch(renamed, 0, { reverse: true })).toBe(`diff --git a/new name.txt b/new name.txt
--- a/new name.txt\t
+++ b/new name.txt\t
@@ -1,2 +1,2 @@
-a
+b
 c
`)
  })

  it('rejects hunks that cannot be applied', () => {
    expect(() => buildHunkPatch(file, 9)).toThrow()
    const binary: DiffFile = { ...file, binary: true }
    expect(() => buildHunkPatch(binary, 0)).toThrow()
  })
})

// ---------------------------------------------------------------------------
// Round trip through the real `git apply`
// ---------------------------------------------------------------------------

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

describe.skipIf(!hasGit())('single-hunk patches through git apply', () => {
  let repo = ''
  const git = (args: string[], input?: string): string =>
    execFileSync('git', args, {
      cwd: repo,
      input,
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
      env: {
        ...process.env,
        HOME: repo,
        XDG_CONFIG_HOME: repo,
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_AUTHOR_NAME: 'Test',
        GIT_AUTHOR_EMAIL: 'test@example.com',
        GIT_COMMITTER_NAME: 'Test',
        GIT_COMMITTER_EMAIL: 'test@example.com'
      }
    })
  const write = (name: string, content: string) => writeFileSync(join(repo, name), content)
  const read = (name: string) => readFileSync(join(repo, name), 'utf8')
  const numbered = (n: number, edit: (line: string, no: number) => string | string[] | null = (l) => l) =>
    Array.from({ length: n }, (_, i) => edit(`line ${i + 1}`, i + 1))
      .flat()
      .filter((l): l is string => l !== null)
      .join('\n') + '\n'
  /** The same call the app makes: git.applyPatch(repo, patch, opts) */
  const apply = (patch: string, opts: { cached?: boolean; reverse?: boolean }) =>
    git(['apply', ...(opts.cached ? ['--cached'] : []), ...(opts.reverse ? ['--reverse'] : []), '-'], patch)
  const unstagedDiff = (path: string) => parseDiff(git(['diff', '--', path]))[0]
  const stagedDiff = (path?: string) => parseDiff(git(['diff', '--cached', '-M', ...(path ? ['--', path] : [])]))[0]

  beforeEach(() => {
    repo = mkdtempSync(join(tmpdir(), 'gitkroken-patch-'))
    git(['init', '-q'])
    git(['config', 'core.autocrlf', 'false'])
  })
  afterEach(() => {
    rmSync(repo, { recursive: true, force: true })
  })

  /** 60 numbered lines committed, then three separate edits in the worktree */
  const threeHunks = () => {
    const original = numbered(60)
    write('f.txt', original)
    git(['add', '.'])
    git(['commit', '-q', '-m', 'init'])
    const edit = (l: string, no: number) =>
      no === 3 ? [l, 'added A', 'added B'] : no === 30 ? 'line thirty' : no === 55 ? null : l
    write('f.txt', numbered(60, edit))
    return {
      original,
      modified: numbered(60, edit),
      only: (which: number) =>
        numbered(60, (l, no) => {
          const r = edit(l, no)
          const hunk = no === 3 ? 0 : no === 30 ? 1 : no === 55 ? 2 : -1
          return hunk === which ? r : l
        })
    }
  }

  it('stages just the middle hunk', () => {
    const { only } = threeHunks()
    const diff = unstagedDiff('f.txt')
    expect(diff.hunks).toHaveLength(3)
    apply(buildHunkPatch(diff, 1), { cached: true })
    expect(git(['show', ':f.txt'])).toBe(only(1))
    expect(unstagedDiff('f.txt').hunks).toHaveLength(2)
    expect(stagedDiff('f.txt').hunks).toHaveLength(1)
  })

  it.each([
    [[0, 1, 2]],
    [[2, 1, 0]],
    [[1, 2, 0]]
  ])('stages every hunk from one stale diff, in order %j', (order) => {
    const { modified } = threeHunks()
    const diff = unstagedDiff('f.txt')
    for (const i of order) apply(buildHunkPatch(diff, i), { cached: true })
    expect(git(['show', ':f.txt'])).toBe(modified)
    expect(git(['diff'])).toBe('')
  })

  it('unstages a single hunk', () => {
    const { only, original } = threeHunks()
    git(['add', 'f.txt'])
    const staged = stagedDiff('f.txt')
    expect(staged.hunks).toHaveLength(3)
    apply(buildHunkPatch(staged, 2, { reverse: true }), { cached: true, reverse: true })
    apply(buildHunkPatch(stagedDiff('f.txt'), 0, { reverse: true }), { cached: true, reverse: true })
    expect(git(['show', ':f.txt'])).toBe(only(1))
    apply(buildHunkPatch(stagedDiff('f.txt'), 0, { reverse: true }), { cached: true, reverse: true })
    expect(git(['show', ':f.txt'])).toBe(original)
    expect(git(['diff', '--cached'])).toBe('')
  })

  it('discards a single hunk from the worktree', () => {
    const { modified, only } = threeHunks()
    const diff = unstagedDiff('f.txt')
    apply(buildHunkPatch(diff, 2, { reverse: true }), { reverse: true })
    apply(buildHunkPatch(diff, 0, { reverse: true }), { reverse: true })
    expect(read('f.txt')).toBe(only(1))
    expect(read('f.txt')).not.toBe(modified)
    expect(git(['diff', '--cached'])).toBe('')
  })

  it('round-trips files without a trailing newline', () => {
    write('n.txt', 'one\ntwo\nthree')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'init'])
    write('n.txt', 'one\ntwo\nTHREE')
    const diff = unstagedDiff('n.txt')
    expect(diff.hunks[0].lines.filter((l) => l.noNewline)).toHaveLength(2)
    apply(buildHunkPatch(diff, 0), { cached: true })
    expect(git(['show', ':n.txt'])).toBe('one\ntwo\nTHREE')
    apply(buildHunkPatch(stagedDiff('n.txt'), 0, { reverse: true }), { cached: true, reverse: true })
    expect(git(['show', ':n.txt'])).toBe('one\ntwo\nthree')
    apply(buildHunkPatch(unstagedDiff('n.txt'), 0, { reverse: true }), { reverse: true })
    expect(read('n.txt')).toBe('one\ntwo\nthree')
  })

  it('unstages a newly added file and stages a deletion', () => {
    write('keep.txt', 'k\n')
    write('gone.txt', 'a\nb\n')
    git(['add', '.'])
    git(['commit', '-q', '-m', 'init'])

    write('new file.txt', 'x\ny\n')
    git(['add', '.'])
    const added = stagedDiff('new file.txt')
    expect(added.status).toBe('added')
    apply(buildHunkPatch(added, 0, { reverse: true }), { cached: true, reverse: true })
    expect(git(['status', '--porcelain'])).toBe('?? "new file.txt"\n')

    unlinkSync(join(repo, 'gone.txt'))
    const deleted = unstagedDiff('gone.txt')
    expect(deleted.status).toBe('deleted')
    apply(buildHunkPatch(deleted, 0), { cached: true })
    expect(git(['status', '--porcelain'])).toBe('D  gone.txt\n?? "new file.txt"\n')
  })

  it('unstages a hunk of a renamed file without undoing the rename', () => {
    const original = numbered(40)
    write('old name.txt', original)
    git(['add', '.'])
    git(['commit', '-q', '-m', 'init'])
    git(['mv', 'old name.txt', 'new name.txt'])
    write('new name.txt', numbered(40, (l, no) => (no === 5 ? 'five' : no === 35 ? 'thirty-five' : l)))
    git(['add', '.'])

    const staged = stagedDiff()
    expect(staged).toMatchObject({ status: 'renamed', oldPath: 'old name.txt', newPath: 'new name.txt' })
    expect(staged.hunks).toHaveLength(2)
    apply(buildHunkPatch(staged, 1, { reverse: true }), { cached: true, reverse: true })
    expect(git(['show', ':new name.txt'])).toBe(numbered(40, (l, no) => (no === 5 ? 'five' : l)))
    expect(stagedDiff()).toMatchObject({ status: 'renamed', newPath: 'new name.txt' })
  })

  it('handles paths that git quotes', () => {
    const name = 'dir ñ/tab\there.txt'
    execFileSync('mkdir', ['-p', join(repo, 'dir ñ')])
    write(name, numbered(30))
    git(['add', '.'])
    git(['commit', '-q', '-m', 'init'])
    write(name, numbered(30, (l, no) => (no === 2 ? 'two' : no === 28 ? 'twenty-eight' : l)))
    const diff = unstagedDiff(name)
    expect(diff.newPath).toBe(name)
    apply(buildHunkPatch(diff, 1), { cached: true })
    expect(git(['show', `:${name}`])).toBe(numbered(30, (l, no) => (no === 28 ? 'twenty-eight' : l)))
    // synthesised header (reverse + rename path is the only one that needs it) must quote too
    const fake: DiffFile = { ...stagedDiff(), headerLines: [] }
    apply(buildHunkPatch(fake, 0, { reverse: true }), { cached: true, reverse: true })
    expect(git(['diff', '--cached'])).toBe('')
  })
})
