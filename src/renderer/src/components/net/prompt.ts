// What to show for a credential request. Pure (no DOM, no IPC): unit-tested.
import type { CredentialRequest } from '@shared/types'

export type CredentialDialog =
  /** A value has to be typed */
  | {
      mode: 'input'
      title: string
      message: string
      label: string
      /** Masked field (passwords, tokens, passphrases) */
      secret: boolean
      defaultValue?: string
      confirmLabel: string
    }
  /** A yes / no question; accepting sends `answer` */
  | { mode: 'confirm'; title: string; message: string; confirmLabel: string; answer: string }
  /** Nothing to type: ssh only wants the user to do something (touch a security key) */
  | { mode: 'notice'; text: string }

const YES_NO = /\(yes\/no(\/\[fingerprint\])?\)\??\s*$/i

/** Host (and user) the request is about, then the prompt exactly as git / ssh printed it. */
function context(req: CredentialRequest, showUser: boolean): string {
  const lines: string[] = []
  if (req.host) lines.push(`Server: ${req.host}`)
  if (showUser && req.username) lines.push(`User: ${req.username}`)
  if (lines.length) lines.push('')
  lines.push(req.prompt.trim())
  return lines.join('\n')
}

export function describeCredential(req: CredentialRequest): CredentialDialog {
  const prompt = req.prompt.trim()
  if (/^Confirm user presence for key/i.test(prompt)) {
    return { mode: 'notice', text: 'Touch your security key to continue…' }
  }
  if (req.kind === 'username') {
    return {
      mode: 'input',
      title: req.host ? `Username for ${req.host}` : 'Git needs your username',
      message: context(req, false),
      label: 'Username',
      secret: false,
      defaultValue: req.username,
      confirmLabel: 'Continue'
    }
  }
  if (req.kind === 'password') {
    return {
      mode: 'input',
      title: req.host ? `Password for ${req.host}` : 'Git needs your password',
      message: context(req, true),
      label: 'Password or access token',
      secret: true,
      confirmLabel: 'Continue'
    }
  }
  if (req.kind === 'passphrase') {
    return {
      mode: 'input',
      title: 'SSH key passphrase',
      message: context(req, true),
      label: /\bPIN\b/.test(prompt) ? 'Security key PIN' : 'Passphrase',
      secret: true,
      confirmLabel: 'Unlock'
    }
  }
  if (YES_NO.test(prompt)) {
    return {
      mode: 'confirm',
      title: req.host ? `Trust the server ${req.host}?` : 'Continue connecting?',
      // The whole text matters here: it carries the key fingerprint to verify.
      message: prompt,
      confirmLabel: 'Yes, connect',
      answer: 'yes'
    }
  }
  return {
    mode: 'input',
    title: 'Git is asking for input',
    message: context(req, true),
    label: 'Answer',
    // Unknown prompt: assume it may be a secret (one-time codes, passwords).
    secret: true,
    confirmLabel: 'Continue'
  }
}
