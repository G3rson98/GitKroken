// Right-hand column: details of the selected commit, or the staging area
// (WIP) with the commit form.
import { CircleCheckBig } from 'lucide-react'
import { WIP, useStore } from '../../store'
import { CommitPanel } from './CommitPanel'
import { WipPanel } from './WipPanel'
import './RightPanel.css'

export function RightPanel() {
  const repo = useStore((s) => s.activeRepo)
  const selected = useStore((s) => s.selected)
  const status = useStore((s) => s.status)

  if (!repo) return <div className="rp" />

  const dirty = !!status && status.staged.length + status.unstaged.length + status.conflicted.length > 0

  let content
  if (selected !== null && selected !== WIP) {
    content = <CommitPanel repo={repo} hash={selected} />
  } else if (!status) {
    content = <div className="rp-empty rp-loading">Cargando…</div>
  } else if (selected === WIP || dirty || status.inProgress) {
    // Nothing selected but there is work in progress: the staging area is the default
    content = <WipPanel key={repo} repo={repo} status={status} />
  } else {
    content = (
      <div className="rp-empty">
        <CircleCheckBig size={40} strokeWidth={1.25} />
        <div className="rp-empty-title">Árbol de trabajo limpio</div>
        <div className="rp-empty-text">
          No hay cambios pendientes{status.branch ? ` en ${status.branch}` : ''}. Selecciona un commit del grafo para ver
          sus detalles y los archivos que modifica.
        </div>
      </div>
    )
  }
  return <div className="rp">{content}</div>
}
