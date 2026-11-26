// HS-01, HS-02: gate residual F-1. The transport import boundary, hardened beyond the regex scan (HT-75):
// the resolution graph Node really loads, a symlink walk, and comment stripping. Helpers: import-graph.ts.
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { importBoundaryViolations } from '../core/host0/import-boundary.ts'
import {
  asUrl,
  graphViolations,
  hostPathViolations,
  importGraph,
  scanBoth,
  stripComments,
  transportFiles,
  TRANSPORT_DIRS,
} from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const tmpRoots: string[] = []
afterAll(() => {
  for (const d of tmpRoots) rmSync(d, { recursive: true, force: true })
})

/** A temp repository: src/core with a public.ts and an internal.ts, src/host with connect.ts, plus `files`. */
function tempTree(files: Record<string, string>): string {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'hs-boundary-')))
  tmpRoots.push(root)
  const put = (rel: string, text: string): void => {
    const full = join(root, rel)
    mkdirSync(join(full, '..'), { recursive: true })
    writeFileSync(full, text)
  }
  put('package.json', '{"type":"module"}')
  put('src/core/public.ts', 'export const pub = 1\n')
  put('src/core/internal.ts', 'export const secret = 2\n')
  put('src/host/connect.ts', 'export const x = 3\n')
  for (const [rel, text] of Object.entries(files)) put(rel, text)
  return root
}

describe('HS-01 the resolution graph and the host fence', () => {
  it('HS-01 the real transport files satisfy rule 1 and rule 2', async () => {
    const { files, symlinks } = transportFiles(ROOT, TRANSPORT_DIRS)
    expect(symlinks).toEqual([])
    expect(files.length).toBeGreaterThan(0)
    const edges = await importGraph(files)
    expect(edges.length).toBeGreaterThan(0)
    expect(graphViolations(edges, ROOT)).toEqual([])
  }, 60_000)

  it('HS-01 a run-time built import of internal.ts is rule 1, and the regex scan flags it as non-literal', async () => {
    const text = "await import(['..', 'core', 'internal.ts'].join('/'))\nexport {}\n"
    const root = tempTree({ 'src/client/x.ts': text })
    const file = join(root, 'src/client/x.ts')
    const edges = await importGraph([file])
    const v = graphViolations(edges, root)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/^rule 1:.*internal\.ts/)
    expect(importBoundaryViolations(root, file, text).some((s) => s.includes('non-literal'))).toBe(true)
  }, 60_000)

  it('HS-01 a static import of the host layer from src/client is rule 2', async () => {
    const text = "import { x } from '../host/connect.ts'\nexport { x }\n"
    const root = tempTree({ 'src/client/y.ts': text })
    const file = join(root, 'src/client/y.ts')
    const v = graphViolations(await importGraph([file]), root)
    expect(v).toHaveLength(1)
    expect(v[0]).toMatch(/^rule 2:.*connect\.ts/)
    expect(hostPathViolations(root, file, text)).not.toEqual([])
  }, 60_000)

  it('HS-01 the public entry is allowed; the other transport directories are held to rule 2 as well', async () => {
    const root = tempTree({
      'src/client/ok.ts': "import { pub } from '../core/public.ts'\nexport { pub }\n",
      'src/mcp/m.ts': "import { x } from '../host/connect.ts'\nexport { x }\n",
    })
    const ok = await importGraph([join(root, 'src/client/ok.ts')])
    expect(graphViolations(ok, root)).toEqual([])
    const bad = graphViolations(await importGraph([join(root, 'src/mcp/m.ts')]), root)
    expect(bad).toHaveLength(1)
    expect(bad[0]).toMatch(/^rule 2:/)
    // src/host itself may import the core's internals: not judged by either rule
    const hostRoot = tempTree({ 'src/host/h.ts': "import { secret } from '../core/internal.ts'\nexport { secret }\n" })
    expect(graphViolations(await importGraph([join(hostRoot, 'src/host/h.ts')]), hostRoot)).toEqual([])
  }, 60_000)

  it('HS-01 graphViolations compares paths case-insensitively (APFS/Win32 mixed-case specifiers)', () => {
    const root = '/tmp/MixedCaseRepo'
    const edges = [
      [asUrl(join(root, 'src/Client/a.ts')), asUrl(join(root, 'src/Core/Internal.ts'))],
      [asUrl(join(root, 'src/Client/b.ts')), asUrl(join(root, 'src/Host/Connect.ts'))],
      [asUrl(join(root, 'src/Client/ok.ts')), asUrl(join(root, 'src/Core/Public.ts'))],
      [asUrl(join(root, 'src/Host/h.ts')), asUrl(join(root, 'src/Core/Internal.ts'))],
    ] as const
    const violations = graphViolations(edges, root)
    expect(violations).toHaveLength(2)
    expect(violations.some((v) => v.startsWith('rule 1:') && v.includes('Internal.ts'))).toBe(true)
    expect(violations.some((v) => v.startsWith('rule 2:') && v.includes('Connect.ts'))).toBe(true)
  })

  it('HS-01 an unloadable file rejects instead of passing silently', async () => {
    const root = tempTree({ 'src/client/z.ts': "import './missing.ts'\n" })
    await expect(importGraph([join(root, 'src/client/z.ts')])).rejects.toThrow(/missing/)
  }, 60_000)

  it('HS-01 every file under src/client passes the regex scan on the text and on the stripped text', () => {
    const { files } = transportFiles(ROOT, ['client'])
    expect(files.length).toBeGreaterThanOrEqual(4)
    for (const file of files) {
      const text = readFileSync(file, 'utf8')
      expect(importBoundaryViolations(ROOT, file, text), file).toEqual([])
      expect(scanBoth(ROOT, file, text), file).toEqual([])
      expect(hostPathViolations(ROOT, file, text), file).toEqual([])
    }
  })

  it('HS-01 the same checks hold for src/server, src/mcp and src/cli when they exist', () => {
    const { files } = transportFiles(ROOT, ['server', 'mcp', 'cli'])
    for (const file of files) {
      expect(scanBoth(ROOT, file, readFileSync(file, 'utf8')), file).toEqual([])
      expect(hostPathViolations(ROOT, file, readFileSync(file, 'utf8')), file).toEqual([])
    }
  })

  it('HS-01 a fixture naming src/host in any spelling fails the host path check', () => {
    const file = join(ROOT, 'src/client/f.ts')
    const spellings = [
      "import { x } from '../host/x.ts'",
      'import { x } from "../host/x.ts"',
      "const p = '../host/x.ts'",
      "// see ../host/x.ts",
      `import { x } from '${join(ROOT, 'src/host/x.ts')}'`,
      `await import('file://${join(ROOT, 'src/host/x.ts')}')`,
      "const p = '..\\u002fhost\\u002fx.ts'",
      "import { x } from '../Host/x.ts'",
    ]
    for (const text of spellings) expect(hostPathViolations(ROOT, file, text).length, text).toBeGreaterThan(0)
    expect(hostPathViolations(ROOT, file, "import { x } from './errors.ts'")).toEqual([])
    expect(hostPathViolations(ROOT, file, "import { x } from '../core/public.ts'")).toEqual([])
  })
})

describe('HS-02 symlinks and comments', () => {
  it('HS-02 transportFiles reports a symlinked directory and a symlinked file in a transport tree', () => {
    const root = tempTree({ 'src/client/real.ts': 'export {}\n' })
    symlinkSync(join(root, 'src/core'), join(root, 'src/client/alias'))
    symlinkSync(join(root, 'src/core/internal.ts'), join(root, 'src/client/inner.ts'))
    const { files, symlinks } = transportFiles(root, ['client', 'server'])
    expect(symlinks.sort()).toEqual([join(root, 'src/client/alias'), join(root, 'src/client/inner.ts')])
    expect(files).toEqual([join(root, 'src/client/real.ts')])
    // a symlinked transport directory itself is reported and not followed
    const root2 = tempTree({})
    symlinkSync(join(root2, 'src/core'), join(root2, 'src/server'))
    expect(transportFiles(root2, ['server']).symlinks).toEqual([join(root2, 'src/server')])
  })

  it('HS-02 stripComments removes comments, so a comment between import and its paren cannot hide it', () => {
    const text = "const m = await import /* c */ (p)\n"
    expect(stripComments(text)).toBe('const m = await import  (p)\n')
    const file = join(ROOT, 'src/client/c.ts')
    expect(importBoundaryViolations(ROOT, file, text)).toEqual([])
    expect(importBoundaryViolations(ROOT, file, stripComments(text)).some((s) => s.includes('non-literal'))).toBe(true)
    expect(scanBoth(ROOT, file, text).length).toBeGreaterThan(0)
    expect(stripComments('import /* a\nb */ (p)')).toBe('import \n (p)')
  })

  it('HS-02 a string literal holding // survives stripping unchanged', () => {
    const cases = [
      "const u = 'https://x'",
      'const u = "https://x" // trailing',
      'const u = `https://x/${a}//y`',
      "const re = /x/; const v = 'a//b'",
    ]
    expect(stripComments(cases[0]!)).toBe(cases[0])
    expect(stripComments(cases[1]!)).toBe('const u = "https://x" ')
    expect(stripComments(cases[2]!)).toBe(cases[2])
    expect(stripComments(cases[3]!)).toContain("'a//b'")
  })

  it('HS-02 line comments, nested template expressions and unterminated comments', () => {
    expect(stripComments('a // x\nb')).toBe('a \nb')
    expect(stripComments('x = `${ f(/* in */ 1) }`')).toBe('x = `${ f( 1) }`')
    expect(stripComments('x = `${ `${ 1 /* c */ }` }`')).toBe('x = `${ `${ 1  }` }`')
    expect(stripComments('a /* never closed')).toBe('a ')
    expect(stripComments("'it''s' // c")).toBe("'it''s' ")
  })
})
