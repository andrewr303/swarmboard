// Small helpers the conformance suites share: untyped calls and error capture over BoardTransport.
import { isBoardError, type BoardErrorLike } from '../../../src/client/errors.ts'
import type { BoardTransport, CallOptions } from '../../../src/client/types.ts'
import type { EventsPage } from '../../../src/core/public.ts'

export type Rec = Record<string, unknown>

export const call = (t: BoardTransport, op: string, input: unknown, opts?: CallOptions): Promise<Rec> =>
  t.call(op as never, input as never, opts) as unknown as Promise<Rec>

export const events = (t: BoardTransport, input: Rec, opts?: CallOptions): Promise<EventsPage> =>
  t.call('events', input as never, opts) as unknown as Promise<EventsPage>

/** The BoardErrorLike a promise rejects with; fails if it resolves or rejects with anything else. */
export async function rejection(p: Promise<unknown>): Promise<BoardErrorLike> {
  try {
    await p
  } catch (error) {
    if (isBoardError(error)) return error
    throw error
  }
  throw new Error('expected a rejection')
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

export const messageOf = (r: Rec): Rec => r['message'] as Rec

export async function post(t: BoardTransport, channel: string, text: string, extra: Rec = {}, opts?: CallOptions): Promise<Rec> {
  return messageOf(await call(t, 'post', { channel, text, ...extra }, opts))
}

/** The head cursor, as an events call with no `after` reads it. */
export async function head(t: BoardTransport): Promise<string> {
  return (await events(t, {})).cursor
}

/** Every event after `after` (paged), optionally on one channel. */
export async function readAll(t: BoardTransport, after: string, extra: Rec = {}): Promise<EventsPage['events']> {
  const out: EventsPage['events'] = []
  let cursor = after
  for (;;) {
    const page = await events(t, { ...extra, after: cursor, limit: 500 })
    out.push(...page.events)
    if (page.events.length === 0 || page.cursor === cursor) return out
    cursor = page.cursor
  }
}
