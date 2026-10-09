// Pure helpers for the sidebar: folder tree out of `a/b/c` branch names,
// remote grouping and persisted collapsed state.
import { useCallback, useEffect, useState } from 'react'
import type { Ref, Remote } from '@shared/types'

export interface TreeLeaf {
  kind: 'leaf'
  /** Last path segment, e.g. `login` for `feature/login` */
  name: string
  ref: Ref
}
export interface TreeFolder {
  kind: 'folder'
  name: string
  /** Stable key used for the collapsed state, e.g. `local/feature/api` */
  path: string
  children: TreeNode[]
  /** Number of leaves below this folder */
  count: number
}
export type TreeNode = TreeLeaf | TreeFolder

export interface TreeEntry {
  /** Name to split into folders (remote branches come without the remote prefix) */
  label: string
  ref: Ref
}

const byName = (a: { name: string }, b: { name: string }) =>
  a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })

function sortNodes(nodes: TreeNode[]): TreeNode[] {
  const folders = nodes.filter((n): n is TreeFolder => n.kind === 'folder').sort(byName)
  const leaves = nodes.filter((n): n is TreeLeaf => n.kind === 'leaf').sort(byName)
  for (const f of folders) f.children = sortNodes(f.children)
  return [...folders, ...leaves]
}

/** `feature/login`, `feature/api/x`, `main` -> [feature/[api/[x], login], main] (folders first). */
export function buildTree(entries: TreeEntry[], keyPrefix: string): TreeNode[] {
  const root: TreeNode[] = []
  const folders = new Map<string, TreeFolder>()

  for (const { label, ref } of entries) {
    const parts = label.split('/').filter(Boolean)
    const leafName = parts.pop() ?? label
    let level = root
    let path = keyPrefix
    const chain: TreeFolder[] = []
    for (const part of parts) {
      path += `/${part}`
      let folder = folders.get(path)
      if (!folder) {
        folder = { kind: 'folder', name: part, path, children: [], count: 0 }
        folders.set(path, folder)
        level.push(folder)
      }
      chain.push(folder)
      level = folder.children
    }
    level.push({ kind: 'leaf', name: leafName, ref })
    for (const f of chain) f.count++
  }
  return sortNodes(root)
}

export interface RemoteGroup {
  name: string
  url?: string
  /** Branches of this remote, labelled without the `<remote>/` prefix */
  entries: TreeEntry[]
}

/**
 * Groups remote-tracking refs by remote. Remotes without branches are kept, and
 * remotes only known through refs are added. `origin/HEAD` is skipped.
 */
export function groupRemotes(remotes: Remote[], remoteRefs: Ref[]): RemoteGroup[] {
  const groups = new Map<string, RemoteGroup>()
  for (const r of remotes) groups.set(r.name, { name: r.name, url: r.url, entries: [] })
  // longest name first so a remote called `foo/bar` wins over `foo`
  const known = remotes.map((r) => r.name).sort((a, b) => b.length - a.length)

  for (const ref of remoteRefs) {
    const remote = known.find((n) => ref.name.startsWith(`${n}/`)) ?? ref.name.split('/')[0]
    const label = ref.name.slice(remote.length + 1)
    if (!label || label === 'HEAD') continue
    let group = groups.get(remote)
    if (!group) {
      group = { name: remote, entries: [] }
      groups.set(remote, group)
    }
    group.entries.push({ label, ref })
  }
  return [...groups.values()].sort(byName)
}

/** Splits `origin/feature/x` into remote + branch using the known remote names. */
export function splitRemoteRef(name: string, remotes: Remote[]): { remote: string; branch: string } {
  const known = remotes.map((r) => r.name).sort((a, b) => b.length - a.length)
  const remote = known.find((n) => name.startsWith(`${n}/`)) ?? name.split('/')[0]
  return { remote, branch: name.slice(remote.length + 1) }
}

/** N of `stash@{N}`; falls back to the position in the list. */
export function stashIndex(ref: Ref, fallback: number): number {
  const m = /\{(\d+)\}/.exec(ref.name)
  return m ? Number(m[1]) : fallback
}

const COLLAPSED_KEY = 'gitkroken.sidebar.collapsed'

function loadCollapsed(): Set<string> {
  try {
    const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
    return new Set(Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : [])
  } catch {
    return new Set()
  }
}

/** Set of collapsed section / remote / folder keys, persisted in localStorage. */
export function useCollapsed(): { isCollapsed: (key: string) => boolean; toggle: (key: string) => void } {
  const [collapsed, setCollapsed] = useState(loadCollapsed)

  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify([...collapsed]))
    } catch {
      /* storage unavailable: the state just is not persisted */
    }
  }, [collapsed])

  const toggle = useCallback((key: string) => {
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(key)) next.add(key)
      return next
    })
  }, [])
  const isCollapsed = useCallback((key: string) => collapsed.has(key), [collapsed])
  return { isCollapsed, toggle }
}
