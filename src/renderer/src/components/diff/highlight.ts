// Syntax highlighting for diff lines, with VS Code's "Dark+" colours.
// Each side of a hunk is tokenised as one block so multi-line constructs
// (block comments, multi-line strings) inside the hunk colour correctly.
import { createHighlighterCore, type HighlighterCore } from 'shiki/core'
import { createJavaScriptRegexEngine } from 'shiki/engine/javascript'
import { bundledLanguages } from 'shiki/langs'
import type { DiffFile, DiffLine } from './parseDiff'
import type { Segment } from './wordDiff'

export interface Tok {
  text: string
  /** Undefined = default text colour */
  color?: string
}
export type TokenMap = WeakMap<DiffLine, Tok[]>

const THEME = 'dark-plus'
const DEFAULT_FG = '#d4d4d4'
/** Bigger diffs stay plain: tokenising runs on the UI thread */
const MAX_LINES = 20_000
const MAX_LINE_LEN = 2_000
/** Lines tokenised before yielding back to the event loop */
const SLICE = 1_500

/** Extensions whose grammar id is not the extension itself (nor a shiki alias) */
const EXT: Record<string, string> = {
  h: 'c',
  hpp: 'cpp',
  hh: 'cpp',
  cc: 'cpp',
  cxx: 'cpp',
  m: 'objective-c',
  mm: 'objective-cpp',
  mjs: 'javascript',
  cjs: 'javascript',
  mts: 'typescript',
  cts: 'typescript',
  htm: 'html',
  gradle: 'groovy',
  kts: 'kotlin',
  plist: 'xml',
  storyboard: 'xml',
  xib: 'xml',
  svg: 'xml',
  arb: 'json',
  podspec: 'ruby',
  conf: 'ini',
  cfg: 'ini',
  env: 'dotenv',
  zsh: 'shellscript',
  bash: 'shellscript'
}
const NAMES: Record<string, string> = {
  dockerfile: 'docker',
  makefile: 'make',
  'cmakelists.txt': 'cmake',
  podfile: 'ruby',
  gemfile: 'ruby',
  fastfile: 'ruby',
  appfile: 'ruby',
  rakefile: 'ruby',
  'pubspec.lock': 'yaml',
  '.gitignore': 'ini',
  '.env': 'dotenv'
}

const known = (id: string | undefined): id is string => !!id && Object.prototype.hasOwnProperty.call(bundledLanguages, id)

/** Grammar id for a file path, or null when the type is unknown */
export function langForPath(path: string): string | null {
  const name = (path.split('/').pop() ?? path).toLowerCase()
  if (known(NAMES[name])) return NAMES[name]
  const dot = name.lastIndexOf('.')
  if (dot < 0) return null
  const ext = name.slice(dot + 1)
  if (known(EXT[ext])) return EXT[ext]
  return known(ext) ? ext : null
}

let highlighter: Promise<HighlighterCore> | null = null
const langs = new Map<string, Promise<void>>()

async function ready(lang: string): Promise<HighlighterCore> {
  highlighter ??= createHighlighterCore({
    themes: [import('shiki/themes/dark-plus.mjs')],
    langs: [],
    // JS regex engine: no WebAssembly, so the page's CSP stays strict
    engine: createJavaScriptRegexEngine({ forgiving: true })
  })
  const hl = await highlighter
  let loading = langs.get(lang)
  if (!loading) {
    loading = hl.loadLanguage(bundledLanguages[lang as keyof typeof bundledLanguages])
    langs.set(lang, loading)
  }
  await loading
  return hl
}

const clean = (text: string): string => (text.endsWith('\r') ? text.slice(0, -1) : text)

/**
 * Tokens for every line of `file`, or null when the file type is unknown or
 * the diff is too large. Keys are the DiffLine objects of `file` itself.
 */
export async function highlightFile(file: DiffFile, path: string): Promise<TokenMap | null> {
  const lang = langForPath(path)
  if (!lang || file.binary || file.combined) return null
  if (file.hunks.reduce((n, h) => n + h.lines.length, 0) > MAX_LINES) return null

  const hl = await ready(lang)
  const map: TokenMap = new WeakMap()
  let budget = SLICE

  const side = (lines: DiffLine[], only: 'del' | null): void => {
    if (lines.length === 0 || lines.some((l) => l.text.length > MAX_LINE_LEN)) return
    const rows = hl.codeToTokensBase(lines.map((l) => clean(l.text)).join('\n'), { lang, theme: THEME })
    if (rows.length !== lines.length) return
    lines.forEach((line, i) => {
      if (only && line.type !== only) return
      map.set(
        line,
        rows[i].map((t) => ({ text: t.content, color: t.color && t.color.toLowerCase() !== DEFAULT_FG ? t.color : undefined }))
      )
    })
  }

  for (const hunk of file.hunks) {
    side(hunk.lines.filter((l) => l.type !== 'del'), null) // new side: context + added
    side(hunk.lines.filter((l) => l.type !== 'add'), 'del') // old side: removed only
    budget -= hunk.lines.length
    if (budget <= 0) {
      budget = SLICE
      await new Promise((r) => setTimeout(r))
    }
  }
  return map
}

export interface Piece extends Tok {
  changed: boolean
}

/**
 * Overlays the word-diff segments on the syntax tokens of the same line.
 * Returns null when both do not describe the same text.
 */
export function mergeTokens(tokens: Tok[], segs: Segment[] | null): Piece[] | null {
  if (!segs) return tokens.map((t) => ({ ...t, changed: false }))
  const out: Piece[] = []
  let s = 0
  let used = 0 // characters of segs[s] already consumed
  for (const tok of tokens) {
    let rest = tok.text
    while (rest) {
      const seg = segs[s]
      if (!seg) return null
      const take = Math.min(rest.length, seg.text.length - used)
      if (take <= 0 || seg.text.substr(used, take) !== rest.slice(0, take)) return null
      out.push({ text: rest.slice(0, take), color: tok.color, changed: seg.changed })
      rest = rest.slice(take)
      used += take
      if (used === seg.text.length) {
        s++
        used = 0
      }
    }
  }
  return s === segs.length ? out : null
}
