// STUB — replaced by the real implementation.
import type { GitApi } from '@shared/types'

const todo = (): never => {
  throw new Error('No implementado todavía')
}

export const conflictsApi: Pick<GitApi, 'conflictFile' | 'resolveConflict' | 'resolveWith'> = {
  conflictFile: async () => todo(),
  resolveConflict: async () => todo(),
  resolveWith: async () => todo(),
}
