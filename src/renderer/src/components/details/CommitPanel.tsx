// Commit mode of the right panel: metadata of the selected commit and the
// list of files it changed.
import { useEffect, useState, type MouseEvent } from 'react'
import { Archive, Cloud, Copy, FolderTree, GitBranch, List, Tag } from 'lucide-react'
import type { Commit, CommitDetails, FileChange, Ref } from '@shared/types'
import { useStore } from '../../store'
import { git } from '../../lib/git'
import { showContextMenu, toast } from '../ui/overlays'
import { FILE_VIEWS, FILE_VIEW_KEY, FileList, type FileViewMode } from './FileList'
import { Segmented, copyText, plural, readPref, writePref } from './common'
import { hueOf, initials, relativeTime } from './commitMessage'
import { openBlame, openFileHistory } from '../history/entry'

const errText = (e: unknown) =>
  (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '')

// Commits are immutable, so their details can be cached for the session
const cache = new Map<string, CommitDetails>()
const CACHE_MAX = 200
const cacheKey = (repo: string, hash: string) => `${repo}\0${hash}`
function remember(key: string, details: CommitDetails): void {
  cache.delete(key)
  cache.set(key, details)
  if (cache.size > CACHE_MAX) cache.delete(cache.keys().next().value as string)
}

const dateFmt = new Intl.DateTimeFormat('en', { dateStyle: 'medium', timeStyle: 'short' })

const REF_ICON = { head: GitBranch, remote: Cloud, tag: Tag, stash: Archive } as const

interface State {
  key: string
  details: CommitDetails | null
  error: string | null
}

export function CommitPanel({ repo, hash }: { repo: string; hash: string }) {
  const known = useStore((s) => s.commits.find((c) => c.hash === hash))
  const refs = useStore((s) => s.refs)
  const selectedFile = useStore((s) => s.selectedFile)
  const key = cacheKey(repo, hash)
  const [state, setState] = useState<State>(() => ({ key, details: cache.get(key) ?? null, error: null }))
  const [view, setViewState] = useState<FileViewMode>(() => readPref(FILE_VIEW_KEY, FILE_VIEWS, 'path'))
  const setView = (v: FileViewMode) => {
    setViewState(v)
    writePref(FILE_VIEW_KEY, v)
  }

  useEffect(() => {
    const hit = cache.get(key)
    setState({ key, details: hit ?? null, error: null })
    if (hit) return
    // A fast run of selections must not let an older answer overwrite a newer one
    let cancelled = false
    git.commitDetails(repo, hash).then(
      (details) => {
        remember(key, details)
        if (!cancelled) setState({ key, details, error: null })
      },
      (e) => {
        if (!cancelled) setState({ key, details: null, error: errText(e) })
      }
    )
    return () => {
      cancelled = true
    }
  }, [key, repo, hash])

  // `state` may still belong to the previous selection during the first render
  const current = state.key === key ? state : { key, details: cache.get(key) ?? null, error: null }
  const commit: Commit | undefined = current.details?.commit ?? known
  const files = current.details?.files ?? null
  const { select, selectFile } = useStore.getState()

  const menu = (e: MouseEvent, file: FileChange) =>
    showContextMenu(e, [
      { label: 'View changes', onClick: () => selectFile({ path: file.path, oldPath: file.oldPath, commit: hash }) },
      { label: 'File History', onClick: () => openFileHistory({ path: file.path, commit: hash, status: file.status }) },
      { label: 'Blame', onClick: () => openBlame({ path: file.path, commit: hash, status: file.status }) },
      { separator: true },
      { label: 'Copy path', onClick: () => copyText(file.path, 'Path') },
      {
        label: window.bridge.platform === 'darwin' ? 'Reveal in Finder' : 'Show in file manager',
        disabled: file.status === 'deleted',
        onClick: () => {
          git.reveal(`${repo}/${file.path}`).catch((err) => toast(errText(err), 'error'))
        }
      }
    ])

  return (
    <div className="rp-commit">
      <div className="rp-head">
        <span className="rp-head-label">{commit?.isStash ? 'stash' : 'commit'}</span>
        <button className="rp-sha" title="Copy the full SHA" onClick={() => copyText(hash, 'SHA')}>
          {hash.slice(0, 7)}
          <Copy size={11} />
        </button>
        <span className="rp-spring" />
      </div>

      {commit ? (
        <CommitMeta commit={commit} refs={refs.filter((r) => r.hash === hash)} onParent={select} />
      ) : (
        !current.error && <div className="rp-loading">Loading commit…</div>
      )}

      <div className="rp-files-head">
        <span className="rp-section-title">
          {files ? plural(files.length, 'file changed', 'files changed') : 'Files changed'}
        </span>
        <span className="rp-spring" />
        <Segmented
          value={view}
          onChange={setView}
          options={[
            { value: 'path', label: 'Path', icon: <List size={12} />, title: 'Flat list of paths' },
            { value: 'tree', label: 'Tree', icon: <FolderTree size={12} />, title: 'Folder tree' }
          ]}
        />
      </div>
      <div className="rp-files">
        {current.error ? (
          <div className="rp-error">Could not load the details: {current.error}</div>
        ) : !files ? (
          <div className="rp-loading">Loading files…</div>
        ) : (
          <FileList
            key={key}
            files={files}
            view={view}
            emptyText="This commit does not change any file"
            isSelected={(f) => selectedFile?.commit === hash && selectedFile.path === f.path}
            onOpen={(f) => selectFile({ path: f.path, oldPath: f.oldPath, commit: hash })}
            onContextMenu={menu}
          />
        )}
      </div>
    </div>
  )
}

function CommitMeta(props: { commit: Commit; refs: Ref[]; onParent: (hash: string) => void }) {
  const { commit, refs } = props
  const body = commit.body?.trim()
  return (
    <div className="rp-meta">
      <div className="rp-subject">{commit.subject}</div>
      {body && <div className="rp-body">{body}</div>}

      {refs.length > 0 && (
        <div className="rp-refs">
          {refs.map((r) => {
            const Icon = REF_ICON[r.type] ?? GitBranch
            return (
              <span
                key={r.type + r.name}
                className={`rp-ref rp-ref-${r.type}${r.isCurrent ? ' current' : ''}`}
                title={r.isCurrent ? `${r.name} (current branch)` : r.name}
              >
                <Icon size={11} />
                {r.name}
              </span>
            )
          })}
        </div>
      )}

      <div className="rp-author">
        <span
          className="rp-avatar"
          style={{ background: `hsl(${hueOf(commit.email || commit.author)} 42% 40%)` }}
          aria-hidden
        >
          {initials(commit.author)}
        </span>
        <div className="rp-author-text">
          <div className="rp-author-name" title={commit.email}>
            {commit.author}
          </div>
          <div className="rp-author-date">
            {dateFmt.format(new Date(commit.date * 1000))} · {relativeTime(commit.date, Date.now() / 1000, 'en')}
          </div>
        </div>
      </div>

      <div className="rp-parents">
        <span className="rp-parents-label">
          {commit.parents.length === 0 ? 'Root commit (no parents)' : commit.parents.length === 1 ? 'Parent:' : 'Parents:'}
        </span>
        {commit.parents.map((p) => (
          <button key={p} className="rp-parent" title={`Go to commit ${p}`} onClick={() => props.onParent(p)}>
            {p.slice(0, 7)}
          </button>
        ))}
      </div>
    </div>
  )
}
