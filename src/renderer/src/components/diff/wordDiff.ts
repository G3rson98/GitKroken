// Intra-line (word level) diff used to highlight what changed between a
// removed line and the added line that replaces it. Pure module.

export interface Segment {
  text: string
  changed: boolean
}

export interface WordDiff {
  old: Segment[]
  new: Segment[]
}

const TOKEN_RE = /[\p{L}\p{N}_]+|\s+|[^\p{L}\p{N}_\s]/gu
/** Above this many tokens per side the LCS table is not worth its cost */
const MAX_TOKENS = 600
/** Lines longer than this are not word-diffed at all */
const MAX_LINE = 4000

export function tokenize(line: string): string[] {
  return line.match(TOKEN_RE) ?? []
}

function push(out: Segment[], text: string, changed: boolean): void {
  if (!text) return
  const last = out[out.length - 1]
  if (last && last.changed === changed) last.text += text
  else out.push({ text, changed })
}

/**
 * Returns the segments of both lines, or null when highlighting would not
 * help: identical lines, lines with nothing in common, or lines too long.
 */
export function wordDiff(oldLine: string, newLine: string): WordDiff | null {
  if (oldLine === newLine) return null
  if (oldLine.length > MAX_LINE || newLine.length > MAX_LINE) return null
  const a = tokenize(oldLine)
  const b = tokenize(newLine)
  if (a.length === 0 || b.length === 0) return null

  let pre = 0
  while (pre < a.length && pre < b.length && a[pre] === b[pre]) pre++
  let suf = 0
  while (suf < a.length - pre && suf < b.length - pre && a[a.length - 1 - suf] === b[b.length - 1 - suf]) suf++

  const am = a.slice(pre, a.length - suf)
  const bm = b.slice(pre, b.length - suf)
  const n = am.length
  const m = bm.length

  const oldSeg: Segment[] = []
  const newSeg: Segment[] = []
  push(oldSeg, a.slice(0, pre).join(''), false)
  push(newSeg, b.slice(0, pre).join(''), false)

  let common = 0
  const count = (tok: string) => {
    if (tok.trim()) common += tok.length
  }
  a.slice(0, pre).forEach(count)
  a.slice(a.length - suf).forEach(count)

  if (n > MAX_TOKENS || m > MAX_TOKENS) {
    push(oldSeg, am.join(''), true)
    push(newSeg, bm.join(''), true)
  } else if (n > 0 || m > 0) {
    // LCS table over the differing middle
    const w = m + 1
    const table = new Uint16Array((n + 1) * w)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        table[i * w + j] =
          am[i] === bm[j] ? table[(i + 1) * w + j + 1] + 1 : Math.max(table[(i + 1) * w + j], table[i * w + j + 1])
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (am[i] === bm[j]) {
        push(oldSeg, am[i], false)
        push(newSeg, bm[j], false)
        count(am[i])
        i++
        j++
      } else if (table[(i + 1) * w + j] >= table[i * w + j + 1]) {
        push(oldSeg, am[i++], true)
      } else {
        push(newSeg, bm[j++], true)
      }
    }
    while (i < n) push(oldSeg, am[i++], true)
    while (j < m) push(newSeg, bm[j++], true)
  }

  push(oldSeg, a.slice(a.length - suf).join(''), false)
  push(newSeg, b.slice(b.length - suf).join(''), false)

  // Two unrelated lines: highlighting scattered punctuation is just noise
  const longest = Math.max(oldLine.trim().length, newLine.trim().length)
  if (longest > 0 && common / longest < 0.2) return null
  return { old: oldSeg, new: newSeg }
}
