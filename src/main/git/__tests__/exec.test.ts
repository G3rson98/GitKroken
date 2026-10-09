import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { GitError, assertPaths, assertRef, cleanGitMessage, git, runGit, tryGit } from '../exec'
import { cleanupAll, seededRepo, setupGitEnv, tmpDir } from './helpers'

beforeAll(() => setupGitEnv())
afterAll(() => cleanupAll())

describe('runGit', () => {
  it('returns stdout and honours okCodes', async () => {
    const { repo, first } = seededRepo()
    expect((await git(repo, ['rev-parse', 'HEAD'])).trim()).toBe(first)
    const res = await runGit(repo, ['show-ref', '--verify', '--quiet', 'refs/heads/nope'], { okCodes: [0, 1] })
    expect(res.code).toBe(1)
    expect(await tryGit(repo, ['rev-parse', '--verify', '--quiet', 'nope'])).toBeNull()
  })

  it('rejects with a GitError carrying a clean message', async () => {
    const { repo } = seededRepo()
    const err = await runGit(repo, ['checkout', 'missing-branch', '--']).catch((e: unknown) => e)
    expect(err).toBeInstanceOf(GitError)
    const e = err as GitError
    expect(e.code).toBe(128)
    expect(e.stderr).toContain('fatal:')
    expect(e.message).toBe('invalid reference: missing-branch')
    // What the renderer sees after Electron's IPC wrapping is "Error: <message>".
    expect(String(e)).toBe('Error: invalid reference: missing-branch')
  })

  it('feeds stdin and always closes it', async () => {
    const { repo } = seededRepo()
    const hash = (await git(repo, ['hash-object', '--stdin'], { input: 'hello\n' })).trim()
    expect(hash).toBe('ce013625030ba8dba906f756967f9e9ca394464a')
    // No input given: a command reading stdin sees EOF instead of blocking.
    expect((await git(repo, ['hash-object', '--stdin'])).trim()).toBe('e69de29bb2d1d6434b8b29ae775ad8c2e48c5391')
  })

  it('sets the non-interactive environment and has no controlling terminal', async () => {
    const { repo } = seededRepo()
    const env = await git(repo, [
      '-c',
      'alias.showenv=!echo "$GIT_TERMINAL_PROMPT|$LC_ALL|$GIT_EDITOR|$GIT_OPTIONAL_LOCKS|${GIT_LITERAL_PATHSPECS:-unset}"',
      'showenv'
    ])
    expect(env.trim()).toBe('0|C|true|0|unset')
    const literal = await git(repo, ['-c', 'alias.showenv=!echo "$GIT_LITERAL_PATHSPECS"', 'showenv'], { literal: true })
    expect(literal.trim()).toBe('1')
    if (process.platform !== 'win32') {
      // ssh / gpg prompt by opening /dev/tty; that must be impossible.
      const tty = await git(repo, ['-c', 'alias.tty=!sh -c "(: </dev/tty) 2>/dev/null && echo has-tty || echo no-tty"', 'tty'])
      expect(tty.trim()).toBe('no-tty')
    }
  })

  it('explains a missing folder and refuses bad arguments', async () => {
    await expect(runGit(`${tmpDir()}/gone`, ['status'])).rejects.toThrow(/Folder not found/)
    await expect(runGit('', ['status'])).rejects.toThrow(/No repository path/)
    await expect(runGit(tmpDir(), ['status', 'a\0b'])).rejects.toThrow(/Invalid argument/)
  })

  it('handles output far beyond the default 1 MiB exec buffer', async () => {
    const { repo } = seededRepo()
    const out = await git(repo, ['-c', 'alias.big=!head -c 8000000 /dev/zero | tr "\\\\0" x', 'big'])
    expect(out.length).toBe(8_000_000)
  })
})

describe('cleanGitMessage', () => {
  it('strips prefixes and hints, keeps conflicts from stdout', () => {
    expect(cleanGitMessage('fatal: bad thing\nhint: try harder\n', '', 'x')).toBe('bad thing')
    expect(cleanGitMessage('error: could not apply abc\nhint: resolve\n', 'CONFLICT (content): Merge conflict in a.txt\nAuto-merging a.txt\n', 'x')).toBe(
      'CONFLICT (content): Merge conflict in a.txt\ncould not apply abc'
    )
    expect(cleanGitMessage('', 'Automatic merge failed; fix conflicts\n', 'x')).toBe('Automatic merge failed; fix conflicts')
    expect(cleanGitMessage('', '  \n', 'fallback text')).toBe('fallback text')
  })
})

describe('argument validation', () => {
  it('assertRef', () => {
    expect(assertRef('main')).toBe('main')
    expect(assertRef('origin/feature/x')).toBe('origin/feature/x')
    expect(assertRef('stash@{0}')).toBe('stash@{0}')
    expect(() => assertRef('-x')).toThrow()
    expect(() => assertRef('--force')).toThrow()
    expect(() => assertRef('')).toThrow()
    expect(() => assertRef('a\nb')).toThrow()
    expect(() => assertRef(undefined)).toThrow()
    expect(() => assertRef(42)).toThrow()
  })

  it('assertPaths', () => {
    expect(assertPaths(['a', '-b', 'c d'])).toEqual(['a', '-b', 'c d'])
    expect(() => assertPaths('a')).toThrow()
    expect(() => assertPaths([''])).toThrow()
    expect(() => assertPaths(['a\0b'])).toThrow()
    expect(() => assertPaths([1])).toThrow()
  })
})
