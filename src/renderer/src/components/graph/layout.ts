// Lane layout for the commit graph. Pure module: no DOM / React imports, so it
// can be unit-tested in plain Node (see layout.test.ts).
//
// The algorithm walks the commits top to bottom (newest first) keeping an
// array of "active lanes": lanes[col] is the hash of the commit that column is
// waiting for. Columns never shift, so a lane is always a straight vertical
// line; the only curves are the ones entering or leaving a node:
//
//   joins  lanes that end at this commit (children on other columns): they come
//          from the top of the row and curve into the node  -> "branch-out"
//   forks  edges to the 2nd..nth parent: they leave the node sideways and
//          curve down into the parent's lane                 -> "merge-in"
//
// Every row lists the columns that are open at its top edge
// (through + joins + own column when `up`) and at its bottom edge
// (through + forks + own column when `down`). The bottom set of row i always
// equals the top set of row i+1, which is what keeps lines continuous.

/** Number of `--lane-N` colours in the theme palette */
export const LANE_COLORS = 10

/** Palette index of a column. Colour is a function of the lane (column). */
export const laneColor = (col: number): number => col % LANE_COLORS

export interface LayoutCommit {
  hash: string
  parents: readonly string[]
  /** Stash entries only link to their base commit (first parent) */
  isStash?: boolean
  /** Draw the link from this node down to its first parent dashed (WIP row) */
  dashed?: boolean
}

export interface GraphRow {
  /** Column of the commit node */
  col: number
  /** Palette index (0..LANE_COLORS-1) of the node */
  color: number
  /** Line from the top edge to the node in its own column (it has a child above) */
  up: boolean
  /** Line from the node to the bottom edge in its own column (first parent) */
  down: boolean
  /** Columns crossing the row straight from top to bottom */
  through: readonly number[]
  /** Columns that come from the top edge and curve into the node */
  joins: readonly number[]
  /** Columns that leave the node and curve down to the bottom edge */
  forks: readonly number[]
  /** Column whose segment entering from the top edge is dashed, or -1 */
  dashedIn: number
  /** True when the node-to-bottom segment of the own column is dashed */
  dashedOut: boolean
}

export interface GraphLayout {
  /** One entry per input commit, same order */
  rows: GraphRow[]
  /** Number of columns needed to draw every row */
  width: number
  /** hash -> row index */
  index: Map<string, number>
}

const NONE: readonly number[] = Object.freeze([]) as readonly number[]

/**
 * Lays out `commits` (newest first, children before parents, unique hashes).
 * Parents missing from the list keep their lane open down to the last row.
 */
export function layoutGraph(commits: readonly LayoutCommit[]): GraphLayout {
  const n = commits.length
  const rows = new Array<GraphRow>(n)
  const index = new Map<string, number>()
  const lanes: (string | null)[] = []
  let width = 0
  let dashedLane = -1

  // `through` arrays are shared between consecutive rows while the set of
  // active lanes and the node column stay the same (long linear stretches).
  let version = 0
  let cacheVersion = -1
  let cacheCol = -1
  let cacheThrough: readonly number[] = NONE

  const alloc = (hash: string, avoid: readonly number[]): number => {
    let l = 0
    while (l < lanes.length && (lanes[l] !== null || avoid.includes(l))) l++
    lanes[l] = hash
    if (l + 1 > width) width = l + 1
    version++
    return l
  }

  for (let i = 0; i < n; i++) {
    const c = commits[i]
    const hash = c.hash

    // 1. Lanes waiting for this commit: the leftmost one becomes its column,
    //    the rest end here.
    let col = -1
    let joins: number[] | null = null
    for (let l = 0; l < lanes.length; l++) {
      if (lanes[l] !== hash) continue
      if (col < 0) col = l
      else {
        if (joins === null) joins = []
        joins.push(l)
        lanes[l] = null
        version++
      }
    }
    const up = col >= 0
    if (!up) col = alloc(hash, NONE) // branch tip: first free column

    let dashedIn = -1
    if (dashedLane >= 0) {
      dashedIn = dashedLane
      if (dashedLane === col || (joins !== null && joins.includes(dashedLane))) dashedLane = -1
    }

    // 2. Lanes that were active before this row and stay active after it.
    let through: readonly number[]
    if (cacheVersion === version && cacheCol === col) {
      through = cacheThrough
    } else {
      const t: number[] = []
      for (let l = 0; l < lanes.length; l++) if (l !== col && lanes[l] !== null) t.push(l)
      through = t.length > 0 ? t : NONE
      cacheVersion = version
      cacheCol = col
      cacheThrough = through
    }

    // 3. Parents: the first one continues in the node's column, the others
    //    fork into the lane already waiting for them or into a new one.
    index.set(hash, i)
    const parents = c.parents
    const pn = c.isStash ? Math.min(1, parents.length) : parents.length
    let down = false
    let forks: number[] | null = null
    for (let k = 0; k < pn; k++) {
      const p = parents[k]
      if (index.has(p)) continue // already drawn above (bad order / self): cannot link downwards
      if (!down) {
        lanes[col] = p
        down = true
        continue
      }
      if (lanes[col] === p) continue // duplicated parent
      let l = lanes.indexOf(p)
      // A column whose lane just ended in this row is not reused in the same
      // row, otherwise a join and a fork would overlap on that column.
      if (l < 0) l = alloc(p, joins ?? NONE)
      if (forks === null) forks = [l]
      else if (!forks.includes(l)) forks.push(l)
    }
    if (!down) {
      lanes[col] = null
      version++
    }

    const dashedOut = c.dashed === true && down
    if (dashedOut) dashedLane = col

    while (lanes.length > 0 && lanes[lanes.length - 1] === null) lanes.pop()

    rows[i] = {
      col,
      color: laneColor(col),
      up,
      down,
      through,
      joins: joins ?? NONE,
      forks: forks ?? NONE,
      dashedIn,
      dashedOut
    }
  }

  return { rows, width, index }
}

/** True when both lists would produce the same layout (same hashes and links). */
export function sameTopology(a: readonly LayoutCommit[], b: readonly LayoutCommit[]): boolean {
  if (a === b) return true
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if (x.hash !== y.hash || !!x.isStash !== !!y.isStash || !!x.dashed !== !!y.dashed) return false
    const xp = x.parents
    const yp = y.parents
    if (xp.length !== yp.length) return false
    for (let k = 0; k < xp.length; k++) if (xp[k] !== yp[k]) return false
  }
  return true
}
