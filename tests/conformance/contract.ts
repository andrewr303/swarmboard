// The transport conformance runner (HOST123_DESIGN 5.8): turns src/client/conformance.ts's catalogue (CF-01..CF-20)
// into vitest tests for one target. A case whose `requires` the target lacks is registered as skipped with the
// reason `feature <name> is off for <target>`. Each test gets fresh boards in fresh directories, closed after it.
import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { CONFORMANCE_CASES, type ConformanceBoard, type ConformanceCaseSpec, type ConformanceTarget, type IdentitySpec } from '../../src/client/conformance.ts'
import { IDS, tempDir, unlistedErrors } from './fixtures.ts'
import { IDEMPOTENCY_SUITE } from './suite/idempotency.ts'
import { ORIGINAL_SUITE } from './suite/original.ts'
import { PARITY_SUITE } from './suite/parity.ts'
import { PEER_SUITE } from './suite/peers.ts'
import { SURFACE_SUITE } from './suite/surface.ts'
import { WAITS_SUITE } from './suite/waits.ts'

export type CaseId = ConformanceCaseSpec['id']

export interface CaseContext {
  readonly target: ConformanceTarget
  /** A fresh board in a fresh directory (closed after the test); identities default to the conformance IDS. */
  open(ids?: Record<string, IdentitySpec>, opts?: { busyTimeoutMs?: number; busyBudgetMs?: number }): Promise<ConformanceBoard>
  /** Same as open(), also returning the board directory path (for cross-process spawnPeer and file surgery). */
  openWithDir(
    ids?: Record<string, IdentitySpec>,
    opts?: { busyTimeoutMs?: number; busyBudgetMs?: number },
  ): Promise<{ readonly dir: string; readonly board: ConformanceBoard }>
  /** A second target for CF-12, or null. */
  readonly parity: ConformanceTarget | null
}

export interface SuiteTest {
  /** Starts with the HS id it proves. */
  readonly name: string
  readonly timeoutMs?: number
  run(ctx: CaseContext): Promise<void>
}

export type Suite = Readonly<Partial<Record<CaseId, readonly SuiteTest[]>>>

export interface ContractOptions {
  /** CF-12's second target. */
  readonly parity?: ConformanceTarget
  /** Bodies a target's own test files supply for cases the shared suite does not implement (CF-16..CF-19). */
  readonly extra?: Suite
}

/** How tests are registered; vitest by default, a recorder in HS-88. */
export interface Registrar {
  describe(name: string, body: () => void): void
  test(name: string, body: () => Promise<void> | void, timeoutMs?: number): void
  skip(name: string): void
  afterEach(body: () => Promise<void> | void): void
  afterAll(body: () => Promise<void> | void): void
}

export const vitestRegistrar: Registrar = {
  describe: (name, body) => describe(name, body),
  test: (name, body, timeoutMs) => it(name, body, timeoutMs),
  skip: (name) => it.skip(name, () => undefined),
  afterEach: (body) => afterEach(body),
  afterAll: (body) => afterAll(body),
}

const SUITES: readonly Suite[] = [SURFACE_SUITE, WAITS_SUITE, IDEMPOTENCY_SUITE, PARITY_SUITE, ORIGINAL_SUITE, PEER_SUITE]

export interface PlannedCase {
  readonly spec: ConformanceCaseSpec
  /** null: runs; else the reason it is skipped. */
  readonly skip: string | null
}

/** Which cases run on `target`, and why the others are skipped. Pure. */
export function planConformance(target: ConformanceTarget, crossProcessWake: boolean | null, opts: ContractOptions = {}): PlannedCase[] {
  return CONFORMANCE_CASES.map((spec) => {
    for (const need of spec.requires) {
      const on = need === 'crossProcessWake' ? crossProcessWake !== false : target.features[need]
      if (!on) return { spec, skip: `feature ${need} is off for ${target.name}` }
    }
    if (spec.id === 'CF-12' && opts.parity === undefined) return { spec, skip: `CF-12 needs a second target; none given for ${target.name}` }
    return { spec, skip: null }
  })
}

function testsFor(id: CaseId, opts: ContractOptions): SuiteTest[] {
  const out: SuiteTest[] = []
  for (const suite of [...SUITES, opts.extra ?? {}]) out.push(...(suite[id] ?? []))
  return out
}

/**
 * Registers the catalogue for `target`. `crossProcessWake` is the target's capability (known only once a board is
 * open; pass null to decide it per test from the opened transport's capabilities).
 */
export function defineTransportConformance(
  target: ConformanceTarget,
  opts: ContractOptions & { readonly crossProcessWake?: boolean | null } = {},
  registrar: Registrar = vitestRegistrar,
): void {
  const boards: ConformanceBoard[] = []
  const ctx: CaseContext = {
    target,
    parity: opts.parity ?? null,
    async open(ids = IDS, openOpts) {
      const board = await target.open(tempDir('cb-cf-'), ids, openOpts)
      boards.push(board)
      return board
    },
    async openWithDir(ids = IDS, openOpts) {
      const dir = tempDir('cb-cf-')
      const board = await target.open(dir, ids, openOpts)
      boards.push(board)
      return { dir, board }
    },
  }
  registrar.describe(`transport conformance: ${target.name}`, () => {
    registrar.afterEach(async () => {
      while (boards.length > 0) await boards.pop()!.close()
    })
    registrar.afterAll(async () => {
      await target.dispose?.()
    })
    for (const planned of planConformance(target, opts.crossProcessWake ?? null, opts)) {
      const { spec } = planned
      const tests = testsFor(spec.id, opts)
      if (planned.skip !== null) {
        registrar.skip(`${spec.id} ${spec.title}: ${planned.skip}`)
        continue
      }
      if (tests.length === 0) {
        registrar.test(`${spec.id} ${spec.title}: a body is supplied`, () => {
          throw new Error(`${spec.id} is on for ${target.name} but no test body exists: supply it through ContractOptions.extra`)
        })
        continue
      }
      for (const test of tests) registrar.test(`${test.name} [${spec.id} ${spec.title}]`, () => test.run(ctx), test.timeoutMs ?? 30_000)
    }
    registrar.test('HS-71 every error code the conformance run saw is universal or listed for its op', () => {
      expect(unlistedErrors()).toEqual([])
    })
  })
}
