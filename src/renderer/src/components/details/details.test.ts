import { describe, expect, it } from 'vitest'
import { buildCommitMessage, hueOf, initials, messageToFields, relativeTime } from './commitMessage'
import { buildTree, flattenTree, type TreeNode } from './fileTree'

const f = (path: string) => ({ path })
const outline = (nodes: TreeNode<{ path: string }>[], collapsed = new Set<string>()) =>
  flattenTree(nodes, collapsed).map(({ node, depth }) => `${'  '.repeat(depth)}${node.name}${node.kind === 'folder' ? '/' : ''}`)

describe('buildTree', () => {
  const tree = buildTree([
    f('README.md'),
    f('src/renderer/src/App.tsx'),
    f('src/renderer/src/components/diff/DiffView.tsx'),
    f('src/renderer/src/components/details/RightPanel.tsx'),
    f('src/main/index.ts'),
    f('package.json'),
    f('docs/guide/intro.md')
  ])

  it('nests files, sorts folders first and merges single-child chains', () => {
    expect(outline(tree)).toEqual([
      'docs/guide/',
      '  intro.md',
      'src/',
      '  main/',
      '    index.ts',
      '  renderer/src/',
      '    components/',
      '      details/',
      '        RightPanel.tsx',
      '      diff/',
      '        DiffView.tsx',
      '    App.tsx',
      'package.json',
      'README.md'
    ])
  })

  it('keeps full folder paths and the files below each folder', () => {
    const src = tree.find((n) => n.name === 'src')
    expect(src?.kind).toBe('folder')
    if (src?.kind !== 'folder') return
    expect(src.path).toBe('src')
    expect(src.files.map((x) => x.path).sort()).toEqual([
      'src/main/index.ts',
      'src/renderer/src/App.tsx',
      'src/renderer/src/components/details/RightPanel.tsx',
      'src/renderer/src/components/diff/DiffView.tsx'
    ])
    const merged = src.children.find((n) => n.name === 'renderer/src')
    expect(merged?.kind === 'folder' && merged.path).toBe('src/renderer/src')
  })

  it('hides the content of collapsed folders', () => {
    expect(outline(tree, new Set(['src', 'docs/guide']))).toEqual(['docs/guide/', 'src/', 'package.json', 'README.md'])
    expect(outline(tree, new Set(['src/renderer/src']))).toContain('  renderer/src/')
    expect(outline(tree, new Set(['src/renderer/src']))).not.toContain('    App.tsx')
  })

  it('handles untracked directories and an empty list', () => {
    expect(buildTree([])).toEqual([])
    expect(outline(buildTree([f('a/newdir/'), f('a/x.txt')]))).toEqual(['a/', '  newdir/', '  x.txt'])
  })
})

describe('commit message helpers', () => {
  it('joins summary and description with a blank line', () => {
    expect(buildCommitMessage('  Fix bug  ', '')).toBe('Fix bug')
    expect(buildCommitMessage('Fix bug', '   \n')).toBe('Fix bug')
    expect(buildCommitMessage('Fix bug', '\nDetails\n- one\n\n')).toBe('Fix bug\n\nDetails\n- one')
    expect(buildCommitMessage('Fix bug', '  indented first line')).toBe('Fix bug\n\n  indented first line')
  })

  it('splits a commit back into form fields', () => {
    expect(messageToFields('Subject', 'Body\ntext\n')).toEqual({ summary: 'Subject', description: 'Body\ntext' })
    expect(messageToFields('Subject', '')).toEqual({ summary: 'Subject', description: '' })
    expect(messageToFields('Subject', 'Subject\n\nBody')).toEqual({ summary: 'Subject', description: 'Body' })
    const { summary, description } = messageToFields('Subject', 'Body')
    expect(buildCommitMessage(summary, description)).toBe('Subject\n\nBody')
  })

  it('derives avatar initials and a stable hue', () => {
    expect(initials('Gerson Oliva Rojas')).toBe('GR')
    expect(initials('linus')).toBe('L')
    expect(initials('  ')).toBe('?')
    expect(initials('dependabot[bot]')).toBe('D')
    expect(hueOf('a@b.c')).toBe(hueOf('a@b.c'))
    expect(hueOf('a@b.c')).toBeGreaterThanOrEqual(0)
    expect(hueOf('a@b.c')).toBeLessThan(360)
  })

  it('formats relative times in English', () => {
    const now = 1_800_000_000
    expect(relativeTime(now - 3 * 86400, now)).toBe('3 days ago')
    expect(relativeTime(now - 2 * 3600, now)).toBe('2 hours ago')
    expect(relativeTime(now - 86400, now)).toBe('yesterday')
    expect(relativeTime(now - 5, now)).toBe('now')
  })
})
