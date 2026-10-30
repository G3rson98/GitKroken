import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { join } from 'path'
import { IPC_CREDENTIAL, IPC_INVOKE, IPC_REPO_CHANGED, type GitApi } from '@shared/types'
import { gitApi, onCredentialRequest, onRepoChanged } from './git'

function createWindow(): void {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: '#131417',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url)
    return { action: 'deny' }
  })

  if (process.env['ELECTRON_RENDERER_URL']) {
    win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    win.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  ipcMain.handle(IPC_INVOKE, async (_e, method: keyof GitApi, args: unknown[]) => {
    const fn = (gitApi as unknown as Record<string, unknown>)[method]
    if (!Object.prototype.hasOwnProperty.call(gitApi, method) || typeof fn !== 'function') {
      throw new Error(`Unknown git method: ${String(method)}`)
    }
    return fn.apply(gitApi, args)
  })

  onRepoChanged((repo) => {
    for (const w of BrowserWindow.getAllWindows()) w.webContents.send(IPC_REPO_CHANGED, repo)
  })

  onCredentialRequest((req) => {
    const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
    if (win) win.webContents.send(IPC_CREDENTIAL, req)
    else void gitApi.answerCredential(req.id, null)
  })

  createWindow()
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
