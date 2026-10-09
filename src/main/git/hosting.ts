// Hosting integrations (GitHub / GitLab), accounts and commit profiles.
//
// Everything that needs Electron (userData path, safeStorage, shell) goes
// through a small `HostingEnv` that is resolved lazily, so this module loads in
// plain Node: tests inject their own env with `setHostingEnv`, and outside
// Electron the default env is simply "unavailable" (no accounts, no profile).
//
// Secrets: a personal access token is only ever held in memory (decrypted) and
// on disk encrypted with safeStorage. It never appears in a return value, a log
// line or an error message (see `scrub`).
import { randomUUID } from 'crypto'
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import type { Account, GitApi, HostKind, HostedRepo, Issue, NewPullRequest, Profile, ProfileList, PullRequest } from '@shared/types'
import { tryGit } from './exec'

// --- environment ----------------------------------------------------------------------------

export interface SafeStorageLike {
  isEncryptionAvailable(): boolean
  encryptString(plain: string): Buffer
  decryptString(encrypted: Buffer): string
  /** Linux only: `basic_text` means there is no real keyring behind it */
  getSelectedStorageBackend?(): string
}

export interface HostingEnv {
  /** Directory where the accounts and profiles files live (`app.getPath('userData')`) */
  userData: string
  safeStorage: SafeStorageLike
  openExternal(url: string): Promise<void>
  /** Request timeout; default 15 s */
  timeoutMs?: number
}

const ACCOUNTS_FILE = 'hosting-accounts.json'
const PROFILES_FILE = 'profiles.json'
const DEFAULT_TIMEOUT = 15_000
/** How many pull requests / issues a list returns at most */
export const LIST_LIMIT = 50

let injectedEnv: HostingEnv | null | undefined
let electronEnv: HostingEnv | null | undefined

function loadElectronEnv(): HostingEnv | null {
  // Plain Node (vitest, scripts): `require('electron')` would only return the
  // path of the binary, so do not even try.
  if (!process.versions['electron']) return null
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const electron = require('electron') as typeof import('electron')
    if (!electron?.app || !electron.safeStorage || !electron.shell) return null
    return {
      userData: electron.app.getPath('userData'),
      safeStorage: electron.safeStorage,
      openExternal: (url) => electron.shell.openExternal(url)
    }
  } catch {
    return null
  }
}

function currentEnv(): HostingEnv | null {
  if (injectedEnv !== undefined) return injectedEnv
  if (electronEnv === undefined) electronEnv = loadElectronEnv()
  return electronEnv
}

function requireEnv(): HostingEnv {
  const env = currentEnv()
  if (!env) throw new Error('Accounts and profiles are only available inside the app.')
  return env
}

/**
 * Replaces the Electron-backed environment (tests) and drops every in-memory
 * cache. `undefined` goes back to the lazily resolved Electron environment.
 */
export function setHostingEnv(env: HostingEnv | null | undefined): void {
  injectedEnv = env
  electronEnv = undefined
  accountCache = null
  profileCache = null
}

// --- small helpers ----------------------------------------------------------------------------

const KINDS: readonly HostKind[] = ['github', 'gitlab']
const KIND_NAME: Record<HostKind, string> = { github: 'GitHub', gitlab: 'GitLab' }
/** What a pull request is called on each provider */
const PR_NAME: Record<HostKind, string> = { github: 'pull request', gitlab: 'merge request' }
const SCOPE_HINT: Record<HostKind, string> = {
  github: 'the "repo" scope',
  gitlab: 'the "api" scope'
}

/** Removes the token from a text. Applied to every error message that leaves this module. */
function scrub(text: string, ...secrets: (string | null | undefined)[]): string {
  let out = text
  for (const secret of secrets) {
    if (!secret) continue
    out = out.split(secret).join('***')
    const encoded = encodeURIComponent(secret)
    if (encoded !== secret) out = out.split(encoded).join('***')
  }
  return out
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v)
/** Arguments arrive over IPC: never trust their shape */
const asRecord = (v: unknown): Record<string, unknown> => (isRecord(v) ? v : {})
const str = (v: unknown): string => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const unixSeconds = (v: unknown): number => {
  const ms = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : 0
}

function writePrivateFile(dir: string, name: string, content: string): void {
  mkdirSync(dir, { recursive: true })
  const file = join(dir, name)
  const tmp = `${file}.${process.pid}.tmp`
  try {
    // Created 0600 from the start, then moved into place: the secret file never
    // exists with wider permissions, not even for a moment.
    writeFileSync(tmp, content, { mode: 0o600 })
    chmodSync(tmp, 0o600)
    renameSync(tmp, file)
  } catch (err) {
    rmSync(tmp, { force: true })
    throw new Error(`Could not save ${name}: ${(err as NodeJS.ErrnoException).code ?? 'write error'}`)
  }
}

function readJson(dir: string, name: string): unknown {
  try {
    return JSON.parse(readFileSync(join(dir, name), 'utf8'))
  } catch {
    return null
  }
}

// --- hosts ------------------------------------------------------------------------------------

/**
 * `https://GitLab.Example.com/foo/` -> `gitlab.example.com`. Keeps an explicit
 * port. Throws when what is left is not a plain host name.
 */
export function normalizeHost(input: unknown): string {
  if (typeof input !== 'string') throw new Error('Enter the host')
  let host = input.trim().toLowerCase()
  host = host.replace(/^[a-z][a-z0-9+.-]*:\/\//, '') // scheme
  host = host.split(/[/?#\\]/)[0] ?? '' // path, query (a backslash is a slash for browsers)
  host = host.slice(host.lastIndexOf('@') + 1) // user info
  host = host.replace(/\.$/, '')
  if (host === 'www.github.com' || host === 'api.github.com') host = 'github.com'
  if (host === 'www.gitlab.com') host = 'gitlab.com'
  if (!host) throw new Error('Enter the host')
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host) || host.includes('..')) {
    throw new Error('Invalid host: enter just the host name, for example "gitlab.mycompany.com"')
  }
  return host
}

const hostName = (host: string): string => host.replace(/:\d+$/, '')

/** SSH endpoints that live on a different host name than the web / API */
const SSH_ALIASES: Record<string, string> = {
  'ssh.github.com': 'github.com',
  'altssh.gitlab.com': 'gitlab.com'
}

function apiBase(kind: HostKind, host: string): string {
  if (kind === 'gitlab') return `https://${host}/api/v4`
  if (host === 'github.com') return 'https://api.github.com'
  // GitHub Enterprise Cloud with data residency
  if (host.endsWith('.ghe.com')) return `https://api.${host}`
  // GitHub Enterprise Server
  return `https://${host}/api/v3`
}

// --- remote URL parsing -------------------------------------------------------------------------

export interface ParsedRemote {
  /** Lower-cased host; includes the port only for http(s) URLs */
  host: string
  /** Path segments without the trailing `.git`: `['group', 'sub', 'name']` */
  segments: string[]
}

/** Parses the URL of a git remote. Null for local paths and anything that is not `host + path`. */
export function parseRemoteUrl(raw: unknown): ParsedRemote | null {
  if (typeof raw !== 'string') return null
  const url = raw.trim()
  if (!url) return null

  let host: string
  let path: string
  const withScheme = /^([a-z][a-z0-9+.-]*):\/\/(.*)$/i.exec(url)
  if (withScheme) {
    const scheme = (withScheme[1] ?? '').toLowerCase()
    if (!['http', 'https', 'ssh', 'git', 'git+ssh', 'ssh+git'].includes(scheme)) return null
    const rest = withScheme[2] ?? ''
    const slash = rest.indexOf('/')
    if (slash < 0) return null
    let authority = rest.slice(0, slash)
    path = rest.slice(slash + 1)
    authority = authority.slice(authority.lastIndexOf('@') + 1)
    // The port of an ssh / git URL says nothing about where the web UI lives.
    host = scheme === 'http' || scheme === 'https' ? authority : hostName(authority)
  } else {
    // scp-like: [user@]host:path. A single-letter "host" is a Windows drive.
    const scp = /^(?:[^@/\\:\s]+@)?([^@/\\:\s]+):(?!\/\/)(.+)$/.exec(url)
    if (!scp) return null
    host = scp[1] ?? ''
    path = scp[2] ?? ''
    if (host.length < 2) return null
    // `host:2222/owner/name` is not valid scp syntax, but people write it.
    path = path.replace(/^\d+\//, '')
  }

  host = host.toLowerCase()
  if (!/^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:\d{1,5})?$/.test(host)) return null
  host = SSH_ALIASES[host] ?? host
  if (host === 'www.github.com') host = 'github.com'
  if (host === 'www.gitlab.com') host = 'gitlab.com'

  path = (path.split(/[?#]/)[0] ?? '').replace(/^\/+/, '').replace(/\/+$/, '').replace(/\.git$/i, '')
  const segments = path.split('/')
  if (segments.length < 2) return null
  for (const s of segments) {
    if (!/^[A-Za-z0-9_.~-]+$/.test(s) || s === '.' || s === '..') return null
  }
  return { host, segments }
}

// --- accounts ------------------------------------------------------------------------------------

interface StoredAccount {
  account: Account
  /** base64 of safeStorage.encryptString(token) */
  enc: string
  /** Decrypted lazily; null while it could not be decrypted */
  token: string | null
}

let accountCache: StoredAccount[] | null = null

function parseAccount(v: unknown): StoredAccount | null {
  if (!isRecord(v)) return null
  const kind = v['kind']
  const host = v['host']
  const username = v['username']
  const enc = v['token']
  if ((kind !== 'github' && kind !== 'gitlab') || typeof host !== 'string' || typeof username !== 'string' || typeof enc !== 'string') {
    return null
  }
  const account: Account = { id: `${kind}:${host}`, kind, host, username }
  if (typeof v['name'] === 'string' && v['name']) account.name = v['name']
  if (typeof v['avatarUrl'] === 'string' && v['avatarUrl']) account.avatarUrl = v['avatarUrl']
  return { account, enc, token: null }
}

function loadAccounts(): StoredAccount[] {
  if (accountCache) return accountCache
  const env = currentEnv()
  if (!env) return []
  const raw = readJson(env.userData, ACCOUNTS_FILE)
  const list = isRecord(raw) && Array.isArray(raw['accounts']) ? raw['accounts'] : []
  accountCache = list.map(parseAccount).filter((a): a is StoredAccount => a !== null)
  return accountCache
}

function persistAccounts(env: HostingEnv, list: StoredAccount[]): void {
  const accounts = list.map((s) => ({ ...s.account, token: s.enc }))
  writePrivateFile(env.userData, ACCOUNTS_FILE, JSON.stringify({ version: 1, accounts }, null, 2))
}

/** Why tokens cannot be stored right now, or null when encryption is usable */
function encryptionProblem(env: HostingEnv): string | null {
  let available = false
  try {
    available = env.safeStorage.isEncryptionAvailable()
  } catch {
    available = false
  }
  if (!available) {
    return 'Encrypted storage is not available on this system (no system keychain), so the token was not saved: GitKroken never stores tokens in plain text.'
  }
  let backend = ''
  try {
    backend = env.safeStorage.getSelectedStorageBackend?.() ?? ''
  } catch {
    backend = ''
  }
  if (backend === 'basic_text') {
    return 'No system keyring was found (gnome-keyring, KWallet…) and the encryption available without one does not protect the token, so it was not saved: GitKroken never stores tokens in plain text.'
  }
  return null
}

function tokenOf(entry: StoredAccount): string | null {
  if (entry.token !== null) return entry.token
  const env = currentEnv()
  if (!env || encryptionProblem(env)) return null
  try {
    const token = env.safeStorage.decryptString(Buffer.from(entry.enc, 'base64'))
    entry.token = token || null
  } catch {
    entry.token = null
  }
  return entry.token
}

function findAccount(host: string): StoredAccount | null {
  const list = loadAccounts()
  return list.find((s) => s.account.host === host) ?? list.find((s) => hostName(s.account.host) === hostName(host)) ?? null
}

async function accounts(): Promise<Account[]> {
  return loadAccounts().map((s) => ({ ...s.account }))
}

async function addAccount(kind: HostKind, host: string, token: string): Promise<Account> {
  const secret = typeof token === 'string' ? token.trim() : ''
  try {
    if (!KINDS.includes(kind)) throw new Error('Unsupported provider: use GitHub or GitLab')
    const cleanHost = normalizeHost(host)
    if (!secret) throw new Error('Enter the personal access token')
    // Anything else could not travel in an HTTP header anyway.
    if (!/^[\x21-\x7e]+$/.test(secret)) throw new Error('The token contains invalid characters (spaces or line breaks)')

    const env = requireEnv()
    const problem = encryptionProblem(env)
    if (problem) throw new Error(problem)

    const res = await request({ kind, host: cleanHost, token: secret }, 'GET', '/user', { action: 'validating the token', validating: true })
    const user = isRecord(res.data) ? res.data : {}
    const username = str(kind === 'github' ? user['login'] : user['username'])
    if (!username) throw new Error(`${cleanHost} did not answer like a ${KIND_NAME[kind]} server. Check the host.`)

    if (kind === 'github') {
      // Classic tokens list their scopes; fine-grained ones send no such header.
      const scopes = res.headers.get('x-oauth-scopes')
      if (scopes !== null) {
        const granted = scopes.split(',').map((s) => s.trim())
        if (!granted.includes('repo') && !granted.includes('public_repo')) {
          throw new Error('The token is valid but lacks the "repo" scope, which is needed to list and create pull requests and issues. Create a token with that scope.')
        }
      }
    }

    const account: Account = { id: `${kind}:${cleanHost}`, kind, host: cleanHost, username }
    const name = str(user['name'])
    if (name) account.name = name
    const avatar = str(user['avatar_url'])
    if (/^https:\/\//.test(avatar)) account.avatarUrl = avatar

    const enc = env.safeStorage.encryptString(secret).toString('base64')
    const next = [...loadAccounts().filter((s) => s.account.id !== account.id), { account, enc, token: secret }]
    persistAccounts(env, next)
    accountCache = next
    return { ...account }
  } catch (err) {
    throw new Error(scrub(err instanceof Error ? err.message : String(err), secret, typeof token === 'string' ? token : null))
  }
}

async function removeAccount(id: string): Promise<void> {
  const env = requireEnv()
  const list = loadAccounts()
  const next = list.filter((s) => s.account.id !== id)
  if (next.length === list.length) return
  persistAccounts(env, next)
  accountCache = next
}

/**
 * Stored token usable as HTTPS git credentials for `host`, if an account exists.
 * The match is exact (host and port): a token is never offered to another
 * port of the same machine. Only use the result for `https://` remotes.
 */
export function credentialsForHost(host: string): { username: string; password: string } | null {
  try {
    const wanted = normalizeHost(host)
    const entry = loadAccounts().find((s) => s.account.host === wanted)
    if (!entry) return null
    const token = tokenOf(entry)
    if (!token) return null
    // GitLab accepts any user name with a token; `oauth2` is the documented one.
    return { username: entry.account.kind === 'gitlab' ? 'oauth2' : entry.account.username, password: token }
  } catch {
    return null
  }
}

// --- HTTP -----------------------------------------------------------------------------------------

interface ApiContext {
  kind: HostKind
  host: string
  token: string
}

interface RequestOptions {
  /** Gerund describing the call, used in messages: "listing pull requests" */
  action: string
  query?: Record<string, string | number>
  body?: Record<string, unknown>
  /** True while checking a token that is not stored yet */
  validating?: boolean
  /** Branch names of a pull request being created, to explain validation errors */
  branches?: { source: string; target: string }
}

interface ApiResponse {
  data: unknown
  headers: Headers
}

function networkMessage(host: string, err: unknown, timedOut: boolean, timeoutMs: number): string {
  if (timedOut) return `${host} did not respond in time (${Math.round(timeoutMs / 1000)} s). Check your connection and try again.`
  const cause = isRecord(err) && isRecord(err['cause']) ? err['cause'] : isRecord(err) ? err : {}
  const code = str(cause['code'])
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return `Could not find the server ${host}. Check the host name and your internet connection.`
  if (code === 'ECONNREFUSED') return `${host} refused the connection.`
  if (/CERT|SELF_SIGNED|UNABLE_TO_VERIFY/.test(code)) {
    return `Could not verify the HTTPS certificate of ${host} (${code}).`
  }
  return `Could not connect to ${host}. Check your internet connection.`
}

/** Seconds until the rate limit resets, from whichever header the provider sent */
function retryAfterSeconds(headers: Headers): number | null {
  const retry = Number(headers.get('retry-after'))
  if (Number.isFinite(retry) && retry > 0) return retry
  const reset = Number(headers.get('x-ratelimit-reset') ?? headers.get('ratelimit-reset'))
  if (Number.isFinite(reset) && reset > 0) {
    const wait = reset - Math.floor(Date.now() / 1000)
    return wait > 0 ? wait : null
  }
  return null
}

/** Flattens the many shapes of provider error bodies into plain sentences */
function errorDetails(body: unknown): { text: string; fields: { field: string; code: string; message: string }[] } {
  const parts: string[] = []
  const fields: { field: string; code: string; message: string }[] = []
  const push = (v: unknown): void => {
    if (typeof v === 'string' && v.trim()) parts.push(v.trim())
    else if (Array.isArray(v)) v.forEach(push)
    else if (isRecord(v)) {
      // GitLab: { message: { title: ["can't be blank"] } }
      for (const [key, value] of Object.entries(v)) {
        const texts = (Array.isArray(value) ? value : [value]).filter((t): t is string => typeof t === 'string')
        if (texts.length) parts.push(`${key}: ${texts.join(', ')}`)
      }
    }
  }
  if (isRecord(body)) {
    push(body['message'])
    push(body['error_description'])
    if (typeof body['error'] === 'string') push(body['error'])
    if (Array.isArray(body['errors'])) {
      // GitHub: { errors: [{ resource, field, code, message }] }
      for (const e of body['errors']) {
        if (typeof e === 'string') parts.push(e)
        else if (isRecord(e)) {
          const item = { field: str(e['field']), code: str(e['code']), message: str(e['message']) }
          fields.push(item)
          if (item.message) parts.push(item.message)
          else if (item.field) parts.push(`${item.field}: ${item.code || 'invalid'}`)
        }
      }
    }
  } else if (typeof body === 'string' && body.trim() && !/^\s*</.test(body)) {
    parts.push(body.trim().slice(0, 300))
  }
  const seen = new Set<string>()
  const unique = parts.filter((p) => p !== 'Validation Failed' && (seen.has(p) ? false : (seen.add(p), true)))
  return { text: unique.join('. ').slice(0, 500), fields }
}

function validationMessage(ctx: ApiContext, body: unknown, opts: RequestOptions): string {
  const { text, fields } = errorDetails(body)
  const pr = PR_NAME[ctx.kind]
  const source = opts.branches?.source
  const target = opts.branches?.target
  if (/pull request already exists|another open merge request already exists/i.test(text)) {
    return `An open ${pr} already exists for the branch "${source ?? '?'}".`
  }
  if (/no commits between/i.test(text)) {
    return `There are no commits between "${target ?? '?'}" and "${source ?? '?'}": nothing to propose. Commit and push to "${source ?? '?'}" first.`
  }
  if (/same project\/branch|source.+target.+(same|identical)|can't use same/i.test(text)) {
    return 'The source and target branches are the same.'
  }
  if (/draft pull requests are not supported/i.test(text)) {
    return 'This repository does not support draft pull requests. Uncheck "Draft" and try again.'
  }
  if (fields.some((f) => f.field === 'head' && f.code === 'invalid') || /source[_ ]branch.+(does not exist|is invalid)/i.test(text)) {
    return `The branch "${source ?? '?'}" does not exist on ${KIND_NAME[ctx.kind]}: push it before creating the ${pr}.`
  }
  if (fields.some((f) => f.field === 'base' && f.code === 'invalid') || /target[_ ]branch.+(does not exist|is invalid)/i.test(text)) {
    return `The target branch "${target ?? '?'}" does not exist on ${KIND_NAME[ctx.kind]}.`
  }
  return text
    ? `${KIND_NAME[ctx.kind]} rejected the request while ${opts.action}: ${text}`
    : `${KIND_NAME[ctx.kind]} rejected the request while ${opts.action} (invalid data).`
}

function httpErrorMessage(ctx: ApiContext, status: number, headers: Headers, body: unknown, opts: RequestOptions): string {
  const provider = KIND_NAME[ctx.kind]
  const { text } = errorDetails(body)

  const rateLimited =
    status === 429 ||
    (status === 403 && (headers.get('x-ratelimit-remaining') === '0' || headers.has('retry-after') || /rate limit|abuse detection/i.test(text)))
  if (rateLimited) {
    const wait = retryAfterSeconds(headers)
    const when = wait === null ? 'in a few minutes' : wait < 90 ? `in ${Math.ceil(wait)} s` : `in about ${Math.ceil(wait / 60)} min`
    return `${provider} rate limit reached. Try again ${when}.`
  }

  if (status === 401) {
    return opts.validating
      ? `${provider} rejected the token: it is invalid or has expired.`
      : `The ${provider} token stored for ${ctx.host} is invalid or has expired. Reconnect the account with a token that has ${SCOPE_HINT[ctx.kind]}.`
  }
  if (status === 403) {
    if (headers.has('x-github-sso')) {
      return `The organization enforces SSO: authorize the token for that organization on GitHub (Settings → Personal access tokens → Configure SSO).`
    }
    return `${provider} denied access while ${opts.action}: the token is missing permissions (it needs ${SCOPE_HINT[ctx.kind]}) or your user has no access to this repository.`
  }
  if (status === 404) {
    return opts.validating
      ? `No ${provider} API was found at ${ctx.host}. Check the host.`
      : `Repository not found on ${ctx.host}, or the connected account has no access to it (the token needs ${SCOPE_HINT[ctx.kind]}).`
  }
  if (status === 410) return 'Issues are disabled for this repository.'
  if (status === 400 || status === 409 || status === 422) return validationMessage(ctx, body, opts)
  if (status >= 500) return `${provider} is having problems right now (error ${status}). Try again later.`
  return `${provider} answered with error ${status} while ${opts.action}${text ? `: ${text}` : '.'}`
}

async function request(ctx: ApiContext, method: 'GET' | 'POST', path: string, opts: RequestOptions): Promise<ApiResponse> {
  const timeoutMs = currentEnv()?.timeoutMs ?? DEFAULT_TIMEOUT
  const url = new URL(apiBase(ctx.kind, ctx.host) + path)
  for (const [key, value] of Object.entries(opts.query ?? {})) url.searchParams.set(key, String(value))
  if (url.protocol !== 'https:') throw new Error('Only HTTPS connections are allowed')

  const headers: Record<string, string> = { 'User-Agent': 'GitKroken' }
  if (ctx.kind === 'github') {
    headers['Accept'] = 'application/vnd.github+json'
    headers['X-GitHub-Api-Version'] = '2022-11-28'
    headers['Authorization'] = `Bearer ${ctx.token}`
  } else {
    headers['Accept'] = 'application/json'
    headers['PRIVATE-TOKEN'] = ctx.token
  }
  if (opts.body) headers['Content-Type'] = 'application/json'

  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    let res: Response
    let text: string
    try {
      res = await globalThis.fetch(url, {
        method,
        headers,
        body: opts.body ? JSON.stringify(opts.body) : undefined,
        signal: controller.signal
      })
      // The timeout also covers a body that never finishes arriving.
      text = await res.text()
    } catch (err) {
      throw new Error(networkMessage(ctx.host, err, timedOut, timeoutMs))
    }

    let data: unknown = null
    let isJson = false
    if (text) {
      try {
        data = JSON.parse(text)
        isJson = true
      } catch {
        data = text
      }
    }
    if (!res.ok) throw new Error(httpErrorMessage(ctx, res.status, res.headers, data, opts))
    if (text && !isJson) throw new Error(`${ctx.host} did not answer like a ${KIND_NAME[ctx.kind]} server. Check the host.`)
    return { data, headers: res.headers }
  } catch (err) {
    throw new Error(scrub(err instanceof Error ? err.message : String(err), ctx.token))
  } finally {
    clearTimeout(timer)
  }
}

// --- hosted repository --------------------------------------------------------------------------------

async function hostedRepo(repo: string): Promise<HostedRepo | null> {
  if (typeof repo !== 'string' || !repo) return null
  const url = await tryGit(repo, ['remote', 'get-url', 'origin'])
  const parsed = parseRemoteUrl(url)
  if (!parsed) return null

  const stored = findAccount(parsed.host)
  const name = hostName(parsed.host)
  const kind: HostKind | null = stored ? stored.account.kind : name === 'github.com' ? 'github' : name === 'gitlab.com' ? 'gitlab' : null
  if (!kind) return null
  // GitHub has no nested namespaces: anything deeper is not a repository URL.
  if (kind === 'github' && parsed.segments.length !== 2) return null

  // The account knows the HTTPS host (an ssh remote carries no web port).
  const host = stored ? stored.account.host : parsed.host
  const repoName = parsed.segments[parsed.segments.length - 1] ?? ''
  const owner = parsed.segments.slice(0, -1).join('/')
  return {
    kind,
    host,
    owner,
    name: repoName,
    webUrl: `https://${host}/${owner}/${repoName}`,
    account: stored ? { ...stored.account } : null
  }
}

interface Target {
  ctx: ApiContext
  hosted: HostedRepo
  /** API path prefix of the repository / project */
  base: string
}

async function target(repo: string): Promise<Target> {
  const hosted = await hostedRepo(repo)
  if (!hosted) throw new Error('The "origin" remote of this repository does not point to GitHub or GitLab.')
  const provider = KIND_NAME[hosted.kind]
  const stored = findAccount(hosted.host)
  if (!stored || stored.account.kind !== hosted.kind) {
    throw new Error(`No ${provider} account is connected for ${hosted.host}. Connect one in "Profiles & Accounts".`)
  }
  const token = tokenOf(stored)
  if (!token) {
    throw new Error(`Could not decrypt the token stored for ${hosted.host}. Reconnect the ${provider} account in "Profiles & Accounts".`)
  }
  const base =
    hosted.kind === 'github'
      ? `/repos/${encodeURIComponent(hosted.owner)}/${encodeURIComponent(hosted.name)}`
      : `/projects/${encodeURIComponent(`${hosted.owner}/${hosted.name}`)}`
  return { ctx: { kind: hosted.kind, host: stored.account.host, token }, hosted, base }
}

// --- mapping ----------------------------------------------------------------------------------------

const login = (user: unknown, key: 'login' | 'username'): string => (isRecord(user) ? str(user[key]) : '')

export function mapGithubPull(raw: unknown): PullRequest | null {
  if (!isRecord(raw) || typeof raw['number'] !== 'number') return null
  const head = isRecord(raw['head']) ? raw['head'] : {}
  const base = isRecord(raw['base']) ? raw['base'] : {}
  const headRepo = isRecord(head['repo']) ? str(head['repo']['full_name']) : ''
  const baseRepo = isRecord(base['repo']) ? str(base['repo']['full_name']) : ''
  // A pull request from a fork: its branch does not exist in this repository,
  // so show it the way GitHub does (`user:branch`).
  const fromFork = headRepo !== baseRepo
  return {
    number: raw['number'],
    title: str(raw['title']),
    author: login(raw['user'], 'login'),
    state: raw['merged_at'] || raw['merged'] === true ? 'merged' : raw['state'] === 'closed' ? 'closed' : 'open',
    draft: raw['draft'] === true,
    sourceBranch: fromFork && str(head['label']) ? str(head['label']) : str(head['ref']),
    targetBranch: str(base['ref']),
    url: str(raw['html_url']),
    updatedAt: unixSeconds(raw['updated_at'])
  }
}

/** Title prefixes GitLab treats as "draft": `Draft:`, `[Draft]`, `(Draft)` and the older `WIP:` / `[WIP]` */
const DRAFT_TITLE = /^\s*(\[(draft|wip)\]|\(draft\)|(draft|wip):)/i

export function mapGitlabMergeRequest(raw: unknown): PullRequest | null {
  if (!isRecord(raw) || typeof raw['iid'] !== 'number') return null
  const state = raw['state']
  const fromFork =
    typeof raw['source_project_id'] === 'number' &&
    typeof raw['target_project_id'] === 'number' &&
    raw['source_project_id'] !== raw['target_project_id']
  const title = str(raw['title'])
  return {
    number: raw['iid'],
    title,
    author: login(raw['author'], 'username'),
    state: state === 'merged' ? 'merged' : state === 'closed' || state === 'locked' ? 'closed' : 'open',
    // `draft` replaced `work_in_progress` in GitLab 14; very old servers only mark the title.
    draft:
      typeof raw['draft'] === 'boolean'
        ? raw['draft']
        : typeof raw['work_in_progress'] === 'boolean'
          ? raw['work_in_progress']
          : DRAFT_TITLE.test(title),
    sourceBranch: fromFork ? `fork:${str(raw['source_branch'])}` : str(raw['source_branch']),
    targetBranch: str(raw['target_branch']),
    url: str(raw['web_url']),
    updatedAt: unixSeconds(raw['updated_at'])
  }
}

function labelNames(raw: unknown): string[] {
  if (!Array.isArray(raw)) return []
  return raw.map((l) => (typeof l === 'string' ? l : isRecord(l) ? str(l['name']) : '')).filter(Boolean)
}

/** Null for the pull requests that GitHub's issues endpoint also returns */
export function mapGithubIssue(raw: unknown): Issue | null {
  if (!isRecord(raw) || typeof raw['number'] !== 'number' || raw['pull_request'] != null) return null
  return {
    number: raw['number'],
    title: str(raw['title']),
    author: login(raw['user'], 'login'),
    state: raw['state'] === 'closed' ? 'closed' : 'open',
    labels: labelNames(raw['labels']),
    url: str(raw['html_url']),
    updatedAt: unixSeconds(raw['updated_at'])
  }
}

export function mapGitlabIssue(raw: unknown): Issue | null {
  if (!isRecord(raw) || typeof raw['iid'] !== 'number') return null
  return {
    number: raw['iid'],
    title: str(raw['title']),
    author: login(raw['author'], 'username'),
    state: raw['state'] === 'closed' ? 'closed' : 'open',
    labels: labelNames(raw['labels']),
    url: str(raw['web_url']),
    updatedAt: unixSeconds(raw['updated_at'])
  }
}

function mapList<T>(data: unknown, map: (raw: unknown) => T | null, ctx: ApiContext): T[] {
  if (!Array.isArray(data)) throw new Error(`${ctx.host} returned an unexpected response. Check that the server is ${KIND_NAME[ctx.kind]}.`)
  return data.map(map).filter((v): v is T => v !== null)
}

function mapOne<T>(data: unknown, map: (raw: unknown) => T | null, ctx: ApiContext): T {
  const value = map(data)
  if (!value) throw new Error(`${ctx.host} returned an unexpected response. Check that the server is ${KIND_NAME[ctx.kind]}.`)
  return value
}

const byUpdated = (a: { updatedAt: number }, b: { updatedAt: number }): number => b.updatedAt - a.updatedAt

// --- pull requests & issues ---------------------------------------------------------------------------

async function pullRequests(repo: string): Promise<PullRequest[]> {
  const { ctx, base } = await target(repo)
  const action = `listing ${PR_NAME[ctx.kind]}s`
  if (ctx.kind === 'github') {
    const res = await request(ctx, 'GET', `${base}/pulls`, {
      action,
      query: { state: 'open', sort: 'updated', direction: 'desc', per_page: LIST_LIMIT }
    })
    return mapList(res.data, mapGithubPull, ctx).sort(byUpdated).slice(0, LIST_LIMIT)
  }
  const res = await request(ctx, 'GET', `${base}/merge_requests`, {
    action,
    query: { state: 'opened', order_by: 'updated_at', sort: 'desc', per_page: LIST_LIMIT }
  })
  return mapList(res.data, mapGitlabMergeRequest, ctx).sort(byUpdated).slice(0, LIST_LIMIT)
}

function cleanText(value: unknown, what: string, required: boolean): string {
  const text = typeof value === 'string' ? value.trim() : ''
  if (required && !text) throw new Error(`Missing ${what}`)
  return text
}

async function createPullRequest(repo: string, input: NewPullRequest): Promise<PullRequest> {
  const data = asRecord(input)
  const title = cleanText(data['title'], 'title', true)
  const source = cleanText(data['sourceBranch'], 'source branch', true)
  const dest = cleanText(data['targetBranch'], 'target branch', true)
  if (source === dest) throw new Error('The source and target branches are the same.')
  const body = cleanText(data['body'], '', false)
  const draft = data['draft'] === true

  const { ctx, base } = await target(repo)
  const opts = { action: `creating the ${PR_NAME[ctx.kind]}`, branches: { source, target: dest } }
  if (ctx.kind === 'github') {
    const res = await request(ctx, 'POST', `${base}/pulls`, {
      ...opts,
      body: { title, head: source, base: dest, draft, ...(body ? { body } : {}) }
    })
    return mapOne(res.data, mapGithubPull, ctx)
  }
  // GitLab has no draft flag on creation: the title prefix is the documented way.
  const mrTitle = draft && !DRAFT_TITLE.test(title) ? `Draft: ${title}` : title
  const res = await request(ctx, 'POST', `${base}/merge_requests`, {
    ...opts,
    body: { title: mrTitle, source_branch: source, target_branch: dest, ...(body ? { description: body } : {}) }
  })
  return mapOne(res.data, mapGitlabMergeRequest, ctx)
}

async function issues(repo: string): Promise<Issue[]> {
  const { ctx, base } = await target(repo)
  const action = 'listing issues'
  if (ctx.kind === 'gitlab') {
    const res = await request(ctx, 'GET', `${base}/issues`, {
      action,
      query: { state: 'opened', order_by: 'updated_at', sort: 'desc', per_page: LIST_LIMIT }
    })
    return mapList(res.data, mapGitlabIssue, ctx).sort(byUpdated).slice(0, LIST_LIMIT)
  }
  // GitHub mixes pull requests into this endpoint: read a few pages until
  // there are enough real issues (bounded, to stay friendly with rate limits).
  const PER_PAGE = 100
  const MAX_PAGES = 3
  const found: Issue[] = []
  for (let page = 1; page <= MAX_PAGES && found.length < LIST_LIMIT; page++) {
    const res = await request(ctx, 'GET', `${base}/issues`, {
      action,
      query: { state: 'open', sort: 'updated', direction: 'desc', per_page: PER_PAGE, page }
    })
    const raw = Array.isArray(res.data) ? res.data : null
    found.push(...mapList(res.data, mapGithubIssue, ctx))
    if (!raw || raw.length < PER_PAGE) break
  }
  return found.sort(byUpdated).slice(0, LIST_LIMIT)
}

async function createIssue(repo: string, input: { title: string; body?: string }): Promise<Issue> {
  const data = asRecord(input)
  const title = cleanText(data['title'], 'title', true)
  const body = cleanText(data['body'], '', false)
  const { ctx, base } = await target(repo)
  if (ctx.kind === 'github') {
    const res = await request(ctx, 'POST', `${base}/issues`, { action: 'creating the issue', body: { title, ...(body ? { body } : {}) } })
    return mapOne(res.data, mapGithubIssue, ctx)
  }
  const res = await request(ctx, 'POST', `${base}/issues`, {
    action: 'creating the issue',
    body: { title, ...(body ? { description: body } : {}) }
  })
  return mapOne(res.data, mapGitlabIssue, ctx)
}

// --- browser ------------------------------------------------------------------------------------------

async function openExternal(url: string): Promise<void> {
  let parsed: URL
  try {
    parsed = new URL(typeof url === 'string' ? url.trim() : '')
  } catch {
    throw new Error('Invalid URL')
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('Only http and https URLs can be opened')
  }
  await requireEnv().openExternal(parsed.href)
}

// --- profiles -----------------------------------------------------------------------------------------

let profileCache: ProfileList | null = null

function parseProfile(v: unknown): Profile | null {
  if (!isRecord(v)) return null
  const { id, name, userName, userEmail } = v
  if (typeof id !== 'string' || !id || typeof name !== 'string' || typeof userName !== 'string' || typeof userEmail !== 'string') return null
  if (!userName.trim() || !userEmail.trim()) return null
  return { id, name, userName, userEmail }
}

function loadProfiles(): ProfileList {
  if (profileCache) return profileCache
  const env = currentEnv()
  if (!env) return { profiles: [], activeId: null }
  const raw = readJson(env.userData, PROFILES_FILE)
  const profiles = (isRecord(raw) && Array.isArray(raw['profiles']) ? raw['profiles'] : [])
    .map(parseProfile)
    .filter((p): p is Profile => p !== null)
  const wanted = isRecord(raw) && typeof raw['activeId'] === 'string' ? raw['activeId'] : null
  profileCache = { profiles, activeId: profiles.some((p) => p.id === wanted) ? wanted : null }
  return profileCache
}

function persistProfiles(env: HostingEnv, list: ProfileList): void {
  writePrivateFile(env.userData, PROFILES_FILE, JSON.stringify({ version: 1, ...list }, null, 2))
  profileCache = list
}

const snapshot = (list: ProfileList): ProfileList => ({ profiles: list.profiles.map((p) => ({ ...p })), activeId: list.activeId })

async function profiles(): Promise<ProfileList> {
  return snapshot(loadProfiles())
}

async function saveProfile(profile: Omit<Profile, 'id'> & { id?: string }): Promise<Profile> {
  const env = requireEnv()
  const data = asRecord(profile)
  const userName = cleanText(data['userName'], 'the commit author name (user.name)', true)
  const userEmail = cleanText(data['userEmail'], 'the commit author email (user.email)', true)
  // eslint-disable-next-line no-control-regex
  if (/[<>\x00-\x1f\x7f]/.test(userName)) throw new Error('The commit author name cannot contain "<", ">" or line breaks')
  if (!/^[^\s@<>]+@[^\s@<>]+$/.test(userEmail)) throw new Error('The email address is not valid')
  const name = cleanText(data['name'], '', false) || userName

  const list = loadProfiles()
  const id = typeof data['id'] === 'string' && data['id'] ? data['id'] : null
  if (id && !list.profiles.some((p) => p.id === id)) throw new Error('That profile no longer exists')
  const saved: Profile = { id: id ?? randomUUID(), name, userName, userEmail }
  const next = id ? list.profiles.map((p) => (p.id === id ? saved : p)) : [...list.profiles, saved]
  persistProfiles(env, { profiles: next, activeId: list.activeId })
  return { ...saved }
}

async function deleteProfile(id: string): Promise<void> {
  const env = requireEnv()
  const list = loadProfiles()
  if (!list.profiles.some((p) => p.id === id)) return
  persistProfiles(env, {
    profiles: list.profiles.filter((p) => p.id !== id),
    activeId: list.activeId === id ? null : list.activeId
  })
}

async function activateProfile(id: string | null): Promise<void> {
  const env = requireEnv()
  const list = loadProfiles()
  const next = id === null || id === undefined ? null : id
  if (next !== null && !list.profiles.some((p) => p.id === next)) throw new Error('That profile no longer exists')
  if (next === list.activeId) return
  persistProfiles(env, { profiles: list.profiles, activeId: next })
}

/** Identity of the active profile, applied to commits through the git environment */
export function activeIdentity(): { name: string; email: string } | null {
  try {
    const list = loadProfiles()
    const active = list.activeId ? list.profiles.find((p) => p.id === list.activeId) : undefined
    return active ? { name: active.userName, email: active.userEmail } : null
  } catch {
    return null
  }
}

export const hostingApi: Pick<
  GitApi,
  | 'openExternal'
  | 'accounts'
  | 'addAccount'
  | 'removeAccount'
  | 'hostedRepo'
  | 'pullRequests'
  | 'createPullRequest'
  | 'issues'
  | 'createIssue'
  | 'profiles'
  | 'saveProfile'
  | 'deleteProfile'
  | 'activateProfile'
> = {
  openExternal,
  accounts,
  addAccount,
  removeAccount,
  hostedRepo,
  pullRequests,
  createPullRequest,
  issues,
  createIssue,
  profiles,
  saveProfile,
  deleteProfile,
  activateProfile
}
