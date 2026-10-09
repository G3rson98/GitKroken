// STUB — replaced by the real implementation.
import type { GitApi } from '@shared/types'

const todo = (): never => {
  throw new Error('No implementado todavía')
}

export const hostingApi: Pick<GitApi, 'openExternal' | 'accounts' | 'addAccount' | 'removeAccount' | 'hostedRepo' | 'pullRequests' | 'createPullRequest' | 'issues' | 'createIssue' | 'profiles' | 'saveProfile' | 'deleteProfile' | 'activateProfile'> = {
  openExternal: async () => todo(),
  accounts: async () => todo(),
  addAccount: async () => todo(),
  removeAccount: async () => todo(),
  hostedRepo: async () => todo(),
  pullRequests: async () => todo(),
  createPullRequest: async () => todo(),
  issues: async () => todo(),
  createIssue: async () => todo(),
  profiles: async () => todo(),
  saveProfile: async () => todo(),
  deleteProfile: async () => todo(),
  activateProfile: async () => todo(),
}

/** Stored token usable as HTTPS git credentials for `host`, if an account exists */
export function credentialsForHost(_host: string): { username: string; password: string } | null {
  return null
}

/** Identity of the active profile, applied to commits through the git environment */
export function activeIdentity(): { name: string; email: string } | null {
  return null
}
