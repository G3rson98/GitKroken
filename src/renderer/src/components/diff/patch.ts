// Builds patches for `git apply` out of parsed hunks (stage / unstage /
// discard a single hunk). Pure: no DOM / React imports.
import type { DiffFile, DiffHunk } from './parseDiff'

export interface HunkPatchOptions {
  /**
   * The patch will be applied with `git apply --reverse` (unstage / discard).
   * The pre-image is then the *new* side, so the old-side start is the one
   * that gets recomputed.
   */
  reverse?: boolean
}

/** C-style quoting, as git does for paths with special characters. */
function quotePath(p: string): string {
  if (!/[\x00-\x1f"\\\x7f]/.test(p)) return p
  let out = '"'
  for (const ch of p) {
    const code = ch.charCodeAt(0)
    if (ch === '"') out += '\\"'
    else if (ch === '\\') out += '\\\\'
    else if (ch === '\t') out += '\\t'
    else if (ch === '\n') out += '\\n'
    else if (ch === '\r') out += '\\r'
    else if (code < 0x20 || code === 0x7f) out += '\\' + code.toString(8).padStart(3, '0')
    else out += ch
  }
  return out + '"'
}

const withPrefix = (prefix: string, p: string) => {
  const q = quotePath(prefix + p)
  // git appends a tab to ---/+++ paths containing spaces so `patch` can parse them
  return q.startsWith('"') || !p.includes(' ') ? q : q + '\t'
}

/** `@@ -a,b +c,d @@ section` with the short form git uses when a count is 1. */
export function formatHunkHeader(
  oldStart: number,
  oldLines: number,
  newStart: number,
  newLines: number,
  section = ''
): string {
  const range = (start: number, count: number) => (count === 1 ? `${start}` : `${start},${count}`)
  return `@@ -${range(oldStart, oldLines)} +${range(newStart, newLines)} @@${section ? ' ' + section : ''}`
}

/**
 * Serialises one hunk so that it applies on its own, i.e. without the other
 * hunks of the file shifting its position.
 *
 * Applied forwards the pre-image is the old side: `oldStart` is already right
 * and `newStart` is derived from it. Applied in reverse it is the other way
 * round. Line counts are always recomputed from the actual lines.
 */
export function serializeHunk(hunk: DiffHunk, opts: HunkPatchOptions = {}): string {
  let oldLines = 0
  let newLines = 0
  const body: string[] = []
  for (const l of hunk.lines) {
    if (l.type !== 'add') oldLines++
    if (l.type !== 'del') newLines++
    body.push((l.type === 'add' ? '+' : l.type === 'del' ? '-' : ' ') + l.text)
    if (l.noNewline) body.push('\\ No newline at end of file')
  }
  // An empty side is addressed by the line *before* the change, hence the ±1
  const emptyOld = oldLines === 0 ? 1 : 0
  const emptyNew = newLines === 0 ? 1 : 0
  let oldStart: number
  let newStart: number
  if (opts.reverse) {
    newStart = hunk.newStart
    oldStart = Math.max(0, newStart + emptyNew - emptyOld)
  } else {
    oldStart = hunk.oldStart
    newStart = Math.max(0, oldStart + emptyOld - emptyNew)
  }
  return [formatHunkHeader(oldStart, oldLines, newStart, newLines, hunk.section), ...body].join('\n')
}

/** File header (`diff --git` … `+++`) to put in front of a lone hunk. */
export function patchHeader(file: DiffFile, opts: HunkPatchOptions = {}): string[] {
  const isMove = file.status === 'renamed' || file.status === 'copied'
  const hasMarkers = file.headerLines.some((l) => l.startsWith('--- '))
  if (file.headerLines.length > 0 && hasMarkers && !(isMove && opts.reverse)) {
    return file.headerLines
  }
  // Synthesised header. For a reversed hunk of a renamed file we only want to
  // undo the hunk, not the rename, so both sides point at the new path.
  const oldPath = isMove && opts.reverse ? file.newPath : file.oldPath
  const a = oldPath ?? file.newPath ?? ''
  const b = file.newPath ?? file.oldPath ?? ''
  const out = [`diff --git ${quotePath('a/' + a)} ${quotePath('b/' + b)}`]
  if (file.status === 'added') out.push(`new file mode ${file.newMode ?? '100644'}`)
  if (file.status === 'deleted') out.push(`deleted file mode ${file.oldMode ?? '100644'}`)
  out.push(file.status === 'added' ? '--- /dev/null' : `--- ${withPrefix('a/', a)}`)
  out.push(file.status === 'deleted' ? '+++ /dev/null' : `+++ ${withPrefix('b/', b)}`)
  return out
}

/**
 * A complete, valid patch containing only hunk `hunkIndex` of `file`, ready
 * for `git apply [--cached] [--reverse]`.
 */
export function buildHunkPatch(file: DiffFile, hunkIndex: number, opts: HunkPatchOptions = {}): string {
  const hunk = file.hunks[hunkIndex]
  if (!hunk) throw new Error(`Hunk ${hunkIndex} fuera de rango`)
  if (file.binary) throw new Error('Cannot apply a hunk of a binary file')
  if (file.combined) throw new Error('Cannot apply a hunk of a combined diff')
  return [...patchHeader(file, opts), serializeHunk(hunk, opts)].join('\n') + '\n'
}
