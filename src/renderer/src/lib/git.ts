import type { GitApi } from '@shared/types'

/** Typed proxy over the IPC bridge: `git.status(repo)` etc. */
export const git = new Proxy({} as GitApi, {
  get: (_t, method: string) => (...args: unknown[]) => window.bridge.invoke(method as keyof GitApi, ...args)
})
