import { useState } from 'react'
import { CloudDownload, FolderGit2, FolderOpen, FolderPlus, GitBranch, LoaderCircle } from 'lucide-react'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { toast } from '../ui/overlays'
import { errText, openRepoFromDisk } from '../toolbar/actions'
import './tabs.css'

const CLONE_DIR_KEY = 'gitabyss.cloneDir'

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
  const locked = working !== null

  const pickDest = async () => {
    try {
      const dir = await git.pickDirectory('Carpeta de destino')
      if (dir) setDest(dir)
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  const doClone = async () => {
    const u = url.trim()
    const d = dest.trim()
    if (!u || !d || locked) return
    setWorking(`Clonando ${repoNameFromUrl(u) || 'repositorio'}…`)
    try {
      const repo = await git.clone(u, d)
      localStorage.setItem(CLONE_DIR_KEY, d)
      toast('Repositorio clonado', 'success')
      setUrl('')
      setCloneOpen(false)
      await openRepo(repo)
    } catch (e) {
      toast(`Clonar: ${errText(e)}`, 'error')
    } finally {
      setWorking(null)
    }
  }

  const doInit = async () => {
    if (locked) return
    try {
      const dir = await git.pickDirectory('Carpeta donde iniciar el repositorio')
      if (!dir) return
      setWorking('Iniciando repositorio…')
      const repo = await git.init(dir)
      toast('Repositorio iniciado', 'success')
      await openRepo(repo || dir)
    } catch (e) {
      toast(`Iniciar repositorio: ${errText(e)}`, 'error')
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
          Git<span>Abyss</span>
        </h1>
        <p className="wl-sub">Abre, clona o inicia un repositorio para empezar.</p>

        <div className="wl-actions">
          <button className="wl-action" disabled={locked} onClick={() => void openRepoFromDisk()}>
            <FolderOpen size={26} />
            <span className="wl-action-title">Abrir repositorio</span>
            <span className="wl-action-desc">Elige una carpeta de tu equipo</span>
          </button>
          <button
            className={`wl-action${cloneOpen ? ' on' : ''}`}
            disabled={locked}
            onClick={() => setCloneOpen((v) => !v)}
          >
            <CloudDownload size={26} />
            <span className="wl-action-title">Clonar</span>
            <span className="wl-action-desc">Descarga un repositorio remoto</span>
          </button>
          <button className="wl-action" disabled={locked} onClick={() => void doInit()}>
            <FolderPlus size={26} />
            <span className="wl-action-title">Iniciar repositorio</span>
            <span className="wl-action-desc">Crea un repositorio nuevo</span>
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
              <label htmlFor="wl-clone-url">URL del repositorio</label>
              <input
                id="wl-clone-url"
                autoFocus
                spellCheck={false}
                placeholder="https://servidor/usuario/repositorio.git"
                value={url}
                disabled={locked}
                onChange={(e) => setUrl(e.target.value)}
              />
            </div>
            <div className="wl-field">
              <label htmlFor="wl-clone-dest">Carpeta de destino</label>
              <div className="wl-field-row">
                <input
                  id="wl-clone-dest"
                  spellCheck={false}
                  placeholder="Selecciona dónde clonar"
                  value={dest}
                  disabled={locked}
                  onChange={(e) => setDest(e.target.value)}
                />
                <button type="button" className="btn" disabled={locked} onClick={() => void pickDest()}>
                  Examinar…
                </button>
              </div>
              {target && <div className="wl-hint" title={target}>Se clonará en {target}</div>}
            </div>
            <div className="wl-clone-actions">
              <button type="button" className="btn" disabled={locked} onClick={() => setCloneOpen(false)}>
                Cancelar
              </button>
              <button type="submit" className="btn btn-primary" disabled={locked || !url.trim() || !dest.trim()}>
                {locked ? 'Clonando…' : 'Clonar repositorio'}
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
          <h4>Repositorios recientes</h4>
          <div className="wl-recent-list">
            {recent.length === 0 && <div className="wl-empty">Aún no has abierto ningún repositorio.</div>}
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
                {tabs.some((t) => t.path === r.path) && <span className="wl-recent-open">abierto</span>}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  )
}
