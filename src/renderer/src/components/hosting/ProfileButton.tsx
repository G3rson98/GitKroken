import { useEffect } from 'react'
import { UserRound } from 'lucide-react'
import { AccountsDialog } from './AccountsDialog'
import { useHosting } from './state'
import { initials } from './util'
import './hosting.css'

/** Tab-bar button (right side) that opens the profiles & accounts dialog */
export function ProfileButton() {
  const profiles = useHosting((s) => s.profiles)
  const activeId = useHosting((s) => s.activeId)
  const open = useHosting((s) => s.dialog !== null)
  const openDialog = useHosting((s) => s.openDialog)
  const active = profiles.find((p) => p.id === activeId) ?? null

  useEffect(() => {
    void useHosting.getState().reload()
  }, [])

  return (
    <>
      <button
        type="button"
        className={`ho-pbtn no-drag${open ? ' open' : ''}`}
        title={
          active
            ? `Profiles & Accounts — active profile: ${active.name} (${active.userName} <${active.userEmail}>)`
            : 'Profiles & Accounts — no active profile: commits use your Git configuration'
        }
        onClick={() => openDialog()}
      >
        {active ? (
          <>
            <span className="ho-avatar">{initials(active.name)}</span>
            <span className="ho-pbtn-name">{active.name}</span>
          </>
        ) : (
          <UserRound size={15} />
        )}
      </button>
      <AccountsDialog />
    </>
  )
}
