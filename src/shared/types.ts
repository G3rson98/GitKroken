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
  /** Include the whole file as context instead of 3 lines around each change */
  fullContext?: boolean
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
  /**
   * `ref` may be a short name or, better, a full one (`refs/heads/x`, `refs/remotes/o/x`,
   * `refs/tags/x`): a short name that is both a branch and a tag is rejected as ambiguous.
   * The same holds for `merge`, `rebase` and the `startPoint` of `createBranch`.
   * Checking out `origin/foo` creates (or fast-forwards) a local `foo`.
   */
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
  push(repo: string, opts?: { branch?: string; force?: boolean; lease?: string }): Promise<void>
  deleteRemoteBranch(repo: string, remote: string, branch: string): Promise<void>
  addRemote(repo: string, name: string, url: string): Promise<void>
  removeRemote(repo: string, name: string): Promise<void>

  // --- stashes ------------------------------------------------------------
  stashSave(repo: string, message?: string): Promise<void>
  /**
   * `index` is the N in stash@{N}. Pass the stash commit `hash` as shown to the
   * user: the call is refused if N no longer names that stash.
   */
  stashPop(repo: string, index: number, hash?: string): Promise<void>
  stashApply(repo: string, index: number, hash?: string): Promise<void>
  stashDrop(repo: string, index: number, hash?: string): Promise<void>

  // --- misc ---------------------------------------------------------------
  /** Reveal a path in Finder / file manager */
  reveal(path: string): Promise<void>
  openInTerminal(repo: string): Promise<void>
  /** Opens an http(s) URL in the default browser */
  openExternal(url: string): Promise<void>

  // --- network control (src/main/git/net.ts) ---------------------------------
  /** Kills the network operation (fetch / pull / push / clone) running for `repo`. Resolves false if none. */
  cancel(repo: string): Promise<boolean>
  /** Reply to a CredentialRequest; null = the user cancelled */
  answerCredential(id: string, value: string | null): Promise<void>

  // --- merge conflicts (src/main/git/conflicts.ts) ---------------------------
  conflictFile(repo: string, path: string): Promise<ConflictFile>
  /** Writes `content` as the resolved file and stages it */
  resolveConflict(repo: string, path: string, content: string): Promise<void>
  /** Takes one whole side (handles delete/modify conflicts too) and stages it */
  resolveWith(repo: string, path: string, side: 'ours' | 'theirs'): Promise<void>

  // --- interactive rebase & undo (src/main/git/rebase.ts) --------------------
  /** Commits `base..HEAD`, oldest first. Rejects when the range contains merge commits. */
  rebaseTodo(repo: string, base: string): Promise<Commit[]>
  /** Rewrites `base..HEAD` following `steps` (oldest first). Never opens an editor. */
  rebaseInteractive(repo: string, base: string, steps: RebaseStep[]): Promise<void>
  undoState(repo: string): Promise<UndoState>
  undo(repo: string): Promise<void>
  redo(repo: string): Promise<void>

  // --- file history, blame, search (src/main/git/history.ts) -----------------
  /** Blame of `path` at `rev`; without `rev`, of the working tree (uncommitted lines carry the all-zero hash) */
  blame(repo: string, path: string, rev?: string): Promise<BlameLine[]>
  /** Commits that touched `path`, newest first, following renames */
  fileHistory(repo: string, path: string, opts?: { limit?: number; skip?: number }): Promise<FileHistoryEntry[]>
  /** File content at a revision; null when the file does not exist there */
  fileAt(repo: string, path: string, rev: string): Promise<string | null>
  /** Hashes (newest first) of commits in all refs matching `query` by message, author or SHA prefix */
  searchCommits(repo: string, query: string, opts?: { limit?: number }): Promise<string[]>

  // --- submodules, worktrees, LFS (src/main/git/extras.ts) -------------------
  submodules(repo: string): Promise<Submodule[]>
  /** `submodule update --init --recursive`, for one path or all */
  submoduleUpdate(repo: string, path?: string): Promise<void>
  submoduleAdd(repo: string, url: string, path: string): Promise<void>
  worktrees(repo: string): Promise<Worktree[]>
  /** Creates a worktree at `path` on `ref`; with `newBranch` creates that branch from `ref` */
  worktreeAdd(repo: string, path: string, ref: string, newBranch?: string): Promise<void>
  worktreeRemove(repo: string, path: string, force?: boolean): Promise<void>
  lfsInfo(repo: string): Promise<LfsInfo>
  /** `git lfs install --local` */
  lfsInstall(repo: string): Promise<void>
  lfsTrack(repo: string, pattern: string): Promise<void>
  lfsUntrack(repo: string, pattern: string): Promise<void>
  lfsPull(repo: string): Promise<void>

  // --- hosting accounts & profiles (src/main/git/hosting.ts) -----------------
  accounts(): Promise<Account[]>
  /** Validates the token against the API and stores it encrypted. The token never returns to the renderer. */
  addAccount(kind: HostKind, host: string, token: string): Promise<Account>
  removeAccount(id: string): Promise<void>
  /** The hosted repository behind the `origin` remote, or null */
  hostedRepo(repo: string): Promise<HostedRepo | null>
  pullRequests(repo: string): Promise<PullRequest[]>
  createPullRequest(repo: string, input: NewPullRequest): Promise<PullRequest>
  issues(repo: string): Promise<Issue[]>
  createIssue(repo: string, input: { title: string; body?: string }): Promise<Issue>
  profiles(): Promise<ProfileList>
  saveProfile(profile: Omit<Profile, 'id'> & { id?: string }): Promise<Profile>
  deleteProfile(id: string): Promise<void>
  /** null = no profile: commits use the user's own git config */
  activateProfile(id: string | null): Promise<void>
}

/** Sent main -> renderer when git needs a credential; answer with `answerCredential` */
export interface CredentialRequest {
  id: string
  kind: 'username' | 'password' | 'passphrase' | 'other'
  /** The prompt exactly as git / ssh printed it */
  prompt: string
  host?: string
  username?: string
}

export interface ConflictFile {
  path: string
  /** Content of each side; null when the file does not exist on that side */
  base: string | null
  ours: string | null
  theirs: string | null
  /** Worktree content (with conflict markers) */
  merged: string
  binary: boolean
  /** Human names of the two sides, e.g. `main` and `feature/login` */
  oursLabel: string
  theirsLabel: string
}

export type RebaseAction = 'pick' | 'reword' | 'squash' | 'fixup' | 'drop'

export interface RebaseStep {
  hash: string
  action: RebaseAction
  /** New message for `reword`; for `squash`, the message of the combined commit (set on the last squashed step) */
  message?: string
}

export interface UndoState {
  /** Description of what Undo would revert, or null when nothing can be undone */
  undo: string | null
  redo: string | null
}

export interface BlameLine {
  hash: string
  author: string
  /** Unix seconds */
  date: number
  summary: string
  /** 1-based line number in the blamed revision */
  lineNo: number
  text: string
  /** Path the file had in that commit, when it differs (renames) */
  path?: string
  /** The commit and path this line's commit changed the file from */
  previous?: { hash: string; path: string }
}

export interface FileHistoryEntry {
  commit: Commit
  /** Path of the file in that commit (differs after a rename) */
  path: string
  /** Previous path when this commit renamed the file */
  oldPath?: string
  status: FileStatus
}

export interface Submodule {
  path: string
  url: string
  /** Commit recorded in the superproject */
  hash: string
  status: 'ok' | 'uninitialized' | 'modified' | 'conflict'
  branch?: string
}

export interface Worktree {
  path: string
  head: string
  /** null when detached */
  branch: string | null
  isMain: boolean
  locked: boolean
  prunable: boolean
}

export interface LfsInfo {
  /** git-lfs binary available */
  installed: boolean
  /** LFS hooks/filters set up for this repo */
  enabled: boolean
  patterns: string[]
  /** Paths of the files stored in LFS */
  files: string[]
}

export type HostKind = 'github' | 'gitlab'

export interface Account {
  id: string
  kind: HostKind
  /** `github.com`, `gitlab.com` or a self-hosted host name */
  host: string
  username: string
  name?: string
  avatarUrl?: string
}

export interface HostedRepo {
  kind: HostKind
  host: string
  owner: string
  name: string
  webUrl: string
  /** The stored account for that host, if any */
  account: Account | null
}

export interface PullRequest {
  number: number
  title: string
  author: string
  state: 'open' | 'closed' | 'merged'
  draft: boolean
  sourceBranch: string
  targetBranch: string
  url: string
  /** Unix seconds */
  updatedAt: number
}

export interface NewPullRequest {
  title: string
  body?: string
  sourceBranch: string
  targetBranch: string
  draft?: boolean
}

export interface Issue {
  number: number
  title: string
  author: string
  state: 'open' | 'closed'
  labels: string[]
  url: string
  updatedAt: number
}

/** A commit identity. While one is active, commits made by the app use it (the user's git config is not modified). */
export interface Profile {
  id: string
  name: string
  userName: string
  userEmail: string
}

export interface ProfileList {
  profiles: Profile[]
  activeId: string | null
}

export const IPC_INVOKE = 'git:invoke'
export const IPC_REPO_CHANGED = 'git:repo-changed'
export const IPC_CREDENTIAL = 'git:credential-request'

/** What preload exposes on `window.bridge` */
export interface Bridge {
  invoke(method: keyof GitApi, ...args: unknown[]): Promise<unknown>
  /** Returns an unsubscribe function */
  onRepoChanged(cb: (repo: string) => void): () => void
  onCredentialRequest(cb: (req: CredentialRequest) => void): () => void
  platform: NodeJS.Platform
}
