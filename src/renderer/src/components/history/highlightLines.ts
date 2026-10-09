// Syntax colours for a whole file (the blame view), in the same "Dark+" theme
// as the diff viewer.
//
// diff/highlight.ts only knows how to colour a diff, and does each hunk in one
// synchronous go: fine for hunks, but a 10 000 line file would block the UI
// for over a second. Here the file is tokenised in slices, carrying the
// grammar state from one slice to the next (so a block comment or a template
// string that crosses a slice boundary still colours right) and yielding to
// the event loop in between.
//
// TODO: this would live better as an export of diff/highlight.ts, sharing its
// highlighter instance (its `ready()` is private today).
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import type { GrammarState } from 'shiki/core'
import { langForPath, type Tok } from '../diff/highlight'

const THEME = 'dark-plus'
const DEFAULT_FG = '#d4d4d4'
/** Lines tokenised per slice (about 50 ms of work) */
const SLICE = 400
/** Files longer than this are coloured only up to here */
const MAX_LINES = 60_000
/** Longer lines stay plain (minified code) */
const MAX_LINE_LEN = 2_000

let highlighter: Promise<HighlighterCore> | null = null
const loaded = new Map<string, Promise<void>>()

async function ready(lang: string): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/dark-plus.mjs')],
    langs: [],
    // JS regex engine: no WebAssembly, so the page's CSP stays strict
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })
  const hl = await highlighter
  let loading = loaded.get(lang)
  if (!loading) {
    loading = hl.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages])
    loaded.set(lang, loading)
  }
  await loading
  return hl
}

export interface HighlightJob {
  /** Stops the job; `onSlice` is not called again */
  cancel(): void
}

/**
 * Tokenises `lines` (the lines of the file at `path`, without terminators)
 * progressively. `onSlice(tokens, done)` is called after every slice with the
 * same sparse array, filled up to `done` lines. Nothing happens when the file
 * type is unknown.
 */
export function highlightLines(
  lines: readonly string[],
  path: string,
  onSlice: (tokens: ReadonlyArray<Tok[] | undefined>, done: number) => void
): HighlightJob {
  let cancelled = false
  const job: HighlightJob = { cancel: () => void (cancelled = true) }
  const lang = langForPath(path)
  if (!lang || lines.length === 0) return job

  void (async () => {
    const hl = await ready(lang)
    const tokens: Array<Tok[] | undefined> = new Array(lines.length)
    const end = Math.min(lines.length, MAX_LINES)
    let state: GrammarState | undefined
    for (let from = 0; from < end && !cancelled; from += SLICE) {
      const to = Math.min(end, from + SLICE)
      const res = hl.codeToTokens(lines.slice(from, to).join('\n'), {
        lang,
        theme: THEME,
        grammarState: state,
        tokenizeMaxLineLength: MAX_LINE_LEN
      })
      state = res.grammarState
      // An empty last line makes no difference to the row count: always `to - from` rows
      for (let i = 0; i < res.tokens.length && from + i < to; i++) {
        tokens[from + i] = res.tokens[i].map((t) => ({
          text: t.content,
          color: t.color && t.color.toLowerCase() !== DEFAULT_FG ? t.color : undefined
        }))
      }
      onSlice(tokens, to)
      await new Promise((r) => setTimeout(r))
    }
  })().catch(() => {
    /* the file simply stays uncoloured */
  })
  return job
}
