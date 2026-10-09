// The editor's pipeline end to end, against real repositories and the real
// backend (src/main/git, no Electron): git creates the conflict ->
// conflictFile -> buildModel -> checkboxes / hand edits -> finalText ->
// resolveConflict -> the operation completes with exactly that content.
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { conflictsApi } from '../../../../main/git/conflicts'
import { coreApi } from '../../../../main/git/core'
import { buildModel, type ConflictChunk, type ConflictModel } from './regions'
import { applyEdit, emptyChoice, finalText, joinBlocks, outputBlocks, progress, takeSide, toggleSide, type Choice, type ManualEdits } from './resolution'

const roots: string[] = []
const saved: Record<string, string | undefined> = {}
const ENV: Record<string, string> = {
  GIT_CONFIG_NOSYSTEM: '1',
  GIT_AUTHOR_NAME: 'Test',
  GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test',
  GIT_COMMITTER_EMAIL: 'test@example.com'
}

const tmp = (): string => {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'gitkroken-ce-')))
  roots.push(dir)
  return dir
}
const sh = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

beforeAll(() => {
  const home = tmp()
  writeFileSync(join(home, 'gitconfig'), '[init]\n\tdefaultBranch = main\n[commit]\n\tgpgsign = false\n')
  const env: Record<string, string> = { ...ENV, HOME: home, GIT_CONFIG_GLOBAL: join(home, 'gitconfig') }
  for (const [k, v] of Object.entries(env)) {
    saved[k] = process.env[k]
    process.env[k] = v
  }
})
afterAll(() => {
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  for (const dir of roots) rmSync(dir, { recursive: true, force: true })
})

/** A repo where `main` and `other` changed `file` from the same base */
function diverged(file: string, base: string, ours: string, theirs: string, config: string[][] = []): string {
  const repo = tmp()
  sh(repo, 'init', '-q')
  for (const [key, value] of config) sh(repo, 'config', key!, value!)
  const commit = (content: string, message: string): void => {
    mkdirSync(dirname(join(repo, file)), { recursive: true })
    writeFileSync(join(repo, file), content)
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', message)
  }
  commit(base, 'base')
  sh(repo, 'checkout', '-q', '-b', 'other')
  commit(theirs, 'other change')
  sh(repo, 'checkout', '-q', 'main')
  commit(ours, 'main change')
  return repo
}

async function open(repo: string, file: string): Promise<{ model: ConflictModel; conflicts: ConflictChunk[]; labels: { ours: string; theirs: string } }> {
  const f = await conflictsApi.conflictFile(repo, file)
  expect(f.binary).toBe(false)
  const model = buildModel({ base: f.base, ours: f.ours!, theirs: f.theirs!, merged: f.merged })
  const conflicts = model.chunks.filter((c): c is ConflictChunk => c.kind === 'conflict')
  return { model, conflicts, labels: { ours: f.oursLabel, theirs: f.theirsLabel } }
}

const NONE: ManualEdits = new Map()
const words = (text: string): string => text.split(' ').join('\n') + '\n'

describe('conflict editor against the real backend', () => {
  const base = words('a b c d e f g h i j k l m n o p q r s t')
  const ours = words('A b c d e f g h i J1 J2 k l m n o p q r T-ours')
  const theirs = words('a b c d E f g h i J3 k l m n o p q r T-theirs')

  it('a real merge gives the regions git wrote, and saving completes it', async () => {
    const repo = diverged('src/file.txt', base, ours, theirs)
    await expect(coreApi.merge(repo, 'other')).rejects.toThrow(/CONFLICT/)
    const { model, conflicts, labels } = await open(repo, 'src/file.txt')

    // The file on disk is exactly our own merge of the three versions.
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 2 })
    expect(conflicts.map((c) => [c.ours.join(''), c.theirs.join('')])).toEqual([
      ['J1\nJ2\n', 'J3\n'],
      ['T-ours\n', 'T-theirs\n']
    ])
    expect(labels).toEqual({ ours: 'main', theirs: 'other' })

    // Unresolved, the output is the conflicted file as git wrote it (only the labels of the markers differ).
    const fresh = conflicts.map(emptyChoice)
    const unlabelled = (text: string): string => text.replace(/^(<{7}|>{7}) .*$/gm, '$1')
    expect(unlabelled(finalText(model, fresh, NONE, labels))).toBe(unlabelled(readFileSync(join(repo, 'src/file.txt'), 'utf8')))
    expect(progress(model, fresh, outputBlocks(model, fresh, NONE, labels))).toMatchObject({ resolved: 0, total: 2 })

    // Conflict 1: theirs then ours. Conflict 2: ours. Plus a hand edit in common text.
    const choices: Choice[] = [toggleSide(takeSide(conflicts[0]!, 'theirs'), 'ours'), takeSide(conflicts[1]!, 'ours')]
    const blocks = outputBlocks(model, choices, NONE, labels)
    const manual = applyEdit(blocks, NONE, joinBlocks(blocks).replace('\nn\n', '\nn (edited)\n'))
    const content = finalText(model, choices, manual, labels)
    expect(content).toBe(words('A b c d E f g h i J3 J1 J2 k l m n(edited) o p q r T-ours').replace('n(edited)', 'n (edited)'))

    await conflictsApi.resolveConflict(repo, 'src/file.txt', content)
    expect((await coreApi.status(repo)).conflicted).toEqual([])
    await coreApi.continueOp(repo)
    expect((await coreApi.status(repo)).inProgress).toBeNull()
    expect(sh(repo, 'show', 'HEAD:src/file.txt')).toBe(content)
    expect(sh(repo, 'rev-list', '--parents', '-1', 'HEAD').trim().split(' ')).toHaveLength(3)
  })

  it('a rebase: the sides are swapped, the regions are the same', async () => {
    const repo = diverged('file.txt', base, ours, theirs)
    sh(repo, 'checkout', '-q', 'other')
    await expect(coreApi.rebase(repo, 'main')).rejects.toThrow()
    const { model, conflicts, labels } = await open(repo, 'file.txt')
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 2 })
    // "ours" is main (rebased onto), "theirs" the commit of `other` being replayed
    expect(conflicts[0]).toMatchObject({ ours: ['J1\n', 'J2\n'], theirs: ['J3\n'] })
    expect(labels.ours).toBe('main (rebasing onto)')
    expect(labels.theirs).toMatch(/^[0-9a-f]{7,} other change \(from other\)$/)

    const content = finalText(model, conflicts.map((c) => takeSide(c, 'theirs')), NONE, labels)
    expect(content).toBe(words('A b c d E f g h i J3 k l m n o p q r T-theirs'))
    await conflictsApi.resolveConflict(repo, 'file.txt', content)
    await coreApi.continueOp(repo)
    const st = await coreApi.status(repo)
    expect(st).toMatchObject({ inProgress: null, branch: 'other', conflicted: [] })
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toBe(content)
  })

  it('diff3 conflict style on disk is recognised as the same merge', async () => {
    const repo = diverged('file.txt', base, ours, theirs, [['merge.conflictStyle', 'diff3']])
    await expect(coreApi.merge(repo, 'other')).rejects.toThrow(/CONFLICT/)
    expect(readFileSync(join(repo, 'file.txt'), 'utf8')).toContain('|||||||')
    const { model } = await open(repo, 'file.txt')
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 2 })
  })

  it('CRLF file without final newline, with core.autocrlf: saved back in the same shape', async () => {
    const crlf = (text: string): string => text.split(' ').join('\r\n')
    const repo = diverged('w.txt', crlf('a b c d e f'), crlf('a B c d e F-ours'), crlf('a b2 c d e F-theirs'), [['core.autocrlf', 'true']])
    await expect(coreApi.merge(repo, 'other')).rejects.toThrow(/CONFLICT/)
    const { model, conflicts, labels } = await open(repo, 'w.txt')
    expect(model).toMatchObject({ diskMatches: true, eol: '\r\n' })
    expect(conflicts.length).toBeGreaterThan(0)

    const choices = conflicts.map((c) => toggleSide(takeSide(c, 'ours'), 'theirs'))
    // What the result pane shows (and a <textarea> would hand back) has "\n" only...
    const shown = joinBlocks(outputBlocks(model, choices, NONE, labels))
    expect(shown).not.toContain('\r')
    // ...and one hand edit makes that block travel with "\n"; the backend restores CRLF.
    const manual = applyEdit(outputBlocks(model, choices, NONE, labels), NONE, shown.replace('F-ours', 'F-ours!'))
    await conflictsApi.resolveConflict(repo, 'w.txt', finalText(model, choices, manual, labels))

    // The two changes are 3 lines apart, so git made them one conflict: ours, then theirs.
    // Every line break is CRLF again, and "F-theirs" still ends the file without one.
    expect(readFileSync(join(repo, 'w.txt'), 'utf8')).toBe(crlf('a B c d e F-ours! b2 c d e F-theirs'))
    expect(sh(repo, 'ls-files', '--eol', 'w.txt')).toMatch(/i\/lf\s+w\/crlf/)
    expect((await coreApi.status(repo)).conflicted).toEqual([])
  })

  it('add/add without base', async () => {
    const repo = tmp()
    sh(repo, 'init', '-q')
    writeFileSync(join(repo, 'seed'), 's\n')
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'seed')
    sh(repo, 'checkout', '-q', '-b', 'other')
    writeFileSync(join(repo, 'new.txt'), words('h1 h2 h3 h4 theirs tail'))
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'other adds')
    sh(repo, 'checkout', '-q', 'main')
    writeFileSync(join(repo, 'new.txt'), words('h1 h2 h3 h4 ours tail'))
    sh(repo, 'add', '-A')
    sh(repo, 'commit', '-q', '-m', 'main adds')
    await expect(coreApi.merge(repo, 'other')).rejects.toThrow(/CONFLICT/)

    const { model, conflicts, labels } = await open(repo, 'new.txt')
    expect(model).toMatchObject({ source: 'stages', diskMatches: true, conflicts: 1 })
    expect(conflicts[0]).toMatchObject({ ours: ['ours\n'], theirs: ['theirs\n'], base: null })
    await conflictsApi.resolveConflict(repo, 'new.txt', finalText(model, [takeSide(conflicts[0]!, 'theirs')], NONE, labels))
    await coreApi.continueOp(repo)
    expect(sh(repo, 'show', 'HEAD:new.txt')).toBe(words('h1 h2 h3 h4 theirs tail'))
  })
})
