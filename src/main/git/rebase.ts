// STUB — replaced by the real implementation.
import type { GitApi } from '@shared/types'

const todo = (): never => {
  throw new Error('No implementado todavía')
}

export const rebaseApi: Pick<GitApi, 'rebaseTodo' | 'rebaseInteractive' | 'undoState' | 'undo' | 'redo'> = {
  rebaseTodo: async () => todo(),
  rebaseInteractive: async () => todo(),
  undoState: async () => todo(),
  undo: async () => todo(),
  redo: async () => todo(),
}
