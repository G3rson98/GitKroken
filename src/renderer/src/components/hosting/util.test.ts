import { describe, expect, it } from 'vitest'
import type { Commit, HostedRepo, Issue, PullRequest, Ref } from '@shared/types'
import {
  ago,
  branchChoices,
  branchRef,
  cleanHost,
  initials,
  listUrl,
  matchesIssue,
  matchesPull,
  pushWarning,
  tipSubject,
  tokenPageUrl,
  validateProfile
} from './util'

const head = (name: string, hash: string, extra: Partial<Ref> = {}): Ref => ({ name, type: 'head', hash, isCurrent: false, ...extra })
const remote = (name: string, hash: string): Ref => ({ name, type: 'remote', hash, isCurrent: false })

const REFS: Ref[] = [
  head('feature/login', 'a1', { isCurrent: true, upstream: 'origin/feature/login', ahead: 2 }),
  head('feature/local-only', 'a5'),
  head('main', 'a2', { upstream: 'origin/main', ahead: 0 }),
  remote('origin/feature/login', 'a3'),
  remote('origin/feature/payments', 'a4'),
  remote('origin/main', 'a2'),
  remote('fork/main', 'a9'),
  { name: 'v1.0', type: 'tag', hash: 'a2', isCurrent: false }
]

describe('initials', () => {
  it.each([
    ['Ana Pérez', 'AP'],
    ['Work', 'W'],
    ['  ana maría  de la o ', 'AO'],
    ['jane.doe', 'JD'],
    ['', '?']
  ])('%s -> %s', (name, expected) => expect(initials(name)).toBe(expected))
})

describe('cleanHost / tokenPageUrl', () => {
  it('normalises what the user types', () => {
    expect(cleanHost(' HTTPS://GitLab.Example.com/users/sign_in ')).toBe('gitlab.example.com')
    expect(cleanHost('git@ghe.example.com:8443')).toBe('ghe.example.com:8443')
    expect(cleanHost('')).toBeNull()
    expect(cleanHost('not a host')).toBeNull()
    expect(cleanHost('a..b')).toBeNull()
  })

  it('points at the token page of each provider with the scope preselected', () => {
    expect(tokenPageUrl('github', 'github.com')).toBe('https://github.com/settings/tokens/new?scopes=repo&description=GitKroken')
    expect(tokenPageUrl('github', 'ghe.example.com')).toBe('https://ghe.example.com/settings/tokens/new?scopes=repo&description=GitKroken')
    expect(tokenPageUrl('gitlab', 'gitlab.com')).toBe('https://gitlab.com/-/user_settings/personal_access_tokens?name=GitKroken&scopes=api')
    expect(tokenPageUrl('gitlab', 'gitlab.example.com')).toBe('https://gitlab.example.com/-/profile/personal_access_tokens?name=GitKroken&scopes=api')
  })
})

describe('validateProfile', () => {
  it('accepts a complete profile', () => {
    expect(validateProfile({ name: 'Work', userName: 'Ana Pérez', userEmail: 'ana@company.com' })).toEqual({})
  })
  it('reports each bad field', () => {
    expect(Object.keys(validateProfile({ name: ' ', userName: '', userEmail: '' })).sort()).toEqual(['name', 'userEmail', 'userName'])
    expect(validateProfile({ name: 'x', userName: 'Ana <x>', userEmail: 'ana@company.com' })).toHaveProperty('userName')
    for (const email of ['ana', 'ana@', '@x.com', 'a b@x.com', '<a@x.com>']) {
      expect(validateProfile({ name: 'x', userName: 'Ana', userEmail: email }), email).toHaveProperty('userEmail')
    }
  })
})

describe('branches', () => {
  it('finds the ref of a branch: local first, then origin/<branch>', () => {
    expect(branchRef(REFS, 'feature/login')?.hash).toBe('a1')
    expect(branchRef(REFS, 'feature/payments')?.name).toBe('origin/feature/payments')
    expect(branchRef(REFS, 'hubot:patch-1')).toBeUndefined()
    expect(branchRef(REFS, 'v1.0')).toBeUndefined() // a tag is not a branch
  })

  it('offers existing branches with sensible defaults', () => {
    const c = branchChoices(REFS, 'feature/login')
    expect(c.sources).toEqual(['feature/local-only', 'feature/login', 'main', 'feature/payments'])
    expect(c.targets).toEqual(['feature/login', 'feature/payments', 'main', 'feature/local-only'])
    expect(c.source).toBe('feature/login')
    expect(c.target).toBe('main')
  })

  it('falls back when HEAD is detached or there is no main', () => {
    expect(branchChoices(REFS, null).source).toBe('feature/login') // the ref marked current
    const noMain = [head('dev', 'b1', { isCurrent: true }), head('topic', 'b2'), remote('origin/master', 'b3')]
    expect(branchChoices(noMain, 'topic')).toMatchObject({ source: 'topic', target: 'master' })
    const odd = [head('topic', 'b2', { isCurrent: true }), head('release', 'b4')]
    expect(branchChoices(odd, 'topic')).toMatchObject({ source: 'topic', target: 'release' })
    expect(branchChoices([], null)).toEqual({ sources: [], targets: [], source: '', target: '' })
  })

  it('takes the default title from the tip of the source branch', () => {
    const commits = [
      { hash: 'a1', subject: 'Add OAuth login' },
      { hash: 'a4', subject: 'Payments' }
    ] as Commit[]
    expect(tipSubject(REFS, commits, 'feature/login')).toBe('Add OAuth login')
    expect(tipSubject(REFS, commits, 'feature/payments')).toBe('Payments')
    expect(tipSubject(REFS, commits, 'main')).toBe('') // tip not among the loaded commits
    expect(tipSubject(REFS, commits, 'nope')).toBe('')
  })
})

describe('pushWarning', () => {
  it('warns when the branch is ahead of its upstream', () => {
    const w = pushWarning(REFS, 'feature/login', 'pull request')
    expect(w?.text).toBe('The branch "feature/login" has 2 unpushed commits: push before creating the pull request.')
    expect(w?.canPush).toBe(true)
    const one = [head('x', 'c1', { upstream: 'origin/x', ahead: 1 }), remote('origin/x', 'c0')]
    expect(pushWarning(one, 'x', 'merge request')?.text).toMatch(/1 unpushed commit: push before creating the merge request/)
  })

  it('warns when the branch has no upstream or is not on origin', () => {
    expect(pushWarning(REFS, 'feature/local-only', 'pull request')?.text).toMatch(/has no upstream .* push it before creating the pull request/)
    const elsewhere = [head('x', 'c1', { upstream: 'fork/x', ahead: 0 }), remote('fork/x', 'c1')]
    expect(pushWarning(elsewhere, 'x', 'pull request')?.text).toMatch(/tracks "fork\/x" and is not on origin/)
  })

  it('compares hashes when the branch exists on origin without being tracked', () => {
    const same = [head('x', 'c1'), remote('origin/x', 'c1')]
    expect(pushWarning(same, 'x', 'pull request')).toBeNull()
    const differs = [head('x', 'c2'), remote('origin/x', 'c1')]
    expect(pushWarning(differs, 'x', 'pull request')?.text).toMatch(/differs from "origin\/x"/)
  })

  it('says nothing for pushed or remote-only branches', () => {
    expect(pushWarning(REFS, 'main', 'pull request')).toBeNull()
    expect(pushWarning(REFS, 'feature/payments', 'pull request')).toBeNull()
  })
})

describe('lists', () => {
  const pr: PullRequest = {
    number: 42,
    title: 'Add OAuth login',
    author: 'octocat',
    state: 'open',
    draft: false,
    sourceBranch: 'feature/login',
    targetBranch: 'main',
    url: 'https://github.com/acme/shop/pull/42',
    updatedAt: 0
  }
  const issue: Issue = { number: 7, title: 'Cart is emptied on reload', author: 'hubot', state: 'open', labels: ['bug', 'High Priority'], url: 'u', updatedAt: 0 }

  it('filters pull requests by number, title, author and branches', () => {
    for (const q of ['', '#42', 'oauth', 'octo', 'feature/', 'main']) expect(matchesPull(pr, q), q).toBe(true)
    expect(matchesPull(pr, 'payments')).toBe(false)
  })

  it('filters issues by number, title, author and labels', () => {
    for (const q of ['', '#7', 'cart', 'hubot', 'high prio']) expect(matchesIssue(issue, q), q).toBe(true)
    expect(matchesIssue(issue, 'oauth')).toBe(false)
  })

  it('links to the full list on each provider', () => {
    const gh = { kind: 'github', webUrl: 'https://github.com/acme/shop' } as HostedRepo
    const gl = { kind: 'gitlab', webUrl: 'https://gitlab.com/acme/web/shop' } as HostedRepo
    expect(listUrl(gh, 'pulls')).toBe('https://github.com/acme/shop/pulls')
    expect(listUrl(gh, 'issues')).toBe('https://github.com/acme/shop/issues')
    expect(listUrl(gl, 'pulls')).toBe('https://gitlab.com/acme/web/shop/-/merge_requests')
    expect(listUrl(gl, 'issues')).toBe('https://gitlab.com/acme/web/shop/-/issues')
  })

  it('formats relative times', () => {
    const now = 1_700_000_000_000
    const at = (secondsAgo: number): string => ago(now / 1000 - secondsAgo, now)
    expect(at(5)).toBe('just now')
    expect(at(120)).toBe('2 min ago')
    expect(at(3 * 3600)).toBe('3 h ago')
    expect(at(2 * 86400)).toBe('2 d ago')
    expect(at(40 * 86400)).toBe('1 month ago')
    expect(at(800 * 86400)).toBe('2 years ago')
    expect(ago(0, now)).toBe('')
  })
})
