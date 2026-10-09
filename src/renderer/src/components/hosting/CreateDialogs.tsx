// "New pull request" and "new issue" forms.
import { useMemo, useState, type FormEvent } from 'react'
import { TriangleAlert, Upload } from 'lucide-react'
import type { HostedRepo, Issue, PullRequest } from '@shared/types'
import { git } from '../../lib/git'
import { useStore } from '../../store'
import { errText, run } from '../toolbar/actions'
import { Modal } from './Modal'
import { KIND_LABEL, branchChoices, prNoun, pushWarning, tipSubject } from './util'

const Target = ({ hosted }: { hosted: HostedRepo }) => (
  <p className="ho-note">
    On {KIND_LABEL[hosted.kind]}: {hosted.owner}/{hosted.name}
    {hosted.account ? ` · as @${hosted.account.username}` : ''}
  </p>
)

export function CreatePullRequestDialog(props: { repo: string; hosted: HostedRepo; onClose: () => void; onCreated: (pr: PullRequest) => void }) {
  const { repo, hosted } = props
  const noun = prNoun(hosted.kind)
  const refs = useStore((s) => s.refs)
  const commits = useStore((s) => s.commits)
  const current = useStore((s) => s.status?.branch ?? null)
  const pushing = useStore((s) => s.busy !== null)

  const choices = useMemo(() => branchChoices(refs, current), [refs, current])
  const [source, setSource] = useState(choices.source)
  const [target, setTarget] = useState(choices.target)
  /** null until the user types: the title then follows the source branch */
  const [typedTitle, setTypedTitle] = useState<string | null>(null)
  const [body, setBody] = useState('')
  const [draft, setDraft] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const title = typedTitle ?? tipSubject(refs, commits, source)
  const warning = pushWarning(refs, source, noun)
  const sameBranch = source !== '' && source === target
  const noBranches = choices.sources.length === 0 || choices.targets.length === 0

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!title.trim()) {
      setError('Enter a title.')
      return
    }
    if (!source || !target) {
      setError('Choose the source and target branches.')
      return
    }
    if (sameBranch) {
      setError('The source and target branches are the same.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const pr = await git.createPullRequest(repo, { title: title.trim(), body: body.trim() || undefined, sourceBranch: source, targetBranch: target, draft })
      props.onCreated(pr)
    } catch (err) {
      setError(errText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title={hosted.kind === 'gitlab' ? 'Create Merge Request' : 'Create Pull Request'} wide onClose={props.onClose}>
      <form className="ho-form ho-form-plain" onSubmit={(e) => void submit(e)} noValidate>
        <Target hosted={hosted} />
        <div className="ho-form-cols ho-branches">
          <div>
            <label htmlFor="ho-pr-source">Source branch</label>
            <select id="ho-pr-source" value={source} onChange={(e) => setSource(e.target.value)}>
              {choices.sources.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
          <span className="ho-arrow">→</span>
          <div>
            <label htmlFor="ho-pr-target">Target branch</label>
            <select id="ho-pr-target" value={target} onChange={(e) => setTarget(e.target.value)}>
              {choices.targets.map((b) => (
                <option key={b} value={b}>
                  {b}
                </option>
              ))}
            </select>
          </div>
        </div>
        {noBranches && <div className="ho-warning">This repository has no branches to create a {noun} between yet.</div>}
        {sameBranch && (
          <div className="ho-warning">
            <TriangleAlert size={14} />
            <span>The source and target branches are the same: choose another one.</span>
          </div>
        )}
        {!sameBranch && warning && (
          <div className="ho-warning">
            <TriangleAlert size={14} />
            <span>{warning.text}</span>
            {warning.canPush && (
              <button
                type="button"
                className="btn ho-btn-sm"
                disabled={pushing}
                onClick={() => void run('Push', (r) => git.push(r, { branch: source }), `Pushed "${source}"`)}
              >
                <Upload size={12} /> {pushing ? 'Pushing…' : 'Push'}
              </button>
            )}
          </div>
        )}
        <label htmlFor="ho-pr-title">Title</label>
        <input id="ho-pr-title" autoFocus value={title} onChange={(e) => setTypedTitle(e.target.value)} />
        <label htmlFor="ho-pr-body">Description (optional)</label>
        <textarea id="ho-pr-body" rows={6} value={body} onChange={(e) => setBody(e.target.value)} />
        <label className="ho-check">
          <input type="checkbox" checked={draft} onChange={(e) => setDraft(e.target.checked)} />
          Create as draft
        </label>
        {error && <div className="ho-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy || noBranches || sameBranch}>
            {busy ? 'Creating…' : hosted.kind === 'gitlab' ? 'Create Merge Request' : 'Create Pull Request'}
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function CreateIssueDialog(props: { repo: string; hosted: HostedRepo; onClose: () => void; onCreated: (issue: Issue) => void }) {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    if (!title.trim()) {
      setError('Enter a title.')
      return
    }
    setBusy(true)
    setError(null)
    try {
      props.onCreated(await git.createIssue(props.repo, { title: title.trim(), body: body.trim() || undefined }))
    } catch (err) {
      setError(errText(err))
      setBusy(false)
    }
  }

  return (
    <Modal title="Create Issue" wide onClose={props.onClose}>
      <form className="ho-form ho-form-plain" onSubmit={(e) => void submit(e)} noValidate>
        <Target hosted={props.hosted} />
        <label htmlFor="ho-is-title">Title</label>
        <input id="ho-is-title" autoFocus value={title} onChange={(e) => setTitle(e.target.value)} />
        <label htmlFor="ho-is-body">Description (optional)</label>
        <textarea id="ho-is-body" rows={8} value={body} onChange={(e) => setBody(e.target.value)} />
        {error && <div className="ho-error">{error}</div>}
        <div className="modal-actions">
          <button type="button" className="btn" onClick={props.onClose}>
            Cancel
          </button>
          <button type="submit" className="btn btn-primary" disabled={busy}>
            {busy ? 'Creating…' : 'Create Issue'}
          </button>
        </div>
      </form>
    </Modal>
  )
}
