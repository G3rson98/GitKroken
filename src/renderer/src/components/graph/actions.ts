// Context menus and git mutations triggered from the graph. Every write goes
// through the store's `run()` so it gets busy state, error toasts and a refresh.
import type { Commit } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { confirmDialog, formDialog, promptDialog, toast, type MenuItem } from '../ui/overlays'
import { splitRemoteRef, stashIndex, type RefLabel } from './refLabels'

const SEP: MenuItem = { separator: true }

const run = (label: string, fn: (repo: string) => Promise<unknown>, successMsg?: string): Promise<boolean> =>
  useStore.getState().run(label, fn, successMsg)

const errText = (e: unknown): string =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '').trim()

function copyText(text: string, what: string): void {
  navigator.clipboard.writeText(text).then(
    () => toast(`${what} copiado al portapapeles`, 'success'),
    () => toast(`No se pudo copiar ${what}`, 'error')
  )
}

/** Name to hand to git for a branch pill */
const gitName = (label: RefLabel): string => (label.kind === 'remote' && label.remote ? label.remote.name : label.name)

// --- commits ---------------------------------------------------------------

async function createBranchAt(hash: string): Promise<void> {
  const name = await promptDialog({
    title: 'Crear rama',
    label: `Nombre de la nueva rama (desde ${hash.slice(0, 7)})`,
    placeholder: 'feature/mi-rama',
    confirmLabel: 'Crear rama'
  })
  if (!name) return
  await run('Crear rama', (repo) => git.createBranch(repo, name, hash, true), `Rama «${name}» creada`)
}

async function createTagAt(hash: string): Promise<void> {
  const r = await formDialog({
    title: 'Crear etiqueta',
    message: `Se creará en el commit ${hash.slice(0, 7)}.`,
    fields: [
      { name: 'name', label: 'Nombre de la etiqueta', placeholder: 'v1.0.0' },
      { name: 'message', label: 'Mensaje (opcional: crea una etiqueta anotada)' }
    ],
    confirmLabel: 'Crear etiqueta'
  })
  if (!r) return
  const name = r.name.trim()
  const message = r.message.trim()
  if (!name) {
    toast('El nombre de la etiqueta es obligatorio', 'error')
    return
  }
  await run('Crear etiqueta', (repo) => git.createTag(repo, name, hash, message || undefined), `Etiqueta «${name}» creada`)
}

async function resetTo(hash: string, mode: 'soft' | 'mixed' | 'hard', target: string): Promise<void> {
  if (mode === 'hard') {
    const ok = await confirmDialog({
      title: 'Reset hard',
      message:
        `${target} se moverá a ${hash.slice(0, 7)} y se descartarán TODOS los cambios sin confirmar ` +
        'del directorio de trabajo y del área de preparación.\n\nEsta acción no se puede deshacer.',
      confirmLabel: 'Descartar y hacer reset',
      danger: true
    })
    if (!ok) return
  }
  await run(`Reset ${mode}`, (repo) => git.reset(repo, hash, mode))
}

export function commitMenu(commit: Commit): MenuItem[] {
  if (commit.isStash) return stashMenu(findStashIndex(commit.hash))

  const { status } = useStore.getState()
  const branch = status?.branch ?? null
  const target = branch ? `«${branch}»` : 'HEAD'
  const isHead = status?.head === commit.hash
  const { hash } = commit

  return [
    { label: 'Hacer checkout de este commit', onClick: () => void run('Checkout', (repo) => git.checkout(repo, hash)) },
    { label: 'Crear rama aquí…', onClick: () => void createBranchAt(hash) },
    { label: 'Crear etiqueta aquí…', onClick: () => void createTagAt(hash) },
    SEP,
    {
      label: 'Cherry-pick de este commit',
      disabled: isHead,
      onClick: () => void run('Cherry-pick', (repo) => git.cherryPick(repo, hash))
    },
    { label: 'Revertir este commit', onClick: () => void run('Revertir', (repo) => git.revert(repo, hash)) },
    SEP,
    {
      label: `Reset de ${target} a este commit: soft (conserva los cambios preparados)`,
      onClick: () => void resetTo(hash, 'soft', target)
    },
    {
      label: `Reset de ${target} a este commit: mixed (conserva los cambios sin preparar)`,
      onClick: () => void resetTo(hash, 'mixed', target)
    },
    {
      label: `Reset de ${target} a este commit: hard (descarta todos los cambios)`,
      danger: true,
      onClick: () => void resetTo(hash, 'hard', target)
    },
    SEP,
    { label: 'Copiar SHA', onClick: () => copyText(hash, 'SHA') }
  ]
}

// --- stashes ---------------------------------------------------------------

function findStashIndex(hash: string): number | null {
  const ref = useStore.getState().refs.find((r) => r.type === 'stash' && r.hash === hash)
  return ref ? stashIndex(ref.name) : null
}

async function dropStash(index: number): Promise<void> {
  const ok = await confirmDialog({
    title: 'Eliminar stash',
    message: `¿Eliminar stash@{${index}}? Los cambios guardados en él se perderán.`,
    confirmLabel: 'Eliminar stash',
    danger: true
  })
  if (ok) await run('Eliminar stash', (repo) => git.stashDrop(repo, index))
}

export function stashMenu(index: number | null): MenuItem[] {
  const off = index === null
  const i = index ?? 0
  return [
    { label: 'Aplicar stash', disabled: off, onClick: () => void run('Aplicar stash', (repo) => git.stashApply(repo, i)) },
    {
      label: 'Aplicar y eliminar stash (pop)',
      disabled: off,
      onClick: () => void run('Pop stash', (repo) => git.stashPop(repo, i))
    },
    SEP,
    { label: 'Eliminar stash…', disabled: off, danger: true, onClick: () => void dropStash(i) }
  ]
}

// --- WIP -------------------------------------------------------------------

async function stashChanges(): Promise<void> {
  const r = await formDialog({
    title: 'Guardar cambios en un stash',
    fields: [{ name: 'message', label: 'Mensaje (opcional)', placeholder: 'WIP' }],
    confirmLabel: 'Guardar stash'
  })
  if (!r) return
  const message = r.message.trim()
  await run('Stash', (repo) => git.stashSave(repo, message || undefined))
}

async function discardAll(): Promise<void> {
  const ok = await confirmDialog({
    title: 'Descartar todos los cambios',
    message:
      'Se descartarán todos los cambios del directorio de trabajo y del área de preparación, ' +
      'incluidos los archivos sin seguimiento.\n\nEsta acción no se puede deshacer.',
    confirmLabel: 'Descartar todo',
    danger: true
  })
  if (ok) await run('Descartar cambios', (repo) => git.discardAll(repo))
}

export function wipMenu(): MenuItem[] {
  return [
    { label: 'Guardar cambios en un stash…', onClick: () => void stashChanges() },
    SEP,
    { label: 'Descartar todos los cambios…', danger: true, onClick: () => void discardAll() }
  ]
}

// --- branches & tags -------------------------------------------------------

/** Double click on a pill */
export function checkoutLabel(label: RefLabel): void {
  if (label.kind === 'local') {
    if (!label.isCurrent) void run('Checkout', (repo) => git.checkout(repo, label.name))
  } else if (label.kind === 'remote') {
    // the backend creates / reuses the local tracking branch
    void run('Checkout', (repo) => git.checkout(repo, gitName(label)))
  }
}

async function renameBranch(name: string): Promise<void> {
  const next = await promptDialog({
    title: 'Renombrar rama',
    label: `Nuevo nombre para «${name}»`,
    defaultValue: name,
    confirmLabel: 'Renombrar'
  })
  if (!next || next === name) return
  await run('Renombrar rama', (repo) => git.renameBranch(repo, name, next))
}

async function deleteLocalBranch(name: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Eliminar rama',
    message: `¿Eliminar la rama local «${name}»?`,
    confirmLabel: 'Eliminar rama',
    danger: true
  })
  if (!ok) return

  // run() swallows errors, so the failure of the safe delete is captured here
  // to be able to offer the forced one.
  const result = { error: null as string | null }
  const ran = await run('Eliminar rama', async (repo) => {
    try {
      await git.deleteBranch(repo, name, false)
    } catch (e) {
      result.error = errText(e)
    }
  })
  if (!ran || result.error === null) return
  if (/checked out|worktree/i.test(result.error)) {
    toast(`Eliminar rama: ${result.error}`, 'error')
    return
  }
  const force = await confirmDialog({
    title: `No se pudo eliminar «${name}»`,
    message:
      `${result.error}\n\nLa rama puede tener commits que no están fusionados. ` +
      '¿Forzar la eliminación? Esos commits podrían perderse.',
    confirmLabel: 'Forzar eliminación',
    danger: true
  })
  if (force) await run('Eliminar rama', (repo) => git.deleteBranch(repo, name, true))
}

async function deleteRemoteBranch(fullName: string): Promise<void> {
  const remoteNames = useStore.getState().remotes.map((r) => r.name)
  const { remote, branch } = splitRemoteRef(fullName, remoteNames)
  if (!remote || !branch) {
    toast(`No se pudo determinar el remoto de «${fullName}»`, 'error')
    return
  }
  const ok = await confirmDialog({
    title: 'Eliminar rama remota',
    message: `¿Eliminar la rama «${branch}» del remoto «${remote}»?\n\nDejará de estar disponible para todo el equipo.`,
    confirmLabel: 'Eliminar del remoto',
    danger: true
  })
  if (ok) await run('Eliminar rama remota', (repo) => git.deleteRemoteBranch(repo, remote, branch))
}

async function deleteTag(name: string): Promise<void> {
  const ok = await confirmDialog({
    title: 'Eliminar etiqueta',
    message: `¿Eliminar la etiqueta local «${name}»?`,
    confirmLabel: 'Eliminar etiqueta',
    danger: true
  })
  if (ok) await run('Eliminar etiqueta', (repo) => git.deleteTag(repo, name))
}

export function labelMenu(label: RefLabel): MenuItem[] {
  const current = useStore.getState().status?.branch ?? null
  const into = current ? `«${current}»` : 'HEAD'

  switch (label.kind) {
    case 'local': {
      const name = label.name
      const items: MenuItem[] = [
        {
          label: label.isCurrent ? `«${name}» es la rama actual` : `Hacer checkout de «${name}»`,
          disabled: label.isCurrent,
          onClick: () => void run('Checkout', (repo) => git.checkout(repo, name))
        },
        SEP
      ]
      if (!label.isCurrent) {
        items.push(
          { label: `Fusionar «${name}» en ${into}`, onClick: () => void run('Merge', (repo) => git.merge(repo, name)) },
          { label: `Rebase de ${into} sobre «${name}»`, onClick: () => void run('Rebase', (repo) => git.rebase(repo, name)) },
          SEP
        )
      }
      items.push(
        { label: `Push de «${name}»`, onClick: () => void run('Push', (repo) => git.push(repo, { branch: name })) },
        { label: 'Renombrar…', onClick: () => void renameBranch(name) },
        {
          label: `Eliminar «${name}»…`,
          danger: true,
          disabled: label.isCurrent,
          onClick: () => void deleteLocalBranch(name)
        }
      )
      if (label.remote) {
        const remoteName = label.remote.name
        items.push({
          label: `Eliminar rama remota «${remoteName}»…`,
          danger: true,
          onClick: () => void deleteRemoteBranch(remoteName)
        })
      }
      items.push(SEP, { label: 'Copiar nombre de la rama', onClick: () => copyText(name, 'Nombre') })
      return items
    }
    case 'remote': {
      const name = gitName(label)
      return [
        { label: `Hacer checkout de «${name}»`, onClick: () => void run('Checkout', (repo) => git.checkout(repo, name)) },
        SEP,
        { label: `Fusionar «${name}» en ${into}`, onClick: () => void run('Merge', (repo) => git.merge(repo, name)) },
        { label: `Rebase de ${into} sobre «${name}»`, onClick: () => void run('Rebase', (repo) => git.rebase(repo, name)) },
        SEP,
        { label: `Eliminar rama remota «${name}»…`, danger: true, onClick: () => void deleteRemoteBranch(name) },
        SEP,
        { label: 'Copiar nombre de la rama', onClick: () => copyText(name, 'Nombre') }
      ]
    }
    case 'tag': {
      const name = label.name
      return [
        { label: `Hacer checkout de la etiqueta «${name}»`, onClick: () => void run('Checkout', (repo) => git.checkout(repo, name)) },
        SEP,
        { label: `Eliminar etiqueta «${name}»…`, danger: true, onClick: () => void deleteTag(name) },
        SEP,
        { label: 'Copiar nombre de la etiqueta', onClick: () => copyText(name, 'Nombre') }
      ]
    }
    case 'stash':
      return stashMenu(stashIndex(label.name))
    case 'detached':
      return []
  }
}

// --- drag a branch pill onto another one -----------------------------------

export const isBranchLabel = (label: RefLabel): boolean => label.kind === 'local' || label.kind === 'remote'

/** Menu shown when `src` is dropped on `dst` */
export function dropMenu(src: RefLabel, dst: RefLabel): MenuItem[] {
  const srcName = gitName(src)
  const dstName = gitName(dst)
  const current = useStore.getState().status?.branch ?? null
  // merging needs the target checked out, rebasing needs the source checked out
  const canMerge = dst.kind === 'local'
  const canRebase = src.kind === 'local'

  return [
    {
      label: `Fusionar «${srcName}» en «${dstName}»`,
      disabled: !canMerge,
      onClick: () =>
        void run('Merge', async (repo) => {
          if (current !== dstName) await git.checkout(repo, dstName)
          await git.merge(repo, srcName)
        })
    },
    {
      label: `Rebase de «${srcName}» sobre «${dstName}»`,
      disabled: !canRebase,
      onClick: () =>
        void run('Rebase', async (repo) => {
          if (current !== srcName) await git.checkout(repo, srcName)
          await git.rebase(repo, dstName)
        })
    }
  ]
}
