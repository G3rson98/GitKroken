// Git actions shared by the toolbar, the sidebar and the welcome screen.
// Every mutation goes through the store's `run` (busy state + toast + refresh).
import { git } from '../../lib/git'
import { useStore } from '../../store'
import { promptDialog, showContextMenu, toast, type MenuItem } from '../ui/overlays'

export const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

export const run = (label: string, fn: (repo: string) => Promise<unknown>, successMsg?: string): Promise<boolean> =>
  useStore.getState().run(label, fn, successMsg)

export const shortSha = (hash: string | null | undefined): string => (hash ? hash.slice(0, 7) : '')

/** Opens the shared context menu anchored under an element (dropdown-button style). */
export function menuBelow(el: Element, items: MenuItem[]): void {
  const r = el.getBoundingClientRect()
  showContextMenu(new MouseEvent('click', { clientX: Math.round(r.left), clientY: Math.round(r.bottom + 4) }), items)
}

export async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text)
    toast('Copiado al portapapeles')
  } catch {
    toast('No se pudo copiar al portapapeles', 'error')
  }
}

export const checkoutRef = (ref: string): Promise<boolean> => run('Checkout', (repo) => git.checkout(repo, ref))

/** Prompts for a name, creates the branch at HEAD and checks it out. */
export async function createBranchAtHead(): Promise<void> {
  const typed = await promptDialog({
    title: 'Nueva rama',
    label: 'Nombre de la rama (se crea en HEAD)',
    placeholder: 'feature/mi-rama',
    confirmLabel: 'Crear rama'
  })
  if (!typed) return
  const name = typed.replace(/\s+/g, '-')
  await run('Crear rama', (repo) => git.createBranch(repo, name, undefined, true), `Rama "${name}" creada`)
}

export async function openRepoFromDisk(): Promise<void> {
  try {
    const dir = await git.pickDirectory('Abrir repositorio')
    if (dir) await useStore.getState().openRepo(dir)
  } catch (e) {
    toast(errText(e), 'error')
  }
}
