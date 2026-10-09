import { describe, expect, it } from 'vitest'
import type { CredentialRequest } from '@shared/types'
import { describeCredential } from './prompt'

const req = (r: Omit<CredentialRequest, 'id'>): CredentialRequest => ({ id: 'x', ...r })

describe('describeCredential', () => {
  it('asks for a user name in a plain field, showing the host and the exact prompt', () => {
    const d = describeCredential(req({ kind: 'username', prompt: "Username for 'https://github.com': ", host: 'github.com' }))
    expect(d).toMatchObject({ mode: 'input', secret: false, label: 'Username' })
    if (d.mode !== 'input') throw new Error('unreachable')
    expect(d.title).toContain('github.com')
    expect(d.message).toContain('Server: github.com')
    expect(d.message).toContain("Username for 'https://github.com':")
  })

  it('asks for passwords, tokens and passphrases in a masked field', () => {
    const pw = describeCredential(
      req({ kind: 'password', prompt: "Password for 'https://ana@gitlab.example.com': ", host: 'gitlab.example.com', username: 'ana' })
    )
    expect(pw).toMatchObject({ mode: 'input', secret: true })
    if (pw.mode !== 'input') throw new Error('unreachable')
    expect(pw.message).toContain('Server: gitlab.example.com')
    expect(pw.message).toContain('User: ana')
    expect(pw.message).toContain("Password for 'https://ana@gitlab.example.com':")
    expect(pw.defaultValue).toBeUndefined()

    const key = describeCredential(req({ kind: 'passphrase', prompt: "Enter passphrase for key '/Users/ana/.ssh/id_ed25519': " }))
    expect(key).toMatchObject({ mode: 'input', secret: true, title: 'SSH key passphrase' })
    if (key.mode !== 'input') throw new Error('unreachable')
    expect(key.message).toBe("Enter passphrase for key '/Users/ana/.ssh/id_ed25519':")
  })

  it('turns the ssh host key question into a yes / no confirmation with the full text', () => {
    const prompt =
      "The authenticity of host 'github.com (140.82.121.4)' can't be established.\n" +
      'ED25519 key fingerprint is SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU.\n' +
      'Are you sure you want to continue connecting (yes/no/[fingerprint])? '
    const d = describeCredential(req({ kind: 'other', prompt, host: 'github.com' }))
    expect(d).toMatchObject({ mode: 'confirm', answer: 'yes' })
    if (d.mode !== 'confirm') throw new Error('unreachable')
    expect(d.title).toContain('github.com')
    expect(d.message).toBe(prompt.trim())
    expect(d.message).toContain('SHA256:+DiY3wvvV6TuJJhbpZisF/zLDA0zPMSvHdkr4UvCOqU')
  })

  it('masks unknown prompts and only notifies for a security key touch', () => {
    expect(describeCredential(req({ kind: 'other', prompt: '(ana@host) Verification code: ', host: 'host', username: 'ana' }))).toMatchObject({
      mode: 'input',
      secret: true
    })
    expect(describeCredential(req({ kind: 'other', prompt: 'Confirm user presence for key ED25519-SK SHA256:abc' }))).toMatchObject({
      mode: 'notice'
    })
  })
})
