// Credential prompts: git / ssh asked the main process for a secret (see
// src/main/git/net.ts) and the main process forwarded the question here.
// Answers are handed straight back over IPC; they are never logged or stored.
import type { CredentialRequest } from '@shared/types'
import { git } from '../../lib/git'
import { confirmDialog, formDialog, toast } from '../ui/overlays'
import { describeCredential } from './prompt'

const queue: CredentialRequest[] = []
let pumping = false

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))
const openDialogTitle = (): string | null => document.querySelector('.modal-backdrop .modal h3')?.textContent ?? null
const dialogOpen = (): boolean => document.querySelector('.modal-backdrop') !== null

/**
 * The app has a single dialog slot: opening a dialog replaces the one on
 * screen, whose promise then never settles. So a credential dialog waits for
 * whatever is open to close first, and if something replaces it, that counts
 * as "cancelled" (git must not be left waiting for an answer nobody can give).
 */
async function guarded<T>(title: string, open: () => Promise<T | null>): Promise<T | null> {
  while (dialogOpen()) await sleep(150)
  let seen = false
  let timer: ReturnType<typeof setInterval> | undefined
  const replaced = new Promise<null>((resolve) => {
    timer = setInterval(() => {
      const current = openDialogTitle()
      if (current === title) seen = true
      else if (seen) resolve(null)
    }, 200)
  })
  try {
    return await Promise.race([open(), replaced])
  } finally {
    clearInterval(timer)
  }
}

/** Resolves the answer for git, or null when the user cancels. */
async function ask(req: CredentialRequest): Promise<string | null> {
  const dialog = describeCredential(req)
  if (dialog.mode === 'notice') {
    toast(dialog.text)
    return ''
  }
  if (dialog.mode === 'confirm') {
    const yes = await guarded(dialog.title, async () =>
      (await confirmDialog({ title: dialog.title, message: dialog.message, confirmLabel: dialog.confirmLabel })) ? true : null
    )
    return yes ? dialog.answer : null
  }
  const values = await guarded(dialog.title, () =>
    formDialog({
      title: dialog.title,
      message: dialog.message,
      confirmLabel: dialog.confirmLabel,
      fields: [{ name: 'value', label: dialog.label, type: dialog.secret ? 'password' : 'text', defaultValue: dialog.defaultValue }]
    })
  )
  if (!values) return null
  // A secret goes back exactly as typed; a user name loses stray spaces.
  return dialog.secret ? (values.value ?? '') : (values.value ?? '').trim()
}

async function pump(): Promise<void> {
  if (pumping) return
  pumping = true
  try {
    for (let req = queue.shift(); req; req = queue.shift()) {
      let value: string | null = null
      try {
        value = await ask(req)
      } catch {
        value = null
      }
      // Always answer, even on failure: null makes git stop instead of waiting forever.
      await git.answerCredential(req.id, value).catch(() => {})
    }
  } finally {
    pumping = false
  }
}

/**
 * Asks the user for the credential git needs and answers through
 * `git.answerCredential`. Requests that arrive while a dialog is open wait
 * their turn: one dialog at a time, in order of arrival.
 */
export function handleCredentialRequest(req: CredentialRequest): void {
  queue.push(req)
  void pump()
}
