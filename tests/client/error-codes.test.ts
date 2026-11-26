// HS-71 (g1 HS-1.66b, the gate for the registry's error lists): every BoardErrorLike code a transport call rejects
// with is in UNIVERSAL_ERRORS or the op's own `errors`. Each test file that drives a transport through the
// recorder checks its own calls (vitest runs files in separate workers, so the pairs cannot be pooled across
// files); this file adds a sweep that drives every op through several shapes of input and several identities.
import { afterAll, describe, expect, it } from 'vitest'
import { BoardService, SqliteUnifiedStore } from '../../src/core/public.ts'
import { OP_NAMES, OPS, type OpName } from '../../src/client/ops.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'
import type { BoardTransport } from '../../src/client/types.ts'
import { FIXTURES, IDS, providerFor, recorded, SEEN_ERRORS, unlistedErrors } from '../conformance/fixtures.ts'

type Rec = Record<string, unknown>
const stores: SqliteUnifiedStore[] = []
afterAll(() => {
  for (const s of stores) s.close()
})

function board(): { as(name: string): BoardTransport } {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  const service = new BoardService(store)
  return { as: (name) => recorded(new InProcessTransport({ board: service, identity: providerFor(IDS[name]!) })) }
}

const quiet = async (p: Promise<unknown>): Promise<void> => {
  try {
    await p
  } catch {
    // recorded
  }
}

/** Variants of an op's fixture input that should each fail in a different way. */
function variants(op: OpName, fixture: Rec): Rec[] {
  const out: Rec[] = [{}]
  const refs: Rec = {}
  for (const p of OPS[op].params) if (p.optional !== true && (p.kind === 'ref' || p.kind === 'string')) refs[p.name] = '999999'
  out.push({ ...fixture, ...refs })
  out.push({ ...fixture, id: 'not a valid id at all \u0000' })
  if ('epoch' in fixture) out.push({ ...fixture, epoch: 99 })
  if ('token' in fixture) out.push({ ...fixture, token: 'x'.repeat(43) })
  if ('lease' in fixture) out.push({ ...fixture, lease: 'nope' })
  if ('channel' in fixture) out.push({ ...fixture, channel: 'Not A Channel' })
  return out
}

describe('HS-71 error codes', () => {
  it('HS-71 a sweep of every op (fixture, empty, missing ids, stale fences, narrowed and non-member identities) sees only listed codes', async () => {
    for (const op of OP_NAMES) {
      const b = board()
      const ada = b.as('ada')
      const fixture = await FIXTURES[op](ada)
      await quiet(ada.call(op, fixture as never))
      await quiet(ada.call(op, fixture as never))
      for (const input of variants(op, fixture)) await quiet(ada.call(op, input as never))
      for (const who of ['eve', 'blind', 'carl', 'adaRead']) await quiet(b.as(who).call(op, fixture as never))
      await quiet(ada.call(op, fixture as never, { as: 'zz' }))
      await quiet(ada.call(op, fixture as never, { as: 'bad_name' }))
      await quiet(ada.call(op, fixture as never, { idempotencyKey: 'has space' }))
      await quiet(ada.call(op, fixture as never, { expectInstance: 'i_other' }))
    }
    // Every op was refused at least once (its `as: 'zz'` call), so every op's list was checked.
    expect(new Set(SEEN_ERRORS.map((p) => p.op)).size).toBe(OP_NAMES.length)
    expect(OP_NAMES.length).toBe(84)
    const codes = new Set(SEEN_ERRORS.map((p) => p.code))
    expect(codes.size).toBeGreaterThan(15)
    for (const code of ['invalid_request', 'forbidden', 'profile_mismatch', 'invalid_profile']) expect(codes.has(code), code).toBe(true)
    expect(unlistedErrors()).toEqual([])
  }, 120_000)
})
