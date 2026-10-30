import { create } from 'zustand'
import type { Commit, Ref, Remote, Status } from '@shared/types'
import { git } from './lib/git'
import { toast } from './components/ui/overlays'
import { handleCredentialRequest } from './components/net/credentials'

/** Pseudo-hash of the "work in progress" row at the top of the graph */
export const WIP = 'WIP'
const PAGE = 2000
const TABS_KEY = 'gitkroken.tabs'
const ACTIVE_KEY = 'gitkroken.active'
const RECENT_KEY = 'gitkroken.recent'

export interface RepoTab {
  path: string
  name: string
}

export interface SelectedFile {
  path: string
  oldPath?: string
  /** Set when the file belongs to a commit; otherwise it is a WIP file */
  commit?: string
  staged?: boolean
  untracked?: boolean
}

/** What the centre area shows instead of the graph (a selected file's diff aside) */
export type CenterView =
  | { kind: 'graph' }
  | { kind: 'conflict'; path: string }
  /** Interactive rebase of `base..HEAD` */
  | { kind: 'rebase'; base: string }
  | { kind: 'blame'; path: string; rev?: string }
  | { kind: 'fileHistory'; path: string }
  /** A file as it is in commit `rev` (read only, whether the commit changed it or not) */
  | { kind: 'file'; path: string; rev: string }

interface AppState {
  tabs: RepoTab[]
  recent: RepoTab[]
  /** Path of the active repo; null shows the welcome screen */
  activeRepo: string | null
  commits: Commit[]
  hasMore: boolean
  refs: Ref[]
  remotes: Remote[]
  status: Status | null
  loading: boolean
  /** Label of the git operation currently running (e.g. "Push"), if any */
  busy: string | null
  /** Selected commit hash, WIP, or null */
  selected: string | null
  /** When set, the center area shows the diff view instead of the graph */
  selectedFile: SelectedFile | null
  view: CenterView

  openRepo(path: string): Promise<void>
  closeTab(path: string): void
  setActive(path: string | null): void
  refresh(): Promise<void>
  loadMore(): Promise<void>
  select(hash: string | null): void
  selectFile(file: SelectedFile | null): void
  /** Opens a centre view (closing any diff); `{ kind: 'graph' }` goes back to the graph */
  openView(view: CenterView): void
  /**
   * Runs a git mutation with busy state + error toast, then refreshes.
   * Resolves true on success. Use for every write operation.
   */
  run(label: string, fn: (repo: string) => Promise<unknown>, successMsg?: string): Promise<boolean>
}

const load = <T,>(key: string, fallback: T): T => {
  try {
    return JSON.parse(localStorage.getItem(key) ?? '') as T
  } catch {
    return fallback
  }
}
const baseName = (p: string) => p.split(/[\\/]/).filter(Boolean).pop() ?? p
const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

let refreshSeq = 0

export const useStore = create<AppState>((set, get) => ({
  tabs: load<RepoTab[]>(TABS_KEY, []),
  recent: load<RepoTab[]>(RECENT_KEY, []),
  activeRepo: null,
  commits: [],
  hasMore: false,
  refs: [],
  remotes: [],
  status: null,
  loading: false,
  busy: null,
  selected: null,
  selectedFile: null,
  view: { kind: 'graph' },

  async openRepo(path) {
    try {
      const repo = await git.resolveRepo(path)
      if (!repo) {
        toast(`"${path}" is not a Git repository`, 'error')
        return
      }
      const tab = { path: repo, name: baseName(repo) }
      const { tabs, recent } = get()
      const nextTabs = tabs.some((t) => t.path === repo) ? tabs : [...tabs, tab]
      const nextRecent = [tab, ...recent.filter((r) => r.path !== repo)].slice(0, 12)
      localStorage.setItem(TABS_KEY, JSON.stringify(nextTabs))
      localStorage.setItem(RECENT_KEY, JSON.stringify(nextRecent))
      set({ tabs: nextTabs, recent: nextRecent })
      get().setActive(repo)
    } catch (e) {
      toast(errText(e), 'error')
    }
  },

  closeTab(path) {
    const { tabs, activeRepo } = get()
    const idx = tabs.findIndex((t) => t.path === path)
    const next = tabs.filter((t) => t.path !== path)
    localStorage.setItem(TABS_KEY, JSON.stringify(next))
    set({ tabs: next })
    git.unwatch(path).catch(() => {})
    if (activeRepo === path) get().setActive(next[Math.min(idx, next.length - 1)]?.path ?? null)
  },

  setActive(path) {
    if (path) localStorage.setItem(ACTIVE_KEY, path)
    else localStorage.removeItem(ACTIVE_KEY)
    set({
      activeRepo: path,
      commits: [],
      refs: [],
      remotes: [],
      status: null,
      hasMore: false,
      selected: null,
      selectedFile: null,
      view: { kind: 'graph' }
    })
    if (!path) return
    // The folder may have stopped being a repository (deleted .git, moved) since
    // the tab was saved; git would then act on a parent repo containing it.
    git.resolveRepo(path).then(
      (top) => {
        if (get().activeRepo !== path) return
        if (top !== path) {
          toast(`"${path}" is no longer the root of a Git repository. Closing its tab.`, 'error')
          get().closeTab(path)
          return
        }
        git.watch(path).catch(() => {})
        get().refresh()
      },
      (e) => get().activeRepo === path && toast(errText(e), 'error')
    )
  },

  async refresh() {
    const repo = get().activeRepo
    if (!repo) return
    const seq = ++refreshSeq
    set({ loading: true })
    try {
      const limit = Math.max(PAGE, get().commits.length)
      const [commits, refs, status, remotes] = await Promise.all([
        git.log(repo, { limit }),
        git.refs(repo),
        git.status(repo),
        git.remotes(repo)
      ])
      if (seq !== refreshSeq || get().activeRepo !== repo) return
      const { selected } = get()
      const stillThere = selected === null || selected === WIP || commits.some((c) => c.hash === selected)
      set({
        commits,
        refs,
        status,
        remotes,
        hasMore: commits.length >= limit,
        selected: stillThere ? selected : null,
        selectedFile: stillThere ? get().selectedFile : null
      })
    } catch (e) {
      if (seq === refreshSeq) toast(errText(e), 'error')
    } finally {
      if (seq === refreshSeq) set({ loading: false })
    }
  },

  async loadMore() {
    const { activeRepo: repo, commits, hasMore, loading } = get()
    if (!repo || !hasMore || loading) return
    set({ loading: true })
    try {
      const more = await git.log(repo, { limit: PAGE, skip: commits.length })
      if (get().activeRepo !== repo) return
      set({ commits: [...get().commits, ...more], hasMore: more.length >= PAGE })
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      set({ loading: false })
    }
  },

  select(hash) {
    set({ selected: hash, selectedFile: null, view: { kind: 'graph' } })
  },

  selectFile(file) {
    set(file ? { selectedFile: file, view: { kind: 'graph' } } : { selectedFile: null })
  },

  openView(view) {
    set({ view, selectedFile: null })
  },

  async run(label, fn, successMsg) {
    const repo = get().activeRepo
    if (!repo || get().busy) return false
    set({ busy: label })
    let ok = true
    try {
      await fn(repo)
      if (successMsg) toast(successMsg, 'success')
    } catch (e) {
      ok = false
      const text = errText(e)
      // Cancelled by the user: say so, but it is not a failure
      if (/^Operation cancelled/i.test(text)) toast(`${label} cancelled`, 'info')
      else toast(`${label}: ${text}`, 'error')
    } finally {
      set({ busy: null })
    }
    await get().refresh()
    return ok
  }
}))

/** Call once at startup: restores the last active tab and wires auto-refresh. */
export function initStore(): () => void {
  const { tabs, setActive } = useStore.getState()
  const last = localStorage.getItem(ACTIVE_KEY)
  const initial = tabs.find((t) => t.path === last) ?? tabs[0]
  if (initial) setActive(initial.path)

  const off = window.bridge.onRepoChanged((repo) => {
    const s = useStore.getState()
    if (repo === s.activeRepo && !s.busy) s.refresh()
  })
  const offCred = window.bridge.onCredentialRequest(handleCredentialRequest)
  const onFocus = () => useStore.getState().refresh()
  window.addEventListener('focus', onFocus)
  return () => {
    off()
    offCred()
    window.removeEventListener('focus', onFocus)
  }
}
