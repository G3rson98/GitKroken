// STUB — replaced by the real implementation.
import type { CredentialRequest } from '@shared/types'
import { git } from '../../lib/git'

/** Asks the user for the credential git needs and answers through `git.answerCredential` */
export function handleCredentialRequest(req: CredentialRequest): void {
  void git.answerCredential(req.id, null)
}
