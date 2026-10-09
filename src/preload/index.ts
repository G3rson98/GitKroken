import { contextBridge, ipcRenderer } from 'electron'
import { IPC_INVOKE, IPC_REPO_CHANGED, type Bridge } from '@shared/types'

const bridge: Bridge = {
  invoke: (method, ...args) => ipcRenderer.invoke(IPC_INVOKE, method, args),
  onRepoChanged: (cb) => {
    const listener = (_e: unknown, repo: string) => cb(repo)
    ipcRenderer.on(IPC_REPO_CHANGED, listener)
    return () => ipcRenderer.removeListener(IPC_REPO_CHANGED, listener)
  },
  platform: process.platform
}

contextBridge.exposeInMainWorld('bridge', bridge)
