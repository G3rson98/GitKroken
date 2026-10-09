// The environment and base config every git invocation runs with.
import { readFileSync, utimesSync } from 'fs'
import { join } from 'path'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'

const hosting = vi.hoisted(() => ({
  identity: vi.fn<() => { name: string; email: string } | null>(() => null)
}))
vi.mock('../hosting', () => ({
  credentialsForHost: () => null,
  activeIdentity: () => hosting.identity()
}))

import { coreApi as api } from '../core'
import { git } from '../exec'
import { cleanupAll, commitFiles, seededRepo, setupGitEnv, sh, tmpDir, write } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

const LOCATION_VARS = [
  'GIT_DIR',
  'GIT_WORK_TREE',
  'GIT_INDEX_FILE',
  'GIT_COMMON_DIR',
  'GIT_NAMESPACE',
  'GIT_OBJECT_DIRECTORY',
  'GIT_ALTERNATE_OBJECT_DIRECTORIES',
  'GIT_PREFIX'
]

afterEach(() => {
  for (const name of LOCATION_VARS) delete process.env[name]
  hosting.identity.mockReset()
  hosting.identity.mockReturnValue(null)
})

describe('inherited repository-location variables', () => {
  it('git acts on the repository it was asked about, not on the one GIT_DIR points at', async () => {
    const victim = seededRepo().repo
    const { repo, first } = seededRepo()
    commitFiles(repo, { 'b.txt': 'b\n' }, 'second')
    write(victim, 'a.txt', 'precious uncommitted work\n')
    write(victim, 'untracked.txt', 'also precious\n')
    write(repo, 'a.txt', 'throw-away\n')

    // The app was started from a hook / terminal of another repository.
    process.env['GIT_DIR'] = join(victim, '.git')
    process.env['GIT_WORK_TREE'] = victim
    process.env['GIT_INDEX_FILE'] = join(victim, '.git', 'index')
    process.env['GIT_COMMON_DIR'] = join(victim, '.git')
    process.env['GIT_OBJECT_DIRECTORY'] = join(victim, '.git', 'objects')
    process.env['GIT_ALTERNATE_OBJECT_DIRECTORIES'] = join(victim, '.git', 'objects')
    process.env['GIT_NAMESPACE'] = 'elsewhere'
    process.env['GIT_PREFIX'] = 'sub/'

    expect((await git(repo, ['rev-parse', '--show-toplevel'])).trim()).toBe(repo)
    expect((await api.log(repo)).map((c) => c.subject)).toEqual(['second', 'first'])
    expect((await api.status(repo)).unstaged.map((f) => f.path)).toEqual(['a.txt'])
    const seen = await git(repo, ['-c', `alias.vars=!echo "${LOCATION_VARS.map((v) => `\${${v}:-}`).join('|')}"`, 'vars'])
    // (git itself exports GIT_DIR / GIT_PREFIX to aliases; what matters is that none points at the victim.)
    expect(seen).not.toContain(victim)
    expect(seen).not.toContain('elsewhere')

    await api.discardAll(repo)
    await api.reset(repo, first, 'hard')
    expect(readFileSync(join(repo, 'a.txt'), 'utf8')).toBe('one\n')

    for (const name of LOCATION_VARS) delete process.env[name]
    expect(readFileSync(join(victim, 'a.txt'), 'utf8')).toBe('precious uncommitted work\n')
    expect(readFileSync(join(victim, 'untracked.txt'), 'utf8')).toBe('also precious\n')
    expect(sh(victim, 'log', '--format=%s')).toBe('first')
  })

  it('a caller can still set them on purpose', async () => {
    const { repo } = seededRepo()
    const index = join(tmpDir(), 'scratch-index')
    await git(repo, ['read-tree', 'HEAD'], { env: { GIT_INDEX_FILE: index } })
    expect((await git(repo, ['ls-files'], { env: { GIT_INDEX_FILE: index } })).trim()).toBe('a.txt')
  })
})

describe('base config', () => {
  it('a read-only diff does not rewrite the index', async () => {
    const { repo } = seededRepo()
    write(repo, 'b.txt', 'b\n')
    sh(repo, 'add', 'b.txt')
    // Same content, different timestamp: the cached stat data is now stale,
    // which is what makes a plain `git diff` refresh (rewrite) the index.
    const old = new Date(Date.now() - 3_600_000)
    utimesSync(join(repo, 'a.txt'), old, old)
    const before = readFileSync(join(repo, '.git', 'index'))

    expect(await api.diff(repo, { path: 'a.txt' })).toBe('')
    expect(await api.diff(repo, { path: 'b.txt', staged: true })).toContain('+b')
    await git(repo, ['diff'])
    expect(readFileSync(join(repo, '.git', 'index')).equals(before)).toBe(true)

    // A real change is still reported.
    write(repo, 'a.txt', 'changed\n')
    expect(await api.diff(repo, { path: 'a.txt' })).toContain('+changed')
    expect((await api.status(repo)).unstaged.map((f) => f.path)).toEqual(['a.txt'])
  })
})

describe('active profile identity', () => {
  const who = (repo: string): string => sh(repo, 'log', '-1', '--format=%an <%ae> / %cn <%ce>')

  it('commits use the active profile; without one, the git config', async () => {
    const { repo } = seededRepo()
    write(repo, 'a.txt', 'two\n')
    await api.stageAll(repo)
    await api.commit(repo, 'with config identity')
    expect(who(repo)).toBe('Test User <test@example.com> / Test User <test@example.com>')

    hosting.identity.mockReturnValue({ name: 'Ana Trabajo', email: 'ana@empresa.example' })
    write(repo, 'a.txt', 'three\n')
    await api.stageAll(repo)
    await api.commit(repo, 'with profile identity')
    expect(who(repo)).toBe('Ana Trabajo <ana@empresa.example> / Ana Trabajo <ana@empresa.example>')
    // The user's configuration is not modified.
    expect(sh(repo, 'config', 'user.name')).toBe('Test User')
    expect(await git(repo, ['-c', 'alias.id=!echo "$GIT_AUTHOR_NAME|$GIT_AUTHOR_EMAIL|$GIT_COMMITTER_NAME|$GIT_COMMITTER_EMAIL"', 'id'])).toBe(
      'Ana Trabajo|ana@empresa.example|Ana Trabajo|ana@empresa.example\n'
    )
  })

  it('a profile store that throws never stops git', async () => {
    const { repo, first } = seededRepo()
    hosting.identity.mockImplementation(() => {
      throw new Error('broken store')
    })
    expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(first)
  })
})
