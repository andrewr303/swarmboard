// HOST-0 stage 3, the API fence (HOST0_DESIGN 3.9, X2/X3/X4): the three barrels and the import boundary
// (HT-71 to HT-75). The transport allow-list (HT-76) is in transport-allow.test.ts.
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import * as index from '../../../src/core/index.ts'
import * as internal from '../../../src/core/internal.ts'
import * as pub from '../../../src/core/public.ts'
import { importBoundaryViolations, SCANNED_EXTENSIONS } from './import-boundary.ts'
import allowed from './public-surface.allow.json' with { type: 'json' }

const ROOT = resolve(import.meta.dirname, '..', '..', '..')
const INDEX_ONLY = [
  'commitTaskEventsInTx',
  'loadAllRows',
  'loadRow',
  'markRootDeletedInTx',
  'rebuildTaskIndexInTx',
  'releaseWakeupLock',
  'staleWakeupLock',
  'syncFtsTaskInTx',
  'wakeupLockToken',
]
const INTERNAL_43 = [
  'IDENTITY_SCHEMA_SQL', 'M1_SCHEMA_SQL', 'META_BOARD_ID', 'META_INSTANCE_FILE', 'META_INSTANCE_ID', 'META_READABLE_KEY',
  'META_READABLE_LEGACY', 'META_READ_MIN', 'META_SCHEMA_VERSION', 'META_VALUE_MAX_BYTES', 'META_WRITABLE_KEY',
  'META_WRITE_MIN', 'RESERVED_META_KEYS', 'RESERVED_SYSTEM_IDS', 'SCHEDULE_ACTOR_ID', 'SCHEMA_STEPS', 'SYSTEM_PRINCIPAL_ID',
  'TASKS_SCHEMA_SQL', 'TICK_LEASE_KEY', 'TICK_LEASE_TTL_MAX_MS', 'TICK_LEASE_TTL_MIN_MS', 'TRANSPORT_ALLOW',
  'V2_LAUNCH_SCHEMA_SQL', 'acquireTickLease', 'commitTaskEventsInTx', 'createSystemCaller', 'isSystemCaller', 'loadAllRows',
  'loadRow', 'markRootDeletedInTx', 'readSchemaState', 'readTickLease', 'rebuildTaskIndexInTx', 'releaseTickLease',
  'releaseWakeupLock', 'renewTickLease', 'scanJsonl', 'schemaTooNew', 'staleWakeupLock', 'syncFtsTaskInTx',
  'systemAuthor', 'systemOps', 'wakeupLockToken',
]

function diff(actual: string[], expected: string[]): { added: string[]; removed: string[] } {
  return { added: actual.filter((k) => !expected.includes(k)), removed: expected.filter((k) => !actual.includes(k)) }
}

describe('C6 the API fence', () => {
  it('HT-71 public.ts exports exactly the allow-listed 342 values', () => {
    const keys = Object.keys(pub).sort()
    expect(diff(keys, allowed)).toEqual({ added: [], removed: [] })
    expect(keys).toEqual([...allowed].sort())
    expect(keys).toHaveLength(342)
  })

  it('HT-72 index.ts is public.ts plus the nine legacy internals', () => {
    const expected = [...allowed, ...INDEX_ONLY].sort()
    expect(diff(Object.keys(index).sort(), expected)).toEqual({ added: [], removed: [] })
    expect(Object.keys(index)).toHaveLength(351)
  })

  it('HT-73 internal.ts exports exactly its 43 names, none of them public except the id constant', () => {
    expect(diff(Object.keys(internal).sort(), INTERNAL_43)).toEqual({ added: [], removed: [] })
    expect(Object.keys(internal)).toHaveLength(43)
    const hidden = [
      'createSystemCaller', 'isSystemCaller', 'systemOps', 'systemAuthor', 'RESERVED_SYSTEM_IDS', 'SCHEDULE_ACTOR_ID',
      'TRANSPORT_ALLOW', 'TICK_LEASE_KEY', 'acquireTickLease', 'renewTickLease', 'releaseTickLease', 'readTickLease',
      'RESERVED_META_KEYS', 'SCHEMA_STEPS', 'readSchemaState', 'schemaTooNew', 'scanJsonl', 'M1_SCHEMA_SQL',
      'TASKS_SCHEMA_SQL', 'IDENTITY_SCHEMA_SQL', 'V2_LAUNCH_SCHEMA_SQL', ...INTERNAL_43.filter((k) => k.startsWith('META_')),
    ]
    for (const name of hidden) {
      expect(name in pub, `public.ts has ${name}`).toBe(false)
      expect(name in index, `index.ts has ${name}`).toBe(false)
    }
  })

  it('HT-74 the package entry is public.ts and ./core keeps its paths', () => {
    const pkg = JSON.parse(fs.readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
      exports: Record<string, { default: string; types: string }>
    }
    expect(pkg.exports['./core']!.default).toBe('./dist/core.mjs')
    expect(pkg.exports['./core']!.types).toBe('./dist/core.d.mts')
    expect(fs.readFileSync(join(ROOT, 'tsdown.config.ts'), 'utf8')).toMatch(/core:\s*'src\/core\/public\.ts'/)
  })

  it('HT-75 transports import only the public surface', () => {
    // Closeout SEC-R1-1: every quote style, export-from, dynamic import, require and every source extension
    // (import-boundary.ts; its negative controls are in closeout-import-boundary.test.ts).
    const violations = (file: string, text: string): string[] => importBoundaryViolations(ROOT, file, text)
    const found: string[] = []
    const walk = (dir: string): void => {
      if (!fs.existsSync(dir)) return
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, e.name)
        if (e.isDirectory()) walk(full)
        else if (SCANNED_EXTENSIONS.some((ext) => e.name.endsWith(ext))) found.push(...violations(full, fs.readFileSync(full, 'utf8')))
      }
    }
    for (const d of ['server', 'client', 'mcp', 'cli']) walk(join(ROOT, 'src', d))
    expect(found).toEqual([])
    // Self-check: a look-alike file that imports the in-repo barrel is reported, the public entry is not.
    const fake = join(ROOT, 'src', 'server', 'x.ts')
    expect(violations(fake, "import { loadRow } from '../core/index.ts'")).toHaveLength(1)
    expect(violations(fake, "import { BoardService } from '../core/public.ts'")).toHaveLength(0)
    expect(violations(fake, "import { x } from 'swarmboard/core'")).toHaveLength(0)
    expect(violations(fake, "import { x } from 'swarmboard/internal'")).toHaveLength(1)
  })
})
