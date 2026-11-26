// HS-89: every op marked retry 'in-process' takes at most one outermost BEGIN IMMEDIATE for its fixture call, on a
// fresh board and on a seeded one. A retryable 503 then proves "not committed", so the in-process busy retry needs
// no key (HOST123_DESIGN 6.3). The test lists every op's count and fails on one that takes more and is still marked.
import { afterAll, describe, expect, it } from 'vitest'
import { BoardService, SqliteUnifiedStore } from '../../src/core/public.ts'
import { OP_NAMES, OPS, type OpName } from '../../src/client/ops.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'
import { ada, FIXTURES } from './fixtures.ts'
import { call } from './suite/util.ts'

const stores: SqliteUnifiedStore[] = []
afterAll(() => {
  for (const s of stores) s.close()
})

async function countFor(op: OpName, seeded: boolean): Promise<number> {
  const counter = { on: false, begins: 0 }
  const store = new SqliteUnifiedStore({
    path: ':memory:',
    testHooks: {
      onBeginImmediate: () => {
        if (counter.on) counter.begins += 1
      },
    },
  })
  stores.push(store)
  const board = new BoardService(store)
  const t = new InProcessTransport({ board, identity: ada() })
  if (seeded) {
    for (let i = 0; i < 5; i++) await call(t, 'post', { channel: 'dev', text: `seed ${i}` })
    await call(t, 'createTasks', { channel: 'work', tasks: [{ text: 'a' }, { text: 'b' }] })
    await call(t, 'createChannel', { path: 'seeded' })
  }
  const input = await FIXTURES[op](t)
  counter.on = true
  try {
    await call(t, op, input)
  } finally {
    counter.on = false
  }
  return counter.begins
}

describe('HS-89 one outermost transaction per retry-marked op', () => {
  it('HS-89 each in-process-retried op takes at most 1 BEGIN IMMEDIATE (fresh and seeded boards)', async () => {
    const table: Record<string, [number, number]> = {}
    const over: string[] = []
    for (const op of OP_NAMES) {
      const fresh = await countFor(op, false)
      const seeded = await countFor(op, true)
      table[op] = [fresh, seeded]
      if (OPS[op].retry === 'in-process' && (fresh > 1 || seeded > 1)) over.push(`${op}: fresh ${fresh}, seeded ${seeded}`)
    }
    expect(over).toEqual([])
    for (const op of ['post', 'edit', 'react', 'createChannel', 'schedule', 'register', 'delete', 'createTask', 'createTasks', 'claimTask', 'claimReadyTask'] as const) {
      expect(table[op], op).toEqual([1, 1])
    }
    for (const op of ['me', 'channels', 'events'] as const) expect(table[op], op).toEqual([0, 0])
    expect(Object.keys(table)).toHaveLength(OP_NAMES.length)
    expect(OP_NAMES).toHaveLength(84)
  })
})
