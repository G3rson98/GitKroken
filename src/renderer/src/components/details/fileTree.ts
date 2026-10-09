// Folder tree for the "Tree" view of the file lists. Pure module.

export interface TreeFile<T> {
  kind: 'file'
  name: string
  file: T
}

export interface TreeFolder<T> {
  kind: 'folder'
  /** Display name; single-child folder chains are merged (`src/renderer`) */
  name: string
  /** Full path of the folder, without trailing slash */
  path: string
  children: TreeNode<T>[]
  /** Every file below this folder, at any depth */
  files: T[]
}

export type TreeNode<T> = TreeFile<T> | TreeFolder<T>

export interface FlatNode<T> {
  node: TreeNode<T>
  depth: number
}

const byName = (a: string, b: string) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' })

export function buildTree<T extends { path: string }>(files: T[]): TreeNode<T>[] {
  const root: TreeFolder<T> = { kind: 'folder', name: '', path: '', children: [], files: [] }
  const folders = new Map<string, TreeFolder<T>>([['', root]])

  const folderFor = (path: string): TreeFolder<T> => {
    const hit = folders.get(path)
    if (hit) return hit
    const i = path.lastIndexOf('/')
    const parent = folderFor(i < 0 ? '' : path.slice(0, i))
    const folder: TreeFolder<T> = { kind: 'folder', name: path.slice(i + 1), path, children: [], files: [] }
    parent.children.push(folder)
    folders.set(path, folder)
    return folder
  }

  for (const file of files) {
    // Untracked directories are reported as `dir/`
    const clean = file.path.replace(/\/+$/, '')
    const i = clean.lastIndexOf('/')
    const parent = folderFor(i < 0 ? '' : clean.slice(0, i))
    parent.children.push({ kind: 'file', name: clean.slice(i + 1) + (clean === file.path ? '' : '/'), file })
  }

  const finish = (folder: TreeFolder<T>): void => {
    folder.children = folder.children.map((child) => {
      if (child.kind === 'file') return child
      // Merge chains of folders that only contain another folder
      let f = child
      while (f.children.length === 1 && f.children[0].kind === 'folder') {
        const only = f.children[0]
        f = { ...only, name: `${f.name}/${only.name}` }
      }
      finish(f)
      return f
    })
    folder.children.sort((a, b) => (a.kind === b.kind ? byName(a.name, b.name) : a.kind === 'folder' ? -1 : 1))
    folder.files = folder.children.flatMap((c) => (c.kind === 'file' ? [c.file] : c.files))
  }
  finish(root)
  return root.children
}

/** Depth-first list of the visible nodes, skipping the content of collapsed folders. */
export function flattenTree<T>(nodes: TreeNode<T>[], collapsed: ReadonlySet<string>, depth = 0): FlatNode<T>[] {
  const out: FlatNode<T>[] = []
  for (const node of nodes) {
    out.push({ node, depth })
    if (node.kind === 'folder' && !collapsed.has(node.path)) out.push(...flattenTree(node.children, collapsed, depth + 1))
  }
  return out
}
