// Contract shared by main, preload and renderer. Every method of GitApi is
// reachable from the renderer as `git.<method>(...)` (see renderer/src/lib/git.ts).

export type RefType = 'head' | 'remote' | 'tag' | 'stash'

export interface Ref {
  /** Short name: `main`, `origin/main`, `v1.0`, `stash@{0}` */
  name: string
  type: RefType
  hash: string
  /** True for the checked-out local branch */
  isCurrent: boolean
  /** Local branches only: short upstream name, e.g. `origin/main` */
  upstream?: string
  ahead?: number
  behind?: number
  /** Stashes only: the stash message */
  message?: string
}

export interface Commit {
  hash: string
  parents: string[]
  author: string
  email: string
  /** Unix seconds */
  date: number
  subject: string
  body: string
  /** True when this commit is a stash entry */
  isStash?: boolean
}

export type FileStatus = 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'untracked' | 'conflicted'

export interface FileChange {
  path: string
  oldPath?: string
  status: FileStatus
}

export interface Status {
  /** Current branch name, or null when HEAD is detached */
  branch: string | null
  head: string | null
  staged: FileChange[]
  unstaged: FileChange[]
  conflicted: FileChange[]
  /** Set while a merge / rebase / cherry-pick / revert is in progress */
  inProgress: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null
}

export interface CommitDetails {
  commit: Commit
  files: FileChange[]
}

export interface Remote {
  name: string
  url: string
}

export interface DiffRequest {
  path: string
  oldPath?: string
  /** Diff of a file inside a commit (against its first parent) */
  commit?: string
  /** Working tree diff: true = index vs HEAD, false = worktree vs index */
  staged?: boolean
  /** Untracked file: diff against /dev/null */
  untracked?: boolean
}

export type ResetMode = 'soft' | 'mixed' | 'hard'

export interface GitApi {
  // --- repositories -------------------------------------------------------
  /** Native folder picker. Resolves null when cancelled. */
  pickDirectory(title?: string): Promise<string | null>
  /** Returns the repo top-level path, or null if `path` is not inside a repo */
  resolveRepo(path: string): Promise<string | null>
  init(path: string): Promise<string>
  /** Clones into `parentDir/<name>` and resolves the new repo path */
  clone(url: string, parentDir: string): Promise<string>
  /** Start watching a repo; `onRepoChanged` fires (debounced) on changes */
  watch(repo: string): Promise<void>
  unwatch(repo: string): Promise<void>

  // --- reading ------------------------------------------------------------
  /** All refs + stashes, newest first, in graph (topological-date) order */
  log(repo: string, opts?: { limit?: number; skip?: number }): Promise<Commit[]>
  refs(repo: string): Promise<Ref[]>
  status(repo: string): Promise<Status>
  commitDetails(repo: string, hash: string): Promise<CommitDetails>
  /** Unified diff text (`git diff` format). Empty string when no changes. */
  diff(repo: string, req: DiffRequest): Promise<string>
  remotes(repo: string): Promise<Remote[]>

  // --- staging & committing ----------------------------------------------
  stage(repo: string, paths: string[]): Promise<void>
  unstage(repo: string, paths: string[]): Promise<void>
  stageAll(repo: string): Promise<void>
  unstageAll(repo: string): Promise<void>
  /** Discards worktree changes (and deletes untracked files) for `paths` */
  discard(repo: string, paths: string[]): Promise<void>
  discardAll(repo: string): Promise<void>
  /** `git apply` a patch: used to stage / unstage / discard single hunks */
  applyPatch(repo: string, patch: string, opts: { cached?: boolean; reverse?: boolean }): Promise<void>
  commit(repo: string, message: string, opts?: { amend?: boolean }): Promise<void>

  // --- branches & history -------------------------------------------------
  /** Checking out `origin/foo` creates/track a local `foo` */
  checkout(repo: string, ref: string): Promise<void>
  createBranch(repo: string, name: string, startPoint?: string, checkout?: boolean): Promise<void>
  deleteBranch(repo: string, name: string, force?: boolean): Promise<void>
  renameBranch(repo: string, oldName: string, newName: string): Promise<void>
  merge(repo: string, ref: string): Promise<void>
  rebase(repo: string, onto: string): Promise<void>
  cherryPick(repo: string, hash: string): Promise<void>
  revert(repo: string, hash: string): Promise<void>
  reset(repo: string, hash: string, mode: ResetMode): Promise<void>
  /** Abort the in-progress merge / rebase / cherry-pick / revert */
  abort(repo: string): Promise<void>
  /** Continue the in-progress operation after conflicts are resolved */
  continueOp(repo: string): Promise<void>
  createTag(repo: string, name: string, hash: string, message?: string): Promise<void>
  deleteTag(repo: string, name: string): Promise<void>

  // --- remotes ------------------------------------------------------------
  fetch(repo: string): Promise<void>
  pull(repo: string, opts?: { rebase?: boolean }): Promise<void>
  /** Pushes the current branch (or `branch`); sets upstream when missing */
  push(repo: string, opts?: { branch?: string; force?: boolean }): Promise<void>
  deleteRemoteBranch(repo: string, remote: string, branch: string): Promise<void>
  addRemote(repo: string, name: string, url: string): Promise<void>
  removeRemote(repo: string, name: string): Promise<void>

  // --- stashes ------------------------------------------------------------
  stashSave(repo: string, message?: string): Promise<void>
  /** `index` is the N in stash@{N} */
  stashPop(repo: string, index: number): Promise<void>
  stashApply(repo: string, index: number): Promise<void>
  stashDrop(repo: string, index: number): Promise<void>

  // --- misc ---------------------------------------------------------------
  /** Reveal a path in Finder / file manager */
  reveal(path: string): Promise<void>
  openInTerminal(repo: string): Promise<void>
}

export const IPC_INVOKE = 'git:invoke'
export const IPC_REPO_CHANGED = 'git:repo-changed'

/** What preload exposes on `window.bridge` */
export interface Bridge {
  invoke(method: keyof GitApi, ...args: unknown[]): Promise<unknown>
  /** Returns an unsubscribe function */
  onRepoChanged(cb: (repo: string) => void): () => void
  platform: NodeJS.Platform
}
