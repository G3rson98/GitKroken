// OS / Electron integration. This is the only file under git/ that imports
// Electron; everything else is plain Node and unit-testable.
import { spawn } from 'child_process'
import { stat } from 'fs/promises'
import { BrowserWindow, dialog, shell } from 'electron'
import type { GitApi } from '@shared/types'

export type NativeGitApi = Pick<GitApi, 'pickDirectory' | 'reveal' | 'openInTerminal'>

async function pickDirectory(title?: string): Promise<string | null> {
  const options: Electron.OpenDialogOptions = {
    title: typeof title === 'string' && title ? title : undefined,
    // macOS hides `title` on open panels; `message` is what is actually shown.
    message: typeof title === 'string' && title ? title : undefined,
    properties: ['openDirectory', 'createDirectory']
  }
  const parent = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  const result = parent ? await dialog.showOpenDialog(parent, options) : await dialog.showOpenDialog(options)
  if (result.canceled) return null
  return result.filePaths[0] ?? null
}

async function reveal(path: string): Promise<void> {
  if (typeof path !== 'string' || !path) throw new Error('Missing path')
  shell.showItemInFolder(path)
}

/** Starts a detached GUI process; resolves false when the executable is missing. */
function launch(command: string, args: string[], cwd: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false
    const done = (ok: boolean): void => {
      if (!settled) {
        settled = true
        resolve(ok)
      }
    }
    try {
      const child = spawn(command, args, { cwd, detached: true, stdio: 'ignore', windowsHide: false })
      child.once('error', () => done(false))
      child.once('spawn', () => {
        child.unref()
        done(true)
      })
    } catch {
      done(false)
    }
  })
}

async function openInTerminal(repo: string): Promise<void> {
  if (typeof repo !== 'string' || !repo) throw new Error('Missing repository path')
  const isDir = await stat(repo).then((s) => s.isDirectory(), () => false)
  if (!isDir) throw new Error(`Folder not found: ${repo}`)

  let candidates: [string, string[]][]
  if (process.platform === 'darwin') {
    candidates = [['open', ['-a', 'Terminal', repo]]]
  } else if (process.platform === 'win32') {
    candidates = [
      ['wt.exe', ['-d', repo]],
      // `start` needs an (empty) window title before the program name.
      ['cmd.exe', ['/c', 'start', '', '/D', repo, 'cmd.exe']]
    ]
  } else {
    const preferred = process.env['TERMINAL']
    candidates = [
      ...(preferred && !preferred.includes(' ') ? [[preferred, []] as [string, string[]]] : []),
      ['x-terminal-emulator', []],
      ['gnome-terminal', [`--working-directory=${repo}`]],
      ['konsole', ['--workdir', repo]],
      ['xfce4-terminal', [`--working-directory=${repo}`]],
      ['kitty', ['--directory', repo]],
      ['alacritty', ['--working-directory', repo]],
      ['xterm', []]
    ]
  }
  for (const [command, args] of candidates) {
    if (await launch(command, args, repo)) return
  }
  throw new Error('Could not find a terminal application to open')
}

export const nativeApi: NativeGitApi = { pickDirectory, reveal, openInTerminal }
