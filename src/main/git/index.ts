// Git backend entry point, consumed by src/main/index.ts.
//
//   exec.ts     git process runner (env, errors, argument validation)
//   parse.ts    parsers for git's machine-readable output
//   core.ts     every GitApi method that only needs the git CLI
//   watcher.ts  fs watching + onRepoChanged
//   native.ts   Electron / OS integration (dialogs, Finder, terminal)
import type { GitApi } from '@shared/types'
import { coreApi } from './core'
import { nativeApi } from './native'
import { netApi } from './net'
import { conflictsApi } from './conflicts'
import { rebaseApi } from './rebase'
import { historyApi } from './history'
import { extrasApi } from './extras'
import { hostingApi } from './hosting'

/**
 * A plain object whose methods are own properties: the IPC dispatcher looks
 * methods up with `hasOwnProperty`.
 */
export const gitApi: GitApi = {
  ...coreApi,
  ...nativeApi,
  ...netApi,
  ...conflictsApi,
  ...rebaseApi,
  ...historyApi,
  ...extrasApi,
  ...hostingApi
}

export { onRepoChanged } from './watcher'
export { onCredentialRequest } from './net'
export { GitError } from './exec'
