// Commit form at the bottom of the staging area.
import { useEffect, useRef, type KeyboardEvent } from 'react'
import type { Status } from '@shared/types'
import { WIP, useStore } from '../../store'
import { git } from '../../lib/git'
import { EMPTY_DRAFT, clearDraft, patchDraft, useDrafts } from './commitDraft'
import { SUMMARY_SOFT_LIMIT, buildCommitMessage, messageToFields } from './commitMessage'
import { plural } from './common'

type Action = 'commit' | 'amend' | 'stage-all-commit' | null

const isClean = (s: Status) => s.staged.length + s.unstaged.length + s.conflicted.length === 0

export function CommitForm({ repo, status }: { repo: string; status: Status }) {
  const draft = useDrafts((s) => s.drafts[repo]) ?? EMPTY_DRAFT
  const busy = useStore((s) => s.busy !== null)
  const headCommit = useStore((s) => (status.head ? s.commits.find((c) => c.hash === status.head) : undefined))
  const descRef = useRef<HTMLTextAreaElement>(null)
  const { summary, description } = draft

  const staged = status.staged.length
  const unstaged = status.unstaged.length
  const conflicts = status.conflicted.length
  const canAmend = !!headCommit && !status.inProgress
  // A ticked box only counts while amending is actually possible
  const amend = draft.amend && canAmend && draft.amendHead === status.head
  // HEAD moved (pull, checkout, a commit made elsewhere) after Amend was ticked:
  // untick it, or the old commit's message would be applied to another commit
  useEffect(() => {
    if (draft.amend && status.head && draft.amendHead !== status.head) {
      patchDraft(repo, {
        amend: false,
        amendHead: undefined,
        saved: null,
        summary: draft.saved?.summary ?? '',
        description: draft.saved?.description ?? ''
      })
    }
  }, [repo, status.head, draft.amend, draft.amendHead, draft.saved])

  const action: Action =
    conflicts > 0 ? null : amend ? 'amend' : staged > 0 ? 'commit' : unstaged > 0 ? 'stage-all-commit' : null
  const hasSummary = summary.trim().length > 0
  const enabled = action !== null && hasSummary && !busy

  const label =
    conflicts > 0
      ? 'Resolve conflicts first'
      : action === 'amend'
        ? staged > 0
          ? `Amend with changes to ${plural(staged, 'file', 'files')}`
          : 'Amend last commit message'
        : action === 'commit'
          ? `Commit changes to ${plural(staged, 'file', 'files')}`
          : action === 'stage-all-commit'
            ? 'Stage all changes and commit'
            : 'Stage changes to commit'

  const hint =
    action !== null && !hasSummary
      ? 'Type a commit summary to commit'
      : action === 'stage-all-commit'
        ? `Nothing is staged: ${plural(unstaged, 'file', 'files')} will be staged and committed`
        : undefined

  const toggleAmend = (on: boolean) => {
    if (on) {
      if (!headCommit) return
      patchDraft(repo, {
        amend: true,
        amendHead: headCommit.hash,
        saved: { summary, description },
        ...messageToFields(headCommit.subject, headCommit.body)
      })
    } else {
      patchDraft(repo, {
        amend: false,
        amendHead: undefined,
        saved: null,
        summary: draft.saved?.summary ?? '',
        description: draft.saved?.description ?? ''
      })
    }
  }

  const submit = async () => {
    if (!enabled) return
    const message = buildCommitMessage(summary, description)
    const ok = await useStore.getState().run(
      amend ? 'Amend' : 'Commit',
      async (r) => {
        if (action === 'stage-all-commit') await git.stageAll(r)
        await git.commit(r, message, amend ? { amend: true } : undefined)
      },
      amend ? 'Commit amended' : 'Commit created'
    )
    if (!ok) return
    clearDraft(repo)
    // Like after any commit: jump from the (now empty) WIP node to the new HEAD
    const s = useStore.getState()
    if (s.activeRepo !== repo || !s.status?.head || !isClean(s.status)) return
    if (s.selected === WIP || s.selected === null) s.select(s.status.head)
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      void submit()
    }
  }

  const over = summary.length > SUMMARY_SOFT_LIMIT

  return (
    <div className="cf" onKeyDown={onKeyDown}>
      <div className="cf-top">
        <label className={`cf-amend${canAmend ? '' : ' disabled'}`} title="Amend the previous commit instead of creating a new one">
          <input type="checkbox" checked={amend} disabled={!canAmend || busy} onChange={(e) => toggleAmend(e.target.checked)} />
          Amend
        </label>
        <span className="cf-title">{amend ? 'Amend previous commit' : 'Commit message'}</span>
      </div>
      <div className="cf-summary">
        <input
          value={summary}
          placeholder="Summary"
          spellCheck={false}
          onChange={(e) => patchDraft(repo, { summary: e.target.value.replace(/[\r\n]+/g, ' ') })}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.metaKey && !e.ctrlKey) {
              e.preventDefault()
              descRef.current?.focus()
            }
          }}
        />
        <span
          className={`cf-count${over ? ' over' : ''}`}
          title={`Summaries of up to ${SUMMARY_SOFT_LIMIT} characters are recommended`}
        >
          {summary.length}/{SUMMARY_SOFT_LIMIT}
        </span>
      </div>
      <textarea
        ref={descRef}
        value={description}
        placeholder="Description"
        spellCheck={false}
        rows={4}
        onChange={(e) => patchDraft(repo, { description: e.target.value })}
      />
      {hint && <div className="cf-hint">{hint}</div>}
      <button
        className="btn btn-primary cf-submit"
        disabled={!enabled}
        title={enabled ? `${label} (${window.bridge.platform === 'darwin' ? '⌘' : 'Ctrl'}+Enter)` : undefined}
        onClick={() => void submit()}
      >
        {label}
      </button>
    </div>
  )
}
