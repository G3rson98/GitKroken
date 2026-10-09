// STUB — replaced by the real implementation.
import type { GitApi } from '@shared/types'

const todo = (): never => {
  throw new Error('No implementado todavía')
}

export const extrasApi: Pick<GitApi, 'submodules' | 'submoduleUpdate' | 'submoduleAdd' | 'worktrees' | 'worktreeAdd' | 'worktreeRemove' | 'lfsInfo' | 'lfsInstall' | 'lfsTrack' | 'lfsUntrack' | 'lfsPull'> = {
  submodules: async () => todo(),
  submoduleUpdate: async () => todo(),
  submoduleAdd: async () => todo(),
  worktrees: async () => todo(),
  worktreeAdd: async () => todo(),
  worktreeRemove: async () => todo(),
  lfsInfo: async () => todo(),
  lfsInstall: async () => todo(),
  lfsTrack: async () => todo(),
  lfsUntrack: async () => todo(),
  lfsPull: async () => todo(),
}
