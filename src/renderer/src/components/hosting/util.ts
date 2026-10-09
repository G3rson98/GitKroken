// Pure helpers of the hosting UI (no React, no bridge): unit-testable.
import type { Commit, HostKind, HostedRepo, Issue, PullRequest, Ref } from '@shared/types'

/** Same cap as the backend (`LIST_LIMIT` in src/main/git/hosting.ts): a full list may be truncated */
export const LIST_LIMIT = 50

export const KIND_LABEL: Record<HostKind, string> = { github: 'GitHub', gitlab: 'GitLab' }
export const DEFAULT_HOST: Record<HostKind, string> = { github: 'github.com', gitlab: 'gitlab.com' }

/** What a pull request is called on each provider */
export const prNoun = (kind: HostKind): string => (kind === 'gitlab' ? 'merge request' : 'pull request')

export const SCOPE_NOTE: Record<HostKind, string> = {
  github:
    'Create a personal access token (classic) with the "repo" scope. For a fine-grained token, grant read and write access to "Pull requests", "Issues" and "Contents" on the repositories you use.',
  gitlab: 'Create a personal access token with the "api" scope (list and create merge requests and issues, and authenticate Git over HTTPS).'
}

/** `AP` for "Ana Pérez", `W` for "Work" */
export function initials(name: string): string {
  const words = name.trim().split(/[\s._-]+/).filter(Boolean)
  const first = Array.from(words[0] ?? '')[0] ?? ''
  const second = words.length > 1 ? (Array.from(words[words.length - 1] ?? '')[0] ?? '') : ''
  return (first + second).toUpperCase() || '?'
}

/** `https://GitLab.example.com/x` -> `gitlab.example.com`; null when it is not a host name */
export function cleanHost(input: string): string | null {
  let host = input.trim().toLowerCase().replace(/^[a-z][a-z0-9+.-]*:\/\//, '')
  host = host.split(/[/?#\\]/)[0] ?? ''
  host = host.slice(host.lastIndexOf('@') + 1)
  return /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) && !host.includes('..') ? host : null
}

/** Page where the user creates a personal access token, with the needed scope preselected */
export function tokenPageUrl(kind: HostKind, host: string): string {
  if (kind === 'github') return `https://${host}/settings/tokens/new?scopes=repo&description=GitKroken`
  // Older self-hosted GitLab only knows the `profile` path; current versions redirect from it.
  const path = host === 'gitlab.com' ? '/-/user_settings/personal_access_tokens' : '/-/profile/personal_access_tokens'
  return `https://${host}${path}?name=GitKroken&scopes=api`
}

export interface ProfileDraft {
  name: string
  userName: string
  userEmail: string
}

/** Field -> message for whatever is wrong in a profile form (empty object = valid) */
export function validateProfile(draft: ProfileDraft): Partial<Record<keyof ProfileDraft, string>> {
  const errors: Partial<Record<keyof ProfileDraft, string>> = {}
  if (!draft.name.trim()) errors.name = 'Give the profile a name'
  const userName = draft.userName.trim()
  if (!userName) errors.userName = 'Enter the author name to use in commits'
  else if (/[<>\n\r]/.test(userName)) errors.userName = 'It cannot contain "<", ">" or line breaks'
  const email = draft.userEmail.trim()
  if (!email) errors.userEmail = 'Enter the author email to use in commits'
  else if (!/^[^\s@<>]+@[^\s@<>]+$/.test(email)) errors.userEmail = 'The email address is not valid'
  return errors
}

// --- branches ---------------------------------------------------------------------------------

const ORIGIN = 'origin/'

export const localBranch = (refs: Ref[], name: string): Ref | undefined => refs.find((r) => r.type === 'head' && r.name === name)
export const originBranch = (refs: Ref[], name: string): Ref | undefined =>
  refs.find((r) => r.type === 'remote' && r.name === ORIGIN + name)

/** The ref a pull request's source branch can be shown / checked out from: local first, then `origin/<branch>` */
export const branchRef = (refs: Ref[], name: string): Ref | undefined => localBranch(refs, name) ?? originBranch(refs, name)

export interface BranchChoices {
  /** Local branches first, then the ones that only exist on origin */
  sources: string[]
  /** Branches of origin first, then local-only ones */
  targets: string[]
  source: string
  target: string
}

/** Branch lists and defaults for the "new pull request" form */
export function branchChoices(refs: Ref[], current: string | null): BranchChoices {
  const locals = refs.filter((r) => r.type === 'head').map((r) => r.name)
  const remotes = refs.filter((r) => r.type === 'remote' && r.name.startsWith(ORIGIN)).map((r) => r.name.slice(ORIGIN.length))
  const sort = (names: string[]): string[] => [...names].sort((a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }))
  const sources = [...sort(locals), ...sort(remotes.filter((n) => !locals.includes(n)))]
  const targets = [...sort(remotes), ...sort(locals.filter((n) => !remotes.includes(n)))]

  const source = current && sources.includes(current) ? current : (refs.find((r) => r.type === 'head' && r.isCurrent)?.name ?? sources[0] ?? '')
  const wellKnown = ['main', 'master', 'develop', 'trunk']
  const target =
    wellKnown.find((n) => remotes.includes(n)) ?? wellKnown.find((n) => locals.includes(n)) ?? targets.find((n) => n !== source) ?? targets[0] ?? ''
  return { sources, targets, source, target }
}

/** Subject of the commit at the tip of `branch` (among the loaded commits), or '' */
export function tipSubject(refs: Ref[], commits: Commit[], branch: string): string {
  const ref = branchRef(refs, branch)
  return (ref && commits.find((c) => c.hash === ref.hash)?.subject) || ''
}

export interface PushWarning {
  text: string
  /** Offer a "push now" button */
  canPush: boolean
}

/**
 * Why creating a pull request from `source` would miss commits (or fail):
 * the branch is not on origin yet, or the local branch has unpushed commits.
 */
export function pushWarning(refs: Ref[], source: string, noun: string): PushWarning | null {
  const local = localBranch(refs, source)
  if (!local) return null
  const remote = originBranch(refs, source)
  if (!remote) {
    return {
      text: local.upstream
        ? `The branch "${source}" tracks "${local.upstream}" and is not on origin: push it before creating the ${noun}.`
        : `The branch "${source}" has no upstream (it has not been pushed yet): push it before creating the ${noun}.`,
      canPush: true
    }
  }
  if (local.upstream === remote.name) {
    const ahead = local.ahead ?? 0
    if (ahead === 0) return null
    return {
      text: `The branch "${source}" has ${ahead} unpushed ${ahead === 1 ? 'commit' : 'commits'}: push before creating the ${noun}.`,
      canPush: true
    }
  }
  if (local.hash === remote.hash) return null
  return {
    text: `The local branch "${source}" differs from "${remote.name}": if you have unpushed commits, push before creating the ${noun}.`,
    canPush: true
  }
}

// --- lists --------------------------------------------------------------------------------------

const has = (q: string, ...texts: string[]): boolean => texts.some((t) => t.toLowerCase().includes(q))

export const matchesPull = (pr: PullRequest, q: string): boolean =>
  !q || has(q, `#${pr.number}`, pr.title, pr.author, pr.sourceBranch, pr.targetBranch)

export const matchesIssue = (issue: Issue, q: string): boolean => !q || has(q, `#${issue.number}`, issue.title, issue.author, ...issue.labels)

/** Web page listing every pull request / issue of the repository */
export function listUrl(hosted: HostedRepo, what: 'pulls' | 'issues'): string {
  if (hosted.kind === 'github') return `${hosted.webUrl}/${what}`
  return `${hosted.webUrl}/-/${what === 'pulls' ? 'merge_requests' : 'issues'}`
}

/** "3 h ago", "2 d ago", "just now" */
export function ago(unixSeconds: number, now = Date.now()): string {
  if (!unixSeconds) return ''
  const s = Math.max(0, Math.floor(now / 1000) - unixSeconds)
  if (s < 60) return 'just now'
  if (s < 3600) return `${Math.floor(s / 60)} min ago`
  if (s < 86400) return `${Math.floor(s / 3600)} h ago`
  if (s < 86400 * 30) return `${Math.floor(s / 86400)} d ago`
  const months = Math.floor(s / (86400 * 30))
  if (s < 86400 * 365) return `${months} ${months === 1 ? 'month' : 'months'} ago`
  const years = Math.floor(s / (86400 * 365))
  return `${years} ${years === 1 ? 'year' : 'years'} ago`
}
