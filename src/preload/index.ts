import { contextBridge, ipcRenderer } from 'electron'
import { IPC_CREDENTIAL, IPC_INVOKE, IPC_REPO_CHANGED, type Bridge, type CredentialRequest } from '@shared/types'

const bridge: Bridge = {
  invoke: (method, ...args) => ipcRenderer.invoke(IPC_INVOKE, method, args),
  onRepoChanged: (cb) => {
    const listener = (_e: unknown, repo: string) => cb(repo)
    ipcRenderer.on(IPC_REPO_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_REPO_CHANGED, listener)
  },
  onCredentialRequest: (cb) => {
    const listener = (_e: unknown, req: CredentialRequest) => cb(req)
    ipcRenderer.on(IPC_CREDENTIAL, listener)
    return () => ipcRenderer.removeListener(IPC_CREDENTIAL, listener)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('bridge', bridge)
