// Sidebar sections rendered last: PULL REQUESTS (MERGE REQUESTS on GitLab) and ISSUES.
import { useCallback, useEffect, useRef, useState, type MouseEvent, type ReactNode } from 'react'
import { CircleDot, GitPullRequest, GitPullRequestDraft, LoaderCircle, Plug, Plus, RefreshCw, TriangleAlert } from 'lucide-react'
import type { HostedRepo, Issue, PullRequest } from '@shared/types'
import { git } from '../../lib/git'
import { useStore } from '../../store'
import { confirmDialog, showContextMenu, toast } from '../ui/overlays'
import { copyText, errText, run } from '../toolbar/actions'
import { Chevron } from '../sidebar/Section'
import { CreateIssueDialog, CreatePullRequestDialog } from './CreateDialogs'
import { useHosting } from './state'
import { KIND_LABEL, LIST_LIMIT, ago, branchRef, listUrl, localBranch, matchesIssue, matchesPull, originBranch, prNoun } from './util'
import './hosting.css'

/** Same left padding as the leaf rows of the other sections */
const ROW_PAD = 26
const COLLAPSED_KEY = 'gitkroken.hosting.collapsed'

const openInBrowser = (url: string): void => {
  git.openExternal(url).catch((e) => toast(errText(e), 'error'))
}

// --- collapsed state (own storage key: the sidebar's hook keeps a private copy of its set) ------------

function useCollapsed(): { isCollapsed: (key: string) => boolean; toggle: (key: string) => void } {
  const [collapsed, setCollapsed] = useState<string[]>(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem(COLLAPSED_KEY) ?? '[]')
      return Array.isArray(raw) ? raw.filter((k): k is string => typeof k === 'string') : []
    } catch {
      return []
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(COLLAPSED_KEY, JSON.stringify(collapsed))
    } catch {
      /* storage unavailable: the state just is not persisted */
    }
  }, [collapsed])
  const toggle = useCallback((key: string) => setCollapsed((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key])), [])
  return { isCollapsed: (key) => collapsed.includes(key), toggle }
}

// --- data ---------------------------------------------------------------------------------------

/**
 * The hosted repository behind `origin` of the active repo. `undefined` while
 * it is not known yet. Re-resolved when the repo, its origin URL or the
 * connected accounts change — not on every store refresh.
 */
function useHostedRepo(): { repo: string | null; hosted: HostedRepo | null | undefined } {
  const repo = useStore((s) => s.activeRepo)
  const loaded = useStore((s) => s.status !== null)
  const originUrl = useStore((s) => s.remotes.find((r) => r.name === 'origin')?.url ?? null)
  const accountsKey = useHosting((s) => s.accounts.map((a) => `${a.id}=${a.username}`).join(','))
  const [resolved, setResolved] = useState<{ repo: string; hosted: HostedRepo | null } | null>(null)

  useEffect(() => {
    if (!repo || !loaded) return
    if (!originUrl) {
      setResolved({ repo, hosted: null })
      return
    }
    let stale = false
    git.hostedRepo(repo).then(
      (hosted) => {
        if (!stale) setResolved({ repo, hosted })
      },
      () => {
        if (!stale) setResolved({ repo, hosted: null })
      }
    )
    return () => {
      stale = true
    }
  }, [repo, loaded, originUrl, accountsKey])

  return { repo, hosted: resolved && resolved.repo === repo ? resolved.hosted : undefined }
}

interface ListState<T> {
  /** What the items belong to; a different key means they are stale */
  key: string | null
  phase: 'loading' | 'ready' | 'error'
  items: T[]
  error?: string
}

/**
 * A remote list that is fetched when `key` changes and on `reload()` only.
 * Responses that arrive after the key changed (another repo, another account)
 * or after a newer request are dropped.
 */
function useRemoteList<T>(key: string | null, repo: string | null, fetcher: (repo: string) => Promise<T[]>): ListState<T> & { reload: () => void } {
  const [state, setState] = useState<ListState<T>>({ key: null, phase: 'loading', items: [] })
  const seq = useRef(0)
  /** The key of the latest render: a `reload` captured earlier (another repo) must not write */
  const liveKey = useRef(key)
  liveKey.current = key

  const reload = useCallback(() => {
    if (!key || !repo || liveKey.current !== key) return
    const mine = ++seq.current
    const current = (): boolean => seq.current === mine && liveKey.current === key
    setState((s) => ({ key, phase: 'loading', items: s.key === key ? s.items : [] }))
    fetcher(repo).then(
      (items) => {
        if (current()) setState({ key, phase: 'ready', items })
      },
      (e) => {
        if (current()) setState({ key, phase: 'error', items: [], error: errText(e) })
      }
    )
  }, [key, repo, fetcher])

  useEffect(() => {
    reload()
    return () => {
      seq.current++ // whatever is in flight belongs to the previous key
    }
  }, [reload])

  if (state.key !== key) return { key, phase: 'loading', items: [], reload }
  return { ...state, reload }
}

const fetchPulls = (repo: string): Promise<PullRequest[]> => git.pullRequests(repo)
const fetchIssues = (repo: string): Promise<Issue[]> => git.issues(repo)

// --- pieces -------------------------------------------------------------------------------------

function HoSection(props: {
  icon: ReactNode
  title: string
  count: number | string
  open: boolean
  onToggle: () => void
  loading?: boolean
  onRefresh?: () => void
  onAdd?: () => void
  addTitle?: string
  children: ReactNode
}) {
  const stop = (fn?: () => void) => (e: MouseEvent) => {
    e.stopPropagation()
    fn?.()
  }
  return (
    <section className="sb-section">
      <div className="sb-head" onClick={props.onToggle}>
        <Chevron open={props.open} />
        <span className="sb-head-icon">{props.icon}</span>
        <span className="sb-head-title ho-head-title">{props.title}</span>
        {props.onRefresh && (
          <button className={`sb-add ho-refresh${props.loading ? ' ho-spin' : ''}`} title="Refresh" disabled={props.loading} onClick={stop(props.onRefresh)}>
            <RefreshCw size={13} />
          </button>
        )}
        <span className="sb-count">{props.count}</span>
        {props.onAdd && (
          <button className="sb-add" title={props.addTitle} onClick={stop(props.onAdd)}>
            <Plus size={14} />
          </button>
        )}
      </div>
      {props.open && props.children}
    </section>
  )
}

/** Loading / error / empty / truncated states shared by both lists */
function ListBody<T>(props: {
  list: ListState<T> & { reload: () => void }
  shown: T[]
  filtering: boolean
  emptyText: string
  moreUrl: string
  render: (item: T) => ReactNode
}) {
  const { list, shown } = props
  if (list.phase === 'error') {
    return (
      <div className="ho-state ho-state-error">
        <TriangleAlert size={13} />
        <div>
          <div className="ho-state-text">{list.error}</div>
          <button className="ho-link" onClick={list.reload}>
            Retry
          </button>
          <button className="ho-link" onClick={() => useHosting.getState().openDialog()}>
            Accounts…
          </button>
        </div>
      </div>
    )
  }
  if (list.phase === 'loading' && list.items.length === 0) {
    return (
      <div className="ho-state">
        <LoaderCircle size={13} className="ho-spin" /> Loading…
      </div>
    )
  }
  return (
    <>
      {shown.length === 0 && <div className="sb-empty">{props.filtering && list.items.length > 0 ? 'No matches' : props.emptyText}</div>}
      {shown.map(props.render)}
      {list.items.length >= LIST_LIMIT && (
        <button className="sb-more ho-more" title={props.moreUrl} onClick={() => openInBrowser(props.moreUrl)}>
          Showing only the {LIST_LIMIT} most recently updated. View all in browser
        </button>
      )}
    </>
  )
}

// --- sections -----------------------------------------------------------------------------------

/** Sidebar sections rendered last: PULL REQUESTS, ISSUES */
export function HostingSections(props: { filter: string }) {
  const { repo, hosted } = useHostedRepo()
  const select = useStore((s) => s.select)
  const selected = useStore((s) => s.selected)
  const refs = useStore((s) => s.refs)
  const { isCollapsed, toggle } = useCollapsed()
  /** Last clicked row; highlighted while its commit stays selected */
  const [activeKey, setActiveKey] = useState<string | null>(null)
  const [creating, setCreating] = useState<'pr' | 'issue' | null>(null)

  const account = hosted?.account ?? null
  const key = repo && hosted && account ? [repo, hosted.kind, hosted.host, hosted.owner, hosted.name, account.id, account.username].join('|') : null
  const pulls = useRemoteList(key, repo, fetchPulls)
  const issues = useRemoteList(key, repo, fetchIssues)

  // A dialog of one repository must not outlive a switch to another.
  useEffect(() => setCreating(null), [key])

  if (!repo || !hosted) return null

  const provider = KIND_LABEL[hosted.kind]
  const noun = prNoun(hosted.kind)
  const q = props.filter.trim().toLowerCase()
  const filtering = q !== ''
  const isOpen = (id: string) => filtering || !isCollapsed(id)

  if (!account) {
    const defaultHost = hosted.host === 'github.com' || hosted.host === 'gitlab.com'
    return (
      <HoSection
        icon={<GitPullRequest size={14} />}
        title="PULL REQUESTS & ISSUES"
        count=""
        open={isOpen('section:connect')}
        onToggle={() => toggle('section:connect')}
      >
        <div
          className="sb-row ho-connect"
          style={{ paddingLeft: ROW_PAD }}
          title={`${hosted.owner}/${hosted.name} is hosted on ${provider} (${hosted.host}). Connect an account to see its ${noun}s and issues.`}
          onClick={() => useHosting.getState().openDialog({ kind: hosted.kind, host: hosted.host })}
        >
          <span className="sb-icon">
            <Plug size={14} />
          </span>
          <span className="sb-label">
            Connect to {provider}
            {defaultHost ? '' : ` (${hosted.host})`}…
          </span>
        </div>
      </HoSection>
    )
  }

  const count = (list: ListState<unknown>, shown: number): number | string => {
    if (list.phase === 'error') return '!'
    if (list.phase === 'loading' && list.items.length === 0) return '…'
    // A full page means there may be more on the server.
    return !filtering && list.items.length >= LIST_LIMIT ? `${shown}+` : shown
  }

  const shownPulls = pulls.items.filter((p) => matchesPull(p, q))
  const shownIssues = issues.items.filter((i) => matchesIssue(i, q))

  const pickPull = (pr: PullRequest, announce: boolean) => {
    const ref = branchRef(refs, pr.sourceBranch)
    setActiveKey(`pr:${pr.number}`)
    if (ref) select(ref.hash)
    else if (announce) {
      toast(
        pr.sourceBranch.includes(':')
          ? `#${pr.number} comes from a fork (${pr.sourceBranch}): its branch is not in this repository.`
          : `The branch "${pr.sourceBranch}" is not in this repository yet. Fetch to get it.`
      )
    }
  }

  const pullMenu = (e: MouseEvent, pr: PullRequest) => {
    const local = localBranch(refs, pr.sourceBranch)
    const remote = originBranch(refs, pr.sourceBranch)
    const checkoutRef = local?.name ?? remote?.name
    pickPull(pr, false)
    showContextMenu(e, [
      { label: 'Open in browser', onClick: () => openInBrowser(pr.url) },
      {
        label: checkoutRef ? `Checkout branch ${pr.sourceBranch}` : 'Checkout branch (not in this repository)',
        onClick: () => checkoutRef && void run('Checkout', (r) => git.checkout(r, checkoutRef)),
        disabled: !checkoutRef || local?.isCurrent === true
      },
      { separator: true },
      { label: 'Copy link', onClick: () => void copyText(pr.url) },
      { label: 'Copy branch name', onClick: () => void copyText(pr.sourceBranch) }
    ])
  }

  const issueMenu = (e: MouseEvent, issue: Issue) => {
    setActiveKey(`issue:${issue.number}`)
    showContextMenu(e, [
      { label: 'Open in browser', onClick: () => openInBrowser(issue.url) },
      { label: 'Copy link', onClick: () => void copyText(issue.url) }
    ])
  }

  const created = async (what: string, item: { number: number; title: string; url: string }, reload: () => void) => {
    setCreating(null)
    reload()
    const yes = await confirmDialog({
      title: `${what} #${item.number}`,
      message: `${item.title}\n\nDo you want to open it in the browser?`,
      confirmLabel: 'Open in browser'
    })
    if (yes) openInBrowser(item.url)
  }

  const renderPull = (pr: PullRequest) => {
    const ref = branchRef(refs, pr.sourceBranch)
    const active = activeKey === `pr:${pr.number}` && (ref ? selected === ref.hash : true)
    return (
      <div
        key={pr.number}
        className={`sb-row ho-row${active ? ' active' : ''}`}
        style={{ paddingLeft: ROW_PAD }}
        title={`#${pr.number} ${pr.title}\n${pr.author ? `@${pr.author} · ` : ''}${pr.sourceBranch} → ${pr.targetBranch}${pr.draft ? ' · draft' : ''}${pr.updatedAt ? `\nUpdated ${ago(pr.updatedAt)}` : ''}\nDouble-click to open in browser`}
        onClick={(e) => pickPull(pr, e.detail === 1)}
        onDoubleClick={() => openInBrowser(pr.url)}
        onContextMenu={(e) => pullMenu(e, pr)}
      >
        <span className={`sb-icon ho-icon-pr${pr.draft ? ' ho-draft' : ''}`}>{pr.draft ? <GitPullRequestDraft size={14} /> : <GitPullRequest size={14} />}</span>
        <span className="ho-row-main">
          <span className="ho-row-line">
            <span className="ho-num">#{pr.number}</span>
            <span className="ho-row-title">{pr.title}</span>
            {pr.draft && <span className="ho-badge">Draft</span>}
          </span>
          <span className="ho-row-line ho-row-sub">
            {pr.author && <span className="ho-author">{pr.author}</span>}
            <span className="ho-branches-text">
              <span className="ho-branch">{pr.sourceBranch}</span> → <span className="ho-branch">{pr.targetBranch}</span>
            </span>
          </span>
        </span>
      </div>
    )
  }

  const renderIssue = (issue: Issue) => (
    <div
      key={issue.number}
      className={`sb-row ho-row${activeKey === `issue:${issue.number}` ? ' active' : ''}`}
      style={{ paddingLeft: ROW_PAD }}
      title={`#${issue.number} ${issue.title}${issue.author ? `\n@${issue.author}` : ''}${issue.labels.length ? `\n${issue.labels.join(', ')}` : ''}${issue.updatedAt ? `\nUpdated ${ago(issue.updatedAt)}` : ''}\nDouble-click to open in browser`}
      onClick={() => setActiveKey(`issue:${issue.number}`)}
      onDoubleClick={() => openInBrowser(issue.url)}
      onContextMenu={(e) => issueMenu(e, issue)}
    >
      <span className="sb-icon ho-icon-issue">
        <CircleDot size={14} />
      </span>
      <span className="ho-row-main">
        <span className="ho-row-line">
          <span className="ho-num">#{issue.number}</span>
          <span className="ho-row-title">{issue.title}</span>
        </span>
        {(issue.author || issue.labels.length > 0) && (
          <span className="ho-row-line ho-row-sub">
            {issue.author && <span className="ho-author">{issue.author}</span>}
            {issue.labels.length > 0 && (
              <span className="ho-labels">
                {issue.labels.map((l) => (
                  <span key={l} className="ho-label">
                    {l}
                  </span>
                ))}
              </span>
            )}
          </span>
        )}
      </span>
    </div>
  )

  return (
    <>
      <HoSection
        icon={<GitPullRequest size={14} />}
        title={hosted.kind === 'gitlab' ? 'MERGE REQUESTS' : 'PULL REQUESTS'}
        count={count(pulls, shownPulls.length)}
        open={isOpen('section:pulls')}
        onToggle={() => toggle('section:pulls')}
        loading={pulls.phase === 'loading'}
        onRefresh={pulls.reload}
        onAdd={() => setCreating('pr')}
        addTitle={hosted.kind === 'gitlab' ? 'Create Merge Request' : 'Create Pull Request'}
      >
        <ListBody
          list={pulls}
          shown={shownPulls}
          filtering={filtering}
          emptyText={`No open ${noun}s`}
          moreUrl={listUrl(hosted, 'pulls')}
          render={renderPull}
        />
      </HoSection>

      <HoSection
        icon={<CircleDot size={14} />}
        title="ISSUES"
        count={count(issues, shownIssues.length)}
        open={isOpen('section:issues')}
        onToggle={() => toggle('section:issues')}
        loading={issues.phase === 'loading'}
        onRefresh={issues.reload}
        onAdd={() => setCreating('issue')}
        addTitle="Create Issue"
      >
        <ListBody
          list={issues}
          shown={shownIssues}
          filtering={filtering}
          emptyText="No open issues"
          moreUrl={listUrl(hosted, 'issues')}
          render={renderIssue}
        />
      </HoSection>

      {creating === 'pr' && (
        <CreatePullRequestDialog
          repo={repo}
          hosted={hosted}
          onClose={() => setCreating(null)}
          onCreated={(pr) =>
            void created(hosted.kind === 'gitlab' ? 'Merge request created:' : 'Pull request created:', pr, pulls.reload)
          }
        />
      )}
      {creating === 'issue' && (
        <CreateIssueDialog
          repo={repo}
          hosted={hosted}
          onClose={() => setCreating(null)}
          onCreated={(issue) => void created('Issue created:', issue, issues.reload)}
        />
      )}
    </>
  )
}
