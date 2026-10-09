// Turns a layout row into SVG path data. Pure (no DOM), unit-tested.
import { laneColor, LANE_COLORS, type GraphRow } from './layout'

/** Horizontal distance between two lanes, in px */
export const LANE_W = 22
/** Left padding of the graph column, in px */
export const PAD = 5

/** X of the centre of a column */
export const laneX = (col: number): number => PAD + col * LANE_W + LANE_W / 2

/** Width needed to draw `cols` columns */
export const graphWidth = (cols: number): number => PAD * 2 + Math.max(1, cols) * LANE_W

export interface RowPath {
  /** Palette index */
  color: number
  d: string
  dashed: boolean
}

/**
 * Path data for one row of height `h`. Solid segments are merged into a single
 * path per colour so wide graphs stay cheap to render.
 */
export function rowPaths(row: GraphRow, h: number): RowPath[] {
  const mid = h / 2
  const r = Math.min(LANE_W / 2, mid) - 1
  const xn = laneX(row.col)
  const solid = new Array<string>(LANE_COLORS).fill('')
  const out: RowPath[] = []

  const add = (col: number, d: string, dashed: boolean): void => {
    const color = laneColor(col)
    if (dashed) out.push({ color, d, dashed: true })
    else solid[color] += d
  }

  for (const c of row.through) add(c, `M${laneX(c)} 0V${h}`, c === row.dashedIn)

  for (const c of row.joins) {
    // down the child lane, round the corner, then sideways into the node
    const x = laneX(c)
    const dir = row.col > c ? 1 : -1
    add(c, `M${x} 0V${mid - r}A${r} ${r} 0 0 ${dir > 0 ? 0 : 1} ${x + dir * r} ${mid}H${xn}`, c === row.dashedIn)
  }

  for (const c of row.forks) {
    // sideways out of the node, round the corner, then down the parent lane
    const x = laneX(c)
    const dir = c > row.col ? 1 : -1
    add(c, `M${xn} ${mid}H${x - dir * r}A${r} ${r} 0 0 ${dir > 0 ? 1 : 0} ${x} ${mid + r}V${h}`, false)
  }

  if (row.up) add(row.col, `M${xn} 0V${mid}`, row.col === row.dashedIn)
  if (row.down) add(row.col, `M${xn} ${mid}V${h}`, row.dashedOut)

  for (let color = 0; color < LANE_COLORS; color++) {
    if (solid[color]) out.push({ color, d: solid[color], dashed: false })
  }
  return out
}
