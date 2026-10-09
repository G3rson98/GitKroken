import { describe, expect, it } from 'vitest'
import type { Ref } from '@shared/types'
import { buildLabels, formatDate, initials, splitRemoteRef, stashIndex } from './refLabels'

const ref = (name: string, type: Ref['type'], hash: string, extra: Partial<Ref> = {}): Ref => ({
  name,
  type,
  hash,
  isCurrent: false,
  ...extra
})

describe('buildLabels', () => {
  it('merges a local branch with its upstream when both point at the same commit', () => {
    const refs = [ref('main', 'head', 'a', { isCurrent: true, upstream: 'origin/main' }), ref('origin/main', 'remote', 'a')]
    const labels = buildLabels(refs, ['origin']).get('a')!
    expect(labels).toHaveLength(1)
    expect(labels[0]).toMatchObject({ kind: 'local', name: 'main', isCurrent: true })
    expect(labels[0].local?.name).toBe('main')
    expect(labels[0].remote?.name).toBe('origin/main')
  })

  it('keeps them apart when they point at different commits', () => {
    const refs = [ref('main', 'head', 'b', { upstream: 'origin/main' }), ref('origin/main', 'remote', 'a')]
    const labels = buildLabels(refs, ['origin'])
    expect(labels.get('b')).toMatchObject([{ kind: 'local', name: 'main' }])
    expect(labels.get('b')![0].remote).toBeUndefined()
    expect(labels.get('a')).toMatchObject([{ kind: 'remote', name: 'origin/main' }])
  })

  it('falls back to the same-named remote branch when there is no upstream', () => {
    const refs = [ref('feature/x', 'head', 'a'), ref('origin/feature/x', 'remote', 'a'), ref('fork/other', 'remote', 'a')]
    const labels = buildLabels(refs, ['origin', 'fork']).get('a')!
    expect(labels.map((l) => l.key)).toEqual(['h:feature/x', 'r:fork/other'])
    expect(labels[0].remote?.name).toBe('origin/feature/x')
  })

  it('does not merge by name when the upstream is a different remote branch', () => {
    const refs = [ref('dev', 'head', 'a', { upstream: 'origin/dev' }), ref('fork/dev', 'remote', 'a')]
    const labels = buildLabels(refs, ['origin', 'fork']).get('a')!
    expect(labels.map((l) => l.kind)).toEqual(['local', 'remote'])
    expect(labels[0].remote).toBeUndefined()
  })

  it('orders current branch, locals, remotes, tags and stashes; hides remote HEAD', () => {
    const refs = [
      ref('v1.0', 'tag', 'a'),
      ref('origin/HEAD', 'remote', 'a'),
      ref('origin/zeta', 'remote', 'a'),
      ref('stash@{0}', 'stash', 'a'),
      ref('alpha', 'head', 'a'),
      ref('work', 'head', 'a', { isCurrent: true })
    ]
    const labels = buildLabels(refs, ['origin']).get('a')!
    expect(labels.map((l) => l.name)).toEqual(['work', 'alpha', 'origin/zeta', 'v1.0', 'stash@{0}'])
    expect(labels.map((l) => l.kind)).toEqual(['local', 'local', 'remote', 'tag', 'stash'])
  })

  it('adds a HEAD marker when detached', () => {
    const labels = buildLabels([ref('main', 'head', 'a')], [], 'b')
    expect(labels.get('b')).toMatchObject([{ kind: 'detached', name: 'HEAD', isCurrent: true }])
    const same = buildLabels([ref('main', 'head', 'a')], [], 'a').get('a')!
    expect(same.map((l) => l.name)).toEqual(['HEAD', 'main'])
  })

  it('produces unique keys', () => {
    const refs = [ref('x', 'head', 'a'), ref('x', 'tag', 'a'), ref('origin/x', 'remote', 'b')]
    const keys = [...buildLabels(refs, ['origin']).values()].flat().map((l) => l.key)
    expect(new Set(keys).size).toBe(keys.length)
  })
})

describe('helpers', () => {
  it('splits remote refs using the known remote names', () => {
    expect(splitRemoteRef('origin/feature/x', ['origin'])).toEqual({ remote: 'origin', branch: 'feature/x' })
    expect(splitRemoteRef('team/fork/main', ['team', 'team/fork'])).toEqual({ remote: 'team/fork', branch: 'main' })
    expect(splitRemoteRef('upstream/dev')).toEqual({ remote: 'upstream', branch: 'dev' })
    expect(splitRemoteRef('weird')).toEqual({ remote: '', branch: 'weird' })
  })

  it('parses stash indexes', () => {
    expect(stashIndex('stash@{0}')).toBe(0)
    expect(stashIndex('stash@{12}')).toBe(12)
    expect(stashIndex('main')).toBeNull()
  })

  it('computes initials', () => {
    expect(initials('Ada Lovelace')).toBe('AL')
    expect(initials('linus')).toBe('L')
    expect(initials('María José Pérez')).toBe('MP')
    expect(initials('dependabot[bot]')).toBe('DB')
    expect(initials('  ')).toBe('?')
  })

  it('formats dates as dd/mm/yyyy @ h:mm', () => {
    const at = (y: number, m: number, d: number, h: number, min: number) => new Date(y, m, d, h, min).getTime() / 1000
    expect(formatDate(at(2026, 8, 17, 11, 32))).toBe('17/09/2026 @ 11:32')
    expect(formatDate(at(2026, 7, 7, 7, 8))).toBe('07/08/2026 @ 7:08')
  })
})
