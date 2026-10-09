// State shared by the hosting UI: the profile button, the "Perfiles y cuentas"
// dialog and the sidebar sections. Tokens never reach this side of the bridge.
import { create } from 'zustand'
import type { Account, HostKind, Profile } from '@shared/types'
import { git } from '../../lib/git'

/** Opens the dialog straight on the "connect account" form */
export interface ConnectRequest {
  kind: HostKind
  host?: string
}

interface HostingState {
  profiles: Profile[]
  activeId: string | null
  accounts: Account[]
  /** Why profiles / accounts could not be read, if they could not */
  error: string | null
  /** null = the dialog is closed */
  dialog: { connect?: ConnectRequest } | null

  reload(): Promise<void>
  openDialog(connect?: ConnectRequest): void
  closeDialog(): void
}

const message = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

let reloadSeq = 0

export const useHosting = create<HostingState>((set) => ({
  profiles: [],
  activeId: null,
  accounts: [],
  error: null,
  dialog: null,

  async reload() {
    const seq = ++reloadSeq
    try {
      const [list, accounts] = await Promise.all([git.profiles(), git.accounts()])
      if (seq !== reloadSeq) return
      set({ profiles: list.profiles, activeId: list.activeId, accounts, error: null })
    } catch (e) {
      if (seq === reloadSeq) set({ error: message(e) })
    }
  },

  openDialog(connect) {
    set({ dialog: connect ? { connect } : {} })
  },

  closeDialog() {
    set({ dialog: null })
  }
}))
