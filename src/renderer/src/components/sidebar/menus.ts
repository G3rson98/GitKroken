// Context-menu definitions and the dialogs behind them for every sidebar item.
import type { Ref, Remote } from '@shared/types'
import { git } from '../../lib/git'
import { useStore } from '../../store'
import { confirmDialog, formDialog, promptDialog, toast, type MenuItem } from '../ui/overlays'
import { checkoutRef, copyText, errText, run } from '../toolbar/actions'
import { splitRemoteRef } from './tree'

const UNMERGED = /not fully merged|no est[aá] (completamente|totalmente) fusionad/i

/** Current branch name, or null when HEAD is detached / unknown */
const currentBranch = (): string | null => {
  const s = useStore.getState()
  return s.status?.branch ?? s.refs.find((r) => r.type === 'head' && r.isCurrent)?.name ?? null
}

/**
 * Merge / rebase may stop on conflicts without failing, so success is only
 * announced when no operation is left in progress after the refresh.
 */
async function runOp(label: string, fn: (repo: string) => Promise<unknown>, doneMsg: string): Promise<void> {
  const ok = await run(label, fn)
  if (ok && !useStore.getState().status?.inProgress) toast(doneMsg, 'success')
}

const mergeInto = (ref: string, current: string) =>
  runOp('Merge', (repo) => git.merge(repo, ref), `"${ref}" fusionada en "${current}"`)

// ----- local branches -------------------------------------------------------

export async function deleteLocalBranch(name: string): Promise<void> {
  const yes = await confirmDialog({
    title: 'Eliminar rama',
    message: `¿Eliminar la rama local "${name}"?`,
    confirmLabel: 'Eliminar',
    danger: true
  })
  if (!yes) return

  // `run` only reports success/failure, so the "not fully merged" case is detected here
  const result = { deleted: false, unmerged: false }
  await run('Eliminar rama', async (repo) => {
    try {
      await git.deleteBranch(repo, name)
      result.deleted = true
    } catch (e) {
      if (!UNMERGED.test(errText(e))) throw e
      result.unmerged = true
    }
  })
  if (result.deleted) {
    toast(`Rama "${name}" eliminada`, 'success')
    return
  }
  if (!result.unmerged) return

  const force = await confirmDialog({
    title: 'La rama no está fusionada',
    message: `"${name}" tiene commits que no están fusionados en ninguna otra rama. Si la eliminas podrías perderlos.\n\n¿Forzar la eliminación?`,
    confirmLabel: 'Forzar eliminación',
    danger: true
  })
  if (force) await run('Eliminar rama', (repo) => git.deleteBranch(repo, name, true), `Rama "${name}" eliminada`)
}

async function renameBranch(name: string): Promise<void> {
  const typed = await promptDialog({
    title: 'Renombrar rama',
    label: `Nuevo nombre para "${name}"`,
    defaultValue: name,
    confirmLabel: 'Renombrar'
  })
  const next = typed?.replace(/\s+/g, '-')
  if (!next || next === name) return
  await run('Renombrar rama', (repo) => git.renameBranch(repo, name, next), `Rama renombrada a "${next}"`)
}

export function localBranchMenu(ref: Ref): MenuItem[] {
  const current = currentBranch()
  const name = ref.name
  const other = !ref.isCurrent && current !== null
  return [
    { label: `Checkout ${name}`, onClick: () => void checkoutRef(name), disabled: ref.isCurrent },
    { separator: true },
    {
      label: other ? `Fusionar ${name} en ${current}` : 'Fusionar en la rama actual',
      onClick: () => current && void mergeInto(name, current),
      disabled: !other
    },
    {
      label: other ? `Rebase de ${current} sobre ${name}` : 'Rebase de la rama actual sobre esta',
      onClick: () => void runOp('Rebase', (repo) => git.rebase(repo, name), `"${current}" reubicada sobre "${name}"`),
      disabled: !other
    },
    { separator: true },
    {
      label: ref.upstream ? `Push a ${ref.upstream}` : 'Push',
      onClick: () => void run('Push', (repo) => git.push(repo, { branch: name }), `Push de "${name}" completado`)
    },
    { label: 'Renombrar…', onClick: () => void renameBranch(name) },
    { label: 'Copiar nombre', onClick: () => void copyText(name) },
    { separator: true },
    { label: `Eliminar ${name}`, onClick: () => void deleteLocalBranch(name), disabled: ref.isCurrent, danger: true }
  ]
}

// ----- remotes --------------------------------------------------------------

export function remoteBranchMenu(ref: Ref, remotes: Remote[]): MenuItem[] {
  const current = currentBranch()
  const name = ref.name
  const { remote, branch } = splitRemoteRef(name, remotes)
  const onDelete = async () => {
    const yes = await confirmDialog({
      title: 'Eliminar rama remota',
      message: `¿Eliminar la rama "${branch}" del remoto "${remote}"?\n\nEsto la borra en el servidor para todo el equipo.`,
      confirmLabel: 'Eliminar del remoto',
      danger: true
    })
    if (yes)
      await run(
        'Eliminar rama remota',
        (repo) => git.deleteRemoteBranch(repo, remote, branch),
        `Rama "${name}" eliminada del remoto`
      )
  }
  return [
    { label: `Checkout ${name}`, onClick: () => void checkoutRef(name) },
    {
      label: current ? `Fusionar ${name} en ${current}` : 'Fusionar en la rama actual',
      onClick: () => current && void mergeInto(name, current),
      disabled: !current
    },
    { label: 'Copiar nombre', onClick: () => void copyText(name) },
    { separator: true },
    { label: `Eliminar ${name}`, onClick: () => void onDelete(), danger: true }
  ]
}

export async function addRemote(): Promise<void> {
  const hasOrigin = useStore.getState().remotes.some((r) => r.name === 'origin')
  const values = await formDialog({
    title: 'Añadir remoto',
    confirmLabel: 'Añadir remoto',
    fields: [
      { name: 'name', label: 'Nombre', defaultValue: hasOrigin ? '' : 'origin', placeholder: 'origin' },
      { name: 'url', label: 'URL', placeholder: 'https://servidor/usuario/repositorio.git' }
    ]
  })
  if (!values) return
  const name = values.name.trim()
  const url = values.url.trim()
  if (!name || !url) {
    toast('Indica el nombre y la URL del remoto', 'error')
    return
  }
  await run('Añadir remoto', (repo) => git.addRemote(repo, name, url), `Remoto "${name}" añadido`)
}

export function remoteMenu(name: string, url: string | undefined): MenuItem[] {
  const onRemove = async () => {
    const yes = await confirmDialog({
      title: 'Quitar remoto',
      message: `¿Quitar el remoto "${name}"${url ? ` (${url})` : ''}?\n\nSe eliminarán también sus ramas de seguimiento locales.`,
      confirmLabel: 'Quitar remoto',
      danger: true
    })
    if (yes) await run('Quitar remoto', (repo) => git.removeRemote(repo, name), `Remoto "${name}" quitado`)
  }
  return [
    { label: 'Fetch', onClick: () => void run('Fetch', (repo) => git.fetch(repo), 'Fetch completado') },
    { label: 'Copiar URL', onClick: () => url && void copyText(url), disabled: !url },
    { separator: true },
    { label: `Quitar ${name}`, onClick: () => void onRemove(), danger: true }
  ]
}

// ----- stashes --------------------------------------------------------------

export function stashMenu(ref: Ref, index: number): MenuItem[] {
  const title = ref.message || ref.name
  const onDrop = async () => {
    const yes = await confirmDialog({
      title: 'Eliminar stash',
      message: `¿Eliminar el stash "${title}"?\n\nLos cambios guardados en él se perderán.`,
      confirmLabel: 'Eliminar',
      danger: true
    })
    if (yes) await run('Eliminar stash', (repo) => git.stashDrop(repo, index), 'Stash eliminado')
  }
  return [
    {
      label: 'Aplicar stash',
      onClick: () => void run('Aplicar stash', (repo) => git.stashApply(repo, index), 'Stash aplicado')
    },
    {
      label: 'Pop (aplicar y eliminar)',
      onClick: () => void run('Pop', (repo) => git.stashPop(repo, index), 'Stash aplicado y eliminado')
    },
    { separator: true },
    { label: 'Eliminar stash', onClick: () => void onDrop(), danger: true }
  ]
}

// ----- tags -----------------------------------------------------------------

export function tagMenu(ref: Ref): MenuItem[] {
  const name = ref.name
  const onDelete = async () => {
    const yes = await confirmDialog({
      title: 'Eliminar tag',
      message: `¿Eliminar el tag local "${name}"?`,
      confirmLabel: 'Eliminar',
      danger: true
    })
    if (yes) await run('Eliminar tag', (repo) => git.deleteTag(repo, name), `Tag "${name}" eliminado`)
  }
  return [
    { label: `Checkout ${name}`, onClick: () => void checkoutRef(name) },
    { label: 'Copiar nombre', onClick: () => void copyText(name) },
    { separator: true },
    { label: `Eliminar ${name}`, onClick: () => void onDelete(), danger: true }
  ]
}
