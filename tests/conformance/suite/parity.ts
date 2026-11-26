// Conformance case CF-12: output parity. A scripted 30-op session gives JSON-equal outputs on two targets after
// minted ids, tokens, board ids and timestamps are replaced by placeholders (HS-187 runs it across modes in B9).
import { expect } from 'vitest'
import type { BoardTransport } from '../../../src/client/types.ts'
import type { Suite } from '../contract.ts'
import { IDS, placeholders, tempDir } from '../fixtures.ts'
import { call, type Rec } from './util.ts'

const TOKEN = 'Pa7_'.repeat(11).slice(0, 43)
const TIME = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z/g
const BOARD_IDS = /\b[bi]_[0-9a-z]{20,40}\b/g

/** The placeholder form plus timestamps and board/instance ids. */
export function parityForm(value: unknown): unknown {
  const text = JSON.stringify(placeholders(value)) ?? 'undefined'
  return JSON.parse(text.replace(TIME, '<time>').replace(BOARD_IDS, '<board-id>')) as unknown
}

/** 30 ops through one transport; returns every settled answer (value or {status, code}). */
export async function scriptedSession(t: BoardTransport): Promise<unknown[]> {
  const out: unknown[] = []
  const run = async (op: string, input: Rec): Promise<Rec> => {
    try {
      const value = await call(t, op, input)
      out.push({ op, value })
      return value
    } catch (error) {
      const e = error as { status?: number; code?: string }
      out.push({ op, error: { status: e.status, code: e.code } })
      return {}
    }
  }
  await run('me', {})
  await run('createChannel', { path: 'parity' })
  await run('channels', {})
  const root = (await run('post', { channel: 'parity', text: 'root', id: 'par-1' }))['message'] as Rec
  const id = root['id']
  await run('post', { re: id, text: 'reply' })
  await run('edit', { id, text: 'edited' })
  await run('react', { id, emoji: 'eyes' })
  await run('label', { id, set: { state: 'open' } })
  await run('message', { id })
  await run('posted', { id: 'par-1' })
  await run('channelMessages', { channel: 'parity' })
  await run('threads', { channel: 'parity' })
  await run('search', { query: 'edited' })
  await run('actors', {})
  const task = ((await run('createTask', { channel: 'parity', text: 'a task', claim: true, token: TOKEN }))['task'] as Rec | undefined) ?? {}
  const epoch = (task['task'] as Rec | undefined)?.['epoch']
  await run('renewTask', { id: task['id'], epoch, token: TOKEN })
  await run('completeTask', { id: task['id'], epoch, token: TOKEN, result: 'done' })
  await run('createTasks', { channel: 'parity', id: 'par-batch', tasks: [{ text: 'one' }, { text: 'two' }] })
  await run('createdTasks', { id: 'par-batch' })
  await run('tasks', { channel: 'parity' })
  await run('createSchema', { name: 'par', version: 1, schema: { type: 'object' } })
  await run('schema', { id: 'par@1' })
  await run('schemas', {})
  await run('register', { watch: { w: { tail: 'parity' } } })
  await run('watchers', {})
  await run('grants', {})
  await run('explain', { channel: 'parity' })
  await run('message', { id: '999999' })
  await run('delete', { id })
  await run('events', { after: '0', channel: 'parity' })
  return out
}

export const PARITY_SUITE: Suite = {
  'CF-12': [
    {
      name: 'CF-12 a scripted 30-op session is JSON-equal on two targets after placeholders (B9 runs it across modes as HS-187)',
      timeoutMs: 60_000,
      async run(ctx) {
        const other = ctx.parity
        expect(other).not.toBeNull()
        const a = await ctx.open()
        const b = await other!.open(tempDir('cb-cf-parity-'), IDS)
        try {
          const left = await scriptedSession(a.transport)
          const right = await scriptedSession(b.transport)
          expect(left).toHaveLength(30)
          expect(parityForm(right)).toEqual(parityForm(left))
        } finally {
          await b.close()
        }
      },
    },
  ],
}
