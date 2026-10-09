import { useState } from 'react'
import { CloudDownload, FolderGit2, FolderOpen, FolderPlus, GitBranch, LoaderCircle, X } from 'lucide-react'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { toast } from '../ui/overlays'
import { CANCELLED, errText, openRepoFromDisk } from '../toolbar/actions'
import './tabs.css'

const CLONE_DIR_KEY = 'gitkroken.cloneDir'

const readCloneDir = (): string => {
  try {
    return localStorage.getItem(CLONE_DIR_KEY) ?? ''
  } catch {
    return ''
  }
}

/** `https://host/org/repo.git` / `git@host:org/repo.git` -> `repo` */
const repoNameFromUrl = (url: string): string =>
  url
    .trim()
    .replace(/[\\/]+$/, '')
    .replace(/\.git$/i, '')
    .split(/[\\/:]/)
    .pop() ?? ''

export function Welcome() {
  const recent = useStore((s) => s.recent)
  const tabs = useStore((s) => s.tabs)
  const openRepo = useStore((s) => s.openRepo)

  const [cloneOpen, setCloneOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [dest, setDest] = useState(readCloneDir)
  /** Label of the long operation in flight (clone / init), if any */
  const [working, setWorking] = useState<string | null>(null)
  /** Destination folder of the clone in flight: what `git.cancel` is keyed by */
  const [cloning, setCloning] = useState<string | null>(null)
  const [cancelling, setCancelling] = useState(false)
  const locked = working !== null

  const pickDest = async () => {
    try {
      const dir = await git.pickDirectory('Destination folder')
      if (dir) setDest(dir)
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  const doClone = async () => {
    const u = url.trim()
    const d = dest.trim()
    if (!u || !d || locked) return
    setWorking(`Cloning ${repoNameFromUrl(u) || 'repository'}…`)
    setCloning(d)
    try {
      const repo = await git.clone(u, d)
      localStorage.setItem(CLONE_DIR_KEY, d)
      toast('Repository cloned', 'success')
      setUrl('')
      setCloneOpen(false)
      await openRepo(repo)
    } catch (e) {
      const message = errText(e)
      // Cancelled by the user: nothing went wrong, and nothing was left on disk.
      if (message === CANCELLED) toast('Clone cancelled')
      else toast(`Clone: ${message}`, 'error')
    } finally {
      setWorking(null)
      setCloning(null)
      setCancelling(false)
    }
  }

  const cancelClone = async () => {
    if (!cloning || cancelling) return
    setCancelling(true)
    try {
      // False when the clone finished (or failed) a moment ago: nothing to do then.
      if (!(await git.cancel(cloning))) setCancelling(false)
    } catch (e) {
      setCancelling(false)
      toast(`Cancel: ${errText(e)}`, 'error')
    }
  }

  const doInit = async () => {
    if (locked) return
    try {
      const dir = await git.pickDirectory('Folder to initialize the repository in')
      if (!dir) return
      setWorking('Initializing repository…')
      const repo = await git.init(dir)
      toast('Repository initialized', 'success')
      await openRepo(repo || dir)
    } catch (e) {
      toast(`Init: ${errText(e)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  const target = url.trim() && dest.trim() ? `${dest.trim().replace(/[\\/]+$/, '')}/${repoNameFromUrl(url)}` : ''

  return (
    <div className="wl">
      <div className="wl-inner">
        <div className="wl-logo">
          <GitBranch size={34} strokeWidth={1.75} />
        </div>
        <h1 className="wl-title">
          Git<span>Kroken</span>
        </h1>
        <p className="wl-sub">Open, clone or initialize a repository to get started.</p>

        <div className="wl-actions">
          <button className="wl-action" disabled={locked} onClick={() => void openRepoFromDisk()}>
            <FolderOpen size={26} />
            <span className="wl-action-title">Open a repo</span>
            <span className="wl-action-desc">Choose a folder on this computer</span>
          </button>
          <button
            className={`wl-action${cloneOpen ? ' on' : ''}`}
            disabled={locked}
            onClick={() => setCloneOpen((v) => !v)}
          >
            <CloudDownload size={26} />
            <span className="wl-action-title">Clone a repo</span>
            <span className="wl-action-desc">Download a remote repository</span>
          </button>
          <button className="wl-action" disabled={locked} onClick={() => void doInit()}>
            <FolderPlus size={26} />
            <span className="wl-action-title">Start a local repo</span>
            <span className="wl-action-desc">Create a new repository</span>
          </button>
        </div>

        {cloneOpen && (
          <form
            className="wl-clone"
            onSubmit={(e) => {
              e.preventDefault()
              void doClone()
            }}
          >
            <div className="wl-field">
              <label htmlFor="wl-clone-url">Repository URL</label>
              <input
                id="wl-clone-url"
                autoFocus
                spellCheck={false}
                placeholder="https://host/user/repository.git"
                value={url}
                disabled={locked}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="wl-field">
              <label htmlFor="wl-clone-dest">Destination folder</label>
              <div className="wl-field-row">
                <input
                  id="wl-clone-dest"
                  spellCheck={false}
                  placeholder="Choose where to clone"
                  value={dest}
                  disabled={locked}
                  onChange={(e) => setDest(e.target.value)}
                />
                <button type="button" className="btn" disabled={locked} onClick={() => void pickDest()}>
                  Browse…
                </button>
              </div>
              {target && <div className="wl-hint" title={target}>Will be cloned into {target}</div>}
            </div>
            <div className="wl-clone-actions">
              {cloning ? (
                <button
                  type="button"
                  className="btn btn-danger"
                  style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}
                  disabled={cancelling}
                  onClick={() => void cancelClone()}
                >
                  <X size={13} />
                  {cancelling ? 'Cancelling…' : 'Cancel clone'}
                </button>
              ) : (
                <button type="button" className="btn" disabled={locked} onClick={() => setCloneOpen(false)}>
                  Cancel
                </button>
              )}
              <button type="submit" className="btn btn-primary" disabled={locked || !url.trim() || !dest.trim()}>
                {cloning ? 'Cloning…' : 'Clone the repo!'}
              </button>
            </div>
          </form>
        )}

        {working && (
          <div className="wl-working">
            <LoaderCircle size={16} className="wl-spin" />
            {working}
          </div>
        )}

        <div className="wl-recent">
          <h4>Recent repositories</h4>
          <div className="wl-recent-list">
            {recent.length === 0 && <div className="wl-empty">You have not opened any repository yet.</div>}
            {recent.map((r) => (
              <button
                key={r.path}
                className="wl-recent-item"
                title={r.path}
                disabled={locked}
                onClick={() => void openRepo(r.path)}
              >
                <FolderGit2 size={18} />
                <span className="wl-recent-text">
                  <span className="wl-recent-name">{r.name}</span>
                  <span className="wl-recent-path">{r.path}</span>
                </span>
                {tabs.some((t) => t.path === r.path) && <span className="wl-recent-open">open</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
