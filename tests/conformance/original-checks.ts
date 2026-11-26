// The ten transport-relevant checks of the original conformance suite (board/packages/board/src/conformance/
// index.ts :509, :546, :571, :762, :797, :864, :871, :878, :1040, :1061), rewritten over BoardTransport.call. The
// original is the specification, not a dependency: nothing is imported from board/. The other 82 checks are ported
// with HOST-9, when an HTTP target exists.
import { expect } from 'vitest'
import type { ConformanceBoard } from '../../src/client/conformance.ts'
import { call, events, messageOf, post, rejection, sleep, type Rec } from './suite/util.ts'

export interface OriginalCheck {
  /** The line of the check in the original's conformance/index.ts. */
  readonly line: number
  readonly name: string
  run(board: ConformanceBoard): Promise<void>
}

const CHANNEL = 'conf'

async function read(board: ConformanceBoard, id: unknown): Promise<Rec> {
  return messageOf(await call(board.transport, 'message', { id }))
}

function lostWith(results: PromiseSettledResult<unknown>[], status: number, code: string): void {
  for (const r of results) {
    if (r.status === 'fulfilled') continue
    expect(r.reason).toMatchObject({ status, code })
  }
}

export const ORIGINAL_CHECKS: readonly OriginalCheck[] = [
  {
    line: 509,
    name: 'posts once for a client ID, however many times it is sent',
    async run(board) {
      const t = board.transport
      const first = await post(t, CHANNEL, 'conformance: once', { id: 'conformance-once' })
      const again = await post(t, CHANNEL, 'conformance: once', { id: 'conformance-once' })
      expect(again['id']).toBe(first['id'])
      expect(messageOf(await call(t, 'posted', { id: 'conformance-once' }))['id']).toBe(first['id'])
      expect(await rejection(call(t, 'posted', { id: 'conformance-once-never' }))).toMatchObject({ status: 404, code: 'post_not_found' })
    },
  },
  {
    line: 546,
    name: 'labels a message only while its labels are as the write says, one of any that race',
    async run(board) {
      const t = board.transport
      const message = await post(t, CHANNEL, 'conformance: a message to claim')
      const labels = async () => (await read(board, message['id']))['labels'] as Rec
      const racing = await Promise.allSettled([1, 2, 3].map((n) => call(t, 'label', { id: message['id'], set: { owner: `agent-${n}` }, if: { owner: null } })))
      const landed = racing.flatMap((r, n) => (r.status === 'fulfilled' ? [`agent-${n + 1}`] : []))
      expect(landed).toHaveLength(1)
      lostWith(racing, 409, 'label_conflict')
      expect((await labels())['owner']).toBe(landed[0])
      expect(await rejection(call(t, 'label', { id: message['id'], set: { owner: 'someone' }, if: { owner: 'no-one' } }))).toMatchObject({
        status: 409,
        code: 'label_conflict',
      })
      expect((await labels())['owner']).toBe(landed[0])
      await call(t, 'label', { id: message['id'], unset: ['owner'], if: { owner: landed[0] } })
      expect((await labels())['owner']).toBeUndefined()
    },
  },
  {
    line: 571,
    name: 'edits and deletes a message only at the revision it was read at, which only edits and deletes change',
    async run(board) {
      const t = board.transport
      const message = await post(t, CHANNEL, 'conformance: a message to edit')
      const id = message['id']
      const first = (await read(board, id))['revision']
      expect(typeof first).toBe('number')
      await call(t, 'react', { id, emoji: 'eyes' })
      await call(t, 'label', { id, set: { state: 'open' } })
      expect((await read(board, id))['revision']).toBe(first)
      await call(t, 'edit', { id, text: 'conformance: edited', revision: first })
      const second = (await read(board, id))['revision']
      expect(second).not.toBe(first)
      expect(await rejection(call(t, 'edit', { id, text: 'conformance: stale', revision: first }))).toMatchObject({ status: 409, code: 'revision_conflict' })
      expect(await rejection(call(t, 'delete', { id, revision: first }))).toMatchObject({ status: 409, code: 'revision_conflict' })
      const after = await read(board, id)
      expect(after['text']).toBe('conformance: edited')
      expect(after['deleted']).toBe(false)
      const racing = await Promise.allSettled([1, 2, 3].map((n) => call(t, 'edit', { id, text: `conformance: racing ${n}`, revision: second })))
      expect(racing.filter((r) => r.status === 'fulfilled')).toHaveLength(1)
      lostWith(racing, 409, 'revision_conflict')
      const last = (await read(board, id))['revision']
      await call(t, 'delete', { id, revision: last })
      expect((await read(board, id))['deleted']).toBe(true)
    },
  },
  {
    line: 762,
    name: 'reads events after a cursor, each with a cursor of its own',
    async run(board) {
      const t = board.transport
      const start = (await events(t, {})).cursor
      const root = await post(t, CHANNEL, 'conformance: root')
      const page = await events(t, { channel: CHANNEL, after: start })
      expect(page.cursor).toMatch(/^\d+$/)
      const posted = page.events.find((e) => e.type === 'message.posted' && String(e.message?.id) === root['id'])
      expect(posted).toBeDefined()
      expect(posted!.cursor).toMatch(/^\d+$/)
      const next = await events(t, { channel: CHANNEL, after: page.cursor })
      expect(next.events.some((e) => String(e.message?.id) === root['id'])).toBe(false)
    },
  },
  {
    line: 797,
    name: 'holds a long-poll open until the next event',
    async run(board) {
      const t = board.transport
      const { cursor } = await events(t, { channel: CHANNEL })
      const waiting = events(t, { channel: CHANNEL, after: cursor, wait: 10 })
      await sleep(200)
      const later = await post(t, CHANNEL, 'conformance: while it waits')
      const page = await waiting
      expect(page.events.some((e) => String(e.message?.id) === later['id'])).toBe(true)
    },
  },
  {
    line: 864,
    name: 'answers 404 for an ID that names nothing',
    async run(board) {
      expect(await rejection(call(board.transport, 'message', { id: 'no-such-message-conformance' }))).toMatchObject({ status: 404, code: 'message_not_found' })
    },
  },
  {
    line: 871,
    name: 'answers 400 for a request that does not validate',
    async run(board) {
      expect(await rejection(call(board.transport, 'post', { channel: 'Not A Channel', text: 'conformance', noSync: true }))).toMatchObject({
        status: 400,
        code: 'invalid_request',
      })
    },
  },
  {
    line: 878,
    name: 'narrows a caller to what its x-board-can says',
    async run(board) {
      const root = await post(board.transport, CHANNEL, 'conformance: root to read')
      const me = await call(board.transport, 'me', {})
      const narrowed = await board.peer('adaRead')
      const seen = await call(narrowed, 'me', {})
      expect(seen['principal']).toBe(me['principal'])
      expect(seen['can']).toEqual({ [CHANNEL]: ['read'] })
      expect((await read({ ...board, transport: narrowed }, root['id']))['id']).toBe(root['id'])
      expect((await rejection(call(narrowed, 'post', { channel: CHANNEL, text: 'conformance: narrowed to read', noSync: true }))).status).toBe(403)
    },
  },
  {
    line: 1040,
    name: 'makes a task once for a client ID, and none under an ID a reply or a plain thread landed with',
    async run(board) {
      const t = board.transport
      const id = 'conformance-task'
      const under = async (landed: string, text: string) => ((await call(t, 'createTask', { channel: CHANNEL, text, noSync: true, id: landed })) as { task: Rec }).task
      const first = await under(id, 'conformance: a task with an ID')
      expect((await under(id, 'conformance: a task with an ID'))['id']).toBe(first['id'])
      await call(t, 'post', { re: first['id'], text: 'conformance: a reply with an ID', id: `${id}-reply` })
      const plain = await post(t, CHANNEL, 'conformance: a thread with an ID', { id: `${id}-thread` })
      expect(await rejection(under(`${id}-reply`, "conformance: a task under a reply's ID"))).toMatchObject({ status: 409, code: 'duplicate_id' })
      expect(await rejection(under(`${id}-thread`, "conformance: a task under a thread's ID"))).toMatchObject({ status: 409, code: 'duplicate_id' })
      expect((await read(board, plain['id']))['task']).toBeUndefined()
      const listed = (await call(t, 'tasks', { channel: CHANNEL, state: 'all' }))['tasks'] as Rec[]
      const ours = listed.filter((l) => {
        const text = String((l['message'] as Rec | undefined)?.['text'] ?? l['text'] ?? '')
        return text.includes('with an ID') || text.includes("'s ID")
      })
      expect(ours).toHaveLength(1)
    },
  },
  {
    line: 1061,
    name: 'gives a task to one of the claims that race for it, and takes its result',
    async run(board) {
      const t = board.transport
      const root = ((await call(t, 'createTask', { channel: CHANNEL, text: 'conformance: a task to race for' })) as { task: Rec }).task
      const racing = await Promise.allSettled([1, 2, 3].map(() => call(t, 'claimTask', { id: root['id'], lease: 60 })))
      const landed = racing.flatMap((r) => (r.status === 'fulfilled' ? [r.value as { task: Rec; claim: Rec }] : []))
      expect(landed).toHaveLength(1)
      lostWith(racing, 409, 'task_claimed')
      const claim = landed[0]!
      const state = claim.task['task'] as Rec
      expect(state['state']).toBe('claimed')
      expect((claim.task['labels'] as Rec)['board.task']).toBe('claimed')
      expect((state['claim'] as Rec)['actor']).toBe('local:user:ada')
      const token = claim.claim['token']
      expect(typeof token === 'string' && token.length > 0).toBe(true)
      expect(JSON.stringify(await call(t, 'message', { id: root['id'] }))).not.toContain(String(token))
      const done = (await call(t, 'completeTask', { id: root['id'], epoch: claim.claim['epoch'], token, result: 'conformance: done' })) as Rec
      const doneTask = ((done['task'] as Rec)['task'] ?? done['task']) as Rec
      expect(doneTask['state']).toBe('completed')
      expect(doneTask['result']).toBe('conformance: done')
      expect(await rejection(call(t, 'claimTask', { id: root['id'] }))).toMatchObject({ status: 409, code: 'task_finished' })
    },
  },
]
