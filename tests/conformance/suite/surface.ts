// Conformance cases on the call surface: capabilities (CF-01), reachability (CF-02), envelope (CF-03), errors
// (CF-04), identity (CF-10), close (CF-11), token hygiene (CF-13), hidden = missing (CF-15). Portable: everything
// here goes through BoardTransport only.
import { expect } from 'vitest'
import { BOARD_ID_PATTERN, SCHEMA_VERSION } from '../../../src/core/public.ts'
import { PROTOCOL_VERSION } from '../../../src/client/version.ts'
import { OP_NAMES, OPS, isOpName, type OpName } from '../../../src/client/ops.ts'
import type { Suite } from '../contract.ts'
import { BAD_INPUTS, FIXTURES } from '../fixtures.ts'
import { call, events, head, messageOf, post, rejection, sleep, type Rec } from './util.ts'

const TOKEN = 'Tk0'.repeat(14) + 'Z'

export const SURFACE_SUITE: Suite = {
  'CF-01': [
    {
      name: 'HS-59 capabilities: frozen, protocol, schemaVersion from the board, boardId pattern, ops = registry',
      async run(ctx) {
        const { transport } = await ctx.open()
        const caps = transport.capabilities
        expect(Object.isFrozen(caps)).toBe(true)
        expect(caps.protocol).toBe(PROTOCOL_VERSION)
        expect(caps.schemaVersion).toBe(SCHEMA_VERSION)
        expect(caps.boardId).toMatch(BOARD_ID_PATTERN)
        for (const op of caps.ops) expect(isOpName(op), op).toBe(true)
        expect([...caps.ops].sort()).toEqual([...OP_NAMES])
        expect(transport.capabilities).toBe(caps)
      },
    },
  ],
  'CF-02': [
    {
      name: 'HS-73 every op in caps.ops answers its minimal fixture input without 501 or 400',
      timeoutMs: 60_000,
      async run(ctx) {
        const probe = await ctx.open()
        const ops = probe.transport.capabilities.ops
        const failures: string[] = []
        for (const op of ops) {
          const board = await ctx.open()
          try {
            const input = await FIXTURES[op](board.transport)
            await call(board.transport, op, input)
          } catch (error) {
            const e = error as { status?: number; code?: string; message?: string }
            failures.push(`${op}: ${e.status} ${e.code} ${e.message}`)
          }
          await board.close()
        }
        expect(failures).toEqual([])
      },
    },
    {
      name: 'HS-73 every op with a required param refuses {} with 400 naming the first missing one',
      async run(ctx) {
        const { transport } = await ctx.open()
        for (const op of OP_NAMES) {
          const required = OPS[op].params.find((p) => p.optional !== true)
          if (required === undefined) continue
          const e = await rejection(call(transport, op, {}))
          expect(e.status, op).toBe(400)
          expect(e.code, op).toBe('invalid_request')
          expect(e.message, op).toContain(required.name)
        }
      },
    },
  ],
  'CF-03': [
    {
      name: 'HS-62 the bad-input table gives 400 invalid_request on this target',
      async run(ctx) {
        const { transport } = await ctx.open()
        const before = await head(transport)
        for (const bad of BAD_INPUTS) {
          const e = await rejection(call(transport, bad.op, bad.input))
          expect({ status: e.status, code: e.code }, bad.name).toEqual({ status: 400, code: 'invalid_request' })
          if (bad.names !== undefined) expect(e.message, bad.name).toContain(bad.names)
        }
        expect(await head(transport)).toBe(before)
      },
    },
  ],
  'CF-04': [
    {
      name: "HS-76 a core refusal keeps status, code and message; a bad body gives the core's first issue",
      async run(ctx) {
        const { transport } = await ctx.open()
        const missing = await rejection(call(transport, 'message', { id: '999999' }))
        expect(missing).toMatchObject({ status: 404, code: 'message_not_found', origin: 'board' })
        expect(missing.message).toContain('999999')
        const empty = await rejection(call(transport, 'post', { channel: 'dev' }))
        expect(empty).toMatchObject({ status: 400, code: 'invalid_request', message: 'text: message text is empty' })
      },
    },
  ],
  'CF-10': [
    {
      name: 'HS-64 as: a profile, a foreign profile (403, nothing written), null (the principal)',
      async run(ctx) {
        const { transport } = await ctx.open()
        expect((await call(transport, 'me', {}, { as: 'w1' }))['actor']).toBe('local:user:ada+w1')
        const before = await head(transport)
        const e = await rejection(call(transport, 'post', { channel: 'dev', text: 'no' }, { as: 'zz' }))
        expect(e).toMatchObject({ status: 403, code: 'profile_mismatch' })
        expect(await head(transport)).toBe(before)
        const me = await call(transport, 'me', {}, { as: null })
        expect(me['actor']).toBe('local:user:ada')
        expect(me['principal']).toBe('local:user:ada')
        const byW2 = await post(transport, 'dev', 'as w2', {}, { as: 'w2' })
        expect((byW2['by'] as Rec)['actor']).toBe('local:user:ada+w2')
      },
    },
  ],
  'CF-11': [
    {
      name: 'HS-67 close(): a pending wait resolves, later calls 503 unavailable, close() is idempotent',
      async run(ctx) {
        const { transport } = await ctx.open()
        const pending = events(transport, { wait: 60 })
        await sleep(30)
        const started = performance.now()
        const closing = transport.close()
        const page = await pending
        expect(performance.now() - started).toBeLessThan(100 + (transport.capabilities.wakePollMs ?? 0))
        await closing
        expect(page.events).toEqual([])
        expect(transport.closed).toBe(true)
        expect(await rejection(call(transport, 'me', {}))).toMatchObject({ status: 503, code: 'unavailable' })
        await expect(transport.close()).resolves.toBeUndefined()
      },
    },
  ],
  'CF-13': [
    {
      name: 'HS-70 a claim token is in no error and in no event another identity (or the claimant) reads',
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const start = await head(transport)
        const made = (await call(transport, 'createTask', { channel: 'work', text: 'secret work', claim: true, token: TOKEN })) as { task: Rec }
        const id = made.task['id']
        const epoch = (made.task['task'] as Rec)['epoch']
        await call(transport, 'renewTask', { id, epoch, token: TOKEN })
        const wrong = 'Wr0'.repeat(14) + 'X'
        const e = await rejection(call(transport, 'completeTask', { id, epoch, token: wrong, result: 'r' }))
        expect(e.code).toBe('claim_lost')
        for (const text of [e.message, JSON.stringify(e), String(e.hint), JSON.stringify(e.details ?? null), String((e as Error & { cause?: unknown }).cause)]) {
          expect(text).not.toContain(wrong.slice(0, 12))
          expect(text).not.toContain(TOKEN.slice(0, 12))
        }
        const bob = await board.peer('bob')
        const seenByBob = JSON.stringify(await events(bob, { after: start }))
        const seenByAda = JSON.stringify(await events(transport, { after: start }))
        expect(seenByBob).toContain('task.claimed')
        expect(seenByBob).not.toContain(TOKEN)
        expect(seenByAda).not.toContain(TOKEN)
        expect(JSON.stringify(await call(bob, 'message', { id }))).not.toContain(TOKEN)
      },
    },
  ],
  'CF-15': [
    {
      name: 'HS-77 a hidden id and a missing id answer the same status, code and message',
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const hidden = messageOf(await call(transport, 'post', { channel: 'secret', text: 'hidden', id: 'cid-secret' }))
        const task = ((await call(transport, 'createTask', { channel: 'secret', text: 'hidden task' })) as { task: Rec }).task
        await post(transport, 'pub', 'public')
        const eve = await board.peer('eve')
        const missing = '999999'
        const cases: [OpName, (id: string) => Rec][] = [
          ['message', (id) => ({ id })],
          ['react', (id) => ({ id, emoji: 'eyes' })],
          ['label', (id) => ({ id, set: { state: 'x' } })],
          ['edit', (id) => ({ id, text: 'x' })],
          ['claimTask', (id) => ({ id })],
        ]
        const shape = (e: { status: number; code: string; message: string }, id: string) => ({
          status: e.status,
          code: e.code,
          message: e.message.split(id).join('<id>'),
        })
        for (const [op, input] of cases) {
          const target = op === 'claimTask' ? String(task['id']) : String(hidden['id'])
          const a = await rejection(call(eve, op, input(target)))
          const b = await rejection(call(eve, op, input(missing)))
          expect(shape(a, target), op).toEqual(shape(b, missing))
        }
        const a = await rejection(call(eve, 'posted', { id: 'cid-secret' }))
        const b = await rejection(call(eve, 'posted', { id: 'cid-unused' }))
        expect(shape(a, 'cid-secret')).toEqual(shape(b, 'cid-unused'))
        expect(a.status).toBe(404)
      },
    },
  ],
}
