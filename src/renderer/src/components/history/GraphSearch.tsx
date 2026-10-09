// Commit search of the graph (Cmd/Ctrl+F): the state machine and the search
// bar. Graph.tsx only has to mount `bar`, tint the rows in `hits` and offer a
// button calling `open()`.
//
// Matches among the loaded commits are found at once in the renderer; after a
// short pause `git.searchCommits` extends the result to the whole history.
// The selected commit is the cursor: next / previous move the selection, and
// a match that is not loaded yet makes the graph load pages until it is.
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type ReactNode, type RefObject } from 'react'
import { ChevronDown, ChevronUp, LoaderCircle, Search, X } from 'lucide-react'
import type { Commit } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { countLabel, createMatcher, firstMatchFrom, orderMatches, stepMatch, type Matcher } from './commitSearch'
import { errText, loadUntilVisible } from './common'

/** Pause after the last keystroke before the whole history is searched */
const DEBOUNCE_MS = 250
/** Matches asked from the backend */
const REMOTE_LIMIT = 500
/** A single character matches almost every commit: not worth walking the history */
const MIN_REMOTE_QUERY = 2

const HL = 'g-search'
const HL_CURRENT = 'g-search-current'

// The graph is unmounted while a diff is open: remember the search of each
// repository so that coming back does not lose it.
const remembered = { repo: '', open: false, query: '' }

interface Seek {
  hash: string
  state: 'loading' | 'limit' | 'missing'
}

interface Remote {
  key: string
  hashes: string[]
  error: string | null
}

export interface GraphSearch {
  /** The search bar is showing */
  active: boolean
  /** Opens the bar (or focuses it when already open) */
  open(): void
  /** Hashes of the matching commits, loaded or not */
  hits: ReadonlySet<string>
  /** The bar itself; null while closed */
  bar: ReactNode
}

export function useGraphSearch(args: {
  repo: string | null
  /** The commits loaded in the graph, in order */
  commits: readonly Commit[]
  /** Row of every loaded commit */
  index: ReadonlyMap<string, number>
  selected: string | null
  hasMore: boolean
  /** The scroll container of the graph (rows are looked up inside it to paint the matched text) */
  scrollRef: RefObject<HTMLElement | null>
}): GraphSearch {
  const { repo, commits, index, selected, hasMore, scrollRef } = args
  const [open, setOpen] = useState(() => remembered.repo === repo && remembered.open)
  const [text, setText] = useState(() => (remembered.repo === repo ? remembered.query : ''))
  const [remote, setRemote] = useState<Remote | null>(null)
  const [searching, setSearching] = useState(false)
  const [seek, setSeek] = useState<Seek | null>(null)
  const inputRef = useRef<HTMLInputElement>(null)
  /** Bumped to abandon the page loading in flight */
  const seekId = useRef(0)

  // Another repository: a fresh, closed search
  const repoRef = useRef(repo)
  useEffect(() => {
    if (repoRef.current === repo) return
    repoRef.current = repo
    seekId.current++
    setSeek(null)
    setOpen(false)
    setText('')
  }, [repo])
  useEffect(() => {
    remembered.repo = repo ?? ''
    remembered.open = open
    remembered.query = text
  }, [repo, open, text])

  const matcher = useMemo<Matcher | null>(() => (open ? createMatcher(text) : null), [open, text])
  const query = matcher?.query ?? ''

  // --- matches -------------------------------------------------------------
  const local = useMemo(() => {
    if (!matcher) return []
    const out: string[] = []
    for (const c of commits) if (matcher.test(c)) out.push(c.hash)
    return out
  }, [matcher, commits])

  // The whole history, once the user pauses. Only needed while there are
  // pages left to load: with everything loaded the local result is complete.
  const top = commits[0]?.hash ?? ''
  const remoteKey = repo && matcher && hasMore && query.trim().length >= MIN_REMOTE_QUERY ? `${repo}\0${top}\0${query}` : ''
  useEffect(() => {
    if (!remoteKey || !repo) {
      setSearching(false)
      return
    }
    let cancelled = false
    setSearching(true)
    const timer = setTimeout(() => {
      git.searchCommits(repo, query, { limit: REMOTE_LIMIT }).then(
        (hashes) => {
          if (cancelled) return
          setRemote({ key: remoteKey, hashes: Array.isArray(hashes) ? hashes : [], error: null })
          setSearching(false)
        },
        (e) => {
          if (cancelled) return
          setRemote({ key: remoteKey, hashes: [], error: errText(e) })
          setSearching(false)
        }
      )
    }, DEBOUNCE_MS)
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
    // `remoteKey` covers repo and query
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [remoteKey])

  const found = remote && remote.key === remoteKey ? remote : null
  const indexOf = useCallback((hash: string) => index.get(hash), [index])
  const matches = useMemo(() => orderMatches(local, found?.hashes ?? [], indexOf), [local, found, indexOf])
  const hits = useMemo<ReadonlySet<string>>(() => new Set(matches), [matches])
  const more = !!found && found.hashes.length >= REMOTE_LIMIT

  // --- moving to a match -----------------------------------------------------
  const goTo = useCallback(
    (hash: string) => {
      const id = ++seekId.current
      const store = useStore.getState()
      if (index.has(hash)) {
        setSeek(null)
        if (store.selected !== hash) store.select(hash)
        return
      }
      setSeek({ hash, state: 'loading' })
      void loadUntilVisible(hash, () => seekId.current !== id).then((result) => {
        if (seekId.current !== id || result === 'cancelled') return
        if (result === 'ok') {
          setSeek(null)
          useStore.getState().select(hash)
        } else {
          setSeek({ hash, state: result })
        }
      })
    },
    [index]
  )

  const selectedRow = selected !== null ? (index.get(selected) ?? -1) : -1
  const step = useCallback(
    (dir: 1 | -1) => {
      // Enter after "could not reach it": keep loading towards the same commit
      if (seek && seek.state === 'limit' && dir === 1) {
        goTo(seek.hash)
        return
      }
      const from = seek ? seek.hash : selected
      const target = stepMatch(matches, indexOf, from, selectedRow, dir)
      if (target) goTo(target)
    },
    [seek, selected, matches, indexOf, selectedRow, goTo]
  )

  // Typing: jump once per query to the first match at or below the selection
  // (like an editor: refining the text never jumps back to the top)
  const auto = useRef({ query: '', done: true })
  useEffect(() => {
    if (!matcher) {
      auto.current = { query: '', done: true }
      return
    }
    if (auto.current.query !== query) auto.current = { query, done: false }
    if (auto.current.done || matches.length === 0) return
    auto.current.done = true
    // the selection still matches what is typed: stay on it
    if (selected !== null && hits.has(selected)) return
    const target = firstMatchFrom(matches, indexOf, Math.max(0, selectedRow))
    if (target) goTo(target)
    // only a new query or new results may move the selection
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [matcher, matches])

  // --- opening / closing --------------------------------------------------------
  // Bumped by every request to open: the box takes the focus (with its text
  // selected, ready to be replaced) also when it was already open. Not on
  // mount: a search restored after closing a diff must not steal the focus.
  const [focusRequest, setFocusRequest] = useState(0)
  const openSearch = useCallback(() => {
    setOpen(true)
    setFocusRequest((n) => n + 1)
  }, [])
  useLayoutEffect(() => {
    if (focusRequest === 0) return
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [focusRequest])

  const close = useCallback(() => {
    seekId.current++
    setSeek(null)
    setOpen(false)
    scrollRef.current?.focus()
  }, [scrollRef])

  // A new query abandons whatever was being loaded for the previous one
  const onChange = (value: string) => {
    seekId.current++
    if (seek) setSeek(null)
    setText(value)
  }

  const live = useRef({ open, step, close, openSearch })
  live.current = { open, step, close, openSearch }
  useEffect(() => {
    const mac = window.bridge.platform === 'darwin'
    const onKey = (e: globalThis.KeyboardEvent) => {
      if (e.defaultPrevented || document.querySelector('.modal-backdrop')) return
      const mod = mac ? e.metaKey && !e.ctrlKey : e.ctrlKey && !e.metaKey
      const key = e.key.toLowerCase()
      if (mod && !e.altKey && !e.shiftKey && key === 'f') {
        e.preventDefault()
        live.current.openSearch()
        return
      }
      if (!live.current.open) return
      if (e.key === 'F3' || (mod && !e.altKey && key === 'g')) {
        e.preventDefault()
        live.current.step(e.shiftKey ? -1 : 1)
      } else if (e.key === 'Escape' && !document.querySelector('.ctx-menu')) {
        e.preventDefault()
        live.current.close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  // --- matched text ----------------------------------------------------------------
  // Rows are memoised and know nothing about the search: the matched text is
  // painted over the DOM they already rendered with the CSS Custom Highlight
  // API, so neither typing nor scrolling re-renders a single row.
  useLayoutEffect(() => {
    const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
    if (!registry) return
    const root = scrollRef.current
    if (!matcher || !root) {
      registry.delete(HL)
      registry.delete(HL_CURRENT)
      return
    }
    const normal: Range[] = []
    const current: Range[] = []
    const add = (into: Range[], node: Text, start: number, end: number) => {
      const range = document.createRange()
      range.setStart(node, start)
      range.setEnd(node, end)
      into.push(range)
    }
    for (const row of root.querySelectorAll('.g-row:not(.is-wip)')) {
      const into = row.classList.contains('selected') ? current : normal
      for (const cell of row.querySelectorAll('.g-c-msg, .g-c-author')) {
        const walker = document.createTreeWalker(cell, NodeFilter.SHOW_TEXT)
        for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
          for (const [start, end] of matcher.ranges(node.data)) add(into, node, start, end)
        }
      }
      const sha = row.querySelector('.g-c-sha')?.firstChild
      if (sha instanceof Text) {
        const hit = matcher.shaRange(sha.data)
        if (hit) add(into, sha, hit[0], hit[1])
      }
    }
    registry.set(HL, new Highlight(...normal))
    registry.set(HL_CURRENT, new Highlight(...current))
  }) // after every render of the graph: the rows on screen change with scrolling

  useEffect(
    () => () => {
      const registry = typeof CSS !== 'undefined' ? CSS.highlights : undefined
      registry?.delete(HL)
      registry?.delete(HL_CURRENT)
    },
    []
  )

  // --- the bar ------------------------------------------------------------------------
  let bar: ReactNode = null
  if (open) {
    const position = seek ? -1 : selected !== null ? matches.indexOf(selected) : -1
    const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        step(e.shiftKey ? -1 : 1)
      } else if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
        // the arrows keep walking the matches instead of doing nothing in a one-line box
        e.preventDefault()
        step(e.key === 'ArrowDown' ? 1 : -1)
      }
    }
    let note: ReactNode = null
    if (seek?.state === 'loading') {
      note = (
        <span className="g-search-note">
          <LoaderCircle size={12} className="g-spin" />
          Loading more commits to reach the result… ({commits.length} loaded)
        </span>
      )
    } else if (seek?.state === 'limit') {
      note = (
        <span className="g-search-note warn">
          Could not reach commit {seek.hash.slice(0, 7)}: it is older than the {commits.length} commits loaded. Press Enter to keep
          loading.
        </span>
      )
    } else if (seek?.state === 'missing') {
      note = <span className="g-search-note warn">Commit {seek.hash.slice(0, 7)} matches, but it is not in the graph.</span>
    } else if (found?.error) {
      note = <span className="g-search-note warn">Could not search the whole history: {found.error}</span>
    } else if (searching) {
      note = (
        <span className="g-search-note">
          <LoaderCircle size={12} className="g-spin" />
          Searching the whole history…
        </span>
      )
    }

    bar = (
      <div className="g-search" role="search">
        <Search size={14} className="g-search-icon" />
        <input
          ref={inputRef}
          className="g-search-input"
          type="text"
          value={text}
          spellCheck={false}
          autoComplete="off"
          placeholder="Search commits by message, author or SHA"
          aria-label="Search commits"
          onChange={(e) => onChange(e.target.value)}
          onKeyDown={onKeyDown}
        />
        {matcher && (
          <span className={`g-search-count${matches.length === 0 && !searching ? ' none' : ''}`} aria-live="polite">
            {matches.length === 0 && searching ? 'Searching…' : countLabel(position, matches.length, more)}
          </span>
        )}
        {note}
        <span className="g-search-spring" />
        <button
          className="g-search-btn"
          disabled={matches.length === 0}
          title="Previous result (Shift+Enter, Shift+F3)"
          aria-label="Previous result"
          onClick={() => step(-1)}
        >
          <ChevronUp size={15} />
        </button>
        <button
          className="g-search-btn"
          disabled={matches.length === 0}
          title="Next result (Enter, F3)"
          aria-label="Next result"
          onClick={() => step(1)}
        >
          <ChevronDown size={15} />
        </button>
        <button className="g-search-btn" title="Close search (Esc)" aria-label="Close search" onClick={close}>
          <X size={15} />
        </button>
      </div>
    )
  }

  return { active: open, open: openSearch, hits: matcher ? hits : EMPTY, bar }
}

const EMPTY: ReadonlySet<string> = new Set()
