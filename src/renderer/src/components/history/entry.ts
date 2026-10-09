// Entry points to the blame and file history views, shared by every place
// that offers them (diff header, file context menus).
import type { FileStatus } from '@shared/types'
import { useStore } from '../../store'

export interface FileRef {
  path: string
  /** Set when the file is looked at inside a commit; otherwise it is a working-tree file */
  commit?: string
  status?: FileStatus
}

/** Untracked files have no history and nothing to blame */
export const hasHistory = (file: FileRef): boolean => file.status !== 'untracked'

/** The revision whose blame makes sense for `file` (undefined = the working tree) */
export function blameRev(file: FileRef): string | undefined {
  // A deleted file has no content to blame: show it as it was right before
  if (file.commit) return file.status === 'deleted' ? `${file.commit}^` : file.commit
  return file.status === 'deleted' ? 'HEAD' : undefined
}

export function openBlame(file: FileRef): void {
  useStore.getState().openView({ kind: 'blame', path: file.path, rev: blameRev(file) })
}

export function openFileHistory(file: FileRef): void {
  useStore.getState().openView({ kind: 'fileHistory', path: file.path })
}
