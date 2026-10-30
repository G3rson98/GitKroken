// Blame, per-file history, file content at a revision and commit search.
// Everything here only reads the repository, so nothing goes through the
// mutation queue of core.ts. No Electron imports: testable in plain Node.
import type { BlameLine, Commit, FileHistoryEntry, GitApi } from '@shared/types'
import { assertPaths, assertRef, git, runGit } from './exec'
import { LOG_FORMAT, STASH_FORMAT, parseLog, parseNameStatus, parseStashList } from './parse'

/** Paths from the UI are file names, never globs or magic pathspecs. */
const LITERAL = { literal: true } as const
const HASH_RE = /^[0-9a-f]{40,64}$/
/** git looks for a NUL in the first 8000 bytes to decide that content is binary */
const BINARY_SNIFF = 8000

function assertPath(path: unknown): string {
  const [p] = assertPaths([path])
  return p!
}

function toCount(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  return Math.max(0, Math.floor(value))
}

// --- blame -----------------------------------------------------------------------

/** Hash git reports for lines that only exist in the working tree */
export const UNCOMMITTED_HASH = '0'.repeat(40)
export const isUncommitted = (hash: string): boolean => /^0+$/.test(hash)

/** More lines than this is not a file anyone reads line by line */
const MAX_BLAME_LINES = 300_000

/**
 * What `blame` really resolves. `path` and `previous` are not part of
 * `BlameLine` in the shared contract (yet); they travel as extra properties
 * and the blame view reads them when present.
 */
export interface BlameEntry extends BlameLine {
  /** Name the file had in the commit the line comes from */
  path?: string
  /** Where to continue to blame "before this commit"; absent when the commit created the file */
  previous?: { hash: string; path: string }
}

interface BlameCommit {
  author: string
  date: number
  summary: string
  path?: string
  previous?: { hash: string; path: string }
}

const C_ESCAPES: Record<string, string> = { a: '\x07', b: '\b', t: '\t', n: '\n', v: '\v', f: '\f', r: '\r', '"': '"', '\\': '\\' }

/** Undoes git's C-style quoting of unusual paths (`"tab\there"`). */
function unquote(raw: string): string {
  if (raw.length < 2 || !raw.startsWith('"') || !raw.endsWith('"')) return raw
  const bytes: number[] = []
  const body = Buffer.from(raw.slice(1, -1), 'utf8')
  for (let i = 0; i < body.length; i++) {
    const b = body[i]!
    if (b !== 0x5c) {
      bytes.push(b)
      continue
    }
    const next = String.fromCharCode(body[++i] ?? 0x5c)
    if (next >= '0' && next <= '7') {
      let oct = next
      while (oct.length < 3 && i + 1 < body.length && body[i + 1]! >= 0x30 && body[i + 1]! <= 0x37) oct += String.fromCharCode(body[++i]!)
      bytes.push(parseInt(oct, 8) & 0xff)
    } else {
      bytes.push(...Buffer.from(C_ESCAPES[next] ?? next, 'utf8'))
    }
  }
  return Buffer.from(bytes).toString('utf8')
}

/**
 * Parses `git blame --porcelain`. Every line of the file is announced by
 * `<hash> <orig-line> <final-line> [<count>]`, followed (only the first time a
 * commit shows up) by `key value` lines, and then by the content prefixed with
 * a TAB. Content can never be mistaken for a header: headers never start with
 * a TAB and content always does.
 *
 * The text of a line carries no line terminator: neither the `\n` nor the
 * `\r` of a CRLF file.
 */
export function parseBlame(out: string): BlameEntry[] {
  const commits = new Map<string, BlameCommit>()
  const result: BlameEntry[] = []
  const rows = out.split('\n')
  let i = 0
  while (i < rows.length) {
    const head = /^([0-9a-f]{40,64}) \d+ (\d+)(?: \d+)?$/.exec(rows[i]!)
    if (!head) {
      i++ // trailing empty string, or something unexpected: resynchronise
      continue
    }
    i++
    const hash = head[1]!
    let info = commits.get(hash)
    if (!info) {
      info = { author: '', date: 0, summary: '' }
      commits.set(hash, info)
    }
    while (i < rows.length && !rows[i]!.startsWith('\t')) {
      const row = rows[i++]!
      const space = row.indexOf(' ')
      const key = space < 0 ? row : row.slice(0, space)
      const value = space < 0 ? '' : row.slice(space + 1)
      if (key === 'author') info.author = value
      else if (key === 'author-time') info.date = Number(value) || 0
      else if (key === 'summary') info.summary = value
      else if (key === 'filename') info.path = unquote(value)
      else if (key === 'previous') {
        const m = /^([0-9a-f]{40,64}) (.*)$/.exec(value)
        if (m) info.previous = { hash: m[1]!, path: unquote(m[2]!) }
      }
    }
    if (i >= rows.length) break // truncated output: a header without its content
    let text = rows[i++]!.slice(1)
    if (text.endsWith('\r')) text = text.slice(0, -1)

    const entry: BlameEntry = isUncommitted(hash)
      ? { hash, author: 'Not Committed Yet', date: info.date, summary: 'Uncommitted changes', lineNo: Number(head[2]), text }
      : { hash, author: info.author, date: info.date, summary: info.summary, lineNo: Number(head[2]), text }
    if (info.path !== undefined) entry.path = info.path
    if (info.previous) entry.previous = info.previous
    result.push(entry)
  }
  return result
}

/**
 * Blame of `path` at `rev`. Without `rev` git blames the working tree, so
 * lines that are not committed yet come back with the all-zero hash
 * (`isUncommitted`), author "Not Committed Yet" and no real commit behind.
 *
 * Deliberately plain `git blame`:
 *  - no `-w`: a line is attributed to the commit whose diff (as this app shows
 *    it) contains that line, even when the change was whitespace only. With
 *    `-w` the blame would point at commits whose diff does not touch the line.
 *  - no `-M` / `-C`: detecting lines moved or copied within / between files is
 *    quadratic-ish and makes big files slow. Whole-file renames are still
 *    followed (git does that by default).
 */
async function blame(repo: string, path: string, rev?: string): Promise<BlameLine[]> {
  assertPath(path)
  const args = ['blame', '--porcelain']
  if (rev !== undefined && rev !== null && rev !== '') args.push(assertRef(rev, 'revision'))
  args.push('--', path)
  const out = await git(repo, args, LITERAL)
  const lines = parseBlame(out)

  let sniffed = 0
  for (const line of lines) {
    if (line.text.includes('\0')) throw new Error(`"${path}" is a binary file: blame is not available`)
    sniffed += line.text.length + 1
    if (sniffed >= BINARY_SNIFF) break
  }
  if (lines.length > MAX_BLAME_LINES) {
    throw new Error(`"${path}" is too large to blame (${lines.length} lines)`)
  }
  return lines
}

// --- file history ----------------------------------------------------------------

/** `FileHistoryEntry` plus the previous name of the file when that commit renamed it */
export interface FileHistoryItem extends FileHistoryEntry {
  oldPath?: string
}

/**
 * Parses `git log -z --name-status --format=LOG_FORMAT -- <one path>`:
 *
 *   <7 NUL-separated fields> NUL [LF <code> NUL <path> NUL [<path> NUL]]...
 *
 * i.e. the name-status entries of a commit follow its body, the first one
 * prefixed with a line feed. A commit with nothing to show (a merge that does
 * not differ from its first parent) has no entries: it is reported as
 * `modified` at the name the file had at that point.
 */
export function parseFileHistory(out: string, path: string): FileHistoryItem[] {
  const tokens = out.split('\0')
  const items: FileHistoryItem[] = []
  /** Name of the file at the commit being read (walks back through renames) */
  let current = path
  let i = 0
  while (i + 7 <= tokens.length) {
    if (!HASH_RE.test(tokens[i]!)) break
    const commit: Commit | undefined = parseLog(tokens.slice(i, i + 7).join('\0'))[0]
    if (!commit) break
    i += 7

    const status: string[] = []
    if (tokens[i] !== undefined && tokens[i]!.startsWith('\n')) {
      let code = tokens[i]!.slice(1)
      while (/^[A-Z]\d*$/.test(code)) {
        const n = code[0] === 'R' || code[0] === 'C' ? 2 : 1
        if (i + n >= tokens.length) break
        status.push(code, ...tokens.slice(i + 1, i + 1 + n))
        i += 1 + n
        code = tokens[i] ?? ''
      }
    }
    const changes = parseNameStatus(status.join('\0'))
    const change = changes.find((c) => c.path === current) ?? changes[0]
    if (!change) {
      items.push({ commit, path: current, status: 'modified' })
      continue
    }
    const item: FileHistoryItem = { commit, path: change.path, status: change.status }
    if (change.oldPath && change.oldPath !== change.path) {
      item.oldPath = change.oldPath
      // A copy keeps following the source, exactly as `--follow` does.
      current = change.oldPath
    } else {
      current = change.path
    }
    items.push(item)
  }
  return items
}

async function hasHead(repo: string): Promise<boolean> {
  const res = await runGit(repo, ['rev-parse', '--verify', '--quiet', 'HEAD^{commit}'], { okCodes: [0, 1] })
  return res.code === 0
}

/**
 * Commits that touched `path`, newest first, following renames.
 *
 * Paging is done here and not with `git log --skip`: `--follow` only learns
 * about a rename when it *shows* the commit that made it, so skipping that
 * commit would silently lose everything before the rename.
 *
 * The history is the one of HEAD. When the path never existed there (a file
 * of a commit that lives on another branch) every ref is searched instead.
 */
async function fileHistory(repo: string, path: string, opts?: { limit?: number; skip?: number }): Promise<FileHistoryEntry[]> {
  assertPath(path)
  const limit = toCount(opts?.limit)
  const skip = toCount(opts?.skip) ?? 0
  if (limit === 0) return []
  if (!(await hasHead(repo))) return []

  const run = async (revs: string[]): Promise<FileHistoryItem[]> => {
    const args = [
      'log',
      '--follow',
      '--name-status',
      '-z',
      '--find-renames',
      // a merge is described by what it changed relative to its first parent, like `diff` does
      '--diff-merges=first-parent',
      `--format=${LOG_FORMAT}`
    ]
    if (limit !== undefined) args.push(`--max-count=${skip + limit}`)
    args.push(...revs, '--', path)
    return parseFileHistory(await git(repo, args, LITERAL), path)
  }

  let items = await run([])
  if (items.length === 0) items = await run(['--exclude=refs/stash', ...GRAPH_REFS])
  return limit === undefined ? items.slice(skip) : items.slice(skip, skip + limit)
}

// --- file content ----------------------------------------------------------------

/** Bigger blobs are refused: they would only freeze the UI */
const MAX_FILE_BYTES = 8 * 1024 * 1024

/**
 * Text of `path` at `rev`, or null when there is no such file in that
 * revision (also for a folder or a submodule). Rejects for an unknown
 * revision, for binary content and for files over 8 MiB.
 */
async function fileAt(repo: string, path: string, rev: string): Promise<string | null> {
  assertPath(path)
  assertRef(rev, 'revision')
  if (/[\r\n]/.test(path)) return null // cannot be addressed as `rev:path` on a batch line (nor does it exist in practice)

  const commit = await runGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { okCodes: [0, 1] })
  if (commit.code !== 0) throw new Error(`Revision not found: ${rev}`)
  const hash = commit.stdout.trim()

  // `<object> missing` when the path does not exist in that tree
  const info = (await git(repo, ['cat-file', '--batch-check=%(objecttype) %(objectsize)'], { input: `${hash}:${path}\n` })).trim()
  const m = /^(\w+) (\d+)$/.exec(info)
  if (!m || m[1] !== 'blob') return null
  const size = Number(m[2])
  if (size > MAX_FILE_BYTES) {
    throw new Error(`"${path}" is too large to display (${(size / 1024 / 1024).toFixed(1)} MB)`)
  }
  const content = await git(repo, ['cat-file', 'blob', `${hash}:${path}`])
  if (content.slice(0, BINARY_SNIFF).includes('\0')) throw new Error(`"${path}" is a binary file`)
  return content
}

/** Trees bigger than this are cut (the list would only freeze the UI) */
export const MAX_TREE_FILES = 200_000

/** Paths of every entry in the tree of `rev` (the whole project, not only what the commit changed). */
async function listFiles(repo: string, rev: string): Promise<string[]> {
  assertRef(rev, 'revision')
  const commit = await runGit(repo, ['rev-parse', '--verify', '--quiet', `${rev}^{commit}`], { okCodes: [0, 1] })
  if (commit.code !== 0) throw new Error(`Revision not found: ${rev}`)
  // -z: paths come raw (no quoting of spaces / non-ASCII names)
  const out = await git(repo, ['ls-tree', '-r', '-z', '--full-tree', '--name-only', commit.stdout.trim()])
  const paths = out.split('\0').filter(Boolean)
  return paths.length > MAX_TREE_FILES ? paths.slice(0, MAX_TREE_FILES) : paths
}

// --- commit search ---------------------------------------------------------------

/**
 * The refs the graph shows: like `--all`, minus bookkeeping refs.
 * Keep in sync with `log()` in core.ts.
 */
const GRAPH_REFS = [
  '--exclude=refs/notes/*',
  '--exclude=refs/replace/*',
  '--exclude=refs/original/*',
  '--exclude=refs/bisect/*',
  '--exclude=refs/prefetch/*',
  '--all'
]

const DEFAULT_SEARCH_LIMIT = 500
const MAX_SEARCH_LIMIT = 20_000
/** Shortest hexadecimal query that is also tried as a SHA prefix (git's own minimum) */
export const MIN_SHA_PREFIX = 4

/**
 * git folds case with the C library, and every command runs under LC_ALL=C
 * (exec.ts), where only ASCII letters fold: "CORRECCIÓN" would not match
 * "corrección". A UTF-8 locale fixes that; if the system lacks it, git simply
 * stays in the C locale.
 */
const UTF8_LOCALE = process.platform === 'darwin' ? 'en_US.UTF-8' : 'C.UTF-8'
const SEARCH_ENV = { LC_ALL: UTF8_LOCALE, LANG: UTF8_LOCALE }

interface Hit {
  hash: string
  /** Committer time: what `--date-order` sorts by */
  time: number
}

function parseHits(out: string): Hit[] {
  const hits: Hit[] = []
  for (const line of out.split('\n')) {
    const space = line.indexOf(' ')
    if (space < 0) continue
    hits.push({ hash: line.slice(0, space), time: Number(line.slice(space + 1)) || 0 })
  }
  return hits
}

/**
 * Merges lists that are each in graph order (newest first) into one, without
 * duplicates. Lists are only ever interleaved, never reordered internally, so
 * the result is still a valid graph order for the commits of each list.
 */
export function mergeHits(lists: Hit[][]): Hit[] {
  const pos = lists.map(() => 0)
  const seen = new Set<string>()
  const out: Hit[] = []
  for (;;) {
    let best = -1
    for (let k = 0; k < lists.length; k++) {
      const list = lists[k]!
      while (pos[k]! < list.length && seen.has(list[pos[k]!]!.hash)) pos[k]!++
      if (pos[k]! >= list.length) continue
      if (best < 0 || list[pos[k]!]!.time > lists[best]![pos[best]!]!.time) best = k
    }
    if (best < 0) return out
    const hit = lists[best]![pos[best]!++]!
    seen.add(hit.hash)
    out.push(hit)
  }
}

/**
 * Hashes of the commits matching `query`, newest first, among everything the
 * graph shows (all refs and stashes).
 *
 * `query` is plain text: it matches case-insensitively and literally (never as
 * a regular expression) when it appears in the commit message, OR in the
 * author (`Name <email>`), OR, if it looks like hexadecimal, at the start of
 * the SHA.
 *
 * `git log --grep=X --author=Y` means "X AND Y", and `--all-match` only makes
 * it stricter, so there is no single invocation with OR semantics: the
 * searches run separately (in parallel) and are merged.
 */
async function searchCommits(repo: string, query: string, opts?: { limit?: number }): Promise<string[]> {
  if (typeof query !== 'string') return []
  const text = query.replace(/[\r\n]+/g, ' ')
  if (text.trim() === '' || text.includes('\0')) return []
  const limit = Math.min(toCount(opts?.limit) ?? DEFAULT_SEARCH_LIMIT, MAX_SEARCH_LIMIT)
  if (limit === 0) return []

  // Same universe as the graph: every ref plus every stash, minus the helper
  // commits git creates for a stash (index state, untracked files).
  const stashes = parseStashList(await git(repo, ['stash', 'list', '-z', `--format=${STASH_FORMAT}`]))
  const stashHashes = new Set(stashes.map((s) => s.hash))
  const helpers = new Set<string>()
  for (const s of stashes) for (const p of s.parents.slice(1)) if (!stashHashes.has(p)) helpers.add(p)

  const walk = (filters: string[], max: number | null): Promise<Hit[]> => {
    const args = ['log', '--date-order', '--no-notes', '--format=%H %ct']
    if (max !== null) args.push(`--max-count=${max + helpers.size}`)
    args.push(...filters, ...GRAPH_REFS, ...stashHashes, '--')
    return git(repo, args, { env: SEARCH_ENV }).then(parseHits)
  }
  // --fixed-strings: the pattern is literal ("[", ".", "*" mean themselves).
  // Passed as `--opt=value`, so a query starting with "-" is still a value.
  const literal = ['--fixed-strings', '--regexp-ignore-case']
  const searches = [walk([...literal, `--grep=${text}`], limit), walk([...literal, `--author=${text}`], limit)]

  const prefix = text.trim().toLowerCase()
  if (prefix.length >= MIN_SHA_PREFIX && /^[0-9a-f]{1,64}$/.test(prefix)) {
    // An abbreviated SHA says nothing about reachability, so the candidates
    // are taken from the graph's own commit list rather than from the object
    // database (which also holds unreachable commits the graph never shows).
    searches.push(walk([], null).then((all) => all.filter((h) => h.hash.startsWith(prefix))))
  }

  const merged = mergeHits(await Promise.all(searches))
  const result: string[] = []
  for (const hit of merged) {
    if (helpers.has(hit.hash)) continue
    result.push(hit.hash)
    if (result.length >= limit) break
  }
  return result
}

// --- the API object --------------------------------------------------------------

export const historyApi: Pick<GitApi, 'blame' | 'fileHistory' | 'fileAt' | 'listFiles' | 'searchCommits'> = {
  blame,
  fileHistory,
  fileAt,
  listFiles,
  searchCommits
}
