// Data and persisted UI state behind the SUBMODULES / WORKTREES / LFS sections.
import { useCallback, useEffect, useState } from 'react'
import type { LfsInfo, Submodule, Worktree } from '@shared/types'
import { git } from '../../lib/git'
import { useStore } from '../../store'

export type ExtraKind = 'submodules' | 'worktrees' | 'lfs'

export interface ExtrasData {
  /** Repository the lists below belong to */
  repo: string | null
  submodules: Submodule[]
  worktrees: Worktree[]
  /** null until the first answer arrives */
  lfs: LfsInfo | null
  /** Message of the last failed read, per list */
  errors: Partial<Record<ExtraKind, string>>
}

const emptyFor = (repo: string | null): ExtrasData => ({ repo, submodules: [], worktrees: [], lfs: null, errors: {} })

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/** Keeps the previous object when nothing changed, so an unchanged list does not re-render its rows. */
const keep = <T,>(prev: T, next: T): T => (JSON.stringify(prev) === JSON.stringify(next) ? prev : next)

function merge(prev: ExtrasData, repo: string, results: [PromiseSettledResult<Submodule[]>, PromiseSettledResult<Worktree[]>, PromiseSettledResult<LfsInfo>]): ExtrasData {
  // A failed read keeps what was on screen for this repository.
  const base = prev.repo === repo ? prev : emptyFor(repo)
  const [subs, wts, lfs] = results
  const errors: ExtrasData['errors'] = {}
  if (subs.status === 'rejected') errors.submodules = errText(subs.reason)
  if (wts.status === 'rejected') errors.worktrees = errText(wts.reason)
  if (lfs.status === 'rejected') errors.lfs = errText(lfs.reason)
  const next: ExtrasData = {
    repo,
    submodules: subs.status === 'fulfilled' ? keep(base.submodules, subs.value) : base.submodules,
    worktrees: wts.status === 'fulfilled' ? keep(base.worktrees, wts.value) : base.worktrees,
    lfs: lfs.status === 'fulfilled' ? keep(base.lfs, lfs.value) : base.lfs,
    errors: keep(base.errors, errors)
  }
  const same =
    prev.repo === next.repo &&
    prev.submodules === next.submodules &&
    prev.worktrees === next.worktrees &&
    prev.lfs === next.lfs &&
    prev.errors === next.errors
  return same ? prev : next
}

/**
 * Submodules, worktrees and LFS state of the active repository. Loaded when
 * the repository changes and again after every store refresh (which is what
 * follows each mutation, file-system change and window focus).
 */
export function useExtrasData(): ExtrasData {
  const [data, setData] = useState<ExtrasData>(() => emptyFor(useStore.getState().activeRepo))

  useEffect(() => {
    let disposed = false
    let running = false
    let again = false

    // Single flight: refreshes arrive in bursts, and one extra pass after the
    // running one is enough to end up with current data.
    const load = async (): Promise<void> => {
      if (running) {
        again = true
        return
      }
      running = true
      try {
        do {
          again = false
          const repo = useStore.getState().activeRepo
          if (!repo) break
          const results = await Promise.allSettled([git.submodules(repo), git.worktrees(repo), git.lfsInfo(repo)])
          if (disposed) return
          // Stale: the user switched repositories while git was running.
          if (useStore.getState().activeRepo !== repo) {
            again = true
            continue
          }
          setData((prev) => merge(prev, repo, results))
        } while (again)
      } finally {
        running = false
      }
    }

    void load()
    const off = useStore.subscribe((s, prev) => {
      if (s.activeRepo !== prev.activeRepo) {
        setData(emptyFor(s.activeRepo))
        void load()
      } else if (s.status !== prev.status && s.status !== null) {
        // `refresh()` is the only thing that replaces `status`.
        void load()
      }
    })
    return () => {
      disposed = true
      off()
    }
  }, [])

  return data
}

// ----- collapsed state ---------------------------------------------------------
// Own storage key: the sidebar's `useCollapsed` keeps a whole Set per hook
// instance, so two instances writing the same key would overwrite each other.

const OPEN_KEY = 'gitkroken.extras.open'

function loadOpen(): Record<string, boolean> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(OPEN_KEY) ?? '{}')
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {}
    return Object.fromEntries(Object.entries(raw).filter((e): e is [string, boolean] => typeof e[1] === 'boolean'))
  } catch {
    return {}
  }
}

/**
 * Open / closed state per section, persisted. Until the user toggles a section
 * it follows `fallback` (e.g. SUBMODULES starts collapsed while there are none).
 */
export function useOpenState(): {
  isOpen: (key: string, fallback: boolean) => boolean
  toggle: (key: string, current: boolean) => void
} {
  const [state, setState] = useState(loadOpen)

  useEffect(() => {
    try {
      localStorage.setItem(OPEN_KEY, JSON.stringify(state))
    } catch {
      /* storage unavailable: the state just is not persisted */
    }
  }, [state])

  const isOpen = useCallback((key: string, fallback: boolean) => state[key] ?? fallback, [state])
  const toggle = useCallback((key: string, current: boolean) => setState((prev) => ({ ...prev, [key]: !current })), [])
  return { isOpen, toggle }
}
