// Groups refs into the pills shown in the BRANCH / TAG column, plus a few
// small text helpers. Pure module (type-only imports), unit-tested.
import type { Ref } from '@shared/types'

export type LabelKind = 'local' | 'remote' | 'tag' | 'stash' | 'detached'

export interface RefLabel {
  /** Unique within the whole graph */
  key: string
  kind: LabelKind
  /** Text shown in the pill */
  name: string
  /** Checked-out branch (or the detached HEAD marker) */
  isCurrent: boolean
  /** The local branch (kind 'local') */
  local?: Ref
  /** The remote branch: the pill itself (kind 'remote') or the remote merged into a local pill */
  remote?: Ref
  /** The tag or stash ref (kinds 'tag' / 'stash') */
  ref?: Ref
}

/** Splits `origin/feature/x` into remote + branch using the known remote names. */
export function splitRemoteRef(name: string, remoteNames: readonly string[] = []): { remote: string; branch: string } {
  let best = ''
  for (const r of remoteNames) {
    if (r.length > best.length && name.startsWith(r + '/')) best = r
  }
  if (!best) {
    const i = name.indexOf('/')
    if (i < 0) return { remote: '', branch: name }
    best = name.slice(0, i)
  }
  return { remote: best, branch: name.slice(best.length + 1) }
}

/** N of `stash@{N}`, or null when the name is not a stash ref */
export function stashIndex(name: string): number | null {
  const m = /stash@\{(\d+)\}/.exec(name)
  return m ? Number(m[1]) : null
}

const ORDER: Record<LabelKind, number> = { detached: 0, local: 1, remote: 2, tag: 3, stash: 4 }

/**
 * Builds the pills of every commit. A local branch and its upstream (or, when
 * it has no upstream, the same-named remote branch) pointing at the same
 * commit are merged into a single pill. The current branch always goes first.
 */
export function buildLabels(
  refs: readonly Ref[],
  remoteNames: readonly string[] = [],
  detachedHead: string | null = null
): Map<string, RefLabel[]> {
  const byHash = new Map<string, Ref[]>()
  for (const ref of refs) {
    if (ref.type === 'remote' && (ref.name === 'HEAD' || ref.name.endsWith('/HEAD'))) continue
    const list = byHash.get(ref.hash)
    if (list) list.push(ref)
    else byHash.set(ref.hash, [ref])
  }

  const out = new Map<string, RefLabel[]>()
  for (const [hash, group] of byHash) {
    const labels: RefLabel[] = []
    const used = new Set<Ref>()
    const remotes = group.filter((r) => r.type === 'remote')

    for (const ref of group) {
      if (ref.type !== 'head') continue
      let remote = ref.upstream ? remotes.find((r) => !used.has(r) && r.name === ref.upstream) : undefined
      if (!remote && !ref.upstream) {
        remote = remotes.find((r) => !used.has(r) && splitRemoteRef(r.name, remoteNames).branch === ref.name)
      }
      if (remote) used.add(remote)
      labels.push({ key: `h:${ref.name}`, kind: 'local', name: ref.name, isCurrent: ref.isCurrent, local: ref, remote })
    }
    for (const ref of remotes) {
      if (!used.has(ref)) labels.push({ key: `r:${ref.name}`, kind: 'remote', name: ref.name, isCurrent: false, remote: ref })
    }
    for (const ref of group) {
      if (ref.type === 'tag') labels.push({ key: `t:${ref.name}`, kind: 'tag', name: ref.name, isCurrent: false, ref })
      else if (ref.type === 'stash') labels.push({ key: `s:${ref.name}`, kind: 'stash', name: ref.name, isCurrent: false, ref })
    }

    // stable sort: current branch first, then by kind, keeping the input order
    labels.sort((a, b) => Number(b.isCurrent) - Number(a.isCurrent) || ORDER[a.kind] - ORDER[b.kind])
    out.set(hash, labels)
  }

  if (detachedHead) {
    const marker: RefLabel = { key: 'detached-head', kind: 'detached', name: 'HEAD', isCurrent: true }
    out.set(detachedHead, [marker, ...(out.get(detachedHead) ?? [])])
  }
  return out
}

/** Up to two initials of an author name: "Ada Lovelace" -> "AL" */
export function initials(author: string): string {
  const words = author
    .replace(/<[^>]*>/g, ' ')
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean)
  if (words.length === 0) return '?'
  const first = Array.from(words[0])[0]
  const last = words.length > 1 ? Array.from(words[words.length - 1])[0] : ''
  return (first + last).toUpperCase()
}

const fullFmt = new Intl.DateTimeFormat('es', { dateStyle: 'full', timeStyle: 'short' })

/** Date for the DATE column: "17/09/2026 @ 7:38" */
export function formatDate(sec: number): string {
  const d = new Date(sec * 1000)
  const p2 = (n: number) => String(n).padStart(2, '0')
  return `${p2(d.getDate())}/${p2(d.getMonth() + 1)}/${d.getFullYear()} @ ${d.getHours()}:${p2(d.getMinutes())}`
}

export const formatFullDate = (sec: number): string => fullFmt.format(sec * 1000)
