// Conformance case CF-05: idempotency keys (HOST123_DESIGN 6.2, 7.2). HS-81..HS-86.
import { expect } from 'vitest'
import { keyedId } from '../../../src/client/idempotency.ts'
import type { Suite } from '../contract.ts'
import { IDS } from '../fixtures.ts'
import { call, head, messageOf, post, readAll, rejection, type Rec } from './util.ts'

const ADA = 'local:user:ada'
const token = (seed: string): string => (seed.repeat(43)).slice(0, 43)

export const IDEMPOTENCY_SUITE: Suite = {
  'CF-05': [
    {
      name: 'HS-81 a key twice lands one post; another body is 409; a refused keyed call records nothing',
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const start = await head(transport)
        const first = await post(transport, 'dev', 'a', {}, { idempotencyKey: 'K' })
        const again = await post(transport, 'dev', 'a', {}, { idempotencyKey: 'K' })
        expect(again['id']).toBe(first['id'])
        const landed = await readAll(transport, start)
        expect(landed.filter((e) => e.type === 'message.posted' && String(e.message?.id) === first['id'])).toHaveLength(1)
        expect(landed).toHaveLength(1)
        const headAfter = await head(transport)
        const conflict = await rejection(call(transport, 'post', { channel: 'dev', text: 'b' }, { idempotencyKey: 'K' }))
        expect(conflict).toMatchObject({ status: 409, code: 'duplicate_id' })
        expect(await head(transport)).toBe(headAfter)
        const found = messageOf(await call(transport, 'posted', { id: keyedId(ADA, null, 'post', 'K') }))
        expect(found['id']).toBe(first['id'])

        const tooLong = await rejection(call(transport, 'post', { channel: 'dev', text: 'x'.repeat(10_001) }, { idempotencyKey: 'K3' }))
        expect(tooLong).toMatchObject({ status: 400, code: 'text_too_long' })
        const ok = await post(transport, 'dev', 'ok', {}, { idempotencyKey: 'K3' })
        expect(ok['text']).toBe('ok')
        expect(messageOf(await call(transport, 'posted', { id: keyedId(ADA, null, 'post', 'K3') }))['id']).toBe(ok['id'])

        // refused 403 by a revoked grant, then resent after the grant is restored
        const boss = await board.peer('boss')
        const carl = await board.peer('carl')
        const grant = { principals: [{ kind: 'user', userId: 'carl' }], can: { dev: ['read', 'post'] } }
        const g = await call(boss, 'createGrant', grant)
        await call(boss, 'revokeGrant', { id: g['id'] })
        const refused = await rejection(call(carl, 'post', { channel: 'dev', text: 'carl' }, { idempotencyKey: 'K4' }))
        expect(refused.status).toBe(403)
        await call(boss, 'createGrant', grant)
        const resent = await post(carl, 'dev', 'carl', {}, { idempotencyKey: 'K4' })
        expect(messageOf(await call(carl, 'posted', { id: keyedId('local:user:carl', null, 'post', 'K4') }))['id']).toBe(resent['id'])
      },
    },
    {
      name: 'HS-82 the same key from two profiles of one principal lands two messages',
      async run(ctx) {
        const { transport } = await ctx.open()
        const a = await post(transport, 'dev', 'same', {}, { idempotencyKey: 'K', as: 'w1' })
        const b = await post(transport, 'dev', 'same', {}, { idempotencyKey: 'K', as: 'w2' })
        expect(a['id']).not.toBe(b['id'])
      },
    },
    {
      name: 'HS-83 key + id is 400; a key on an unsafe op is 400 and writes nothing; label and react accept a key',
      async run(ctx) {
        const { transport } = await ctx.open()
        const both = await rejection(call(transport, 'post', { channel: 'dev', text: 'x', id: 'k-2' }, { idempotencyKey: 'k-1' }))
        expect(both).toMatchObject({ status: 400, code: 'invalid_request' })
        expect(both.message).toContain('pass an id or an idempotencyKey, not both')
        const sched = await rejection(call(transport, 'schedule', { channel: 'dev', text: 'later', in: '1h' }, { idempotencyKey: 'S' }))
        expect(sched).toMatchObject({ status: 400, code: 'invalid_request' })
        expect(sched.message).toContain('no idempotent form')
        expect(await call(transport, 'schedules', {})).toEqual([])
        const m = await post(transport, 'dev', 'target')
        await call(transport, 'label', { id: m['id'], set: { state: 'open' } }, { idempotencyKey: 'L' })
        await call(transport, 'react', { id: m['id'], emoji: 'eyes' }, { idempotencyKey: 'R' })
        const thread = messageOf(await call(transport, 'message', { id: m['id'] }))
        expect(thread['labels']).toMatchObject({ state: 'open' })
        expect(JSON.stringify(thread['reactions'])).toContain('eyes')
        expect(await rejection(call(transport, 'post', { channel: 'dev', text: 'x' }, { idempotencyKey: 'has space' }))).toMatchObject({ status: 400 })
      },
    },
    {
      name: 'HS-84 a keyed claimTask replays only with its own token; the key derives no token',
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const start = await head(transport)
        const task = ((await call(transport, 'createTask', { channel: 'work', text: 't' })) as { task: Rec }).task
        const T = token('Ab9-')
        const one = (await call(transport, 'claimTask', { id: task['id'], token: T }, { idempotencyKey: 'K' })) as { claim: Rec }
        const two = (await call(transport, 'claimTask', { id: task['id'], token: T }, { idempotencyKey: 'K' })) as { claim: Rec }
        expect(two.claim['epoch']).toBe(one.claim['epoch'])
        expect(one.claim['token']).toBe(T)
        expect(two.claim['token']).toBe(T)
        expect((await readAll(transport, start)).filter((e) => e.type === 'task.claimed')).toHaveLength(1)
        const bob = await board.peer('bob')
        expect(await rejection(call(bob, 'claimTask', { id: task['id'] }))).toMatchObject({ status: 409, code: 'task_claimed' })
        expect(await rejection(call(transport, 'claimTask', { id: task['id'], token: token('Zz8_') }))).toMatchObject({ status: 409, code: 'task_claimed' })
        const fresh = ((await call(transport, 'createTask', { channel: 'work', text: 'fresh' })) as { task: Rec }).task
        await call(transport, 'claimTask', { id: fresh['id'] }, { idempotencyKey: 'K2' })
        expect(await rejection(call(transport, 'claimTask', { id: fresh['id'] }, { idempotencyKey: 'K2' }))).toMatchObject({
          status: 409,
          code: 'task_claimed',
        })
      },
    },
    {
      name: 'HS-85 createTasks with a key twice gives the same roots; another list under the key from another connection is 409',
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const body = { channel: 'work', tasks: [{ text: 'one' }, { text: 'two' }] }
        const roots = (r: Rec): unknown => JSON.stringify((r['tasks'] as Rec[]).map((t) => t['id']))
        const a = await call(transport, 'createTasks', body, { idempotencyKey: 'K' })
        const b = await call(transport, 'createTasks', body, { idempotencyKey: 'K' })
        expect(roots(b)).toBe(roots(a))
        const other = await board.peer('ada')
        const e = await rejection(call(other, 'createTasks', { channel: 'work', tasks: [{ text: 'three' }] }, { idempotencyKey: 'K' }))
        expect(e).toMatchObject({ status: 409, code: 'duplicate_id' })
      },
    },
    {
      name: "HS-86 a blind writer's keyed replay is frozen at what it first saw",
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const blind = await board.peer('blind')
        const first = await call(blind, 'post', { channel: 'drop', text: 'into the drop' }, { idempotencyKey: 'K' })
        const id = messageOf(first)['id']
        await call(transport, 'label', { id, set: { state: 'seen' } })
        await call(transport, 'react', { id, emoji: 'eyes' })
        const again = await call(blind, 'post', { channel: 'drop', text: 'into the drop' }, { idempotencyKey: 'K' })
        expect(again).toEqual(first)
        expect(JSON.stringify(messageOf(await call(transport, 'message', { id })))).toContain('seen')
      },
    },
    {
      name: 'HS-81 CF-05 (B4-2) a busy-injected first attempt retried by the transport yields one set of events',
      timeoutMs: 60_000,
      async run(ctx) {
        if (!ctx.target.features.busyRetry || !ctx.target.spawnPeer) return
        const { dir, board } = await ctx.openWithDir(IDS)
        const { transport } = board
        const peer = await ctx.target.spawnPeer(dir, IDS, 'bob')
        try {
          const start = await head(transport)
          // Hold BEGIN IMMEDIATE across processes so the first attempt of each keyed write hits SQLITE_BUSY.
          await peer.hold(250)
          const first = await post(transport, 'dev', 'busy-keyed', {}, { idempotencyKey: 'K-busy-post' })
          const replay = await post(transport, 'dev', 'busy-keyed', {}, { idempotencyKey: 'K-busy-post' })
          expect(replay['id']).toBe(first['id'])
          expect(messageOf(await call(transport, 'posted', { id: keyedId(ADA, null, 'post', 'K-busy-post') }))['id']).toBe(first['id'])

          await peer.hold(250)
          const task1 = (await call(transport, 'createTask', { channel: 'work', text: 'busy-task' }, { idempotencyKey: 'K-busy-task' })) as { task: Rec }
          const task2 = (await call(transport, 'createTask', { channel: 'work', text: 'busy-task' }, { idempotencyKey: 'K-busy-task' })) as { task: Rec }
          expect(task2.task['id']).toBe(task1.task['id'])

          await peer.hold(250)
          const batch1 = (await call(
            transport,
            'createTasks',
            { channel: 'work', tasks: [{ text: 'b1' }, { text: 'b2' }] },
            { idempotencyKey: 'K-busy-batch' },
          )) as { tasks: Rec[] }
          const batch2 = (await call(
            transport,
            'createTasks',
            { channel: 'work', tasks: [{ text: 'b1' }, { text: 'b2' }] },
            { idempotencyKey: 'K-busy-batch' },
          )) as { tasks: Rec[] }
          expect(batch2.tasks.map((t) => t['id'])).toEqual(batch1.tasks.map((t) => t['id']))

          const evs = await readAll(transport, start)
          expect(evs.filter((e) => e.type === 'message.posted' && String(e.message?.id) === String(first['id']))).toHaveLength(1)
          expect(evs.filter((e) => e.type === 'task.created' && String(e.message?.id) === String(task1.task['id']))).toHaveLength(1)
          for (const t of batch1.tasks) {
            expect(evs.filter((e) => e.type === 'task.created' && String(e.message?.id) === String(t['id']))).toHaveLength(1)
          }
        } finally {
          await peer.close()
        }
      },
    },
  ],
}
