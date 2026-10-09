// Pure parsers for git's machine-readable output. No process / Electron access.
import type { Commit, FileChange, FileStatus, Ref, Status } from '@shared/types'

// --- log ----------------------------------------------------------------------

/**
 * Fields are NUL-separated and (with `git log -z`) every record is
 * NUL-terminated. NUL can never appear inside a commit message, so this is
 * unambiguous whatever the body contains. Body goes last.
 */
export const LOG_FORMAT = ['%H', '%P', '%an', '%ae', '%at', '%s', '%b'].join('%x00')
const LOG_FIELDS = 7

export function parseLog(out: string): Commit[] {
  const tokens = out.split('\0')
  const commits: Commit[] = []
  for (let i = 0; i + LOG_FIELDS <= tokens.length; i += LOG_FIELDS) {
    const hash = tokens[i]!
    if (!/^[0-9a-f]{40,64}$/.test(hash)) break
    commits.push({
      hash,
      parents: tokens[i + 1]! ? tokens[i + 1]!.split(' ') : [],
      author: tokens[i + 2]!,
      email: tokens[i + 3]!,
      date: Number(tokens[i + 4]) || 0,
      subject: tokens[i + 5]!,
      body: tokens[i + 6]!.replace(/\s+$/, '')
    })
  }
  return commits
}

// --- stashes --------------------------------------------------------------------

export interface StashEntry {
  /** N in stash@{N} */
  index: number
  hash: string
  /** [base commit, index commit, (untracked-files commit)] */
  parents: string[]
  message: string
}

/** For `git stash list -z --format=STASH_FORMAT` */
export const STASH_FORMAT = ['%H', '%P', '%gs'].join('%x00')

export function parseStashList(out: string): StashEntry[] {
  const tokens = out.split('\0')
  const stashes: StashEntry[] = []
  for (let i = 0; i + 3 <= tokens.length; i += 3) {
    const hash = tokens[i]!
    if (!/^[0-9a-f]{40,64}$/.test(hash)) break
    stashes.push({
      // Position in the list, not %gd: `log.date` can turn %gd into a timestamp.
      index: stashes.length,
      hash,
      parents: tokens[i + 1]! ? tokens[i + 1]!.split(' ') : [],
      message: tokens[i + 2]!
    })
  }
  return stashes
}

// --- refs -----------------------------------------------------------------------

/** For `git for-each-ref --format=REF_FORMAT refs/heads refs/remotes refs/tags` */
export const REF_FORMAT = [
  '%(refname)',
  '%(objectname)',
  '%(*objectname)',
  '%(upstream:short)',
  '%(upstream:track,nobracket)',
  '%(HEAD)',
  '%(symref)'
].join('%00')

export function parseRefs(out: string): Ref[] {
  const heads: Ref[] = []
  const remotes: Ref[] = []
  const tags: Ref[] = []
  for (const line of out.split('\n')) {
    if (!line) continue
    const [refname = '', hash = '', peeled = '', upstream = '', track = '', head = '', symref = ''] = line.split('\0')
    if (refname.startsWith('refs/heads/')) {
      const ref: Ref = { name: refname.slice('refs/heads/'.length), type: 'head', hash, isCurrent: head === '*' }
      if (upstream) {
        ref.upstream = upstream
        // "ahead 1, behind 2" | "ahead 1" | "behind 2" | "gone" | ""
        if (track !== 'gone') {
          ref.ahead = Number(/ahead (\d+)/.exec(track)?.[1] ?? 0)
          ref.behind = Number(/behind (\d+)/.exec(track)?.[1] ?? 0)
        }
      }
      heads.push(ref)
    } else if (refname.startsWith('refs/remotes/')) {
      // Skip `origin/HEAD` (a symbolic ref pointing at the default branch).
      if (symref || refname.endsWith('/HEAD')) continue
      remotes.push({ name: refname.slice('refs/remotes/'.length), type: 'remote', hash, isCurrent: false })
    } else if (refname.startsWith('refs/tags/')) {
      // Annotated tags: report the commit the tag points at, not the tag object.
      tags.push({ name: refname.slice('refs/tags/'.length), type: 'tag', hash: peeled || hash, isCurrent: false })
    }
  }
  return [...heads, ...remotes, ...tags]
}

// --- status -----------------------------------------------------------------------

function statusFromCode(code: string): FileStatus {
  switch (code) {
    case 'A':
      return 'added'
    case 'D':
      return 'deleted'
    case 'R':
      return 'renamed'
    case 'C':
      return 'copied'
    case 'U':
      return 'conflicted'
    default:
      // M (modified), T (type change)
      return 'modified'
  }
}

/** Splits off `n` space-separated fields; the remainder (the path) may contain spaces. */
function splitFields(entry: string, n: number): { fields: string[]; rest: string } {
  const fields: string[] = []
  let pos = 0
  for (let i = 0; i < n; i++) {
    const next = entry.indexOf(' ', pos)
    if (next === -1) {
      fields.push(entry.slice(pos))
      return { fields, rest: '' }
    }
    fields.push(entry.slice(pos, next))
    pos = next + 1
  }
  return { fields, rest: entry.slice(pos) }
}

export type ParsedStatus = Omit<Status, 'inProgress'>

/** Parses `git status --porcelain=v2 -z --branch` */
export function parseStatus(out: string): ParsedStatus {
  const result: ParsedStatus = { branch: null, head: null, staged: [], unstaged: [], conflicted: [] }
  const tokens = out.split('\0')
  for (let i = 0; i < tokens.length; i++) {
    const entry = tokens[i]!
    if (!entry) continue
    const kind = entry[0]
    if (kind === '#') {
      if (entry.startsWith('# branch.oid ')) {
        const oid = entry.slice('# branch.oid '.length)
        result.head = oid === '(initial)' ? null : oid
      } else if (entry.startsWith('# branch.head ')) {
        const name = entry.slice('# branch.head '.length)
        result.branch = name === '(detached)' ? null : name
      }
    } else if (kind === '1' || kind === '2') {
      // 1 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <path>
      // 2 <XY> <sub> <mH> <mI> <mW> <hH> <hI> <X><score> <path> NUL <origPath>
      const { fields, rest: path } = splitFields(entry, kind === '1' ? 8 : 9)
      const xy = fields[1] ?? '..'
      const x = xy[0] ?? '.'
      const y = xy[1] ?? '.'
      let origPath: string | undefined
      if (kind === '2') origPath = tokens[++i]
      if (x !== '.') {
        const change: FileChange = { path, status: statusFromCode(x) }
        if (origPath && (x === 'R' || x === 'C')) change.oldPath = origPath
        result.staged.push(change)
      }
      if (y !== '.') {
        const change: FileChange = { path, status: statusFromCode(y) }
        if (origPath && (y === 'R' || y === 'C')) change.oldPath = origPath
        result.unstaged.push(change)
      }
    } else if (kind === 'u') {
      // u <XY> <sub> <m1> <m2> <m3> <mW> <h1> <h2> <h3> <path>
      const { rest: path } = splitFields(entry, 10)
      result.conflicted.push({ path, status: 'conflicted' })
    } else if (kind === '?') {
      result.unstaged.push({ path: entry.slice(2), status: 'untracked' })
    }
    // '!' (ignored) entries are not requested.
  }
  return result
}

// --- name-status ------------------------------------------------------------------

/** Parses `git diff --name-status -z` / `git diff-tree --name-status -z` */
export function parseNameStatus(out: string): FileChange[] {
  const tokens = out.split('\0')
  const files: FileChange[] = []
  let i = 0
  while (i < tokens.length) {
    const code = tokens[i++]!
    if (!code) continue
    const letter = code[0]!
    if (letter === 'R' || letter === 'C') {
      const oldPath = tokens[i++]
      const path = tokens[i++]
      if (oldPath === undefined || path === undefined) break
      files.push({ path, oldPath, status: statusFromCode(letter) })
    } else {
      const path = tokens[i++]
      if (path === undefined) break
      files.push({ path, status: statusFromCode(letter) })
    }
  }
  return files
}

// --- remotes ----------------------------------------------------------------------

/** Parses `git remote -v` */
export function parseRemotes(out: string): { name: string; url: string }[] {
  const byName = new Map<string, string>()
  for (const line of out.split('\n')) {
    if (!line.trim()) continue
    const tab = line.indexOf('\t')
    if (tab === -1) {
      if (!byName.has(line.trim())) byName.set(line.trim(), '')
      continue
    }
    const name = line.slice(0, tab)
    const rest = line.slice(tab + 1)
    const isPush = / \(push\)$/.test(rest)
    const url = rest.replace(/ \((fetch|push)\)$/, '')
    // Prefer the fetch URL; fall back to whatever we saw first.
    if (!byName.has(name) || (!isPush && url)) byName.set(name, url)
  }
  return [...byName].map(([name, url]) => ({ name, url }))
}
