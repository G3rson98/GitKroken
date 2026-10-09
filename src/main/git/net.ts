// STUB — replaced by the real implementation.
import type { GitApi } from '@shared/types'

const todo = (): never => {
  throw new Error('No implementado todavía')
}

export const netApi: Pick<GitApi, 'cancel' | 'answerCredential'> = {
  cancel: async () => todo(),
  answerCredential: async () => todo(),
}

export function onCredentialRequest(_cb: (req: import('@shared/types').CredentialRequest) => void): void {}
