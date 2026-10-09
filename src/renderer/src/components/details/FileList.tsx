// File list shared by the commit details and the staging area, with the
// Path (flat) and Tree (collapsible folders) views.
import { useMemo, useState, type MouseEvent, type ReactNode } from 'react'
import { ChevronDown, ChevronRight, Folder, FolderOpen } from 'lucide-react'
import type { FileChange } from '@shared/types'
import { StatusIcon, splitPath } from './common'
import { buildTree, flattenTree } from './fileTree'

export type FileViewMode = 'path' | 'tree'
export const FILE_VIEWS = ['path', 'tree'] as const
export const FILE_VIEW_KEY = 'gitabyss.fileView'

/** Rows rendered before the "show more" button (keeps huge change sets responsive) */
const PAGE = 400

export interface FileListProps {
  files: FileChange[]
  view: FileViewMode
  isSelected: (file: FileChange) => boolean
  onOpen: (file: FileChange) => void
  onContextMenu?: (e: MouseEvent, file: FileChange) => void
  /** Buttons shown on hover at the right of a file row */
  actions?: (file: FileChange) => ReactNode
  /** Buttons shown on hover at the right of a folder row (tree view) */
  folderActions?: (files: FileChange[]) => ReactNode
  emptyText?: string
}

const stop = (e: MouseEvent) => e.stopPropagation()

export function FileList(props: FileListProps) {
  const { files, view } = props
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(() => new Set())
  const [limit, setLimit] = useState(PAGE)

  const tree = useMemo(() => (view === 'tree' ? buildTree(files) : null), [files, view])
  const flat = useMemo(() => (tree ? flattenTree(tree, collapsed) : null), [tree, collapsed])

  const toggle = (path: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev)
      if (!next.delete(path)) next.add(path)
      return next
    })

  const count = flat ? flat.length : files.length
  if (count === 0) return props.emptyText ? <div className="fl-empty">{props.emptyText}</div> : null

  const fileRow = (file: FileChange, depth: number, name: string, dir: string, key: string) => (
    <div
      key={key}
      className={`fl-row${props.isSelected(file) ? ' selected' : ''}`}
      style={{ paddingLeft: 8 + depth * 14 }}
      title={file.oldPath && file.oldPath !== file.path ? `${file.oldPath} → ${file.path}` : file.path}
      onClick={() => props.onOpen(file)}
      onContextMenu={props.onContextMenu ? (e) => props.onContextMenu!(e, file) : undefined}
    >
      <StatusIcon status={file.status} />
      <span className="fl-path">
        {dir && <span className="fl-dir">{dir}</span>}
        <span className="fl-name">{name}</span>
      </span>
      {props.actions && (
        <span className="fl-actions" onClick={stop} onDoubleClick={stop}>
          {props.actions(file)}
        </span>
      )}
    </div>
  )

  return (
    <div className="fl">
      {flat
        ? flat.slice(0, limit).map(({ node, depth }) => {
            if (node.kind === 'file') return fileRow(node.file, depth, node.name, '', 'f:' + node.file.path)
            const open = !collapsed.has(node.path)
            return (
              <div
                key={'d:' + node.path}
                className="fl-row fl-folder"
                style={{ paddingLeft: 4 + depth * 14 }}
                title={node.path}
                onClick={() => toggle(node.path)}
              >
                {open ? <ChevronDown size={13} /> : <ChevronRight size={13} />}
                {open ? <FolderOpen size={13} /> : <Folder size={13} />}
                <span className="fl-path">
                  <span className="fl-name">{node.name}</span>
                </span>
                <span className="fl-count">{node.files.length}</span>
                {props.folderActions && (
                  <span className="fl-actions" onClick={stop}>
                    {props.folderActions(node.files)}
                  </span>
                )}
              </div>
            )
          })
        : files.slice(0, limit).map((file) => {
            const [dir, name] = splitPath(file.path.replace(/\/+$/, ''))
            return fileRow(file, 0, file.path.endsWith('/') ? name + '/' : name, dir, 'f:' + file.path)
          })}
      {count > limit && (
        <button className="fl-more" onClick={() => setLimit((n) => n + PAGE * 5)}>
          Mostrar más ({count - limit} restantes)
        </button>
      )}
    </div>
  )
}
