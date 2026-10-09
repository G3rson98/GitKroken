// Small pieces shared by the blame view, the file history view and the graph search.
import { useEffect, useRef, type ReactNode } from 'react'
import { useStore } from '../../store'
import { toast } from '../ui/overlays'
import { splitPath } from '../details/common'

export const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

/**
 * Calls `onEscape` when Escape is pressed, unless a dialog / context menu is
 * open or a text field has the focus. Return true from the callback when the
 * key was used (it then goes no further).
 */
export function useEscape(onEscape: () => boolean | void): void {
  const cb = useRef(onEscape)
  cb.current = onEscape
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return
      if (document.querySelector('.modal-backdrop, .ctx-menu')) return
      const t = e.target as HTMLElement | null
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return
      if (cb.current() !== false) e.preventDefault()
    }
    // Capture phase: runs before a dialog / menu handles (and unmounts on) the same Escape
    window.addEventListener('keydown', onKey, true)
    return () => window.removeEventListener('keydown', onKey, true)
  }, [])
}

export function Notice(props: { icon: ReactNode; text: string; detail?: string; error?: boolean; children?: ReactNode }) {
  return (
    <div className={`hv-notice${props.error ? ' error' : ''}`}>
      {props.icon}
      <div className="hv-notice-title">{props.text}</div>
      {props.detail && <div className="hv-notice-detail">{props.detail}</div>}
      {props.children}
    </div>
  )
}

/** `src/a/` dimmed + `b.ts` bold, cut on the left when it does not fit */
export function PathLabel({ path }: { path: string }) {
  const [dir, name] = splitPath(path)
  return (
    <div className="hv-path" title={path}>
      <span className="hv-path-inner">
        <span className="hv-path-dir">{dir}</span>
        <span className="hv-path-name">{name}</span>
      </span>
    </div>
  )
}

const UNITS: Array<[Intl.RelativeTimeFormatUnit, number]> = [
  ['year', 365 * 24 * 3600],
  ['month', 30 * 24 * 3600],
  ['week', 7 * 24 * 3600],
  ['day', 24 * 3600],
  ['hour', 3600],
  ['minute', 60]
]
const narrow = new Intl.RelativeTimeFormat('en', { numeric: 'always', style: 'narrow' })

/** Compact relative date for narrow columns: "3d ago", "2w ago", "5y ago" */
export function shortRelative(date: number, now: number): string {
  const diff = date - now
  const abs = Math.abs(diff)
  for (const [unit, secs] of UNITS) {
    if (abs >= secs) return narrow.format(Math.trunc(diff / secs), unit)
  }
  return 'now'
}

const fullFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })
export const fullDate = (sec: number): string => fullFmt.format(sec * 1000)

/** Pages of the graph loaded at most to reach one commit (2000 commits each) */
export const MAX_REVEAL_PAGES = 30

export type RevealResult = 'ok' | 'limit' | 'missing' | 'cancelled'

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

/**
 * Makes sure `hash` is among the commits the graph has loaded, asking for
 * more pages (a bounded number of them) until it shows up.
 *  - 'ok'       it is loaded
 *  - 'limit'    still not there after MAX_REVEAL_PAGES pages (calling again continues)
 *  - 'missing'  the whole history is loaded and the commit is not in it
 */
export async function loadUntilVisible(hash: string, cancelled: () => boolean = () => false): Promise<RevealResult> {
  const repo = useStore.getState().activeRepo
  let pages = 0
  let waits = 0
  for (;;) {
    const s = useStore.getState()
    if (cancelled() || s.activeRepo !== repo) return 'cancelled'
    if (s.commits.some((c) => c.hash === hash)) return 'ok'
    if (s.loading) {
      // a refresh or another page is in flight: `loadMore` would be a no-op
      if (++waits > 400) return 'limit'
      await sleep(50)
      continue
    }
    if (!s.hasMore) return 'missing'
    if (pages >= MAX_REVEAL_PAGES) return 'limit'
    pages++
    const before = s.commits.length
    await s.loadMore()
    const after = useStore.getState()
    // nothing arrived: the page failed to load (the store already reported the error)
    if (after.commits.length === before && after.hasMore && !after.loading) return 'limit'
  }
}

/**
 * Goes back to the graph with `hash` selected. The commit may be older than
 * the loaded pages: the selection is made at once (the right panel shows the
 * commit) and the graph is extended in the background until the row exists.
 */
export async function showInGraph(hash: string): Promise<void> {
  const { select } = useStore.getState()
  select(hash)
  const result = await loadUntilVisible(hash, () => {
    const s = useStore.getState()
    // the user moved on (another selection or another view): stop loading
    return (s.selected !== hash && s.selected !== null) || s.view.kind !== 'graph'
  })
  const s = useStore.getState()
  if (result === 'ok') {
    // a refresh that ran before the row was loaded clears the selection
    if (s.selected === null && s.view.kind === 'graph') select(hash)
  } else if (result === 'limit') {
    toast(`Commit ${hash.slice(0, 7)} is older than the ${s.commits.length} commits loaded in the graph`, 'info')
  } else if (result === 'missing') {
    toast(`Commit ${hash.slice(0, 7)} is not in the graph (no branch or tag reaches it)`, 'info')
  }
}
