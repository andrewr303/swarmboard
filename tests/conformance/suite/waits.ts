// Conformance cases on waits and feeds: feed integrity (CF-06), bounded wait (CF-07), abort (CF-08), cross-process
// wake (CF-09), cursor portability (CF-14).
import { expect } from 'vitest'
import type { EventsPage } from '../../../src/core/public.ts'
import type { Suite } from '../contract.ts'
import { call, events, head, post, readAll, rejection, sleep } from './util.ts'

const p95 = (xs: number[]): number => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1]!

export const WAITS_SUITE: Suite = {
  'CF-06': [
    {
      name: 'HS-79 events() while a peer posts three waves of 10: all 30 in order, no repeat; abort and close end it',
      timeoutMs: 90_000,
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const peer = await board.peer('bob')
        const controller = new AbortController()
        const got: { cursor: number; id: string }[] = []
        let endedAt = 0
        const consumer = (async () => {
          for await (const page of transport.events({ channel: 'dev' }, { signal: controller.signal })) {
            for (const ev of page.events) if (ev.type === 'message.posted') got.push({ cursor: Number(ev.cursor), id: String(ev.message?.id) })
          }
          endedAt = performance.now()
        })()
        await sleep(30)
        const ids: string[] = []
        for (let wave = 0; wave < 3; wave++) {
          for (let i = 0; i < 10; i++) ids.push(String((await post(peer, 'dev', `w${wave}-${i}`))['id']))
          await sleep(150)
        }
        const deadline = Date.now() + 5_000
        while (got.length < 30 && Date.now() < deadline) await sleep(20)
        const abortedAt = performance.now()
        controller.abort()
        await consumer
        expect(endedAt - abortedAt).toBeLessThan(100 + (transport.capabilities.wakePollMs ?? 0))
        expect(got.map((g) => g.id)).toEqual(ids)
        for (let i = 1; i < got.length; i++) expect(got[i]!.cursor).toBeGreaterThan(got[i - 1]!.cursor)

        // close() ends a feed too
        const second = (async () => {
          let pages = 0
          for await (const _ of transport.events({ channel: 'dev' })) pages += 1
          return pages
        })()
        await sleep(30)
        await transport.close()
        await expect(second).resolves.toBeTypeOf('number')
      },
    },
    {
      name: 'HS-79 CF-06 two writers × 250 posts while one consumer iterates: the exact range, ascending, no duplicates',
      timeoutMs: 120_000,
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const peer = await board.peer('bob')
        const start = await head(transport)
        const controller = new AbortController()
        const seen: number[] = []
        const cursors: string[] = []
        const consumer = (async () => {
          for await (const page of transport.events({ channel: 'dev', after: start }, { signal: controller.signal })) {
            cursors.push(page.cursor)
            for (const ev of page.events) seen.push(Number(ev.cursor))
          }
        })()
        const writer = async (t: typeof transport, name: string) => {
          for (let i = 0; i < 250; i++) {
            await post(t, 'dev', `${name}-${i}`)
            if (i % 25 === 0) await sleep(1)
          }
        }
        await Promise.all([writer(transport, 'a'), writer(peer, 'b')])
        const expected = (await readAll(transport, start, { channel: 'dev' })).map((e) => Number(e.cursor))
        expect(expected).toHaveLength(500)
        const deadline = Date.now() + 10_000
        while (seen.length < 500 && Date.now() < deadline) await sleep(20)
        controller.abort()
        await consumer
        expect(seen).toEqual(expected)
        for (const c of cursors) expect(c).toMatch(/^(0|[1-9]\d*)$/)
        for (let i = 1; i < cursors.length; i++) expect(Number(cursors[i])).toBeGreaterThanOrEqual(Number(cursors[i - 1]))
      },
    },
  ],
  'CF-07': [
    {
      name: 'HS-65 a bounded wait on a quiet board returns {events: []} at the head after its wait',
      async run(ctx) {
        const { transport } = await ctx.open()
        const at = await head(transport)
        const started = performance.now()
        const page = await events(transport, { wait: 1 })
        const took = performance.now() - started
        expect(page.events).toEqual([])
        expect(page.cursor).toBe(at)
        expect(took).toBeGreaterThanOrEqual(995)
        expect(took).toBeLessThanOrEqual(1000 + (transport.capabilities.wakePollMs ?? 0) + 250)
      },
    },
    {
      name: 'HS-80 a wait above 300 s is refused 400 for events and claimReadyTask',
      async run(ctx) {
        const { transport } = await ctx.open()
        expect(await rejection(events(transport, { wait: 301 }))).toMatchObject({ status: 400, code: 'invalid_request' })
        expect(await rejection(call(transport, 'claimReadyTask', { channel: 'work', wait: 301 }))).toMatchObject({ status: 400, code: 'invalid_request' })
      },
    },
  ],
  'CF-08': [
    {
      name: 'HS-78 an aborted events wait resolves empty at the head; an aborted claim wait resolves {task: null}',
      async run(ctx) {
        const { transport } = await ctx.open()
        const at = await head(transport)
        const slack = 100 + (transport.capabilities.wakePollMs ?? 0)
        const c1 = new AbortController()
        const waiting = events(transport, { wait: 30 }, { signal: c1.signal })
        await sleep(100)
        const t1 = performance.now()
        c1.abort()
        const page = await waiting
        expect(performance.now() - t1).toBeLessThanOrEqual(slack)
        expect(page).toEqual({ events: [], cursor: at })
        const c2 = new AbortController()
        const claiming = call(transport, 'claimReadyTask', { channel: 'work', wait: 30 }, { signal: c2.signal })
        await sleep(100)
        const t2 = performance.now()
        c2.abort()
        expect(await claiming).toEqual({ task: null })
        expect(performance.now() - t2).toBeLessThanOrEqual(slack)
      },
    },
    {
      name: "HS-65 an aborted non-wait op rejects with the signal's reason",
      async run(ctx) {
        const { transport } = await ctx.open()
        const before = await head(transport)
        const signal = AbortSignal.abort()
        let thrown: unknown
        try {
          await call(transport, 'post', { channel: 'dev', text: 'never' }, { signal })
        } catch (error) {
          thrown = error
        }
        expect(thrown).toBe(signal.reason)
        expect(await head(transport)).toBe(before)
      },
    },
  ],
  'CF-09': [
    {
      name: 'HS-72 CF-09 an external commit wakes a pending events wait within the poll budget (20 trials, p95)',
      timeoutMs: 120_000,
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const caps = transport.capabilities
        expect(caps.crossProcessWake).toBe(true)
        const budget = caps.wake === 'fs-watch' ? 50 : (caps.wakePollMs ?? 0) + 50
        // Warm up once so `.wakeup` exists and any watcher is armed before the 20 measured trials.
        const warmAfter = await head(transport)
        const warmWait = events(transport, { after: warmAfter, wait: 10 })
        await sleep(15)
        const warm = await board.externalPost('dev', 'warmup')
        const warmPage: EventsPage = await warmWait
        expect(warmPage.events.some((e) => String(e.message?.id) === warm.id)).toBe(true)
        const lat: number[] = []
        for (let i = 0; i < 20; i++) {
          const after = await head(transport)
          const waiting = events(transport, { after, wait: 10 })
          await sleep(15)
          const at = performance.now()
          const { id } = await board.externalPost('dev', `x${i}`)
          const page: EventsPage = await waiting
          lat.push(performance.now() - at)
          expect(page.events.some((e) => String(e.message?.id) === id)).toBe(true)
        }
        expect(p95(lat)).toBeLessThanOrEqual(budget)
      },
    },
  ],
  'CF-14': [
    {
      name: 'HS-72 CF-14 a cursor from the transport returns the same next events on a peer',
      async run(ctx) {
        const board = await ctx.open()
        const { transport } = board
        const peer = await board.peer('ada')
        const cursor = await head(transport)
        for (let i = 0; i < 3; i++) await post(transport, 'dev', `c${i}`)
        const mine = await events(transport, { after: cursor })
        const theirs = await events(peer, { after: cursor })
        expect(theirs.cursor).toBe(mine.cursor)
        expect(theirs.events.map((e) => [e.cursor, e.type])).toEqual(mine.events.map((e) => [e.cursor, e.type]))
        expect(mine.events.length).toBeGreaterThanOrEqual(3)
      },
    },
  ],
}
