// The assembled `gitApi` object, with Electron mocked (plain Node has none).
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { GitApi } from '@shared/types'

const electron = vi.hoisted(() => ({
  showOpenDialog: vi.fn(),
  showItemInFolder: vi.fn()
}))

vi.mock('electron', () => ({
  dialog: { showOpenDialog: electron.showOpenDialog },
  shell: { showItemInFolder: electron.showItemInFolder },
  BrowserWindow: { getFocusedWindow: () => null, getAllWindows: () => [] }
}))

import { gitApi, onRepoChanged } from '../index'

/** Every method of the GitApi contract. `satisfies` keeps this list honest. */
const METHODS = {
  pickDirectory: 1, resolveRepo: 1, init: 1, clone: 1, watch: 1, unwatch: 1,
  log: 1, refs: 1, status: 1, commitDetails: 1, diff: 1, remotes: 1,
  stage: 1, unstage: 1, stageAll: 1, unstageAll: 1, discard: 1, discardAll: 1, applyPatch: 1, commit: 1,
  checkout: 1, createBranch: 1, deleteBranch: 1, renameBranch: 1, merge: 1, rebase: 1, cherryPick: 1,
  revert: 1, reset: 1, abort: 1, continueOp: 1, createTag: 1, deleteTag: 1,
  fetch: 1, pull: 1, push: 1, deleteRemoteBranch: 1, addRemote: 1, removeRemote: 1,
  stashSave: 1, stashPop: 1, stashApply: 1, stashDrop: 1,
  reveal: 1, openInTerminal: 1, openExternal: 1,
  cancel: 1, answerCredential: 1,
  conflictFile: 1, resolveConflict: 1, resolveWith: 1,
  rebaseTodo: 1, rebaseInteractive: 1, undoState: 1, undo: 1, redo: 1,
  blame: 1, fileHistory: 1, fileAt: 1, searchCommits: 1,
  submodules: 1, submoduleUpdate: 1, submoduleAdd: 1, worktrees: 1, worktreeAdd: 1, worktreeRemove: 1,
  lfsInfo: 1, lfsInstall: 1, lfsTrack: 1, lfsUntrack: 1, lfsPull: 1,
  accounts: 1, addAccount: 1, removeAccount: 1, hostedRepo: 1, pullRequests: 1, createPullRequest: 1,
  issues: 1, createIssue: 1, profiles: 1, saveProfile: 1, deleteProfile: 1, activateProfile: 1
} satisfies Record<keyof GitApi, 1>

describe('gitApi object', () => {
  beforeEach(() => {
    electron.showOpenDialog.mockReset()
    electron.showItemInFolder.mockReset()
  })

  it('exposes every contract method as an own function property', () => {
    for (const name of Object.keys(METHODS)) {
      // Same check the IPC dispatcher in src/main/index.ts performs.
      expect(Object.prototype.hasOwnProperty.call(gitApi, name), name).toBe(true)
      expect(typeof (gitApi as unknown as Record<string, unknown>)[name], name).toBe('function')
    }
    expect(Object.keys(gitApi).sort()).toEqual(Object.keys(METHODS).sort())
    expect(Object.getPrototypeOf(gitApi)).toBe(Object.prototype)
    expect(typeof onRepoChanged).toBe('function')
  })

  it('pickDirectory returns the chosen folder or null when cancelled', async () => {
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: false, filePaths: ['/some/folder'] })
    expect(await gitApi.pickDirectory('Pick one')).toBe('/some/folder')
    expect(electron.showOpenDialog).toHaveBeenCalledWith(
      expect.objectContaining({ title: 'Pick one', properties: expect.arrayContaining(['openDirectory']) })
    )
    electron.showOpenDialog.mockResolvedValueOnce({ canceled: true, filePaths: [] })
    expect(await gitApi.pickDirectory()).toBeNull()
  })

  it('reveal delegates to the shell', async () => {
    await gitApi.reveal('/some/folder/file.txt')
    expect(electron.showItemInFolder).toHaveBeenCalledWith('/some/folder/file.txt')
    await expect(gitApi.reveal('')).rejects.toThrow()
  })

  it('openInTerminal rejects for a missing folder (without launching anything)', async () => {
    await expect(gitApi.openInTerminal('/definitely/not/a/real/folder')).rejects.toThrow(/Folder not found/)
  })
})
