import { describe, expect, it } from 'vitest'
import { highlightFile, langForPath, mergeTokens } from './highlight'
import { parseDiff } from './parseDiff'

describe('langForPath', () => {
  it('maps paths to grammars', () => {
    expect(langForPath('lib/core/session/actor.dart')).toBe('dart')
    expect(langForPath('src/App.tsx')).toBe('tsx')
    expect(langForPath('android/app/build.gradle')).toBe('groovy')
    expect(langForPath('ios/Runner/Info.plist')).toBe('xml')
    expect(langForPath('pubspec.yaml')).toBe('yaml')
    expect(langForPath('ios/Podfile')).toBe('ruby')
    expect(langForPath('Dockerfile')).toBe('docker')
    expect(langForPath('LICENSE')).toBeNull()
    expect(langForPath('assets/logo.png')).toBeNull()
    expect(langForPath('notes.constructor')).toBeNull()
  })
})

describe('highlightFile', () => {
  const diff = [
    'diff --git a/lib/a.dart b/lib/a.dart',
    'index 1111111..2222222 100644',
    '--- a/lib/a.dart',
    '+++ b/lib/a.dart',
    '@@ -1,4 +1,5 @@',
    ' class Foo {',
    '-  final int x = 1; // viejo',
    '+  final int x = 42; // nuevo',
    '+  /* bloque',
    '+     de dos lineas */',
    ' }'
  ].join('\n')

  it('colours every line of a Dart diff and keeps the text intact', async () => {
    const [file] = parseDiff(diff)
    const map = await highlightFile(file, 'lib/a.dart')
    expect(map).not.toBeNull()
    const lines = file.hunks[0].lines
    for (const line of lines) {
      const toks = map!.get(line)
      expect(toks, line.text).toBeDefined()
      expect(toks!.map((t) => t.text).join('')).toBe(line.text)
    }
    const colorOf = (i: number, text: string) => map!.get(lines[i])!.find((t) => t.text.includes(text))?.color?.toLowerCase()
    expect(colorOf(0, 'class')).toBe('#569cd6') // keyword
    expect(colorOf(1, '// viejo')).toBe('#6a9955') // comment on the removed line
    expect(colorOf(2, '42')).toBe('#b5cea8') // number
    expect(colorOf(4, 'de dos lineas')).toBe('#6a9955') // second line of a block comment
  })

  it('returns null for unknown file types', async () => {
    const [file] = parseDiff(diff)
    expect(await highlightFile(file, 'lib/a.unknownext')).toBeNull()
  })
})

describe('mergeTokens', () => {
  const toks = [{ text: 'final', color: '#569CD6' }, { text: ' x = ' }, { text: '42', color: '#B5CEA8' }]

  it('passes tokens through without word diff', () => {
    expect(mergeTokens(toks, null)).toEqual(toks.map((t) => ({ ...t, changed: false })))
  })

  it('splits tokens at word-diff boundaries', () => {
    const segs = [{ text: 'final x ', changed: false }, { text: '= 4', changed: true }, { text: '2', changed: false }]
    const out = mergeTokens(toks, segs)!
    expect(out.map((p) => p.text).join('')).toBe('final x = 42')
    expect(out.filter((p) => p.changed).map((p) => p.text)).toEqual(['= ', '4'])
    expect(out.find((p) => p.text === '4')!.color).toBe('#B5CEA8')
  })

  it('rejects segments that describe a different text', () => {
    expect(mergeTokens(toks, [{ text: 'otra cosa', changed: true }])).toBeNull()
  })
})
