// "Profiles & Accounts": commit identities and the GitHub / GitLab accounts.
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { Check, ExternalLink, Github, Gitlab, Pencil, Plus, Trash2, UserRound } from 'lucide-react'
import type { Account, HostKind, Profile } from '@shared/types'
import { git } from '../../lib/git'
import { confirmDialog, toast } from '../ui/overlays'
import { errText } from '../toolbar/actions'
import { Modal } from './Modal'
import { useHosting, type ConnectRequest } from './state'
import { DEFAULT_HOST, KIND_LABEL, SCOPE_NOTE, cleanHost, initials, tokenPageUrl, validateProfile, type ProfileDraft } from './util'

export const KindIcon = ({ kind, size = 15 }: { kind: HostKind; size?: number }) =>
  kind === 'github' ? <Github size={size} /> : <Gitlab size={size} />

// --- profiles ----------------------------------------------------------------------------------

function ProfileForm(props: { initial: Profile | null; onDone: () => void }) {
  const [draft, setDraft] = useState<ProfileDraft>({
    name: props.initial?.name ?? '',
    userName: props.initial?.userName ?? '',
    userEmail: props.initial?.userEmail ?? ''
  })
  const [submitted, setSubmitted] = useState(false)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const errors = validateProfile(draft)
  const show = (field: keyof ProfileDraft) => (submitted && errors[field] ? <div className="ho-field-error">{errors[field]}</div> : null)
  const set = (field: keyof ProfileDraft) => (e: { target: { value: string } }) => setDraft({ ...draft, [field]: e.target.value })

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    setSubmitted(true)
    if (Object.keys(errors).length > 0 || saving) return
    setSaving(true)
    setError(null)
    try {
      await git.saveProfile({
        id: props.initial?.id,
        name: draft.name.trim(),
        userName: draft.userName.trim(),
        userEmail: draft.userEmail.trim()
      })
      await useHosting.getState().reload()
      props.onDone()
    } catch (err) {
      setError(errText(err))
      setSaving(false)
    }
  }

  return (
    <form className="ho-form" onSubmit={(e) => void submit(e)} noValidate>
      <div className="ho-form-title">{props.initial ? `Edit "${props.initial.name}"` : 'New profile'}</div>
      <label htmlFor="ho-p-name">Profile name</label>
      <input id="ho-p-name" autoFocus spellCheck={false} placeholder="Work" value={draft.name} onChange={set('name')} />
      {show('name')}
      <div className="ho-form-cols">
        <div>
          <label htmlFor="ho-p-user">Author name (user.name)</label>
          <input id="ho-p-user" spellCheck={false} placeholder="Jane Doe" value={draft.userName} onChange={set('userName')} />
          {show('userName')}
        </div>
        <div>
          <label htmlFor="ho-p-email">Author email (user.email)</label>
          <input id="ho-p-email" spellCheck={false} placeholder="jane@company.com" value={draft.userEmail} onChange={set('userEmail')} />
          {show('userEmail')}
        </div>
      </div>
      {error && <div className="ho-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {props.initial ? 'Save changes' : 'Create profile'}
        </button>
      </div>
    </form>
  )
}

function Profiles() {
  const profiles = useHosting((s) => s.profiles)
  const activeId = useHosting((s) => s.activeId)
  /** `new`, a profile id being edited, or null */
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const activate = async (id: string | null) => {
    if (busy || id === activeId) return
    setBusy(true)
    try {
      await git.activateProfile(id)
      await useHosting.getState().reload()
    } catch (e) {
      toast(errText(e), 'error')
    } finally {
      setBusy(false)
    }
  }

  const remove = async (p: Profile) => {
    const yes = await confirmDialog({
      title: 'Delete profile',
      message:
        `Delete the profile "${p.name}" (${p.userName} <${p.userEmail}>)?` +
        (p.id === activeId ? '\n\nIt is the active profile: commits will go back to using your Git configuration.' : ''),
      confirmLabel: 'Delete',
      danger: true
    })
    if (!yes) return
    try {
      await git.deleteProfile(p.id)
      if (editing === p.id) setEditing(null)
      await useHosting.getState().reload()
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  const editingProfile = editing && editing !== 'new' ? (profiles.find((p) => p.id === editing) ?? null) : null

  return (
    <section className="ho-part">
      <h4>Profiles</h4>
      <p className="ho-note">
        The identity (name and email) of the active profile is used for the commits you make from the app. Your Git configuration is not modified.
      </p>
      <div className="ho-list" role="radiogroup" aria-label="Active profile">
        <div className={`ho-item${activeId === null ? ' on' : ''}`}>
          <button type="button" role="radio" aria-checked={activeId === null} className="ho-item-main" onClick={() => void activate(null)}>
            <span className="ho-radio">{activeId === null && <Check size={11} />}</span>
            <span className="ho-avatar ho-avatar-none">
              <UserRound size={13} />
            </span>
            <span className="ho-item-text">
              <span className="ho-item-name">Use the Git configuration</span>
              <span className="ho-item-sub">No profile: user.name and user.email from your gitconfig</span>
            </span>
          </button>
        </div>
        {profiles.map((p) => (
          <div key={p.id} className={`ho-item${activeId === p.id ? ' on' : ''}`}>
            <button type="button" role="radio" aria-checked={activeId === p.id} className="ho-item-main" onClick={() => void activate(p.id)}>
              <span className="ho-radio">{activeId === p.id && <Check size={11} />}</span>
              <span className="ho-avatar">{initials(p.name)}</span>
              <span className="ho-item-text">
                <span className="ho-item-name">{p.name}</span>
                <span className="ho-item-sub">
                  {p.userName} &lt;{p.userEmail}&gt;
                </span>
              </span>
            </button>
            <button type="button" className="ho-icon-btn" title={`Edit "${p.name}"`} onClick={() => setEditing(p.id)}>
              <Pencil size={13} />
            </button>
            <button type="button" className="ho-icon-btn ho-danger" title={`Delete "${p.name}"`} onClick={() => void remove(p)}>
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      {editing === null ? (
        <button type="button" className="btn ho-btn-sm" onClick={() => setEditing('new')}>
          <Plus size={13} /> New profile
        </button>
      ) : (
        <ProfileForm key={editing} initial={editingProfile} onDone={() => setEditing(null)} />
      )}
    </section>
  )
}

// --- accounts ----------------------------------------------------------------------------------

function ConnectForm(props: { request: ConnectRequest; onDone: () => void }) {
  const { kind } = props.request
  const provider = KIND_LABEL[kind]
  const [host, setHost] = useState(props.request.host ?? DEFAULT_HOST[kind])
  const [token, setToken] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  useEffect(() => {
    // Set here too: StrictMode and Fast Refresh run the cleanup and then the effect again.
    alive.current = true
    return () => {
      alive.current = false
    }
  }, [])

  const openTokenPage = () => {
    const clean = cleanHost(host)
    if (!clean) {
      setError('Enter a valid host first, for example "gitlab.mycompany.com".')
      return
    }
    git.openExternal(tokenPageUrl(kind, clean)).catch((e) => toast(errText(e), 'error'))
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!cleanHost(host)) {
      setError('Invalid host: enter just the host name, for example "gitlab.mycompany.com".')
      return
    }
    if (!token.trim()) {
      setError('Paste the personal access token.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const account = await git.addAccount(kind, host, token)
      // The token lives in the main process from here on; drop this copy.
      setToken('')
      await useHosting.getState().reload()
      toast(`Connected to ${provider} as @${account.username} (${account.host})`, 'success')
      if (alive.current) props.onDone()
    } catch (err) {
      if (alive.current) {
        setError(errText(err))
        setBusy(false)
      }
    }
  }

  return (
    <form className="ho-form" onSubmit={(e) => void submit(e)} noValidate>
      <div className="ho-form-title">
        <KindIcon kind={kind} /> Connect to {provider}
      </div>
      <label htmlFor="ho-a-host">Host</label>
      <input
        id="ho-a-host"
        spellCheck={false}
        autoCapitalize="off"
        placeholder={DEFAULT_HOST[kind]}
        value={host}
        onChange={(e) => setHost(e.target.value)}
      />
      <label htmlFor="ho-a-token">Personal access token</label>
      <input
        id="ho-a-token"
        type="password"
        autoFocus
        autoComplete="off"
        spellCheck={false}
        placeholder={kind === 'github' ? 'ghp_…' : 'glpat-…'}
        value={token}
        onChange={(e) => setToken(e.target.value)}
      />
      <p className="ho-note">
        {SCOPE_NOTE[kind]} The token is stored encrypted with the system keychain and is only ever sent to that host, over HTTPS.
      </p>
      <button type="button" className="ho-link" onClick={openTokenPage}>
        <ExternalLink size={12} /> Generate a token on {provider}
      </button>
      {error && <div className="ho-error">{error}</div>}
      <div className="modal-actions">
        <button type="button" className="btn" onClick={props.onDone}>
          Cancel
        </button>
        <button type="submit" className="btn btn-primary" disabled={busy}>
          {busy ? 'Checking the token…' : 'Connect'}
        </button>
      </div>
    </form>
  )
}

function Accounts(props: { initial?: ConnectRequest }) {
  const accounts = useHosting((s) => s.accounts)
  const [connecting, setConnecting] = useState<ConnectRequest | null>(props.initial ?? null)

  const remove = async (a: Account) => {
    const yes = await confirmDialog({
      title: 'Disconnect account',
      message: `Disconnect the ${KIND_LABEL[a.kind]} account @${a.username} (${a.host})?\n\nThe token stored on this computer is deleted. The token itself still exists on ${KIND_LABEL[a.kind]}: revoke it there if you no longer need it.`,
      confirmLabel: 'Disconnect',
      danger: true
    })
    if (!yes) return
    try {
      await git.removeAccount(a.id)
      await useHosting.getState().reload()
      toast(`Disconnected @${a.username} (${a.host})`, 'success')
    } catch (e) {
      toast(errText(e), 'error')
    }
  }

  return (
    <section className="ho-part">
      <h4>Accounts</h4>
      <p className="ho-note">Connect GitHub or GitLab to list and create pull requests and issues, and to authenticate Git over HTTPS.</p>
      <div className="ho-list">
        {accounts.length === 0 && <div className="ho-empty">No accounts connected.</div>}
        {accounts.map((a) => (
          <div key={a.id} className="ho-item">
            <div className="ho-item-main ho-static">
              <span className="ho-kind">
                <KindIcon kind={a.kind} />
              </span>
              <span className="ho-item-text">
                <span className="ho-item-name">
                  {KIND_LABEL[a.kind]} <span className="ho-dim">· {a.host}</span>
                </span>
                <span className="ho-item-sub">
                  @{a.username}
                  {a.name ? ` — ${a.name}` : ''}
                </span>
              </span>
            </div>
            <button
              type="button"
              className="ho-icon-btn ho-danger"
              title={`Disconnect @${a.username} (${a.host})`}
              onClick={() => void remove(a)}
            >
              <Trash2 size={13} />
            </button>
          </div>
        ))}
      </div>
      {connecting ? (
        <ConnectForm key={`${connecting.kind}:${connecting.host ?? ''}`} request={connecting} onDone={() => setConnecting(null)} />
      ) : (
        <div className="ho-btn-row">
          <button type="button" className="btn ho-btn-sm" onClick={() => setConnecting({ kind: 'github' })}>
            <Github size={13} /> Connect to GitHub
          </button>
          <button type="button" className="btn ho-btn-sm" onClick={() => setConnecting({ kind: 'gitlab' })}>
            <Gitlab size={13} /> Connect to GitLab
          </button>
        </div>
      )}
    </section>
  )
}

export function AccountsDialog() {
  const dialog = useHosting((s) => s.dialog)
  const error = useHosting((s) => s.error)
  const close = useHosting((s) => s.closeDialog)

  useEffect(() => {
    if (dialog) void useHosting.getState().reload()
  }, [dialog])

  if (!dialog) return null
  return (
    <Modal title="Profiles & Accounts" wide onClose={close}>
      {error && <div className="ho-error">{error}</div>}
      <div className="ho-parts">
        <Profiles />
        <Accounts initial={dialog.connect} />
      </div>
      <div className="modal-actions">
        <button type="button" className="btn" onClick={close}>
          Close
        </button>
      </div>
    </Modal>
  )
}
