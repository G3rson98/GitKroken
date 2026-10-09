import { describe, expect, it } from 'vitest'
import { layoutGraph, sameTopology, laneColor, LANE_COLORS, type GraphRow, type LayoutCommit } from './layout'
import { rowPaths, laneX } from './geometry'

const c = (hash: string, ...parents: string[]): LayoutCommit => ({ hash, parents })

const topCols = (r: GraphRow): number[] => [...r.through, ...r.joins, ...(r.up ? [r.col] : [])].sort((a, b) => a - b)
const bottomCols = (r: GraphRow): number[] => [...r.through, ...r.forks, ...(r.down ? [r.col] : [])].sort((a, b) => a - b)

/** Lines must be continuous: what leaves a row at the bottom enters the next one at the top. */
function expectContinuous(rows: GraphRow[]): void {
  expect(topCols(rows[0])).toEqual([])
  for (let i = 0; i + 1 < rows.length; i++) {
    // a fork into an existing lane is listed both in through and forks
    expect([...new Set(bottomCols(rows[i]))], `rows ${i} -> ${i + 1}`).toEqual(topCols(rows[i + 1]))
  }
}

/** Every loaded parent must be reachable by following one column down from the child. */
function expectEdgesConnected(commits: LayoutCommit[], rows: GraphRow[], index: Map<string, number>): void {
  commits.forEach((commit, i) => {
    const row = rows[i]
    commit.parents.forEach((p, k) => {
      const j = index.get(p)
      const lane = k === 0 ? row.col : row.forks[k - 1]
      expect(lane, `${commit.hash} -> ${p}`).toBeTypeOf('number')
      if (k === 0) expect(row.down).toBe(true)
      const last = j ?? rows.length
      for (let r = i + 1; r < last; r++) {
        expect(rows[r].through, `${commit.hash} -> ${p} crossing row ${r}`).toContain(lane)
      }
      if (j !== undefined) {
        const target = rows[j]
        const arrives = (target.col === lane && target.up) || target.joins.includes(lane)
        expect(arrives, `${commit.hash} -> ${p} arrives`).toBe(true)
      }
    })
  })
}

/** Deterministic PRNG so the property tests are reproducible */
function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

/** Random DAG in valid log order: parents always come later in the list. */
function randomDag(n: number, seed: number, missing = 0): LayoutCommit[] {
  const rnd = mulberry32(seed)
  const out: LayoutCommit[] = []
  for (let i = 0; i < n; i++) {
    const parents = new Set<string>()
    const roll = rnd()
    const count = i === n - 1 ? 0 : roll < 0.04 ? 0 : roll < 0.78 ? 1 : roll < 0.95 ? 2 : 3
    for (let k = 0; k < count; k++) {
      const j = i + 1 + Math.floor(rnd() * Math.min(6, n - i - 1))
      if (j < n) parents.add(`c${j}`)
    }
    if (missing > 0 && rnd() < missing) parents.add(`gone${i}`)
    out.push({ hash: `c${i}`, parents: [...parents] })
  }
  return out
}

describe('layoutGraph', () => {
  it('returns an empty layout for no commits', () => {
    const l = layoutGraph([])
    expect(l.rows).toEqual([])
    expect(l.width).toBe(0)
    expect(l.index.size).toBe(0)
  })

  it('keeps a linear history on a single lane', () => {
    const commits = [c('c', 'b'), c('b', 'a'), c('a')]
    const { rows, width, index } = layoutGraph(commits)
    expect(width).toBe(1)
    expect(rows.map((r) => r.col)).toEqual([0, 0, 0])
    expect(rows.map((r) => [r.up, r.down])).toEqual([
      [false, true],
      [true, true],
      [true, false]
    ])
    for (const r of rows) {
      expect(r.through).toEqual([])
      expect(r.joins).toEqual([])
      expect(r.forks).toEqual([])
      expect(r.color).toBe(0)
    }
    expect(index.get('b')).toBe(1)
    expectContinuous(rows)
  })

  it('draws a merge: fork out of the merge commit, join back at the common ancestor', () => {
    //  M
    //  |\
    //  A B
    //  |/
    //  C
    const commits = [c('M', 'A', 'B'), c('B', 'C'), c('A', 'C'), c('C')]
    const { rows, width, index } = layoutGraph(commits)
    expect(width).toBe(2)
    expect(rows[0]).toMatchObject({ col: 0, up: false, down: true, forks: [1], joins: [], through: [] })
    expect(rows[1]).toMatchObject({ col: 1, color: 1, up: true, down: true, through: [0] })
    expect(rows[2]).toMatchObject({ col: 0, color: 0, up: true, down: true, through: [1] })
    expect(rows[3]).toMatchObject({ col: 0, up: true, down: false, joins: [1], forks: [], through: [] })
    expectContinuous(rows)
    expectEdgesConnected(commits, rows, index)
  })

  it('gives every branch tip its own lane and joins them at the shared parent', () => {
    const commits = [c('x', 'base'), c('y', 'base'), c('z', 'base'), c('base')]
    const { rows, width } = layoutGraph(commits)
    expect(width).toBe(3)
    expect(rows.slice(0, 3).map((r) => r.col)).toEqual([0, 1, 2])
    expect(rows.slice(0, 3).map((r) => r.up)).toEqual([false, false, false])
    expect(rows[1].through).toEqual([0])
    expect(rows[2].through).toEqual([0, 1])
    expect(rows[3]).toMatchObject({ col: 0, up: true, joins: [1, 2], down: false })
    expectContinuous(rows)
  })

  it('handles octopus merges', () => {
    const commits = [c('O', 'p1', 'p2', 'p3'), c('p1', 'r'), c('p2', 'r'), c('p3', 'r'), c('r')]
    const { rows, width, index } = layoutGraph(commits)
    expect(width).toBe(3)
    expect(rows[0]).toMatchObject({ col: 0, down: true, forks: [1, 2] })
    expect(rows[1]).toMatchObject({ col: 0, through: [1, 2] })
    expect(rows[2]).toMatchObject({ col: 1, through: [0, 2] })
    expect(rows[3]).toMatchObject({ col: 2, through: [0, 1] })
    expect(rows[4]).toMatchObject({ col: 0, joins: [1, 2] })
    expectContinuous(rows)
    expectEdgesConnected(commits, rows, index)
  })

  it('merges into a lane that already exists instead of opening a new one', () => {
    // F is a branch tip on its own lane; M merges it later.
    const commits = [c('F', 'A'), c('M', 'B', 'F2'), c('X', 'F2'), c('F2', 'A'), c('B', 'A'), c('A')]
    // lanes: F=0 ; M=1 (tip) forks to a new lane for F2 ; X (tip) waits for F2 too
    const { rows, index } = layoutGraph(commits)
    expectContinuous(rows)
    expectEdgesConnected(commits, rows, index)

    const merged = [c('T', 'P'), c('M', 'A', 'P'), c('P', 'A'), c('A')]
    const l = layoutGraph(merged)
    // T opens lane 0 waiting for P; M's second parent reuses that lane
    expect(l.rows[1]).toMatchObject({ col: 1, forks: [0], through: [0] })
    expect(l.width).toBe(2)
    expect(l.rows[2]).toMatchObject({ col: 0, up: true, joins: [] })
    expect(l.rows[3]).toMatchObject({ col: 0, joins: [1] })
    expectContinuous(l.rows)
    expectEdgesConnected(merged, l.rows, l.index)
  })

  it('supports several roots and reuses freed lanes', () => {
    const commits = [c('a2', 'a1'), c('b2', 'b1'), c('a1'), c('b1'), c('n2', 'n1'), c('n1')]
    const { rows, width } = layoutGraph(commits)
    expect(width).toBe(2)
    expect(rows.map((r) => r.col)).toEqual([0, 1, 0, 1, 0, 0])
    expect(rows[2]).toMatchObject({ up: true, down: false, through: [1] })
    expect(rows[3]).toMatchObject({ up: true, down: false, through: [] })
    expect(rows[4]).toMatchObject({ up: false, down: true, through: [] })
    expect(bottomCols(rows[5])).toEqual([])
    expectContinuous(rows)
  })

  it('keeps the lane of a parent that is not loaded open down to the last row', () => {
    const commits = [c('t', 'missing'), c('m', 'k', 'alsoMissing'), c('k', 'j'), c('j')]
    const { rows, width } = layoutGraph(commits)
    expect(width).toBe(3)
    expect(rows[0]).toMatchObject({ col: 0, down: true })
    expect(rows[1]).toMatchObject({ col: 1, forks: [2], through: [0] })
    expect(rows[2].through).toEqual([0, 2])
    expect(rows[3]).toMatchObject({ col: 1, down: false, through: [0, 2] })
    expect(bottomCols(rows[3])).toEqual([0, 2])
    expectContinuous(rows)

    const cut = layoutGraph([c('b', 'a')])
    expect(cut.rows[0]).toMatchObject({ col: 0, up: false, down: true })
  })

  it('links a stash only to its base commit', () => {
    const stash: LayoutCommit = { hash: 's', parents: ['h', 'index', 'untracked'], isStash: true }
    const { rows, width } = layoutGraph([c('h2', 'h'), stash, c('h')])
    expect(width).toBe(2)
    expect(rows[1]).toMatchObject({ col: 1, up: false, down: true, forks: [], through: [0] })
    expect(rows[2]).toMatchObject({ col: 0, joins: [1] })
    expect(bottomCols(rows[2])).toEqual([])
  })

  it('marks the WIP link as dashed all the way down to HEAD', () => {
    const wip: LayoutCommit = { hash: 'WIP', parents: ['head'], dashed: true }
    const commits = [wip, c('other', 'head'), c('head', 'root'), c('root')]
    const { rows } = layoutGraph(commits)
    expect(rows[0]).toMatchObject({ col: 0, dashedOut: true, dashedIn: -1 })
    expect(rows[1]).toMatchObject({ col: 1, through: [0], dashedIn: 0, dashedOut: false })
    expect(rows[2]).toMatchObject({ col: 0, up: true, joins: [1], dashedIn: 0 })
    expect(rows[3]).toMatchObject({ dashedIn: -1, dashedOut: false })
    expectContinuous(rows)

    const alone = layoutGraph([{ hash: 'WIP', parents: [], dashed: true }])
    expect(alone.rows[0]).toMatchObject({ col: 0, up: false, down: false, dashedOut: false })
  })

  it('does not reuse, in the same row, a column whose lane just ended', () => {
    // m is waited for by lanes 0 and 1; its second parent must not land on column 1
    const commits = [c('x', 'm'), c('y', 'm'), c('m', 'a', 'b'), c('b', 'a'), c('a')]
    const { rows, index } = layoutGraph(commits)
    expect(rows[2]).toMatchObject({ col: 0, joins: [1], forks: [2] })
    expectContinuous(rows)
    expectEdgesConnected(commits, rows, index)
  })

  it('ignores duplicated parents and parents listed out of order', () => {
    const dup = layoutGraph([c('m', 'a', 'a'), c('a')])
    expect(dup.rows[0]).toMatchObject({ down: true, forks: [] })
    expect(dup.width).toBe(1)

    // "p" is drawn before its child: no dangling lane must be left behind
    const bad = layoutGraph([c('p'), c('child', 'p'), c('self', 'self')])
    expect(bad.rows[1]).toMatchObject({ up: false, down: false })
    expect(bad.rows[2]).toMatchObject({ up: false, down: false })
    expect(bad.width).toBe(1)
  })

  it('colours by lane, cycling through the palette', () => {
    const tips = Array.from({ length: LANE_COLORS + 2 }, (_, i) => c(`t${i}`, 'base'))
    const { rows } = layoutGraph([...tips, c('base')])
    rows.slice(0, -1).forEach((r, i) => {
      expect(r.col).toBe(i)
      expect(r.color).toBe(i % LANE_COLORS)
    })
    expect(laneColor(LANE_COLORS + 3)).toBe(3)
  })

  it('shares pass-through arrays across unchanged rows', () => {
    const commits = [c('side', 'root'), c('a3', 'a2'), c('a2', 'a1'), c('a1', 'root'), c('root')]
    const { rows } = layoutGraph(commits)
    expect(rows[1].through).toEqual([0])
    expect(rows[2].through).toBe(rows[1].through)
    expect(rows[3].through).toBe(rows[1].through)
  })

  it('stays continuous and connected on random histories', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const commits = randomDag(120, seed)
      const { rows, index, width } = layoutGraph(commits)
      expect(rows).toHaveLength(commits.length)
      expectContinuous(rows)
      expectEdgesConnected(commits, rows, index)
      expect(bottomCols(rows[rows.length - 1])).toEqual([])
      for (const r of rows) {
        const all = [r.col, ...r.through, ...r.joins, ...r.forks]
        expect(Math.max(...all)).toBeLessThan(width)
        // a node never sits on a lane that passes through or ends in its row
        expect(r.through).not.toContain(r.col)
        expect(r.joins).not.toContain(r.col)
        expect(r.forks).not.toContain(r.col)
        for (const j of r.joins) expect(r.forks).not.toContain(j)
      }
    }
  })

  it('stays continuous when some parents are not loaded', () => {
    for (let seed = 100; seed < 130; seed++) {
      const commits = randomDag(80, seed, 0.1)
      const { rows, index } = layoutGraph(commits)
      expectContinuous(rows)
      expectEdgesConnected(commits, rows, index)
    }
  })

  it('lays out a large history quickly enough', () => {
    const commits = randomDag(30_000, 7)
    const t0 = performance.now()
    const { rows } = layoutGraph(commits)
    const ms = performance.now() - t0
    expect(rows).toHaveLength(30_000)
    expect(ms).toBeLessThan(2000)
  })
})

describe('sameTopology', () => {
  it('compares hashes, parents and flags', () => {
    const a = [c('b', 'a'), c('a')]
    expect(sameTopology(a, a)).toBe(true)
    expect(sameTopology(a, [c('b', 'a'), c('a')])).toBe(true)
    expect(sameTopology(a, [c('b', 'a')])).toBe(false)
    expect(sameTopology(a, [c('b', 'x'), c('a')])).toBe(false)
    expect(sameTopology(a, [c('b'), c('a')])).toBe(false)
    expect(sameTopology(a, [{ hash: 'b', parents: ['a'], isStash: true }, c('a')])).toBe(false)
  })
})

describe('rowPaths', () => {
  const H = 28

  it('draws straight halves for a plain commit', () => {
    const { rows } = layoutGraph([c('b', 'a'), c('a')])
    const x = laneX(0)
    expect(rowPaths(rows[0], H)).toEqual([{ color: 0, dashed: false, d: `M${x} 14V28` }])
    expect(rowPaths(rows[1], H)).toEqual([{ color: 0, dashed: false, d: `M${x} 0V14` }])
  })

  it('draws rounded corners for forks and joins, coloured like the side lane', () => {
    const { rows } = layoutGraph([c('M', 'A', 'B'), c('B', 'C'), c('A', 'C'), c('C')])
    const x0 = laneX(0)
    const x1 = laneX(1)
    const fork = rowPaths(rows[0], H).find((p) => p.color === 1)!
    expect(fork.d).toBe(`M${x0} 14H${x1 - 10}A10 10 0 0 1 ${x1} 24V28`)
    const join = rowPaths(rows[3], H).find((p) => p.color === 1)!
    expect(join.d).toBe(`M${x1} 0V4A10 10 0 0 1 ${x1 - 10} 14H${x0}`)
    // lane 0 passing next to B
    expect(rowPaths(rows[1], H)).toContainEqual({ color: 0, dashed: false, d: `M${x0} 0V28` })
  })

  it('mirrors the corners when the side lane is on the left', () => {
    const { rows } = layoutGraph([c('T', 'P'), c('M', 'A', 'P'), c('P', 'A'), c('A')])
    const x0 = laneX(0)
    const x1 = laneX(1)
    const fork = rowPaths(rows[1], H).find((p) => p.color === 0)!
    // the existing lane 0 passes through and the fork joins it from the right
    expect(fork.d).toBe(`M${x0} 0V28M${x1} 14H${x0 + 10}A10 10 0 0 0 ${x0} 24V28`)
  })

  it('keeps dashed segments in their own paths', () => {
    const { rows } = layoutGraph([{ hash: 'WIP', parents: ['h'], dashed: true }, c('o', 'h'), c('h')])
    expect(rowPaths(rows[0], H)).toEqual([{ color: 0, dashed: true, d: `M${laneX(0)} 14V28` }])
    expect(rowPaths(rows[1], H)).toContainEqual({ color: 0, dashed: true, d: `M${laneX(0)} 0V28` })
    expect(rowPaths(rows[2], H)).toContainEqual({ color: 0, dashed: true, d: `M${laneX(0)} 0V14` })
  })
})
