// The conformance contract on the `in-process` target (Mode 0, file board), plus the checks that need the core in
// the same process (prototype spies, direct-call comparison): HS-72..HS-76, HS-88, and HS-55's conformance.ts
// clause.
import { join, resolve } from 'node:path'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import {
  BoardService,
  createLocalCaller,
  normalizeError,
  SqliteUnifiedStore,
  TaskService,
  toErrorPayload,
  type CallerContext,
} from '../../src/core/public.ts'
import { CONFORMANCE_CASES, type ConformanceTarget } from '../../src/client/conformance.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { fixedIdentity, localIdentity, type IdentityProvider } from '../../src/client/identity.ts'
import { bindArgs, OP_NAMES, OPS, type OpName } from '../../src/client/ops.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'
import { defineTransportConformance, planConformance, type Registrar } from './contract.ts'
import { ada, FIXTURES, idSequence, inProcessTarget, manualClock, placeholders, removeTempDirs } from './fixtures.ts'
import { call, rejection, type Rec } from './suite/util.ts'
import { asUrl, importGraph } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

defineTransportConformance(inProcessTarget(), { parity: inProcessTarget('in-process (second board)'), crossProcessWake: true })

type Method = (...args: unknown[]) => unknown
const opened: { close(): void }[] = []
afterEach(() => vi.restoreAllMocks())
afterAll(() => {
  for (const o of opened) o.close()
  removeTempDirs()
})

function memBoard(seed?: string, now?: () => number): { store: SqliteUnifiedStore; board: BoardService } {
  const store = new SqliteUnifiedStore({ path: ':memory:', testHooks: seed !== undefined ? { newId: idSequence(seed) } : {} })
  const board = new BoardService(store, now !== undefined ? { now } : {})
  opened.push({ close: () => store.close() })
  return { store, board }
}

/** Spies on every method of both service prototypes; returns the total call count. */
function spyAllServiceMethods(): () => number {
  const spies: { mock: { calls: unknown[] } }[] = []
  for (const proto of [BoardService.prototype, TaskService.prototype] as unknown as Record<string, Method>[]) {
    for (const name of Object.getOwnPropertyNames(proto)) {
      if (name === 'constructor') continue
      const d = Object.getOwnPropertyDescriptor(proto, name)
      if (d === undefined || typeof d.value !== 'function') continue
      spies.push(vi.spyOn(proto, name as never) as unknown as { mock: { calls: unknown[] } })
    }
  }
  return () => spies.reduce((n, s) => n + s.mock.calls.length, 0)
}

async function settleDirect(board: BoardService, op: OpName, input: Rec, caller: CallerContext): Promise<unknown> {
  const spec = OPS[op]
  const service = (spec.binds.service === 'board' ? board : board.tasks) as unknown as Record<string, Method>
  try {
    return { ok: placeholders(await service[spec.binds.method]!.apply(service, bindArgs(op, input, caller, undefined))) }
  } catch (error) {
    const e = normalizeError(error)
    return { error: { status: e.status, code: e.code, message: e.message } }
  }
}

async function settleVia(t: InProcessTransport, op: OpName, input: Rec): Promise<unknown> {
  try {
    return { ok: placeholders(await call(t, op, input)) }
  } catch (error) {
    if (!isBoardError(error)) throw error
    return { error: { status: error.status, code: error.code, message: error.message } }
  }
}

describe('conformance catalogue and contract', () => {
  it('HS-72 CONFORMANCE_CASES has CF-01..CF-20, each with clauses; in-process skips only the cases whose features it lacks', () => {
    expect(CONFORMANCE_CASES.map((c) => c.id)).toEqual(Array.from({ length: 20 }, (_, i) => `CF-${String(i + 1).padStart(2, '0')}`))
    for (const c of CONFORMANCE_CASES) {
      expect(c.clauses.length, c.id).toBeGreaterThan(0)
      expect(c.title.length, c.id).toBeGreaterThan(0)
    }
    expect(Object.isFrozen(CONFORMANCE_CASES)).toBe(true)
    const plan = planConformance(inProcessTarget(), true, { parity: inProcessTarget('second') })
    expect(plan.filter((p) => p.skip !== null).map((p) => p.spec.id)).toEqual(['CF-16', 'CF-17', 'CF-18', 'CF-19'])
    expect(plan.find((p) => p.spec.id === 'CF-09')!.skip).toBeNull()
    expect(plan.find((p) => p.spec.id === 'CF-14')!.skip).toBeNull()
  })

  it('HS-88 a target with features off registers those cases as skipped with the reason, and nothing fails', () => {
    const fake: ConformanceTarget = {
      name: 'fake',
      features: { crossProcess: false, busyRetry: false, lanes: false, identityEvents: false, crashInjection: false, clock: false },
      open: () => Promise.reject(new Error('not opened in this test')),
    }
    const skipped: string[] = []
    const tests: string[] = []
    const rec: Registrar = {
      describe: (_name, body) => body(),
      test: (name) => void tests.push(name),
      skip: (name) => void skipped.push(name),
      afterEach: () => undefined,
      afterAll: () => undefined,
    }
    defineTransportConformance(fake, {}, rec)
    expect(skipped).toEqual(
      expect.arrayContaining([
        'CF-16 lanes: feature lanes is off for fake',
        'CF-17 busy policy: feature busyRetry is off for fake',
        'CF-18 identity events: feature identityEvents is off for fake',
        'CF-19 crash replay: feature crashInjection is off for fake',
        'CF-12 output parity: CF-12 needs a second target; none given for fake',
      ]),
    )
    expect(skipped).toHaveLength(5)
    // Every case that is not skipped has at least one registered body; none is the "no body" failure.
    expect(tests.some((n) => n.includes('a body is supplied'))).toBe(false)
    for (const c of CONFORMANCE_CASES) {
      if (['CF-12', 'CF-16', 'CF-17', 'CF-18', 'CF-19'].includes(c.id)) continue
      expect(tests.some((n) => n.includes(`[${c.id} `)), c.id).toBe(true)
    }
    const planned = planConformance({ ...fake, features: { ...fake.features, lanes: true } }, null)
    expect(planned.find((p) => p.spec.id === 'CF-16')!.skip).toBe('feature crossProcess is off for fake')
  })

  it(
    'HS-55 conformance.ts is thin: it resolves nothing under src/core and no zod',
    async () => {
      const file = join(ROOT, 'src', 'client', 'conformance.ts')
      const edges = await importGraph([file])
      const own = edges.filter(([parent]) => parent === asUrl(file))
      for (const [, child] of edges) {
        expect(child).not.toContain('/src/core/')
        expect(child).not.toMatch(/\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?zod\//)
      }
      expect(own.length).toBeLessThanOrEqual(15)
    },
    60_000,
  )
})

describe('in-process conformance checks with the core in reach', () => {
  it('HS-73 (a) no-required-param ops and (b) ref/string ops at 999999 settle exactly as the direct core call; (c) {} refuses before the core', async () => {
    const clockA = manualClock()
    const clockB = manualClock()
    const a = memBoard('hs73', clockA.now)
    const b = memBoard('hs73', clockB.now)
    const t = new InProcessTransport({ board: a.board, identity: ada() })
    const caller = ada().callerFor(undefined)
    const groupA: OpName[] = []
    const groupB: OpName[] = []
    const groupC: OpName[] = []
    for (const op of OP_NAMES) {
      const required = OPS[op].params.filter((p) => p.optional !== true)
      if (required.length === 0) groupA.push(op)
      else if (required.every((p) => p.kind === 'ref' || p.kind === 'string')) groupB.push(op)
      else groupC.push(op)
    }
    expect([...groupA, ...groupB, ...groupC].sort()).toEqual([...OP_NAMES])
    expect(groupC).toEqual(['uploadFinish'])
    for (const op of groupA) {
      expect(await settleVia(t, op, {}), op).toEqual(await settleDirect(b.board, op, {}, caller))
    }
    for (const op of groupB) {
      const input: Rec = {}
      for (const p of OPS[op].params) if (p.optional !== true) input[p.name] = '999999'
      expect(await settleVia(t, op, input), op).toEqual(await settleDirect(b.board, op, input, caller))
    }
    const calls = spyAllServiceMethods()
    for (const op of [...groupB, ...groupC]) {
      const first = OPS[op].params.find((p) => p.optional !== true)!
      const e = await rejection(call(t, op, {}))
      expect({ status: e.status, code: e.code }, op).toEqual({ status: 400, code: 'invalid_request' })
      expect(e.message, op).toContain(first.name)
    }
    expect(calls()).toBe(0)
  })

  it('HS-73 CF-02 every op answers its fixture on a fresh board (in-process, direct check of the fixture table)', async () => {
    const failures: string[] = []
    for (const op of OP_NAMES) {
      const { board } = memBoard()
      const t = new InProcessTransport({ board, identity: ada() })
      try {
        await call(t, op, await FIXTURES[op](t))
      } catch (error) {
        failures.push(`${op}: ${String((error as Error).message)}`)
      }
    }
    expect(failures).toEqual([])
  })

  it('HS-74 callerFor runs once per call with opts.as; its refusal stops the call before the core; input never shapes the caller', async () => {
    const { board } = memBoard()
    const inner = ada()
    const seen: (string | null | undefined)[] = []
    let last: CallerContext | null = null
    const identity: IdentityProvider = {
      kind: inner.kind,
      base: inner.base,
      callerFor(as) {
        seen.push(as)
        last = inner.callerFor(as)
        return last
      },
    }
    const t = new InProcessTransport({ board, identity })
    await call(t, 'me', {})
    await call(t, 'me', {}, { as: 'w1' })
    await call(t, 'me', {}, { as: null })
    expect(seen).toEqual([undefined, 'w1', null])

    const calls = spyAllServiceMethods()
    const e = await rejection(call(t, 'post', { channel: 'dev', text: 'x' }, { as: 'bad_name' }))
    expect(e).toMatchObject({ status: 400, code: 'invalid_profile' })
    expect(seen).toHaveLength(4)
    expect(calls()).toBe(0)
    vi.restoreAllMocks()

    const postSpy = vi.spyOn(BoardService.prototype, 'postMessage')
    await call(t, 'post', { channel: 'dev', text: 'x', principal: 'local:user:boss', actor: 'x', caller: 'y' }).catch(() => undefined)
    expect(postSpy).toHaveBeenCalledTimes(1)
    expect(postSpy.mock.calls[0]![0]).toBe(last)
    expect((postSpy.mock.calls[0]![0] as CallerContext).principal.id).toBe('local:user:ada')
  })

  it("HS-75 a deployment-kind caller is 403 forbidden before the core (accident protection, not a boundary)", async () => {
    const { board } = memBoard()
    const base = createLocalCaller()
    const deployment = { ...base, principal: { ...base.principal, kind: 'deployment' } } as unknown as CallerContext
    const t = new InProcessTransport({ board, identity: fixedIdentity(deployment) })
    const calls = spyAllServiceMethods()
    const e = await rejection(call(t, 'me', {}))
    expect(e).toMatchObject({ status: 403, code: 'forbidden', message: "a transport never acts as the board's deployment" })
    expect(calls()).toBe(0)
  })

  it('HS-76 a non-board failure is 500 "internal error" and leaks nothing; a bad body is the core\'s first issue', async () => {
    const { board } = memBoard()
    const t = new InProcessTransport({ board, identity: ada() })
    vi.spyOn(BoardService.prototype, 'me').mockImplementation(() => {
      throw new TypeError('/secret/path')
    })
    const e = await rejection(call(t, 'me', {}))
    expect(e).toMatchObject({ status: 500, code: 'internal', message: 'internal error' })
    for (const text of [e.message, String(e.hint), JSON.stringify(e.details ?? null), JSON.stringify(toErrorPayload(e))]) {
      expect(text).not.toContain('/secret/path')
    }
    vi.restoreAllMocks()
    expect(await rejection(call(t, 'post', { channel: 'dev' }))).toMatchObject({ status: 400, code: 'invalid_request', message: 'text: message text is empty' })
  })

  it('HS-74 a localIdentity without member is refused by the seeded grants on every op (no implicit full access)', async () => {
    const { board } = memBoard()
    const t = new InProcessTransport({ board, identity: localIdentity({ userId: 'nobody', profiles: [] }) })
    expect(await rejection(call(t, 'me', {}))).toMatchObject({ status: 403, code: 'forbidden' })
  })
})
