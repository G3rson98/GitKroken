// Pure parser for `git diff` unified output. No DOM / React imports: this
// module is unit-tested in plain Node.

export type DiffLineType = 'context' | 'add' | 'del'

export interface DiffLine {
  type: DiffLineType
  /** Line content without the leading diff marker (and without the newline) */
  text: string
  /** 1-based line number in the old file; null for added lines */
  oldNo: number | null
  /** 1-based line number in the new file; null for removed lines */
  newNo: number | null
  /** True when the line is followed by `\ No newline at end of file` */
  noNewline?: boolean
}

export interface DiffHunk {
  /** The raw `@@ -a,b +c,d @@ section` line */
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** Text after the closing `@@` (usually the enclosing function) */
  section: string
  lines: DiffLine[]
}

export type DiffFileStatus = 'added' | 'deleted' | 'modified' | 'renamed' | 'copied'

export interface DiffFile {
  /** Path on the old side; null for new files */
  oldPath: string | null
  /** Path on the new side; null for deleted files */
  newPath: string | null
  status: DiffFileStatus
  binary: boolean
  /** `diff --cc` / `diff --combined` output (unmerged paths, merge commits) */
  combined: boolean
  oldMode?: string
  newMode?: string
  /** Rename / copy similarity, 0-100 */
  similarity?: number
  /** Raw lines from `diff --git` up to (not including) the first hunk */
  headerLines: string[]
  hunks: DiffHunk[]
  additions: number
  deletions: number
}

const HUNK_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/
const COMBINED_HUNK_RE = /^(@{3,}) ((?:-\d+(?:,\d+)? )+)\+(\d+)(?:,(\d+))? @{3,} ?(.*)$/

const ESCAPES: Record<string, number> = {
  a: 7, b: 8, t: 9, n: 10, v: 11, f: 12, r: 13, '"': 34, '\\': 92
}

/** Undoes git's C-style path quoting (`"sp\303\244ce\t.txt"`). */
export function unquotePath(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const body = raw.slice(1, -1)
  const bytes: number[] = []
  const enc = new TextEncoder()
  for (let i = 0; i < body.length; i++) {
    const ch = body[i]
    if (ch !== '\\') {
      bytes.push(...enc.encode(ch))
      continue
    }
    const next = body[++i]
    if (next === undefined) break
    if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3 && body[i + 1] >= '0' && body[i + 1] <= '7') oct += body[++i]
      bytes.push(parseInt(oct, 8) & 0xff)
    } else if (next in ESCAPES) {
      bytes.push(ESCAPES[next])
    } else {
      bytes.push(...enc.encode(next))
    }
  }
  return new TextDecoder().decode(new Uint8Array(bytes))
}

/** `a/src/x.ts` -> `src/x.ts`; `/dev/null` -> null. Handles quoting and the trailing tab git adds. */
function headerPath(raw: string): string | null {
  let p = raw
  if (!p.startsWith('"')) p = p.replace(/\t.*$/, '')
  p = unquotePath(p.trim())
  if (p === '/dev/null') return null
  return p.replace(/^[a-z]\//, '')
}

/** Best-effort split of `a/old b/new` from a `diff --git` line (ambiguous with spaces). */
function splitGitHeader(rest: string): [string | null, string | null] {
  const quoted = rest.match(/^("(?:[^"\\]|\\.)*"|\S+) ("(?:[^"\\]|\\.)*"|\S+)$/)
  if (rest.includes('"') && quoted) return [headerPath(quoted[1]), headerPath(quoted[2])]
  // Unrenamed files: both halves are identical apart from the prefix
  if (rest.length % 2 === 1 && rest[(rest.length - 1) / 2] === ' ') {
    const mid = (rest.length - 1) / 2
    const a = rest.slice(0, mid)
    const b = rest.slice(mid + 1)
    if (a.replace(/^[a-z]\//, '') === b.replace(/^[a-z]\//, '')) return [headerPath(a), headerPath(b)]
  }
  const idx = rest.indexOf(' b/')
  if (idx > 0) return [headerPath(rest.slice(0, idx)), headerPath(rest.slice(idx + 1))]
  if (quoted) return [headerPath(quoted[1]), headerPath(quoted[2])]
  return [null, null]
}

function newFile(): DiffFile {
  return {
    oldPath: null,
    newPath: null,
    status: 'modified',
    binary: false,
    combined: false,
    headerLines: [],
    hunks: [],
    additions: 0,
    deletions: 0
  }
}

/**
 * Parses the output of `git diff` (one or several files). Returns [] for an
 * empty diff. Tolerates output whose trailing blank lines were trimmed.
 */
export function parseDiff(text: string): DiffFile[] {
  const files: DiffFile[] = []
  if (!text) return files
  const lines = text.split('\n')
  if (lines[lines.length - 1] === '') lines.pop()

  // `as`: keeps TS from narrowing to `null` (it is reassigned inside closures)
  let file = null as DiffFile | null
  let sawNewMarker = false
  let sawDeletedMarker = false
  let i = 0

  const finish = () => {
    if (!file) return
    if (file.status === 'modified') {
      if (sawNewMarker) file.status = 'added'
      else if (sawDeletedMarker) file.status = 'deleted'
    }
    if (file.status === 'added') file.oldPath = null
    if (file.status === 'deleted') file.newPath = null
    files.push(file)
    file = null
  }
  const start = () => {
    finish()
    file = newFile()
    sawNewMarker = false
    sawDeletedMarker = false
    return file
  }

  while (i < lines.length) {
    const line = lines[i]

    if (line.startsWith('diff --git ')) {
      const f = start()
      f.headerLines.push(line)
      const [a, b] = splitGitHeader(line.slice('diff --git '.length))
      f.oldPath = a
      f.newPath = b
      i++
      continue
    }
    if (line.startsWith('diff --cc ') || line.startsWith('diff --combined ')) {
      const f = start()
      f.headerLines.push(line)
      f.combined = true
      const p = unquotePath(line.replace(/^diff --(cc|combined) /, ''))
      f.oldPath = p
      f.newPath = p
      i++
      continue
    }

    // A bare patch without the `diff --git` line
    if (!file && line.startsWith('--- ') && lines[i + 1]?.startsWith('+++ ')) start()
    if (!file) {
      i++
      continue
    }
    const f: DiffFile = file

    const hunk = HUNK_RE.exec(line)
    if (hunk && !f.combined) {
      i = readHunk(lines, i, hunk, f)
      continue
    }
    const combined = f.combined ? COMBINED_HUNK_RE.exec(line) : null
    if (combined) {
      i = readCombinedHunk(lines, i, combined, f)
      continue
    }

    // Extended header lines
    if (f.hunks.length === 0) f.headerLines.push(line)
    if (line.startsWith('--- ')) {
      const p = headerPath(line.slice(4))
      if (p === null) sawNewMarker = true
      else f.oldPath = p
    } else if (line.startsWith('+++ ')) {
      const p = headerPath(line.slice(4))
      if (p === null) sawDeletedMarker = true
      else f.newPath = p
    } else if (line.startsWith('new file mode ')) {
      sawNewMarker = true
      f.newMode = line.slice('new file mode '.length).trim()
    } else if (line.startsWith('deleted file mode ')) {
      sawDeletedMarker = true
      f.oldMode = line.slice('deleted file mode '.length).trim()
    } else if (line.startsWith('old mode ')) {
      f.oldMode = line.slice('old mode '.length).trim()
    } else if (line.startsWith('new mode ')) {
      f.newMode = line.slice('new mode '.length).trim()
    } else if (line.startsWith('rename from ')) {
      f.status = 'renamed'
      f.oldPath = unquotePath(line.slice('rename from '.length))
    } else if (line.startsWith('rename to ')) {
      f.status = 'renamed'
      f.newPath = unquotePath(line.slice('rename to '.length))
    } else if (line.startsWith('copy from ')) {
      f.status = 'copied'
      f.oldPath = unquotePath(line.slice('copy from '.length))
    } else if (line.startsWith('copy to ')) {
      f.status = 'copied'
      f.newPath = unquotePath(line.slice('copy to '.length))
    } else if (line.startsWith('similarity index ')) {
      f.similarity = parseInt(line.slice('similarity index '.length), 10)
    } else if (line.startsWith('index ')) {
      const m = /^index \S+ (\d+)$/.exec(line)
      if (m && !f.oldMode && !f.newMode) {
        f.oldMode = m[1]
        f.newMode = m[1]
      }
    } else if (/^Binary files .* differ$/.test(line) || line === 'GIT binary patch') {
      f.binary = true
      const m = /^Binary files (.*) and (.*) differ$/.exec(line)
      if (m) {
        if (m[1] === '/dev/null') sawNewMarker = true
        if (m[2] === '/dev/null') sawDeletedMarker = true
      }
    }
    i++
  }
  finish()
  return files
}

function readHunk(lines: string[], at: number, m: RegExpExecArray, file: DiffFile): number {
  const hunk: DiffHunk = {
    header: lines[at],
    oldStart: +m[1],
    oldLines: m[2] === undefined ? 1 : +m[2],
    newStart: +m[3],
    newLines: m[4] === undefined ? 1 : +m[4],
    section: m[5] ?? '',
    lines: []
  }
  let remOld = hunk.oldLines
  let remNew = hunk.newLines
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  let i = at + 1
  // The header counts (not the line prefixes) decide where the hunk ends, so
  // removed lines such as `-- foo` are never mistaken for a `---` header.
  for (; i < lines.length; i++) {
    const l = lines[i]
    const c = l[0]
    if (c === '\\') {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
      continue
    }
    if (remOld <= 0 && remNew <= 0) break
    if (c === '+' && remNew > 0) {
      hunk.lines.push({ type: 'add', text: l.slice(1), oldNo: null, newNo: newNo++ })
      remNew--
      file.additions++
    } else if (c === '-' && remOld > 0) {
      hunk.lines.push({ type: 'del', text: l.slice(1), oldNo: oldNo++, newNo: null })
      remOld--
      file.deletions++
    } else if ((c === ' ' || l === '') && remOld > 0 && remNew > 0) {
      // `l === ''`: a blank context line whose single space was stripped
      hunk.lines.push({ type: 'context', text: l.slice(1), oldNo: oldNo++, newNo: newNo++ })
      remOld--
      remNew--
    } else {
      break // malformed / truncated hunk
    }
  }
  file.hunks.push(hunk)
  return i
}

/**
 * Combined diff hunk (`@@@ -1,5 -1,5 +1,9 @@@`). Each line carries one marker
 * column per parent. We flatten it: a line is removed if any column is `-`,
 * added if any column is `+`. Old numbers follow the first parent.
 */
function readCombinedHunk(lines: string[], at: number, m: RegExpExecArray, file: DiffFile): number {
  const parents = m[1].length - 1
  const first = /^-(\d+)(?:,(\d+))?/.exec(m[2])!
  const hunk: DiffHunk = {
    header: lines[at],
    oldStart: +first[1],
    oldLines: first[2] === undefined ? 1 : +first[2],
    newStart: +m[3],
    newLines: m[4] === undefined ? 1 : +m[4],
    section: m[5] ?? '',
    lines: []
  }
  let oldNo = hunk.oldStart
  let newNo = hunk.newStart
  let i = at + 1
  for (; i < lines.length; i++) {
    const l = lines[i]
    if (l.startsWith('\\')) {
      const last = hunk.lines[hunk.lines.length - 1]
      if (last) last.noNewline = true
      continue
    }
    if (l.startsWith('diff --') || COMBINED_HUNK_RE.test(l)) break
    const marks = l.slice(0, parents)
    if (l !== '' && !/^[ +-]+$/.test(marks)) break
    const text = l.slice(parents)
    if (marks.includes('-')) {
      const inFirst = marks[0] === '-'
      hunk.lines.push({ type: 'del', text, oldNo: inFirst ? oldNo++ : null, newNo: null })
      file.deletions++
    } else if (marks.includes('+')) {
      const inFirst = marks[0] === ' '
      hunk.lines.push({ type: 'add', text, oldNo: inFirst ? oldNo++ : null, newNo: newNo++ })
      file.additions++
    } else {
      hunk.lines.push({ type: 'context', text, oldNo: oldNo++, newNo: newNo++ })
    }
  }
  file.hunks.push(hunk)
  return i
}

/** Picks the entry for `path` out of a parsed diff (falls back to the first file). */
export function findDiffFile(files: DiffFile[], path: string): DiffFile | null {
  return files.find((f) => f.newPath === path) ?? files.find((f) => f.oldPath === path) ?? files[0] ?? null
}
