// Repository file watching. No Electron imports.
import { watch as fsWatch, type FSWatcher } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { tryGit } from './exec'

const DEBOUNCE_MS = 300
/** Under constant churn (a build writing files) still emit at least this often. */
const MAX_WAIT_MS = 2000

type Listener = (repo: string) => void

interface Entry {
  watchers: FSWatcher[]
  timer: NodeJS.Timeout | null
  firstEventAt: number
  closed: boolean
}

const listeners = new Set<Listener>()
const entries = new Map<string, Entry>()

/** Subscribe to (debounced) repo change notifications. Returns an unsubscribe function. */
export function onRepoChanged(cb: Listener): () => void {
  listeners.add(cb)
  return () => {
    listeners.delete(cb)
  }
}

function emit(repo: string): void {
  for (const cb of [...listeners]) {
    try {
      cb(repo)
    } catch {
      // A broken listener must not break the watcher.
    }
  }
}

function schedule(repo: string, entry: Entry): void {
  if (entry.closed) return
  const now = Date.now()
  if (entry.timer) clearTimeout(entry.timer)
  else entry.firstEventAt = now
  const wait = Math.max(0, Math.min(DEBOUNCE_MS, entry.firstEventAt + MAX_WAIT_MS - now))
  entry.timer = setTimeout(() => {
    entry.timer = null
    if (!entry.closed) emit(repo)
  }, wait)
}

/**
 * Decides whether a changed path (relative to the worktree, '/'-separated) is
 * noise. `insideGitDir` is true for paths relative to the git directory itself.
 */
export function isNoise(file: string, insideGitDir = false): boolean {
  const parts = file.split('/').filter(Boolean)
  if (parts.length === 0) return false
  let gitParts: string[] | null = insideGitDir ? parts : null
  if (!gitParts && parts[0] === '.git') gitParts = parts.slice(1)

  if (gitParts) {
    // The `.git` directory entry itself changing carries no information.
    if (gitParts.length === 0) return true
    const last = gitParts[gitParts.length - 1]!
    // Lock files are created and removed around every git write.
    if (last.endsWith('.lock')) return true
    // Loose objects / packs: any change that matters also moves a ref,
    // HEAD or the index.
    if (gitParts[0] === 'objects') return true
    if (gitParts[0] === 'hooks' || gitParts[0] === 'info' || gitParts[0] === 'lfs') return true
    if (gitParts[0] === 'fsmonitor--daemon' || gitParts[0] === 'fsmonitor--daemon.ipc') return true
    if (last === 'gc.pid' || last === 'gc.log' || last === 'COMMIT_EDITMSG' || last === 'FETCH_HEAD') return true
    if (last.startsWith('tmp_') || last.endsWith('.tmp') || last.endsWith('~')) return true
    return false
  }

  if (parts.includes('node_modules')) return true
  // Nested repositories / submodules manage their own state.
  if (parts.includes('.git')) return true
  const last = parts[parts.length - 1]!
  if (last === '.DS_Store' || last === 'Thumbs.db') return true
  // Editor swap / atomic-save temp files.
  if (/^\..*\.sw[a-p]$/.test(last) || last === '4913' || last.endsWith('~')) return true
  return false
}

function normalize(filename: string | Buffer | null): string | null {
  if (filename == null) return null
  const text = typeof filename === 'string' ? filename : filename.toString('utf8')
  return sep === '\\' ? text.replace(/\\/g, '/') : text
}

function openWatcher(dir: string, recursive: boolean, onEvent: (file: string | null) => void, onError: () => void): FSWatcher | null {
  try {
    const w = fsWatch(dir, { recursive, persistent: false }, (_event, filename) => {
      try {
        onEvent(normalize(filename))
      } catch {
        // never throw out of an fs callback
      }
    })
    w.on('error', () => {
      try {
        w.close()
      } catch {
        // ignore
      }
      onError()
    })
    return w
  } catch {
    return null
  }
}

function isInside(parent: string, child: string): boolean {
  const rel = relative(parent, child)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}

/** Starts watching `repo`. Idempotent; never rejects. */
export async function watch(repo: string): Promise<void> {
  try {
    if (typeof repo !== 'string' || !repo || entries.has(repo)) return
    const entry: Entry = { watchers: [], timer: null, firstEventAt: 0, closed: false }
    entries.set(repo, entry)

    const add = (dir: string, insideGitDir: boolean): void => {
      const onEvent = (file: string | null): void => {
        if (file !== null && isNoise(file, insideGitDir)) return
        schedule(repo, entry)
      }
      let w = openWatcher(dir, true, onEvent, () => {})
      if (!w && !insideGitDir) {
        // Platforms without recursive fs.watch: at least watch the top level
        // and the git dir (HEAD, index, refs changes cover most operations).
        w = openWatcher(dir, false, onEvent, () => {})
        const gitDir = join(dir, '.git')
        const g = openWatcher(gitDir, false, (f) => onEvent(f === null ? null : `.git/${f}`), () => {})
        if (g) entry.watchers.push(g)
      }
      if (w) entry.watchers.push(w)
    }

    add(repo, false)

    // Linked worktrees and submodules keep their git dir outside the worktree:
    // watch it too so ref / index changes are still seen.
    const out = await tryGit(repo, ['rev-parse', '--absolute-git-dir', '--git-common-dir'])
    if (entry.closed || !out) return
    const [gitDirRaw, commonRaw] = out.split('\n')
    const extra = new Set<string>()
    for (const raw of [gitDirRaw, commonRaw]) {
      if (!raw) continue
      const dir = resolve(repo, raw)
      if (!isInside(repo, dir)) extra.add(dir)
    }
    for (const dir of extra) add(dir, true)
  } catch {
    // watching is best-effort
  }
}

/** Stops watching `repo`. Never rejects. */
export async function unwatch(repo: string): Promise<void> {
  try {
    const entry = entries.get(repo)
    if (!entry) return
    entries.delete(repo)
    entry.closed = true
    if (entry.timer) clearTimeout(entry.timer)
    entry.timer = null
    for (const w of entry.watchers) {
      try {
        w.close()
      } catch {
        // ignore
      }
    }
    entry.watchers = []
  } catch {
    // ignore
  }
}

/** Stops every watcher (used on shutdown and in tests). */
export async function unwatchAll(): Promise<void> {
  await Promise.all([...entries.keys()].map((repo) => unwatch(repo)))
}
