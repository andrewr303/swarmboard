// HS-03 (B4 half): the client normalizer. A BoardErrorLike passes through as the same object; anything else gets the
// core's mapping; the payload equals the core's own for every value that is not a ClientError; and no client or
// host file other than src/client/normalize.ts calls the core's three normalizers (a ClientError given to them
// would come back as 500).
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { z } from 'zod'
import { BoardError, normalizeError, toErrorPayload } from '../../src/core/public.ts'
import { ClientError, clientError, errorPayload } from '../../src/client/errors.ts'
import { clientErrorPayload, normalizeThrown } from '../../src/client/normalize.ts'
import { SCANNED_EXTENSIONS } from '../core/host0/import-boundary.ts'
import { stripComments } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')
const CORE_NORMALIZER_REF = /\b(?:normalizeError|toErrorPayload|toErrorResponse)\b/
const NON_CORE_SRC_DIRS = ['src/client', 'src/host', 'src/server', 'src/cli', 'src/mcp', 'src/ui'] as const
const tmpDirs: string[] = []
afterAll(() => {
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true })
})

function sourceFiles(dir: string): string[] {
  const out: string[] = []
  let names: string[]
  try {
    names = readdirSync(dir)
  } catch {
    return out
  }
  for (const name of names) {
    const path = join(dir, name)
    const st = statSync(path)
    if (st.isDirectory()) out.push(...sourceFiles(path))
    else if (SCANNED_EXTENSIONS.some((ext) => name.endsWith(ext))) out.push(path)
  }
  return out
}

function scanNormalizerRefs(root: string, dirs: readonly string[]): string[] {
  const found: string[] = []
  for (const dir of dirs) {
    for (const file of sourceFiles(join(root, dir))) {
      const text = stripComments(readFileSync(file, 'utf8'))
      if (CORE_NORMALIZER_REF.test(text)) {
        found.push(relative(root, file).split('\\').join('/'))
      }
    }
  }
  return found.sort()
}

describe('normalize (HS-03, B4 half)', () => {
  it('HS-03 normalizeThrown passes a ClientError through as the same object; its payload is errorPayload', () => {
    const clientErr = new ClientError(403, 'unsafe_location', 'm', { details: { reasons: ['symlink'] } })
    expect(normalizeThrown(clientErr)).toBe(clientErr)
    expect(clientErrorPayload(clientErr)).toEqual(errorPayload(clientErr))
    expect(clientErrorPayload(clientErr)).toEqual({
      status: 403,
      payload: { error: { code: 'unsafe_location', message: 'm', details: { reasons: ['symlink'] } } },
    })
    const shed = clientError('backpressure_shed', 'shed', { retryAfter: 1 })
    expect(clientErrorPayload(shed)).toMatchObject({ status: 503, retryAfter: 1 })
    // The core's own normalizer would have answered 500 for it (F27): that is why this module exists.
    expect(toErrorPayload(clientErr).status).toBe(500)
  })

  it("HS-03 for a core BoardError, a ZodError, a busy error and a TypeError the payload equals the core's", () => {
    const zod = z.object({ text: z.string().min(1, 'message text is empty') }).safeParse({ text: '' })
    expect(zod.success).toBe(false)
    const busy = Object.assign(new Error('database is locked'), { code: 'ERR_SQLITE_ERROR', errcode: 5 })
    const samples: unknown[] = [
      new BoardError(404, 'message_not_found', 'no message 7', { hint: 'h', details: { id: 7 } }),
      zod.error,
      busy,
      new TypeError('/secret/path'),
    ]
    for (const e of samples) {
      expect(clientErrorPayload(e)).toEqual(toErrorPayload(e))
    }
    const core = samples[0] as BoardError
    expect(normalizeThrown(core)).toBe(core)
    // Anything that is not a BoardErrorLike keeps the original as cause.
    const type = samples[3] as TypeError
    const n = normalizeThrown(type)
    expect(n.status).toBe(500)
    expect(n.code).toBe('internal')
    expect((n as Error & { cause?: unknown }).cause).toBe(type)
    expect(n.message).not.toContain('/secret/path')
    expect(normalizeThrown(busy)).toMatchObject({ status: 503, code: 'unavailable', retryAfter: 1 })
    expect(normalizeThrown(zod.error)).toMatchObject({ status: 400, code: 'invalid_request', message: normalizeError(zod.error).message })
  })

  it('HS-03 only src/client/normalize.ts references normalizeError, toErrorPayload or toErrorResponse across all non-core src/ dirs (comment-stripped)', () => {
    for (const dir of NON_CORE_SRC_DIRS) {
      expect(sourceFiles(join(ROOT, dir)).length, `expected files under ${dir}`).toBeGreaterThan(0)
    }
    const hits = scanNormalizerRefs(ROOT, NON_CORE_SRC_DIRS)
    expect(hits).toEqual(['src/client/normalize.ts'])
  })

  it('HS-03 scanner catches callback, aliased, and rebound references across .js/.mjs/.tsx in all non-core dirs while ignoring comments', () => {
    const root = mkdtempSync(join(tmpdir(), 'hs-norm-scan-'))
    tmpDirs.push(root)
    const put = (rel: string, text: string) => {
      const full = join(root, rel)
      mkdirSync(join(full, '..'), { recursive: true })
      writeFileSync(full, text)
    }
    put('src/client/direct.ts', 'export const f = (e: unknown) => normalizeError(e)\n')
    put('src/client/callback.js', 'export const f = (xs) => xs.map(normalizeError)\n')
    put('src/client/aliased.mjs', "import { toErrorPayload as fmt } from '../core/public.ts'\nexport const f = (e) => fmt(e)\n")
    put('src/host/rebound.tsx', 'const fn = toErrorResponse\nexport { fn }\n')
    put('src/server/err.ts', 'export const s = (e: unknown) => toErrorPayload(e)\n')
    put('src/cli/err.ts', 'export const c = (e: unknown) => normalizeError(e)\n')
    put('src/mcp/err.ts', 'export const m = (e: unknown) => toErrorResponse(e)\n')
    put('src/ui/err.ts', 'export const u = (e: unknown) => normalizeError(e)\n')
    put('src/client/comment-only.ts', '// delegates instead of calling normalizeError or toErrorPayload\nexport const ok = 1\n')

    expect(scanNormalizerRefs(root, NON_CORE_SRC_DIRS)).toEqual([
      'src/cli/err.ts',
      'src/client/aliased.mjs',
      'src/client/callback.js',
      'src/client/direct.ts',
      'src/host/rebound.tsx',
      'src/mcp/err.ts',
      'src/server/err.ts',
      'src/ui/err.ts',
    ])
  })
})
