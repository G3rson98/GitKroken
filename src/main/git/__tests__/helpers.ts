// Test helpers: real throw-away repositories under os.tmpdir().
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'

const roots: string[] = []
let clock = 1_700_000_000

/** Isolates git from the developer's own config and gives it an identity. */
export function setupGitEnv(): void {
  const home = realpathSync(mkdtempSync(join(tmpdir(), 'gitkroken-home-')))
  roots.push(home)
  const config = join(home, 'gitconfig')
  writeFileSync(
    config,
    [
      '[user]',
      '\tname = Test User',
      '\temail = test@example.com',
      '[init]',
      '\tdefaultBranch = main',
      '[commit]',
      '\tgpgsign = false',
      '[tag]',
      '\tgpgsign = false',
      '[protocol "file"]',
      '\tallow = always',
      ''
    ].join('\n')
  )
  process.env['HOME'] = home
  process.env['GIT_CONFIG_GLOBAL'] = config
  process.env['GIT_CONFIG_NOSYSTEM'] = '1'
  delete process.env['GIT_DIR']
  delete process.env['GIT_WORK_TREE']
  tick()
}

/** Advances the commit clock so `--date-order` is deterministic. */
export function tick(seconds = 60): void {
  clock += seconds
  const stamp = `${clock} +0000`
  process.env['GIT_AUTHOR_DATE'] = stamp
  process.env['GIT_COMMITTER_DATE'] = stamp
}

export function tmpDir(prefix = 'gitkroken-'): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

export function cleanupAll(): void {
  for (const dir of roots.splice(0)) rmSync(dir, { recursive: true, force: true })
}

/** Runs raw git (for arranging fixtures and asserting on results). */
export function sh(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).replace(/\n$/, '')
}

export function write(repo: string, file: string, content: string): void {
  const full = join(repo, file)
  mkdirSync(dirname(full), { recursive: true })
  writeFileSync(full, content)
}

/** `git init` in a fresh temp dir. */
export function emptyRepo(): string {
  const dir = tmpDir()
  sh(dir, 'init', '-q')
  return dir
}

/** Writes files, stages everything and commits. Returns the new hash. */
export function commitFiles(repo: string, files: Record<string, string>, message: string): string {
  for (const [file, content] of Object.entries(files)) write(repo, file, content)
  tick()
  sh(repo, 'add', '-A')
  sh(repo, 'commit', '-q', '-m', message)
  return sh(repo, 'rev-parse', 'HEAD')
}

/** A repo with one commit containing `a.txt`. */
export function seededRepo(): { repo: string; first: string } {
  const repo = emptyRepo()
  const first = commitFiles(repo, { 'a.txt': 'one\n' }, 'first')
  return { repo, first }
}

export function lines(n: number, prefix = 'line'): string {
  return Array.from({ length: n }, (_, i) => `${prefix} ${i + 1}`).join('\n') + '\n'
}
