// Line diff used by the three-way merge. Pure module (unit-tested in Node).
//
// It follows git's xdiff closely on purpose (same bidirectional Myers search,
// same "slide the change group down" normalisation) so that the regions the
// editor computes are, in practice, the ones git itself wrote to the file.

/** `a[a .. a+an)` was replaced by `b[b .. b+bn)`; `an` or `bn` may be 0 */
export interface Hunk {
  a: number
  an: number
  b: number
  bn: number
}

const MAX_COST_MIN = 256
const NO_SNAKE = 0x3fffffff

/** Integer square root rounded up to a power of two, like xdiff's `xdl_bogosqrt` */
function bogoSqrt(n: number): number {
  let i = 1
  for (; n > 0; n >>= 2) i <<= 1
  return i
}

class Differ {
  private readonly kvdf: Int32Array
  private readonly kvdb: Int32Array
  private readonly offset: number
  private readonly maxCost: number

  constructor(
    private readonly a: Int32Array,
    private readonly b: Int32Array,
    private readonly changedA: Uint8Array,
    private readonly changedB: Uint8Array,
    private readonly indexA: Int32Array,
    private readonly indexB: Int32Array
  ) {
    const diags = a.length + b.length + 3
    this.kvdf = new Int32Array(2 * diags + 2)
    this.kvdb = new Int32Array(2 * diags + 2)
    this.offset = b.length + 1 + diags
    this.maxCost = Math.max(MAX_COST_MIN, bogoSqrt(diags))
  }

  run(): void {
    this.compare(0, this.a.length, 0, this.b.length)
  }

  private compare(off1: number, lim1: number, off2: number, lim2: number): void {
    const { a, b } = this
    for (;;) {
      while (off1 < lim1 && off2 < lim2 && a[off1] === b[off2]) off1++, off2++
      while (off1 < lim1 && off2 < lim2 && a[lim1 - 1] === b[lim2 - 1]) lim1--, lim2--
      if (off1 === lim1) {
        for (; off2 < lim2; off2++) this.changedB[this.indexB[off2]!] = 1
        return
      }
      if (off2 === lim2) {
        for (; off1 < lim1; off1++) this.changedA[this.indexA[off1]!] = 1
        return
      }
      const [i1, i2] = this.split(off1, lim1, off2, lim2)
      this.compare(off1, i1, off2, i2)
      // Tail call for the second half
      off1 = i1
      off2 = i2
    }
  }

  /** Finds a point of an optimal (or, past `maxCost`, good enough) path to split the box at. */
  private split(off1: number, lim1: number, off2: number, lim2: number): [number, number] {
    const { a, b, kvdf, kvdb, offset: o } = this
    const dmin = off1 - lim2
    const dmax = lim1 - off2
    const fmid = off1 - off2
    const bmid = lim1 - lim2
    const odd = ((fmid - bmid) & 1) !== 0
    let fmin = fmid
    let fmax = fmid
    let bmin = bmid
    let bmax = bmid
    kvdf[o + fmid] = off1
    kvdb[o + bmid] = lim1

    for (let ec = 1; ; ec++) {
      // Forward: extend the furthest reaching path on each diagonal by one edit.
      if (fmin > dmin) kvdf[o + --fmin - 1] = -1
      else ++fmin
      if (fmax < dmax) kvdf[o + ++fmax + 1] = -1
      else --fmax
      for (let d = fmax; d >= fmin; d -= 2) {
        let i1 = kvdf[o + d - 1]! >= kvdf[o + d + 1]! ? kvdf[o + d - 1]! + 1 : kvdf[o + d + 1]!
        let i2 = i1 - d
        while (i1 < lim1 && i2 < lim2 && a[i1] === b[i2]) i1++, i2++
        kvdf[o + d] = i1
        if (odd && bmin <= d && d <= bmax && kvdb[o + d]! <= i1) return [i1, i2]
      }

      // Backward
      if (bmin > dmin) kvdb[o + --bmin - 1] = NO_SNAKE
      else ++bmin
      if (bmax < dmax) kvdb[o + ++bmax + 1] = NO_SNAKE
      else --bmax
      for (let d = bmax; d >= bmin; d -= 2) {
        let i1 = kvdb[o + d - 1]! < kvdb[o + d + 1]! ? kvdb[o + d - 1]! : kvdb[o + d + 1]! - 1
        let i2 = i1 - d
        while (i1 > off1 && i2 > off2 && a[i1 - 1] === b[i2 - 1]) i1--, i2--
        kvdb[o + d] = i1
        if (!odd && fmin <= d && d <= fmax && i1 <= kvdf[o + d]!) return [i1, i2]
      }

      // Too expensive (very different inputs): settle for the path that got furthest.
      if (ec >= this.maxCost) {
        let fbest = -1
        let fbest1 = -1
        for (let d = fmax; d >= fmin; d -= 2) {
          let i1 = Math.min(kvdf[o + d]!, lim1)
          let i2 = i1 - d
          if (lim2 < i2) (i1 = lim2 + d), (i2 = lim2)
          if (fbest < i1 + i2) (fbest = i1 + i2), (fbest1 = i1)
        }
        let bbest = NO_SNAKE
        let bbest1 = NO_SNAKE
        for (let d = bmax; d >= bmin; d -= 2) {
          let i1 = Math.max(off1, kvdb[o + d]!)
          let i2 = i1 - d
          if (i2 < off2) (i1 = off2 + d), (i2 = off2)
          if (i1 + i2 < bbest) (bbest = i1 + i2), (bbest1 = i1)
        }
        return lim1 + lim2 - bbest < fbest - (off1 + off2) ? [fbest1, fbest - fbest1] : [bbest1, bbest - bbest1]
      }
    }
  }
}

/**
 * xdiff's `xdl_change_compact`: a run of changed lines that could equally sit
 * a few lines up or down (inserting one of several identical lines) is moved
 * as far down as it goes, unless a higher position lines it up with a change
 * of the other file. `changed*` have one extra trailing 0 as sentinel.
 */
function compact(lines: Int32Array, changed: Uint8Array, otherChanged: Uint8Array): void {
  const n = lines.length
  const m = otherChanged.length - 1
  // A "group" is a maximal run [start, end) of changed lines; between any two
  // unchanged lines there is one (possibly empty) group, in both files.
  let start = 0
  let end = 0
  while (changed[end]) end++
  let oStart = 0
  let oEnd = 0
  while (otherChanged[oEnd]) oEnd++

  const otherNext = (): void => {
    oStart = oEnd + 1
    for (oEnd = oStart; oEnd <= m && otherChanged[oEnd]; oEnd++);
  }
  const otherPrev = (): void => {
    oEnd = oStart - 1
    for (oStart = oEnd; oStart > 0 && otherChanged[oStart - 1]; oStart--);
  }
  const slideUp = (): boolean => {
    if (start > 0 && lines[start - 1] === lines[end - 1]) {
      changed[--start] = 1
      changed[--end] = 0
      while (start > 0 && changed[start - 1]) start--
      return true
    }
    return false
  }
  const slideDown = (): boolean => {
    if (end < n && lines[start] === lines[end]) {
      changed[start++] = 0
      changed[end++] = 1
      while (changed[end]) end++
      return true
    }
    return false
  }

  for (;;) {
    if (end !== start) {
      let size: number
      let earliestEnd: number
      let endMatchingOther: number
      do {
        size = end - start
        endMatchingOther = -1
        while (slideUp()) otherPrev()
        earliestEnd = end
        if (oEnd > oStart) endMatchingOther = end
        while (slideDown()) {
          otherNext()
          if (oEnd > oStart) endMatchingOther = end
        }
      } while (size !== end - start)

      if (end !== earliestEnd && endMatchingOther !== -1) {
        // Back up to the last position that lines up with a change in the other file.
        while (oEnd === oStart) {
          if (!slideUp()) break
          otherPrev()
        }
      }
    }
    if (end >= n) break
    start = end + 1
    for (end = start; changed[end]; end++);
    otherNext()
  }
}

/** Minimal-ish line diff of two arrays of lines, as an ordered list of hunks. */
export function diffLines(a: readonly string[], b: readonly string[]): Hunk[] {
  // Intern the lines: the search then compares integers.
  const ids = new Map<string, number>()
  const intern = (lines: readonly string[]): Int32Array => {
    const out = new Int32Array(lines.length)
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!
      let id = ids.get(line)
      if (id === undefined) ids.set(line, (id = ids.size))
      out[i] = id
    }
    return out
  }
  const ia = intern(a)
  const ib = intern(b)
  const changedA = new Uint8Array(a.length + 1)
  const changedB = new Uint8Array(b.length + 1)

  // Lines that do not exist at all on the other side are changed for sure;
  // leaving them out of the search makes very different files cheap.
  const inA = new Uint8Array(ids.size)
  const inB = new Uint8Array(ids.size)
  for (const id of ia) inA[id] = 1
  for (const id of ib) inB[id] = 1
  const keep = (src: Int32Array, present: Uint8Array, changed: Uint8Array): [Int32Array, Int32Array] => {
    const lines = new Int32Array(src.length)
    const index = new Int32Array(src.length)
    let n = 0
    for (let i = 0; i < src.length; i++) {
      if (present[src[i]!]) {
        lines[n] = src[i]!
        index[n++] = i
      } else changed[i] = 1
    }
    return [lines.subarray(0, n), index.subarray(0, n)]
  }
  const [ka, indexA] = keep(ia, inB, changedA)
  const [kb, indexB] = keep(ib, inA, changedB)

  new Differ(ka, kb, changedA, changedB, indexA, indexB).run()
  compact(ia, changedA, changedB)
  compact(ib, changedB, changedA)

  const hunks: Hunk[] = []
  let i = 0
  let j = 0
  while (i < a.length || j < b.length) {
    if (!changedA[i] && !changedB[j]) {
      i++
      j++
      continue
    }
    const hunk: Hunk = { a: i, an: 0, b: j, bn: 0 }
    while (changedA[i]) i++
    while (changedB[j]) j++
    hunk.an = i - hunk.a
    hunk.bn = j - hunk.b
    hunks.push(hunk)
  }
  return hunks
}
