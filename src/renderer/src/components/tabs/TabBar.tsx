import { Plus, X } from 'lucide-react'
import { useStore, type RepoTab } from '../../store'
import { git } from '../../lib/git'
import { showContextMenu } from '../ui/overlays'
import { ProfileButton } from '../hosting/ProfileButton'
import './tabs.css'

export function TabBar() {
  const tabs = useStore((s) => s.tabs)
  const activeRepo = useStore((s) => s.activeRepo)
  const setActive = useStore((s) => s.setActive)
  const closeTab = useStore((s) => s.closeTab)
  const isMac = window.bridge?.platform === 'darwin'

  const activate = (path: string | null) => {
    // setActive resets the loaded repo state, so never call it for the tab already shown
    if (path !== useStore.getState().activeRepo) setActive(path)
  }

  const closeOthers = (keep: RepoTab) => {
    activate(keep.path)
    for (const t of useStore.getState().tabs) if (t.path !== keep.path) closeTab(t.path)
  }

  return (
    <div className={`tb drag-region${isMac ? ' tb-mac' : ''}`}>
      <div className="tb-tabs">
        {tabs.map((t) => (
          <div
            key={t.path}
            className={`tb-tab no-drag${t.path === activeRepo ? ' active' : ''}`}
            title={t.path}
            onClick={() => activate(t.path)}
            onMouseDown={(e) => {
              if (e.button === 1) e.preventDefault() // no autoscroll cursor on middle click
            }}
            onAuxClick={(e) => {
              if (e.button === 1) closeTab(t.path)
            }}
            onContextMenu={(e) =>
              showContextMenu(e, [
                { label: 'Close tab', onClick: () => closeTab(t.path) },
                { label: 'Close other tabs', onClick: () => closeOthers(t), disabled: tabs.length < 2 },
                { separator: true },
                { label: 'Reveal in file manager', onClick: () => void git.reveal(t.path).catch(() => {}) }
              ])
            }
          >
            <span className="tb-tab-name">{t.name}</span>
            <button
              className="tb-close"
              title="Close tab"
              onClick={(e) => {
                e.stopPropagation()
                closeTab(t.path)
              }}
            >
              <X size={13} />
            </button>
          </div>
        ))}
        <button
          className={`tb-new no-drag${activeRepo === null ? ' active' : ''}`}
          title="New tab"
          onClick={() => activate(null)}
        >
          <Plus size={15} />
        </button>
      </div>
      {/* right end of the bar; the button itself is a no-drag element */}
      <ProfileButton />
    </div>
  )
}
