// STUB — replaced by the real implementation.
import type { GitApi } from '@shared/types'

const todo = (): never => {
  throw new Error('No implementado todavía')
}

export const historyApi: Pick<GitApi, 'blame' | 'fileHistory' | 'fileAt' | 'searchCommits'> = {
  blame: async () => todo(),
  fileHistory: async () => todo(),
  fileAt: async () => todo(),
  searchCommits: async () => todo(),
}
