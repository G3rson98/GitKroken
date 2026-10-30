// Hosting integrations: accounts, hosted-repo detection, pull requests / issues
// and profiles. No Electron and no network: safeStorage is faked, `fetch` is
// stubbed, userData is a temp dir. The tokens below are made up.
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import {
  activeIdentity,
  credentialsForHost,
  hostingApi,
  mapGithubIssue,
  mapGithubPull,
  mapGitlabIssue,
  mapGitlabMergeRequest,
  normalizeHost,
  parseRemoteUrl,
  setHostingEnv,
  type HostingEnv,
  type SafeStorageLike
} from '../hosting'
import { cleanupAll, emptyRepo, setupGitEnv, sh, tmpDir } from './helpers'

const GH_TOKEN = 'ghp_FAKEfakeFAKEfakeFAKEfake0000000001'
const GH_TOKEN_2 = 'ghp_FAKEfakeFAKEfakeFAKEfake0000000002'
const GL_TOKEN = 'fake-gitlab-token-0003'

// --- fakes --------------------------------------------------------------------------------------

/** Reversible "encryption" that leaves no trace of the plain text in the output */
function fakeSafeStorage(overrides: Partial<SafeStorageLike> = {}): SafeStorageLike {
  return {
    isEncryptionAvailable: () => true,
    encryptString: (plain) => Buffer.from(`enc:${Buffer.from(plain, 'utf8').toString('hex').split('').reverse().join('')}`),
    decryptString: (buf) => {
      const text = buf.toString('utf8')
      if (!text.startsWith('enc:')) throw new Error('bad ciphertext')
      return Buffer.from(text.slice(4).split('').reverse().join(''), 'hex').toString('utf8')
    },
    ...overrides
  }
}

let userData: string
let opened: string[]
const fetchMock = vi.fn<(input: URL | string, init?: RequestInit) => Promise<Response>>()

function useEnv(overrides: Partial<HostingEnv> = {}): void {
  setHostingEnv({
    userData,
    safeStorage: fakeSafeStorage(),
    openExternal: async (url) => {
      opened.push(url)
    },
    ...overrides
  })
}

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } })

/** The n-th request made through the stubbed fetch */
function call(n = 0): { url: URL; method: string; headers: Record<string, string>; body: Record<string, unknown> | null } {
  const [input, init] = fetchMock.mock.calls[n] ?? []
  if (!input) throw new Error(`fetch call #${n} was not made`)
  return {
    url: new URL(String(input)),
    method: init?.method ?? 'GET',
    headers: (init?.headers ?? {}) as Record<string, string>,
    body: typeof init?.body === 'string' ? (JSON.parse(init.body) as Record<string, unknown>) : null
  }
}

async function addGithub(host = 'github.com', token = GH_TOKEN, user: Record<string, unknown> = { login: 'octocat', name: 'The Octocat' }) {
  fetchMock.mockResolvedValueOnce(json(200, { avatar_url: 'https://avatars.githubusercontent.com/u/1', ...user }, { 'x-oauth-scopes': 'repo, read:org' }))
  return hostingApi.addAccount('github', host, token)
}

async function addGitlab(host = 'gitlab.com', token = GL_TOKEN) {
  fetchMock.mockResolvedValueOnce(json(200, { id: 7, username: 'ana', name: 'Ana Pérez', avatar_url: 'https://gitlab.com/uploads/a.png' }))
  return hostingApi.addAccount('gitlab', host, token)
}

function repoWithOrigin(url: string): string {
  const repo = emptyRepo()
  sh(repo, 'remote', 'add', 'origin', url)
  return repo
}

/** Rejection message of a promise (fails the test when it resolves) */
async function failure(p: Promise<unknown>): Promise<string> {
  try {
    await p
  } catch (e) {
    return e instanceof Error ? e.message : String(e)
  }
  throw new Error('expected the call to fail')
}

beforeAll(() => setupGitEnv())
afterAll(() => {
  setHostingEnv(undefined)
  cleanupAll()
})

beforeEach(() => {
  userData = tmpDir('gitkroken-userdata-')
  opened = []
  fetchMock.mockReset()
  fetchMock.mockRejectedValue(new Error('unexpected network request in a test'))
  vi.stubGlobal('fetch', fetchMock)
  useEnv()
})

afterEach(() => {
  vi.unstubAllGlobals()
})

// --- accounts -----------------------------------------------------------------------------------

describe('accounts', () => {
  it('validates the token against the GitHub API and stores only public info in the result', async () => {
    const account = await addGithub()
    expect(account).toEqual({
      id: 'github:github.com',
      kind: 'github',
      host: 'github.com',
      username: 'octocat',
      name: 'The Octocat',
      avatarUrl: 'https://avatars.githubusercontent.com/u/1'
    })
    const req = call()
    expect(req.url.href).toBe('https://api.github.com/user')
    expect(req.headers['Authorization']).toBe(`Bearer ${GH_TOKEN}`)
    expect(await hostingApi.accounts()).toEqual([account])
    expect(JSON.stringify([account, await hostingApi.accounts()])).not.toContain(GH_TOKEN)
  })

  it('writes the token encrypted, in a 0600 file under userData, never in plain text', async () => {
    await addGithub()
    const file = join(userData, 'hosting-accounts.json')
    const raw = readFileSync(file, 'utf8')
    expect(raw).not.toContain(GH_TOKEN)
    expect(raw).toContain('octocat')
    if (process.platform !== 'win32') expect(statSync(file).mode & 0o777).toBe(0o600)
    // No temp file left behind, and nothing else in userData holds the token.
    for (const name of readdirSync(userData)) expect(readFileSync(join(userData, name), 'utf8')).not.toContain(GH_TOKEN)
    expect(readdirSync(userData)).toEqual(['hosting-accounts.json'])
    const stored = (JSON.parse(raw) as { accounts: { token: string }[] }).accounts[0]?.token ?? ''
    expect(fakeSafeStorage().decryptString(Buffer.from(stored, 'base64'))).toBe(GH_TOKEN)
  })

  it('uses /api/v3 for GitHub Enterprise and /api/v4 with PRIVATE-TOKEN for GitLab', async () => {
    await addGithub('ghe.example.com')
    expect(call(0).url.href).toBe('https://ghe.example.com/api/v3/user')
    const gl = await addGitlab('gitlab.example.com')
    expect(call(1).url.href).toBe('https://gitlab.example.com/api/v4/user')
    expect(call(1).headers['PRIVATE-TOKEN']).toBe(GL_TOKEN)
    expect(call(1).headers['Authorization']).toBeUndefined()
    expect(gl).toMatchObject({ id: 'gitlab:gitlab.example.com', kind: 'gitlab', username: 'ana', name: 'Ana Pérez' })
    expect((await hostingApi.accounts()).map((a) => a.id)).toEqual(['github:ghe.example.com', 'gitlab:gitlab.example.com'])
  })

  it('normalises the host and only ever talks HTTPS to it', async () => {
    const account = await addGitlab('http://GitLab.Example.com/users/sign_in?x=1')
    expect(account.host).toBe('gitlab.example.com')
    expect(call().url.protocol).toBe('https:')
    expect(call().url.host).toBe('gitlab.example.com')

    expect(normalizeHost(' HTTPS://GitHub.com/ ')).toBe('github.com')
    expect(normalizeHost('www.github.com')).toBe('github.com')
    expect(normalizeHost('git@gitlab.example.com:8443/x')).toBe('gitlab.example.com:8443')
    expect(normalizeHost('evil.example\\@github.com')).toBe('evil.example') // same reading as a browser
    for (const bad of ['', '   ', 'https://', 'exa mple.com', 'a..b', 'host:999999', '-bad.com', '[::1]', 'host:port', 'a_b.com']) {
      expect(() => normalizeHost(bad), bad).toThrow()
    }
  })

  it('keeps one account per (kind, host): adding again replaces it', async () => {
    await addGithub()
    await addGitlab()
    const second = await addGithub('github.com', GH_TOKEN_2, { login: 'hubot' })
    expect(second.username).toBe('hubot')
    const list = await hostingApi.accounts()
    expect(list.map((a) => `${a.id}=${a.username}`).sort()).toEqual(['github:github.com=hubot', 'gitlab:gitlab.com=ana'])
    expect(credentialsForHost('github.com')).toEqual({ username: 'hubot', password: GH_TOKEN_2 })
    expect(readFileSync(join(userData, 'hosting-accounts.json'), 'utf8')).not.toContain(GH_TOKEN)
  })

  it('removeAccount deletes the token from memory and from disk', async () => {
    await addGithub()
    await addGitlab()
    await hostingApi.removeAccount('github:github.com')
    expect((await hostingApi.accounts()).map((a) => a.id)).toEqual(['gitlab:gitlab.com'])
    expect(credentialsForHost('github.com')).toBeNull()
    const raw = readFileSync(join(userData, 'hosting-accounts.json'), 'utf8')
    expect(raw).not.toContain('octocat')
    expect((JSON.parse(raw) as { accounts: unknown[] }).accounts).toHaveLength(1)
    await expect(hostingApi.removeAccount('nope')).resolves.toBeUndefined()
  })

  it('survives a restart: accounts are read back and decrypted lazily', async () => {
    await addGithub()
    useEnv() // drops the in-memory cache, same userData
    expect(await hostingApi.accounts()).toHaveLength(1)
    expect(credentialsForHost('github.com')).toEqual({ username: 'octocat', password: GH_TOKEN })
    expect(fetchMock).toHaveBeenCalledTimes(1) // reading back makes no request
  })

  it('refuses to store anything when encryption is not available, and says why', async () => {
    useEnv({ safeStorage: fakeSafeStorage({ isEncryptionAvailable: () => false }) })
    const msg = await failure(hostingApi.addAccount('github', 'github.com', GH_TOKEN))
    expect(msg).toMatch(/encrypted storage is not available/i)
    expect(msg).toMatch(/never stores tokens in plain text/i)
    expect(msg).not.toContain(GH_TOKEN)
    expect(fetchMock).not.toHaveBeenCalled()
    expect(existsSync(join(userData, 'hosting-accounts.json'))).toBe(false)
    expect(await hostingApi.accounts()).toEqual([])

    // Linux without a keyring: Electron "encrypts" with a hard-coded password.
    useEnv({ safeStorage: fakeSafeStorage({ getSelectedStorageBackend: () => 'basic_text' }) })
    expect(await failure(hostingApi.addAccount('gitlab', 'gitlab.com', GL_TOKEN))).toMatch(/keyring/i)
    expect(existsSync(join(userData, 'hosting-accounts.json'))).toBe(false)
  })

  it('rejects invalid tokens without storing them, and never echoes the token', async () => {
    fetchMock.mockResolvedValueOnce(json(401, { message: 'Bad credentials' }))
    const bad = await failure(hostingApi.addAccount('github', 'github.com', GH_TOKEN))
    expect(bad).toMatch(/GitHub rejected the token: it is invalid or has expired/)
    expect(bad).not.toContain(GH_TOKEN)

    // A server (or proxy) that echoes the credential back in its error body.
    fetchMock.mockResolvedValueOnce(json(422, { message: `token ${GL_TOKEN} is malformed` }))
    const echoed = await failure(hostingApi.addAccount('gitlab', 'gitlab.com', GL_TOKEN))
    expect(echoed).not.toContain(GL_TOKEN)
    expect(echoed).toContain('***')

    // A transport error that mentions the header value.
    fetchMock.mockRejectedValueOnce(new TypeError(`invalid header value "Bearer ${GH_TOKEN}"`))
    expect(await failure(hostingApi.addAccount('github', 'github.com', GH_TOKEN))).not.toContain(GH_TOKEN)

    expect(await failure(hostingApi.addAccount('github', 'github.com', '   '))).toMatch(/token/i)
    const spaced = await failure(hostingApi.addAccount('github', 'github.com', 'ghp_fake with\nbreaks'))
    expect(spaced).toMatch(/invalid characters/)
    expect(spaced).not.toContain('ghp_fake')
    expect(await failure(hostingApi.addAccount('bitbucket' as never, 'bitbucket.org', GH_TOKEN))).toMatch(/use GitHub or GitLab/)

    expect(await hostingApi.accounts()).toEqual([])
    expect(existsSync(join(userData, 'hosting-accounts.json'))).toBe(false)
  })

  it('rejects a classic GitHub token without the repo scope, and a host that is not the provider', async () => {
    fetchMock.mockResolvedValueOnce(json(200, { login: 'octocat' }, { 'x-oauth-scopes': 'read:user, gist' }))
    expect(await failure(hostingApi.addAccount('github', 'github.com', GH_TOKEN))).toMatch(/lacks the "repo" scope/)

    // Fine-grained tokens send no scopes header: accepted.
    fetchMock.mockResolvedValueOnce(json(200, { login: 'octocat' }))
    await expect(hostingApi.addAccount('github', 'github.com', GH_TOKEN)).resolves.toMatchObject({ username: 'octocat' })

    fetchMock.mockResolvedValueOnce(new Response('<html>Sign in</html>', { status: 200, headers: { 'content-type': 'text/html' } }))
    expect(await failure(hostingApi.addAccount('gitlab', 'intranet.example.com', GL_TOKEN))).toMatch(/did not answer like a GitLab server/)

    fetchMock.mockResolvedValueOnce(json(404, { message: 'Not Found' }))
    expect(await failure(hostingApi.addAccount('github', 'ghe.example.com', GH_TOKEN))).toMatch(/No GitHub API was found at ghe\.example\.com/)
  })
})

describe('credentialsForHost', () => {
  it('returns login + token for GitHub and oauth2 + token for GitLab', async () => {
    await addGithub()
    await addGitlab('gitlab.example.com:8443')
    expect(credentialsForHost('github.com')).toEqual({ username: 'octocat', password: GH_TOKEN })
    expect(credentialsForHost('https://GitHub.com/owner/repo.git')).toEqual({ username: 'octocat', password: GH_TOKEN })
    expect(credentialsForHost('gitlab.example.com:8443')).toEqual({ username: 'oauth2', password: GL_TOKEN })
  })

  it('returns null for unknown hosts, other ports, garbage, and undecryptable tokens', async () => {
    await addGithub()
    await addGitlab('gitlab.example.com:8443')
    expect(credentialsForHost('gitlab.com')).toBeNull()
    expect(credentialsForHost('gitlab.example.com')).toBeNull()
    expect(credentialsForHost('github.com:8080')).toBeNull()
    expect(credentialsForHost('github.com.evil.example')).toBeNull()
    expect(credentialsForHost('')).toBeNull()
    expect(credentialsForHost(undefined as never)).toBeNull()

    // The keychain entry changed: the stored blob cannot be decrypted any more.
    useEnv({
      safeStorage: fakeSafeStorage({
        decryptString: () => {
          throw new Error('decrypt failed')
        }
      })
    })
    expect(credentialsForHost('github.com')).toBeNull()
    expect(await hostingApi.accounts()).toHaveLength(2) // still listed, so it can be reconnected / removed
  })

  it('works (returning nothing) outside Electron', async () => {
    setHostingEnv(undefined)
    expect(credentialsForHost('github.com')).toBeNull()
    expect(activeIdentity()).toBeNull()
    expect(await hostingApi.accounts()).toEqual([])
    expect(await hostingApi.profiles()).toEqual({ profiles: [], activeId: null })
    await expect(hostingApi.addAccount('github', 'github.com', GH_TOKEN)).rejects.toThrow(/only available inside the app/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// --- hosted repository ---------------------------------------------------------------------------

describe('parseRemoteUrl', () => {
  const table: [string, { host: string; segments: string[] } | null][] = [
    ['https://github.com/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['https://github.com/owner/name', { host: 'github.com', segments: ['owner', 'name'] }],
    ['https://github.com/owner/name/', { host: 'github.com', segments: ['owner', 'name'] }],
    ['https://GitHub.com/Owner/Name.git', { host: 'github.com', segments: ['Owner', 'Name'] }],
    ['http://github.com/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['https://user:secret@github.com/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['https://www.github.com/owner/name', { host: 'github.com', segments: ['owner', 'name'] }],
    ['https://github.com/owner/my.repo.js.git', { host: 'github.com', segments: ['owner', 'my.repo.js'] }],
    ['git@github.com:owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['git@github.com:owner/name', { host: 'github.com', segments: ['owner', 'name'] }],
    ['github.com:owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['git@github.com:/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['ssh://git@github.com/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['ssh://git@ssh.github.com:443/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['git://github.com/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    ['git+ssh://git@github.com/owner/name.git', { host: 'github.com', segments: ['owner', 'name'] }],
    // GitLab subgroups
    ['https://gitlab.com/group/sub/name.git', { host: 'gitlab.com', segments: ['group', 'sub', 'name'] }],
    ['git@gitlab.com:group/sub/deeper/name.git', { host: 'gitlab.com', segments: ['group', 'sub', 'deeper', 'name'] }],
    ['ssh://git@altssh.gitlab.com:443/group/name.git', { host: 'gitlab.com', segments: ['group', 'name'] }],
    // Self-hosted, ports
    ['https://gitlab.example.com:8443/group/name.git', { host: 'gitlab.example.com:8443', segments: ['group', 'name'] }],
    ['ssh://git@gitlab.example.com:2222/group/sub/name.git', { host: 'gitlab.example.com', segments: ['group', 'sub', 'name'] }],
    ['git@ghe.example.com:team/tool.git', { host: 'ghe.example.com', segments: ['team', 'tool'] }],
    ['git@gitlab.example.com:2222/group/name.git', { host: 'gitlab.example.com', segments: ['group', 'name'] }],
    // Not a hosted repository
    ['/Users/me/repos/project.git', null],
    ['../sibling/repo', null],
    ['./repo', null],
    ['file:///srv/git/project.git', null],
    ['C:\\repos\\project', null],
    ['C:/repos/project', null],
    ['https://github.com/owner', null],
    ['https://github.com/', null],
    ['git@github.com:name.git', null],
    ['https://github.com/owner/../name', null],
    ['https://github.com/owner/na me', null],
    ['ftp://example.com/owner/name.git', null],
    ['', null],
    ['not a url', null]
  ]
  it.each(table)('%s', (url, expected) => {
    expect(parseRemoteUrl(url)).toEqual(expected)
  })

  it('ignores non-string input', () => {
    expect(parseRemoteUrl(null)).toBeNull()
    expect(parseRemoteUrl(undefined)).toBeNull()
    expect(parseRemoteUrl(42)).toBeNull()
  })
})

describe('hostedRepo', () => {
  it('recognises github.com and gitlab.com without any account', async () => {
    expect(await hostingApi.hostedRepo(repoWithOrigin('git@github.com:octo-org/hello_world.git'))).toEqual({
      kind: 'github',
      host: 'github.com',
      owner: 'octo-org',
      name: 'hello_world',
      webUrl: 'https://github.com/octo-org/hello_world',
      account: null
    })
    expect(await hostingApi.hostedRepo(repoWithOrigin('https://gitlab.com/group/sub/name.git'))).toEqual({
      kind: 'gitlab',
      host: 'gitlab.com',
      owner: 'group/sub',
      name: 'name',
      webUrl: 'https://gitlab.com/group/sub/name',
      account: null
    })
  })

  it('attaches the stored account for the host', async () => {
    const account = await addGithub()
    const hosted = await hostingApi.hostedRepo(repoWithOrigin('ssh://git@ssh.github.com:443/octo-org/hello.git'))
    expect(hosted).toMatchObject({ kind: 'github', host: 'github.com', owner: 'octo-org', name: 'hello', account })
    expect(JSON.stringify(hosted)).not.toContain(GH_TOKEN)
  })

  it('knows self-hosted servers only through a stored account', async () => {
    const https = repoWithOrigin('https://gitlab.example.com:8443/group/sub/name.git')
    const ssh = repoWithOrigin('ssh://git@gitlab.example.com:2222/group/sub/name.git')
    const ghe = repoWithOrigin('git@ghe.example.com:team/tool.git')
    expect(await hostingApi.hostedRepo(https)).toBeNull()
    expect(await hostingApi.hostedRepo(ssh)).toBeNull()
    expect(await hostingApi.hostedRepo(ghe)).toBeNull()

    await addGitlab('gitlab.example.com:8443')
    await addGithub('ghe.example.com')
    expect(await hostingApi.hostedRepo(https)).toMatchObject({
      kind: 'gitlab',
      host: 'gitlab.example.com:8443',
      owner: 'group/sub',
      name: 'name',
      webUrl: 'https://gitlab.example.com:8443/group/sub/name',
      account: { id: 'gitlab:gitlab.example.com:8443' }
    })
    // The ssh port is not the web port: the account's host is used for the web URL.
    expect(await hostingApi.hostedRepo(ssh)).toMatchObject({ kind: 'gitlab', webUrl: 'https://gitlab.example.com:8443/group/sub/name' })
    expect(await hostingApi.hostedRepo(ghe)).toMatchObject({ kind: 'github', host: 'ghe.example.com', owner: 'team', name: 'tool' })
  })

  it('returns null for unknown providers, nested GitHub paths, local remotes and repos without origin', async () => {
    expect(await hostingApi.hostedRepo(repoWithOrigin('git@bitbucket.org:team/name.git'))).toBeNull()
    expect(await hostingApi.hostedRepo(repoWithOrigin('https://dev.azure.com/org/project/_git/repo'))).toBeNull()
    expect(await hostingApi.hostedRepo(repoWithOrigin('https://github.com/owner/name/extra.git'))).toBeNull()
    expect(await hostingApi.hostedRepo(repoWithOrigin('/srv/git/project.git'))).toBeNull()
    expect(await hostingApi.hostedRepo(emptyRepo())).toBeNull()
    const upstreamOnly = emptyRepo()
    sh(upstreamOnly, 'remote', 'add', 'upstream', 'git@github.com:owner/name.git')
    expect(await hostingApi.hostedRepo(upstreamOnly)).toBeNull()
    expect(await hostingApi.hostedRepo(join(userData, 'does-not-exist'))).toBeNull()
    expect(await hostingApi.hostedRepo('')).toBeNull()
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// --- sample payloads (trimmed from the providers' API documentation) --------------------------------

const GH_PULL = {
  url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1347',
  id: 1,
  html_url: 'https://github.com/octocat/Hello-World/pull/1347',
  number: 1347,
  state: 'open',
  locked: false,
  title: 'Amazing new feature',
  user: { login: 'octocat', id: 1, avatar_url: 'https://github.com/images/error/octocat_happy.gif', type: 'User' },
  body: 'Please pull these awesome changes in!',
  labels: [{ id: 208045946, name: 'bug', color: 'f29513' }],
  created_at: '2011-01-26T19:01:12Z',
  updated_at: '2011-01-26T19:01:12Z',
  closed_at: null,
  merged_at: null,
  head: { label: 'octocat:new-topic', ref: 'new-topic', sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e', repo: { id: 1296269, full_name: 'octocat/Hello-World' } },
  base: { label: 'octocat:master', ref: 'master', sha: '6dcb09b5b57875f334f61aebed695e2e4193db5e', repo: { id: 1296269, full_name: 'octocat/Hello-World' } },
  draft: false
}

const GH_ISSUE = {
  id: 1,
  url: 'https://api.github.com/repos/octocat/Hello-World/issues/1347',
  html_url: 'https://github.com/octocat/Hello-World/issues/1347',
  number: 1347,
  state: 'open',
  title: 'Found a bug',
  body: "I'm having a problem with this.",
  user: { login: 'octocat', id: 1 },
  labels: [
    { id: 208045946, name: 'bug', description: "Something isn't working", color: 'f29513', default: true },
    { id: 208045947, name: 'help wanted', color: '008672' }
  ],
  assignee: null,
  comments: 0,
  closed_at: null,
  created_at: '2011-04-22T13:33:48Z',
  updated_at: '2011-04-22T13:33:48Z'
}

const GL_MR = {
  id: 1,
  iid: 12,
  project_id: 3,
  title: 'Draft: test1',
  description: 'fixed login page css paddings',
  state: 'opened',
  created_at: '2017-04-29T08:46:00Z',
  updated_at: '2017-04-29T08:46:00.500Z',
  target_branch: 'main',
  source_branch: 'feature/test1',
  author: { id: 1, name: 'Administrator', username: 'admin', state: 'active', web_url: 'https://gitlab.example.com/admin' },
  source_project_id: 3,
  target_project_id: 3,
  labels: ['Community contribution', 'Manage'],
  draft: true,
  work_in_progress: true,
  merge_status: 'can_be_merged',
  sha: '8888888888888888888888888888888888888888',
  web_url: 'https://gitlab.example.com/my-group/my-project/-/merge_requests/12',
  references: { short: '!12', relative: '!12', full: 'my-group/my-project!12' }
}

const GL_ISSUE = {
  id: 76,
  iid: 6,
  project_id: 3,
  title: 'Consequatur vero maxime deserunt laboriosam est voluptas dolorem.',
  description: 'Ratione dolores corrupti mollitia soluta quia.',
  state: 'opened',
  author: { id: 18, username: 'eileen.lowe', name: 'Alexandra Bashirian', state: 'active' },
  labels: ['foo', 'bar'],
  created_at: '2016-01-04T15:31:51.081Z',
  updated_at: '2016-01-04T15:31:51.081Z',
  web_url: 'https://gitlab.example.com/my-group/my-project/-/issues/6'
}

describe('mapping', () => {
  it('maps a GitHub pull request', () => {
    expect(mapGithubPull(GH_PULL)).toEqual({
      number: 1347,
      title: 'Amazing new feature',
      author: 'octocat',
      state: 'open',
      draft: false,
      sourceBranch: 'new-topic',
      targetBranch: 'master',
      url: 'https://github.com/octocat/Hello-World/pull/1347',
      updatedAt: Date.UTC(2011, 0, 26, 19, 1, 12) / 1000
    })
    expect(mapGithubPull({ ...GH_PULL, draft: true })?.draft).toBe(true)
    expect(mapGithubPull({ ...GH_PULL, state: 'closed' })?.state).toBe('closed')
    expect(mapGithubPull({ ...GH_PULL, state: 'closed', merged_at: '2011-01-27T00:00:00Z' })?.state).toBe('merged')
    // From a fork: the branch is not in this repository, shown as `user:branch`.
    const fork = { ...GH_PULL, head: { label: 'hubot:patch-1', ref: 'patch-1', repo: { full_name: 'hubot/Hello-World' } } }
    expect(mapGithubPull(fork)?.sourceBranch).toBe('hubot:patch-1')
    // Deleted fork / deleted author.
    expect(mapGithubPull({ ...GH_PULL, user: null, head: { label: 'ghost:x', ref: 'x', repo: null } })).toMatchObject({ author: '', sourceBranch: 'ghost:x' })
    expect(mapGithubPull({ title: 'no number' })).toBeNull()
    expect(mapGithubPull(null)).toBeNull()
  })

  it('maps a GitLab merge request (iid -> number, draft / work_in_progress)', () => {
    expect(mapGitlabMergeRequest(GL_MR)).toEqual({
      number: 12,
      title: 'Draft: test1',
      author: 'admin',
      state: 'open',
      draft: true,
      sourceBranch: 'feature/test1',
      targetBranch: 'main',
      url: 'https://gitlab.example.com/my-group/my-project/-/merge_requests/12',
      updatedAt: Date.UTC(2017, 3, 29, 8, 46, 0) / 1000
    })
    const { draft: _d, work_in_progress: _w, ...old } = GL_MR
    expect(mapGitlabMergeRequest({ ...old, work_in_progress: true, title: 'x' })?.draft).toBe(true) // GitLab < 14
    expect(mapGitlabMergeRequest({ ...old, title: 'WIP: x' })?.draft).toBe(true) // neither flag
    expect(mapGitlabMergeRequest({ ...old, title: 'Draft a plan' })?.draft).toBe(false)
    expect(mapGitlabMergeRequest({ ...GL_MR, draft: false, work_in_progress: false, title: 'test1' })?.draft).toBe(false)
    expect(mapGitlabMergeRequest({ ...GL_MR, state: 'merged' })?.state).toBe('merged')
    expect(mapGitlabMergeRequest({ ...GL_MR, state: 'closed' })?.state).toBe('closed')
    expect(mapGitlabMergeRequest({ ...GL_MR, state: 'locked' })?.state).toBe('closed')
    expect(mapGitlabMergeRequest({ ...GL_MR, source_project_id: 99 })?.sourceBranch).toBe('fork:feature/test1')
    expect(mapGitlabMergeRequest({ id: 1 })).toBeNull()
  })

  it('maps issues of both providers and drops the pull requests GitHub mixes in', () => {
    expect(mapGithubIssue(GH_ISSUE)).toEqual({
      number: 1347,
      title: 'Found a bug',
      author: 'octocat',
      state: 'open',
      labels: ['bug', 'help wanted'],
      url: 'https://github.com/octocat/Hello-World/issues/1347',
      updatedAt: Date.UTC(2011, 3, 22, 13, 33, 48) / 1000
    })
    expect(mapGithubIssue({ ...GH_ISSUE, pull_request: { url: 'https://api.github.com/repos/octocat/Hello-World/pulls/1347' } })).toBeNull()
    expect(mapGithubIssue({ ...GH_ISSUE, labels: ['plain', { name: 'obj' }, { id: 3 }, 7] })?.labels).toEqual(['plain', 'obj'])
    expect(mapGitlabIssue(GL_ISSUE)).toEqual({
      number: 6,
      title: 'Consequatur vero maxime deserunt laboriosam est voluptas dolorem.',
      author: 'eileen.lowe',
      state: 'open',
      labels: ['foo', 'bar'],
      url: 'https://gitlab.example.com/my-group/my-project/-/issues/6',
      updatedAt: Math.floor(Date.UTC(2016, 0, 4, 15, 31, 51, 81) / 1000)
    })
    expect(mapGitlabIssue({ ...GL_ISSUE, state: 'closed', labels: [{ name: 'detailed', color: '#fff' }] })).toMatchObject({ state: 'closed', labels: ['detailed'] })
  })
})

// --- listing & creating --------------------------------------------------------------------------

describe('pull requests and issues', () => {
  it('lists open GitHub pull requests, most recently updated first', async () => {
    await addGithub()
    const repo = repoWithOrigin('git@github.com:octocat/Hello-World.git')
    fetchMock.mockResolvedValueOnce(
      json(200, [
        { ...GH_PULL, number: 1, updated_at: '2024-01-01T00:00:00Z' },
        { ...GH_PULL, number: 2, updated_at: '2024-03-01T00:00:00Z', draft: true }
      ])
    )
    const list = await hostingApi.pullRequests(repo)
    expect(list.map((p) => p.number)).toEqual([2, 1])
    expect(list[0]).toMatchObject({ draft: true, sourceBranch: 'new-topic', targetBranch: 'master' })
    const req = call(1)
    expect(req.method).toBe('GET')
    expect(req.url.origin + req.url.pathname).toBe('https://api.github.com/repos/octocat/Hello-World/pulls')
    expect(Object.fromEntries(req.url.searchParams)).toEqual({ state: 'open', sort: 'updated', direction: 'desc', per_page: '50' })
    expect(req.headers['Authorization']).toBe(`Bearer ${GH_TOKEN}`)
    expect(req.url.href).not.toContain(GH_TOKEN)
    expect(JSON.stringify(list)).not.toContain(GH_TOKEN)
  })

  it('lists GitLab merge requests of a subgroup project through the URL-encoded path', async () => {
    await addGitlab('gitlab.example.com')
    const repo = repoWithOrigin('git@gitlab.example.com:my-group/sub/my-project.git')
    fetchMock.mockResolvedValueOnce(json(200, [GL_MR]))
    const list = await hostingApi.pullRequests(repo)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ number: 12, draft: true, sourceBranch: 'feature/test1', targetBranch: 'main', author: 'admin' })
    const req = call(1)
    expect(req.url.href.split('?')[0]).toBe('https://gitlab.example.com/api/v4/projects/my-group%2Fsub%2Fmy-project/merge_requests')
    expect(Object.fromEntries(req.url.searchParams)).toEqual({ state: 'opened', order_by: 'updated_at', sort: 'desc', per_page: '50' })
    expect(req.headers['PRIVATE-TOKEN']).toBe(GL_TOKEN)
  })

  it('caps lists at 50 entries', async () => {
    await addGithub()
    const repo = repoWithOrigin('https://github.com/octocat/Hello-World.git')
    fetchMock.mockResolvedValueOnce(json(200, Array.from({ length: 60 }, (_, i) => ({ ...GH_PULL, number: i + 1 }))))
    expect(await hostingApi.pullRequests(repo)).toHaveLength(50)
  })

  it('filters pull requests out of GitHub issues and reads more pages when they crowd the first one', async () => {
    await addGithub()
    const repo = repoWithOrigin('https://github.com/octocat/Hello-World.git')
    const pr = (n: number) => ({ ...GH_ISSUE, number: n, pull_request: { url: 'x' } })
    const issue = (n: number) => ({ ...GH_ISSUE, number: n, title: `Issue ${n}` })
    // Page 1: 100 items, only 2 real issues -> a second page is requested.
    fetchMock.mockResolvedValueOnce(json(200, [issue(1), ...Array.from({ length: 98 }, (_, i) => pr(100 + i)), issue(2)]))
    fetchMock.mockResolvedValueOnce(json(200, [issue(3), pr(300)]))
    const list = await hostingApi.issues(repo)
    expect(list.map((i) => i.number)).toEqual([1, 2, 3])
    expect(list.every((i) => i.title.startsWith('Issue'))).toBe(true)
    expect(fetchMock).toHaveBeenCalledTimes(3) // /user + 2 pages
    expect(Object.fromEntries(call(1).url.searchParams)).toEqual({ state: 'open', sort: 'updated', direction: 'desc', per_page: '100', page: '1' })
    expect(call(2).url.searchParams.get('page')).toBe('2')
    expect(call(1).url.pathname).toBe('/repos/octocat/Hello-World/issues')
  })

  it('stops paging GitHub issues after a short page and never reads more than three', async () => {
    await addGithub()
    const repo = repoWithOrigin('https://github.com/octocat/Hello-World.git')
    fetchMock.mockResolvedValueOnce(json(200, [GH_ISSUE]))
    expect(await hostingApi.issues(repo)).toHaveLength(1)
    expect(fetchMock).toHaveBeenCalledTimes(2)

    fetchMock.mockClear()
    const fullOfPrs = (): Response => json(200, Array.from({ length: 100 }, (_, i) => ({ ...GH_ISSUE, number: i, pull_request: {} })))
    fetchMock.mockResolvedValueOnce(fullOfPrs()).mockResolvedValueOnce(fullOfPrs()).mockResolvedValueOnce(fullOfPrs())
    expect(await hostingApi.issues(repo)).toEqual([])
    expect(fetchMock).toHaveBeenCalledTimes(3)
  })

  it('lists GitLab issues', async () => {
    await addGitlab()
    const repo = repoWithOrigin('https://gitlab.com/my-group/my-project.git')
    fetchMock.mockResolvedValueOnce(json(200, [GL_ISSUE]))
    expect(await hostingApi.issues(repo)).toEqual([expect.objectContaining({ number: 6, labels: ['foo', 'bar'], author: 'eileen.lowe' })])
    expect(call(1).url.href.split('?')[0]).toBe('https://gitlab.com/api/v4/projects/my-group%2Fmy-project/issues')
    expect(call(1).url.searchParams.get('state')).toBe('opened')
  })

  it('creates a GitHub pull request', async () => {
    await addGithub()
    const repo = repoWithOrigin('https://github.com/octocat/Hello-World.git')
    fetchMock.mockResolvedValueOnce(json(201, { ...GH_PULL, number: 9, title: 'Add login', draft: true }))
    const created = await hostingApi.createPullRequest(repo, {
      title: '  Add login ',
      body: 'Details',
      sourceBranch: 'new-topic',
      targetBranch: 'master',
      draft: true
    })
    expect(created).toMatchObject({ number: 9, title: 'Add login', draft: true, url: GH_PULL.html_url })
    const req = call(1)
    expect(req.method).toBe('POST')
    expect(req.url.href).toBe('https://api.github.com/repos/octocat/Hello-World/pulls')
    expect(req.body).toEqual({ title: 'Add login', body: 'Details', head: 'new-topic', base: 'master', draft: true })
    expect(req.headers['Content-Type']).toBe('application/json')
  })

  it('creates a GitLab merge request; a draft is marked through the title', async () => {
    await addGitlab()
    const repo = repoWithOrigin('git@gitlab.com:my-group/my-project.git')
    fetchMock.mockResolvedValueOnce(json(201, GL_MR))
    const created = await hostingApi.createPullRequest(repo, { title: 'test1', sourceBranch: 'feature/test1', targetBranch: 'main', draft: true })
    expect(created).toMatchObject({ number: 12, draft: true })
    expect(call(1).url.href).toBe('https://gitlab.com/api/v4/projects/my-group%2Fmy-project/merge_requests')
    expect(call(1).body).toEqual({ title: 'Draft: test1', source_branch: 'feature/test1', target_branch: 'main' })

    fetchMock.mockResolvedValueOnce(json(201, GL_MR))
    await hostingApi.createPullRequest(repo, { title: 'Draft: already', body: 'd', sourceBranch: 'a', targetBranch: 'main', draft: true })
    expect(call(2).body).toEqual({ title: 'Draft: already', description: 'd', source_branch: 'a', target_branch: 'main' })

    fetchMock.mockResolvedValueOnce(json(201, { ...GL_MR, draft: false, work_in_progress: false, title: 'plain' }))
    await hostingApi.createPullRequest(repo, { title: 'plain', sourceBranch: 'a', targetBranch: 'main' })
    expect(call(3).body).toMatchObject({ title: 'plain' })
  })

  it('creates issues on both providers', async () => {
    await addGithub()
    await addGitlab()
    fetchMock.mockResolvedValueOnce(json(201, GH_ISSUE))
    const gh = await hostingApi.createIssue(repoWithOrigin('https://github.com/octocat/Hello-World.git'), { title: 'Found a bug', body: 'Steps' })
    expect(gh).toMatchObject({ number: 1347, labels: ['bug', 'help wanted'] })
    expect(call(2).method).toBe('POST')
    expect(call(2).url.href).toBe('https://api.github.com/repos/octocat/Hello-World/issues')
    expect(call(2).body).toEqual({ title: 'Found a bug', body: 'Steps' })

    fetchMock.mockResolvedValueOnce(json(201, GL_ISSUE))
    const gl = await hostingApi.createIssue(repoWithOrigin('https://gitlab.com/my-group/my-project.git'), { title: 'T' })
    expect(gl).toMatchObject({ number: 6 })
    expect(call(3).url.href).toBe('https://gitlab.com/api/v4/projects/my-group%2Fmy-project/issues')
    expect(call(3).body).toEqual({ title: 'T' })
  })

  it('validates input before making any request', async () => {
    await addGithub()
    const repo = repoWithOrigin('https://github.com/octocat/Hello-World.git')
    fetchMock.mockClear()
    expect(await failure(hostingApi.createPullRequest(repo, { title: ' ', sourceBranch: 'a', targetBranch: 'b' }))).toMatch(/Missing title/)
    expect(await failure(hostingApi.createPullRequest(repo, { title: 't', sourceBranch: '', targetBranch: 'b' }))).toMatch(/Missing source branch/)
    expect(await failure(hostingApi.createPullRequest(repo, { title: 't', sourceBranch: 'a', targetBranch: 'a' }))).toMatch(/are the same/)
    expect(await failure(hostingApi.createPullRequest(repo, null as never))).toMatch(/Missing title/)
    expect(await failure(hostingApi.createIssue(repo, { title: '' }))).toMatch(/Missing title/)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

// --- error translation ------------------------------------------------------------------------------

describe('error messages', () => {
  const GH_URL = 'https://github.com/octocat/Hello-World.git'
  const NEW_PR = { title: 'T', sourceBranch: 'feature/x', targetBranch: 'main' }

  it('no account for that host', async () => {
    const gh = await failure(hostingApi.pullRequests(repoWithOrigin(GH_URL)))
    expect(gh).toBe('No GitHub account is connected for github.com. Connect one in "Profiles & Accounts".')
    const gl = await failure(hostingApi.issues(repoWithOrigin('git@gitlab.com:g/p.git')))
    expect(gl).toMatch(/No GitLab account is connected for gitlab\.com/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('repository that is not hosted on a known provider', async () => {
    expect(await failure(hostingApi.pullRequests(repoWithOrigin('git@bitbucket.org:t/n.git')))).toMatch(/does not point to GitHub or GitLab/)
    expect(await failure(hostingApi.createIssue(emptyRepo(), { title: 't' }))).toMatch(/does not point to GitHub or GitLab/)
  })

  it('stored token that can no longer be decrypted', async () => {
    await addGithub()
    useEnv({
      safeStorage: fakeSafeStorage({
        decryptString: () => {
          throw new Error('nope')
        }
      })
    })
    expect(await failure(hostingApi.pullRequests(repoWithOrigin(GH_URL)))).toMatch(/Could not decrypt the token stored for github\.com/)
  })

  it('401: invalid or expired token, naming the scope to grant', async () => {
    await addGithub()
    await addGitlab()
    fetchMock.mockResolvedValueOnce(json(401, { message: 'Bad credentials', documentation_url: 'https://docs.github.com/rest' }))
    const gh = await failure(hostingApi.pullRequests(repoWithOrigin(GH_URL)))
    expect(gh).toMatch(/The GitHub token stored for github\.com is invalid or has expired/)
    expect(gh).toMatch(/"repo" scope/)
    fetchMock.mockResolvedValueOnce(json(401, { message: '401 Unauthorized' }))
    const gl = await failure(hostingApi.issues(repoWithOrigin('git@gitlab.com:g/p.git')))
    expect(gl).toMatch(/The GitLab token stored for gitlab\.com/)
    expect(gl).toMatch(/"api" scope/)
    expect(gh + gl).not.toContain(GH_TOKEN)
    expect(gh + gl).not.toContain(GL_TOKEN)
  })

  it('403: missing scopes or no access', async () => {
    await addGithub()
    await addGitlab()
    fetchMock.mockResolvedValueOnce(json(403, { message: 'Resource not accessible by personal access token' }, { 'x-ratelimit-remaining': '4999' }))
    const gh = await failure(hostingApi.createIssue(repoWithOrigin(GH_URL), { title: 't' }))
    expect(gh).toMatch(/GitHub denied access while creating the issue/)
    expect(gh).toMatch(/"repo" scope/)
    fetchMock.mockResolvedValueOnce(
      json(403, { error: 'insufficient_scope', error_description: 'The request requires higher privileges than provided by the access token.', scope: 'api' })
    )
    const gl = await failure(hostingApi.pullRequests(repoWithOrigin('git@gitlab.com:g/p.git')))
    expect(gl).toMatch(/GitLab denied access while listing merge requests/)
    expect(gl).toMatch(/"api" scope/)

    fetchMock.mockResolvedValueOnce(json(403, { message: 'Resource protected by organization SAML enforcement.' }, { 'x-github-sso': 'required; url=https://github.com/orgs/x/sso' }))
    expect(await failure(hostingApi.pullRequests(repoWithOrigin(GH_URL)))).toMatch(/SSO/)
  })

  it('404: repository not found or no access', async () => {
    await addGithub()
    await addGitlab()
    fetchMock.mockResolvedValueOnce(json(404, { message: 'Not Found' }))
    const gh = await failure(hostingApi.pullRequests(repoWithOrigin(GH_URL)))
    expect(gh).toMatch(/Repository not found on github\.com, or the connected account has no access/)
    fetchMock.mockResolvedValueOnce(json(404, { message: '404 Project Not Found' }))
    expect(await failure(hostingApi.issues(repoWithOrigin('git@gitlab.com:g/p.git')))).toMatch(/Repository not found on gitlab\.com/)
  })

  it('422: pull request already exists', async () => {
    await addGithub()
    await addGitlab()
    fetchMock.mockResolvedValueOnce(
      json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'A pull request already exists for octocat:feature/x.' }] })
    )
    expect(await failure(hostingApi.createPullRequest(repoWithOrigin(GH_URL), NEW_PR))).toBe('An open pull request already exists for the branch "feature/x".')
    fetchMock.mockResolvedValueOnce(json(409, { message: ['Another open merge request already exists for this source branch: !5'] }))
    expect(await failure(hostingApi.createPullRequest(repoWithOrigin('git@gitlab.com:g/p.git'), NEW_PR))).toBe(
      'An open merge request already exists for the branch "feature/x".'
    )
  })

  it('422: no commits between the branches, unpushed source branch, unknown target, drafts unsupported', async () => {
    await addGithub()
    const repo = repoWithOrigin(GH_URL)
    fetchMock.mockResolvedValueOnce(
      json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'No commits between main and feature/x' }] })
    )
    expect(await failure(hostingApi.createPullRequest(repo, NEW_PR))).toMatch(/There are no commits between "main" and "feature\/x"/)

    fetchMock.mockResolvedValueOnce(json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] }))
    expect(await failure(hostingApi.createPullRequest(repo, NEW_PR))).toBe(
      'The branch "feature/x" does not exist on GitHub: push it before creating the pull request.'
    )

    fetchMock.mockResolvedValueOnce(json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] }))
    expect(await failure(hostingApi.createPullRequest(repo, NEW_PR))).toBe('The target branch "main" does not exist on GitHub.')

    fetchMock.mockResolvedValueOnce(
      json(422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', message: 'Draft pull requests are not supported in this repository.' }] })
    )
    expect(await failure(hostingApi.createPullRequest(repo, { ...NEW_PR, draft: true }))).toMatch(/does not support draft pull requests/)
  })

  it('other validation errors keep the detail the server gave', async () => {
    await addGithub()
    await addGitlab()
    fetchMock.mockResolvedValueOnce(json(422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'title', code: 'missing_field' }] }))
    expect(await failure(hostingApi.createIssue(repoWithOrigin(GH_URL), { title: 't' }))).toBe(
      'GitHub rejected the request while creating the issue: title: missing_field'
    )
    fetchMock.mockResolvedValueOnce(json(400, { message: { title: ["can't be blank", 'is too long'] } }))
    expect(await failure(hostingApi.createIssue(repoWithOrigin('git@gitlab.com:g/p.git'), { title: 't' }))).toBe(
      "GitLab rejected the request while creating the issue: title: can't be blank, is too long"
    )
    fetchMock.mockResolvedValueOnce(json(400, { error: 'source_branch is missing' }))
    expect(await failure(hostingApi.createPullRequest(repoWithOrigin('git@gitlab.com:g/p.git'), NEW_PR))).toMatch(/source_branch is missing/)
  })

  it('rate limiting (GitHub primary / secondary, GitLab 429)', async () => {
    await addGithub()
    await addGitlab()
    const repo = repoWithOrigin(GH_URL)
    const reset = Math.floor(Date.now() / 1000) + 25 * 60
    fetchMock.mockResolvedValueOnce(
      json(403, { message: 'API rate limit exceeded for user ID 1.' }, { 'x-ratelimit-remaining': '0', 'x-ratelimit-reset': String(reset) })
    )
    const primary = await failure(hostingApi.pullRequests(repo))
    expect(primary).toMatch(/GitHub rate limit reached/)
    expect(primary).toMatch(/in about 2[45] min/)

    fetchMock.mockResolvedValueOnce(json(403, { message: 'You have exceeded a secondary rate limit.' }, { 'retry-after': '60' }))
    expect(await failure(hostingApi.issues(repo))).toMatch(/GitHub rate limit reached.*in 60 s/)

    fetchMock.mockResolvedValueOnce(json(429, { message: 'Too Many Requests' }))
    expect(await failure(hostingApi.pullRequests(repoWithOrigin('git@gitlab.com:g/p.git')))).toMatch(/GitLab rate limit reached.*in a few minutes/)
  })

  it('network failures', async () => {
    await addGithub()
    const repo = repoWithOrigin(GH_URL)
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ENOTFOUND', hostname: 'api.github.com' } }))
    expect(await failure(hostingApi.pullRequests(repo))).toMatch(/Could not find the server github\.com/)
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'ECONNREFUSED' } }))
    expect(await failure(hostingApi.pullRequests(repo))).toMatch(/refused the connection/)
    fetchMock.mockRejectedValueOnce(Object.assign(new TypeError('fetch failed'), { cause: { code: 'SELF_SIGNED_CERT_IN_CHAIN' } }))
    expect(await failure(hostingApi.pullRequests(repo))).toMatch(/HTTPS certificate/)
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'))
    expect(await failure(hostingApi.pullRequests(repo))).toBe('Could not connect to github.com. Check your internet connection.')
  })

  it('timeouts abort the request', async () => {
    await addGithub()
    useEnv({ timeoutMs: 30 })
    let aborted = false
    fetchMock.mockImplementationOnce(
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            aborted = true
            reject(new DOMException('This operation was aborted', 'AbortError'))
          })
        })
    )
    const msg = await failure(hostingApi.pullRequests(repoWithOrigin(GH_URL)))
    expect(aborted).toBe(true)
    expect(msg).toMatch(/github\.com did not respond in time/)
  })

  it('server errors, disabled issues and non-JSON answers', async () => {
    await addGithub()
    const repo = repoWithOrigin(GH_URL)
    fetchMock.mockResolvedValueOnce(new Response('<html>502 Bad Gateway</html>', { status: 502 }))
    expect(await failure(hostingApi.pullRequests(repo))).toMatch(/GitHub is having problems right now \(error 502\)/)
    fetchMock.mockResolvedValueOnce(json(410, { message: 'Issues are disabled for this repo' }))
    expect(await failure(hostingApi.issues(repo))).toBe('Issues are disabled for this repository.')
    fetchMock.mockResolvedValueOnce(new Response('<html>login</html>', { status: 200 }))
    expect(await failure(hostingApi.pullRequests(repo))).toMatch(/did not answer like a GitHub server/)
    fetchMock.mockResolvedValueOnce(json(200, { not: 'a list' }))
    expect(await failure(hostingApi.pullRequests(repo))).toMatch(/unexpected response/)
  })

  it('no error of any kind contains the token', async () => {
    await addGithub()
    const repo = repoWithOrigin(GH_URL)
    const responses: (() => Response | Promise<never>)[] = [
      () => json(401, { message: `Bad credentials for ${GH_TOKEN}` }),
      () => json(403, { message: `denied ${GH_TOKEN}` }),
      () => json(404, { message: GH_TOKEN }),
      () => json(422, { message: 'Validation Failed', errors: [{ message: `bad ${GH_TOKEN}` }] }),
      () => json(418, { message: `teapot ${GH_TOKEN}` }),
      () => json(500, { message: GH_TOKEN }),
      () => new Response(`plain ${GH_TOKEN}`, { status: 400 }),
      () => Promise.reject(new Error(`boom ${GH_TOKEN} ${encodeURIComponent(GH_TOKEN)}`))
    ]
    for (const make of responses) {
      fetchMock.mockImplementationOnce(async () => make())
      const msg = await failure(hostingApi.createPullRequest(repo, { title: 't', sourceBranch: 'a', targetBranch: 'b' }))
      expect(msg).not.toContain(GH_TOKEN)
      expect(msg.length).toBeGreaterThan(10)
    }
  })
})

// --- browser ------------------------------------------------------------------------------------------

describe('openExternal', () => {
  it('opens http(s) URLs through the shell', async () => {
    await hostingApi.openExternal('https://github.com/octocat/Hello-World/pull/1')
    await hostingApi.openExternal('  http://gitlab.example.com/a/b  ')
    expect(opened).toEqual(['https://github.com/octocat/Hello-World/pull/1', 'http://gitlab.example.com/a/b'])
  })

  it('rejects everything else', async () => {
    const bad = ['file:///etc/passwd', 'javascript:alert(1)', 'smb://server/share', 'mailto:a@b.c', 'vscode://x', 'data:text/html,x', '/usr/bin/open', 'github.com', '', null, undefined, 42]
    for (const url of bad) await expect(hostingApi.openExternal(url as never), String(url)).rejects.toThrow()
    expect(opened).toEqual([])
  })
})

// --- profiles -----------------------------------------------------------------------------------------

describe('profiles', () => {
  it('starts empty: commits use the git configuration', async () => {
    expect(await hostingApi.profiles()).toEqual({ profiles: [], activeId: null })
    expect(activeIdentity()).toBeNull()
  })

  it('creates, edits, activates and deletes profiles', async () => {
    const work = await hostingApi.saveProfile({ name: 'Work', userName: 'Ana Pérez', userEmail: 'ana@company.com' })
    const personal = await hostingApi.saveProfile({ name: ' Personal ', userName: ' ana ', userEmail: ' ana@example.org ' })
    expect(work.id).toBeTruthy()
    expect(personal).toEqual({ id: personal.id, name: 'Personal', userName: 'ana', userEmail: 'ana@example.org' })
    expect(personal.id).not.toBe(work.id)
    expect(await hostingApi.profiles()).toEqual({ profiles: [work, personal], activeId: null })
    expect(activeIdentity()).toBeNull() // creating does not activate

    await hostingApi.activateProfile(work.id)
    expect((await hostingApi.profiles()).activeId).toBe(work.id)
    expect(activeIdentity()).toEqual({ name: 'Ana Pérez', email: 'ana@company.com' })

    const edited = await hostingApi.saveProfile({ id: work.id, name: 'Work', userName: 'Ana P.', userEmail: 'ana.p@empresa.com' })
    expect(edited.id).toBe(work.id)
    expect((await hostingApi.profiles()).profiles).toEqual([edited, personal])
    expect(activeIdentity()).toEqual({ name: 'Ana P.', email: 'ana.p@empresa.com' }) // edits apply to the active profile

    await hostingApi.activateProfile(personal.id)
    expect(activeIdentity()).toEqual({ name: 'ana', email: 'ana@example.org' })
    await hostingApi.activateProfile(null)
    expect(activeIdentity()).toBeNull()

    await hostingApi.activateProfile(work.id)
    await hostingApi.deleteProfile(work.id) // deleting the active one falls back to the git config
    expect(await hostingApi.profiles()).toEqual({ profiles: [personal], activeId: null })
    expect(activeIdentity()).toBeNull()
    await expect(hostingApi.deleteProfile('missing')).resolves.toBeUndefined()
  })

  it('persists across restarts in a JSON file under userData', async () => {
    const p = await hostingApi.saveProfile({ name: 'Work', userName: 'Ana', userEmail: 'ana@company.com' })
    await hostingApi.activateProfile(p.id)
    const file = join(userData, 'profiles.json')
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({ version: 1, profiles: [p], activeId: p.id })
    useEnv()
    expect(activeIdentity()).toEqual({ name: 'Ana', email: 'ana@company.com' }) // sync, loaded lazily
    expect(await hostingApi.profiles()).toEqual({ profiles: [p], activeId: p.id })
  })

  it('validates input', async () => {
    expect(await failure(hostingApi.saveProfile({ name: 'x', userName: '', userEmail: 'a@b.c' }))).toMatch(/user\.name/)
    expect(await failure(hostingApi.saveProfile({ name: 'x', userName: 'Ana', userEmail: '' }))).toMatch(/user\.email/)
    for (const email of ['ana', 'ana@', '@empresa.com', 'ana @empresa.com', 'ana@emp resa.com', '<ana@company.com>']) {
      expect(await failure(hostingApi.saveProfile({ name: 'x', userName: 'Ana', userEmail: email })), email).toMatch(/email address is not valid/)
    }
    expect(await failure(hostingApi.saveProfile({ name: 'x', userName: 'Ana <x>', userEmail: 'a@b.c' }))).toMatch(/cannot contain/)
    expect(await failure(hostingApi.saveProfile({ name: 'x', userName: 'Ana\nGIT_DIR=x', userEmail: 'a@b.c' }))).toMatch(/cannot contain/)
    expect(await failure(hostingApi.saveProfile({ id: 'ghost', name: 'x', userName: 'Ana', userEmail: 'a@b.c' }))).toMatch(/no longer exists/)
    expect(await failure(hostingApi.activateProfile('ghost'))).toMatch(/no longer exists/)
    expect(await failure(hostingApi.saveProfile(null as never))).toMatch(/user\.name/)
    expect(await hostingApi.profiles()).toEqual({ profiles: [], activeId: null })

    // The display name defaults to the git name.
    expect((await hostingApi.saveProfile({ name: '  ', userName: 'Ana', userEmail: 'a@b.c' })).name).toBe('Ana')
  })

  it('tolerates a corrupt or tampered file', async () => {
    writeFileSync(join(userData, 'profiles.json'), '{ not json')
    useEnv()
    expect(await hostingApi.profiles()).toEqual({ profiles: [], activeId: null })
    expect(activeIdentity()).toBeNull()

    writeFileSync(
      join(userData, 'profiles.json'),
      JSON.stringify({ profiles: [{ id: 'a', name: 'ok', userName: 'Ana', userEmail: 'a@b.c' }, { id: 'b' }, 'junk', null], activeId: 'b' })
    )
    writeFileSync(join(userData, 'hosting-accounts.json'), JSON.stringify({ accounts: [{ kind: 'svn', host: 'x' }, 7, { kind: 'github' }] }))
    useEnv()
    expect(await hostingApi.profiles()).toEqual({ profiles: [{ id: 'a', name: 'ok', userName: 'Ana', userEmail: 'a@b.c' }], activeId: null })
    expect(await hostingApi.accounts()).toEqual([])
  })

  it('never touches the git configuration', async () => {
    const before = sh(emptyRepo(), 'config', '--global', '--list')
    const p = await hostingApi.saveProfile({ name: 'Work', userName: 'Otra Persona', userEmail: 'otra@empresa.com' })
    await hostingApi.activateProfile(p.id)
    expect(sh(emptyRepo(), 'config', '--global', '--list')).toBe(before)
    expect(before).toContain('user.name=Test User')
  })
})
