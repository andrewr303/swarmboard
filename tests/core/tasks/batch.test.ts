// Slice A5: batch create and lookup (M2_DESIGN 2.7.4), ported from the original's
// test/tasks-batch.test.ts with its messages verbatim.
import { afterEach, describe, expect, it } from 'vitest'
import { batchDigest, derivedId } from '../../../src/core/index.ts'
import { alice, eventCount, makeBoard, type Board } from './helpers.ts'
import {
  ALICE,
  bob,
  eventsAfter,
  finish,
  head,
  makeTask,
  messageCount,
  refusal,
  taskEventsAfter,
  userWith,
} from './verb-helpers.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  return b
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
})

type Asked = {
  key?: string
  text: string
  labels?: Record<string, string>
  noSync?: boolean
  attachments?: string[]
  needs?: (string | { key: string })[]
  for?: string | null
}

const batch = (b: Board, tasks: Asked[], more: Record<string, unknown> = {}, as = alice) =>
  b.board.tasks.createTasks(as, { channel: 'dev', tasks, ...more })

// ---- A scratch copy of the original's own code (client/ids.ts:13-21 derivedId, server/serve.ts:625-632
//      batchRequest), run as it is, with WebCrypto: the oracle the bit-exact port is checked against.
const hex = (bytes: Uint8Array) => Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('')
async function sha256(text: string): Promise<string> {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))))
}
async function originalDerivedId(...parts: string[]): Promise<string> {
  const bytes = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(JSON.stringify(parts)))).slice(0, 16)
  bytes[6] = (bytes[6]! & 15) | 128
  bytes[8] = (bytes[8]! & 63) | 128
  const text = hex(bytes)
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`
}
async function originalBatchRequest(body: { channel: string; tasks: Asked[] }): Promise<string> {
  const tasks = body.tasks.map((task) => [task.key ?? null, task.text, Object.entries(task.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)), task.noSync ?? false, task.attachments ?? [], task.needs ?? [], task.for ?? null])
  return (await sha256(JSON.stringify([body.channel, tasks]))).slice(0, 32)
}

const eventIdAt = (b: Board, index: number): string =>
  (b.store.db.prepare('SELECT event_id FROM board_events WHERE log_index = ?').get(index) as { event_id: string }).event_id

describe('A5 batch create', () => {
  it('AT-29 lands in one write in request order: posted, created, ready? per task; needs are outside IDs then keys', () => {
    const b = open()
    const cut = makeTask(b, alice, 'cut the release branch')
    finish(b, alice, cut.id)
    const frozen = makeTask(b, alice, 'freeze the schema')
    const before = head(b)
    const made = batch(b, [
      { key: 'review', text: 'review the fix', needs: [{ key: 'fix' }] },
      { key: 'fix', text: 'fix the export', labels: { step: 'fix' }, noSync: true },
      { text: 'announce the release', needs: [cut.id] },
      { text: 'ship it', needs: [cut.id, { key: 'review' }, { key: 'fix' }], for: `${ALICE}+shipper` },
      { text: 'migrate the data', needs: [cut.id, frozen.id] },
    ])
    const [review, fix, announce, ship, migrate] = made.tasks
    expect(made.tasks.map((root) => [root.text, root.task?.state, root.task?.needs, root.task?.for, root.task?.owner, root.channel])).toEqual([
      ['review the fix', 'waiting', [fix!.id], null, ALICE, 'dev'],
      ['fix the export', 'ready', [], null, ALICE, 'dev'],
      ['announce the release', 'ready', [cut.id], null, ALICE, 'dev'],
      ['ship it', 'waiting', [cut.id, review!.id, fix!.id], `${ALICE}+shipper`, ALICE, 'dev'],
      ['migrate the data', 'waiting', [cut.id, frozen.id], null, ALICE, 'dev'],
    ])
    expect([fix!.labels, fix!.noSync, review!.noSync]).toEqual([{ step: 'fix', 'board.task': 'ready' }, true, false])
    // Each root is the thread it reads as.
    for (const root of made.tasks) {
      expect(b.board.getMessageThread(alice, root.id).message).toMatchObject({ id: root.id, text: root.text, re: null, task: root.task })
    }
    const found = eventsAfter(b, before)
    expect(found.map((e) => [e.type, String(e.payload.id ?? e.index)])).toEqual([
      ['message.posted', review!.id],
      ['task.created', review!.id],
      ['message.posted', fix!.id],
      ['task.created', fix!.id],
      ['message.posted', announce!.id],
      ['task.created', announce!.id],
      ['task.ready', announce!.id],
      ['message.posted', ship!.id],
      ['task.created', ship!.id],
      ['message.posted', migrate!.id],
      ['task.created', migrate!.id],
    ])
    // Nothing between them, and each post says how many came along with it.
    expect(found.map((e) => e.index)).toEqual(found.map((_, at) => before + 1 + at))
    expect(found.filter((e) => e.type === 'message.posted').map((e) => e.payload.along)).toEqual([1, 1, 2, 1, 1])
    // A task of the batch that completes readies what waited only for it.
    finish(b, alice, fix!.id)
    expect(b.board.tasks.listTasks(alice, { channel: 'dev' }).tasks.map((t) => [t.message.text, t.message.task?.state])).toEqual([
      ['freeze the schema', 'ready'],
      ['review the fix', 'ready'],
      ['announce the release', 'ready'],
      ['ship it', 'waiting'],
      ['migrate the data', 'waiting'],
    ])
  })

  it('AT-29 stores [cut, {key:review}, {key:fix}] as [cut, review, fix], and names roots right for a first-time author', () => {
    const b = open()
    const cut = makeTask(b, alice, 'cut the release branch')
    const made = batch(b, [
      { key: 'fix', text: 'fix it' },
      { key: 'review', text: 'review it' },
      { text: 'ship it', needs: [cut.id, { key: 'review' }, { key: 'fix' }, cut.id] },
    ])
    expect(made.tasks[2]!.task?.needs).toEqual([cut.id, made.tasks[1]!.id, made.tasks[0]!.id])
    // Bob writes for the first time: his actor record comes first, ahead of the roots, and a forward key still resolves.
    const before = head(b)
    const his = batch(b, [{ text: 'draft the plan', needs: [{ key: 'scope' }] }, { key: 'scope', text: 'scope the work' }], {}, bob)
    const [draft, scope] = his.tasks
    expect(draft!.task?.needs).toEqual([scope!.id])
    expect(eventsAfter(b, before)[0]!.type).toBe('actor.seen')
    expect([draft!.task?.state, scope!.task?.state]).toEqual(['waiting', 'ready'])
    expect(b.board.getMessageThread(bob, scope!.id).message.text).toBe('scope the work')
  })

  it('AT-29 a plan problem, a need that is no task, or any bad task makes none of them', () => {
    const b = open()
    const canceled = makeTask(b, alice, 'an idea we dropped')
    b.board.tasks.cancelTask(alice, canceled.id, { reason: 'dropped' })
    const note = b.board.postMessage(alice, { channel: 'dev', text: 'just a note' }).message
    const secret = b.board.tasks.createTask(alice, { channel: 'secret', text: 'out of sight' }).task
    const events = eventCount(b)
    const messages = messageCount(b)
    const fine: Asked[] = [{ key: 'a', text: 'first, and fine' }, { text: 'second, and fine', needs: [{ key: 'a' }] }]
    const refused = (last: Asked[], as = alice) => refusal(() => b.board.tasks.createTasks(as, { channel: 'plans', tasks: [...fine, ...last] }))
    expect(refused([{ text: 'waits for no one here', needs: [{ key: 'nobody' }] }])).toEqual([
      400,
      'invalid_needs',
      'needs: no task of the batch has the key "nobody"',
    ])
    expect(refused([{ key: 'a', text: 'a second a' }])).toEqual([400, 'invalid_needs', 'needs: two tasks of the batch have the key "a"'])
    expect(refused([{ key: 'self', text: 'waits for itself', needs: [{ key: 'self' }] }])).toEqual([
      400,
      'invalid_needs',
      'needs: the task with the key "self" waits for itself',
    ])
    expect(
      refused([
        { key: 'x', text: 'x waits for z', needs: [{ key: 'z' }] },
        { key: 'y', text: 'y waits for x', needs: [{ key: 'x' }] },
        { key: 'z', text: 'z waits for y', needs: [{ key: 'y' }] },
      ]),
    ).toEqual([400, 'invalid_needs', 'needs: the tasks with the keys "x", "z", "y" wait for each other'])
    expect(refused([{ text: 'waits for a canceled one', needs: [canceled.id] }])).toEqual([
      400,
      'invalid_needs',
      `needs: #${canceled.id} was canceled: it can never complete`,
    ])
    // A thread that is no task, one that isn't there, and one its sender can't read: the same words.
    const notATask = `needs: #${note.id} isn't a task`
    expect(refused([{ text: 'waits for a note', needs: [note.id] }])).toEqual([400, 'invalid_needs', notATask])
    expect(refused([{ text: 'waits for nothing there', needs: ['99999'] }])).toEqual([400, 'invalid_needs', "needs: #99999 isn't a task"])
    const planner = userWith('planner', 'plans=read,post;dev=read')
    expect(refused([{ text: 'waits for one it can not read', needs: [secret.id] }], planner)).toEqual([
      400,
      'invalid_needs',
      `needs: #${secret.id} isn't a task`,
    ])
    // An assignee that isn't its owner's, more than a task waits for, and an empty root.
    expect(refused([{ text: 'for someone else', for: 'local:user:bob+fixer' }])[1]).toBe('invalid_request')
    expect(refused([{ text: 'waits for 21', needs: Array.from({ length: 21 }, (_, n) => String(n + 1)) }])).toEqual([
      400,
      'invalid_request',
      'tasks.2.needs: a task waits for at most 20 tasks',
    ])
    expect(refused([{ text: '   ' }])[1]).toBe('invalid_request')
    expect([eventCount(b), messageCount(b)]).toEqual([events, messages])
    expect(b.board.listChannels(alice).channels.map((c) => c.path)).not.toContain('plans')
  })

  it("AT-29 101 tasks are batch_too_large before the parse; each task holds a root's and a task's limits", () => {
    const b = open()
    const many = (count: number): Asked[] =>
      Array.from({ length: count }, (_, n) => ({ key: `step-${n}`, text: `step ${n}`, ...(n > 0 ? { needs: [{ key: `step-${n - 1}` }] } : {}) }))
    expect(refusal(() => batch(b, many(101)))).toEqual([
      400,
      'batch_too_large',
      'a batch makes 100 tasks at most, and this one has 101: send it in parts',
    ])
    // Said so whatever else is wrong with it.
    expect(refusal(() => batch(b, [...many(100), { text: '' }]))[1]).toBe('batch_too_large')
    expect(refusal(() => b.board.tasks.createTasks(alice, { channel: 'Not A Channel', tasks: many(101) }))[1]).toBe('batch_too_large')
    expect(refusal(() => batch(b, [...many(99), { text: '' }]))[1]).toBe('invalid_request')
    const one = (task: Record<string, unknown>) => refusal(() => batch(b, [{ text: 'first, and fine' }, task as Asked]))
    expect(one({ text: 'x'.repeat(10_001) }).slice(0, 2)).toEqual([400, 'text_too_long'])
    expect(one({ text: 'with traces', attachments: Array.from({ length: 11 }, (_, n) => `${'A'.repeat(21)}${String.fromCharCode(65 + n)}`) })).toEqual([
      400,
      'invalid_request',
      'tasks.1.attachments: a message carries at most 10',
    ])
    expect(one({ text: 'after them all', needs: Array.from({ length: 21 }, (_, n) => String(9000 + n)) })).toEqual([
      400,
      'invalid_request',
      'tasks.1.needs: a task waits for at most 20 tasks',
    ])
    expect(one({ key: 'k'.repeat(65), text: 'a long name' })).toEqual([400, 'invalid_request', "tasks.1.key: a task's key is at most 64 characters"])
    // Twenty needs, however often each is named, and a key of 64 are within them.
    expect(one({ key: 'k'.repeat(64), text: 'a long name', needs: Array.from({ length: 40 }, (_, n) => String(9000 + (n % 20))) }).slice(0, 2)).toEqual([
      400,
      'invalid_needs',
    ])
    expect(messageCount(b)).toBe(0)
    const full = batch(b, many(100))
    expect(full.tasks.map((root) => root.text)).toEqual(many(100).map((task) => task.text))
    expect(full.tasks.map((root) => root.task?.needs)).toEqual(full.tasks.map((_, at) => (at === 0 ? [] : [full.tasks[at - 1]!.id])))
  })

  it('AT-33 a board.* label on any task of a batch is reserved_label, and a batch takes post (+label with labels)', () => {
    const b = open()
    expect(refusal(() => batch(b, [{ text: 'fine' }, { text: 'wears a state', labels: { 'board.task': 'completed' } }]))).toEqual([
      400,
      'reserved_label',
      expect.stringContaining('board.task'),
    ])
    const poster = userWith('poster', 'dev=read,post;intake=post;audit=read')
    expect(refusal(() => batch(b, [{ text: 'read-only here' }], { channel: 'audit' }, poster))).toEqual([403, 'forbidden', "this token can't post in audit"])
    expect(refusal(() => batch(b, [{ text: 'plain' }, { text: 'labeled', labels: { step: 'fix' } }], {}, poster))).toEqual([
      403,
      'forbidden',
      "this token can't label in dev",
    ])
    expect(messageCount(b)).toBe(0)
    expect(batch(b, [{ text: 'plain' }, { text: 'and plain' }], {}, poster).tasks).toHaveLength(2)
    // Where it posts without reading, it gets its tasks back as it made them, on the write and on a retry.
    const plan: Asked[] = [{ key: 'triage', text: 'triage the outage' }, { text: 'write it up', needs: [{ key: 'triage' }] }]
    const filed = batch(b, plan, { channel: 'intake', id: 'outage-1' }, poster)
    const [triage, writeUp] = filed.tasks
    expect([triage!.text, triage!.task?.state, writeUp!.text, writeUp!.task]).toEqual([
      'triage the outage',
      'ready',
      'write it up',
      expect.objectContaining({ state: 'waiting', needs: [triage!.id], owner: 'local:user:poster' }),
    ])
    b.board.tasks.claimTask(alice, triage!.id, {})
    const refiled = batch(b, plan, { channel: 'intake', id: 'outage-1' }, poster)
    expect(refiled.tasks.map((root) => [root.id, root.text, root.task?.state, root.task?.claim])).toEqual([
      [triage!.id, 'triage the outage', 'ready', null],
      [writeUp!.id, 'write it up', 'waiting', null],
    ])
  })
})

describe('A5 batch idempotency and lookup', () => {
  it('AT-30 the same id and digest answer the tasks as they are now and write nothing; another request or author is 409', () => {
    const b = open()
    const plan: Asked[] = [{ key: 'fix', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'fix' }] }]
    const first = batch(b, plan, { id: 'release-42' })
    const ids = first.tasks.map((root) => root.id)
    b.board.tasks.claimTask(bob, ids[0]!, {})
    const before = eventCount(b)
    const again = batch(b, plan, { id: 'release-42' })
    expect(again.tasks.map((root) => [root.id, root.task?.state])).toEqual([
      [ids[0], 'claimed'],
      [ids[1], 'waiting'],
    ])
    expect(eventCount(b)).toBe(before)
    for (const [what, other] of Object.entries<Asked[]>({
      'fewer tasks': plan.slice(0, 1),
      'one more': [...plan, { text: 'and one more' }],
      'another text': [{ key: 'fix', text: 'fix the import' }, plan[1]!],
      'another key': [{ key: 'repair', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'repair' }] }],
      'a label': [plan[0]!, { ...plan[1]!, labels: { step: 'review' } }],
      'kept off platforms': [{ ...plan[0]!, noSync: true }, plan[1]!],
      'an assignee': [{ ...plan[0]!, for: `${ALICE}+fixer` }, plan[1]!],
      'one more need': [plan[0]!, { ...plan[1]!, needs: [{ key: 'fix' }, ids[0]!] }],
      'the other order': [plan[1]!, plan[0]!],
    })) {
      expect(refusal(() => batch(b, other, { id: 'release-42' }))[1], what).toBe('duplicate_id')
    }
    expect(refusal(() => batch(b, plan, { id: 'release-42' }, bob))).toEqual([409, 'duplicate_id', 'that id was already used for a different write'])
    expect(refusal(() => batch(b, plan, { id: 'release-42', channel: 'elsewhere' }))[1]).toBe('duplicate_id')
    expect(eventCount(b)).toBe(before)
    // A field left out is its empty value: the same request written out in full is the same batch.
    const full = [
      { key: 'fix', text: 'fix the export', labels: {}, noSync: false, attachments: [], needs: [], for: null },
      { text: 'review the fix', needs: [{ key: 'fix' }], labels: {} },
    ]
    expect(batch(b, full, { id: 'release-42' }).tasks.map((root) => root.id)).toEqual(ids)
    // What happened to its tasks since is no part of what was asked.
    b.board.editMessage(alice, ids[1]!, { text: 'review the fix, carefully' })
    b.board.tasks.setTaskNeeds(alice, ids[1]!, { needs: [] })
    expect(batch(b, plan, { id: 'release-42' }).tasks.map((root) => [root.id, root.text, root.task?.needs])).toEqual([
      [ids[0], 'fix the export', []],
      [ids[1], 'review the fix, carefully', []],
    ])
    // The board's own IDs and another client's key are refused, as a post's are.
    expect(refusal(() => batch(b, plan, { id: '0f8fad5b-d9cb-8469-a165-70867728950e' }))[1]).toBe('invalid_request')
    expect(refusal(() => batch(b, plan, { id: 'key:local:user:bob:0123456789abcdef0123456789abcdef' }))[1]).toBe('invalid_request')
    // A batch's id is its own: a task made with the same one is another thing; without an id, the same batch is new tasks.
    expect(b.board.tasks.createTask(alice, { channel: 'dev', text: 'a task of its own', id: 'release-42' }).task.id).not.toBe(ids[0])
    const n = b.board.tasks.listTasks(alice, { state: 'all' }).tasks.length
    batch(b, plan)
    batch(b, plan)
    expect(b.board.tasks.listTasks(alice, { state: 'all' }).tasks).toHaveLength(n + 4)
    // A request that says its own digest: the same one again is its batch, whatever the tasks.
    const own = batch(b, plan, { id: 'plan-3', request: 'my own word for it' })
    expect(batch(b, [{ text: 'anything' }], { id: 'plan-3', request: 'my own word for it' }).tasks.map((r) => r.id)).toEqual(own.tasks.map((r) => r.id))
    expect(refusal(() => batch(b, plan, { id: 'plan-3' }))[1]).toBe('duplicate_id')
  })

  it('AT-30 getBatch answers 200 with its tasks as they are, 404 batch_not_found, or 409 for another request', () => {
    const b = open()
    const plan: Asked[] = [{ key: 'fix', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'fix' }] }]
    const ids = batch(b, plan, { id: 'release-42' }).tasks.map((root) => root.id)
    b.board.tasks.claimTask(bob, ids[0]!, {})
    const found = b.board.tasks.getBatch(alice, 'release-42')
    expect(found.tasks.map((root) => [root.id, root.task?.state])).toEqual([
      [ids[0], 'claimed'],
      [ids[1], 'waiting'],
    ])
    expect(refusal(() => b.board.tasks.getBatch(alice, 'release-41'))).toEqual([404, 'batch_not_found', 'no batch of yours has id release-41'])
    expect(refusal(() => b.board.tasks.getBatch(bob, 'release-42'))).toEqual([404, 'batch_not_found', 'no batch of yours has id release-42'])
    expect(refusal(() => b.board.tasks.getBatch(alice, 'release-42', { request: 'another' }))[1]).toBe('duplicate_id')
    expect(b.board.tasks.getBatch(alice, 'release-42', { request: batchDigest('dev', plan) }).tasks.map((r) => r.id)).toEqual(ids)
  })

  it("AT-30 root event IDs and the request digest are bit-exact with the original's own derivedId and batchRequest", async () => {
    const b = open()
    const plans: { channel: string; tasks: Asked[] }[] = [
      { channel: 'dev', tasks: [{ key: 'fix', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'fix' }] }] },
      {
        channel: 'dev',
        tasks: [
          { text: 'ünïcödé ✓ "quoted" \\ back', labels: { zeta: '1', alpha: 'two', mid: '' }, noSync: true, for: `${ALICE}+fixer` },
          { key: 'k', text: 'x', needs: ['1', { key: 'k2' }] },
          { key: 'k2', text: 'y', labels: {}, attachments: [], needs: [] },
        ],
      },
    ]
    for (const [n, plan] of plans.entries()) {
      expect(batchDigest(plan.channel, plan.tasks)).toBe(await originalBatchRequest(plan))
      for (const parts of [['board-batch', `id-${n}`, '0'], ['board-batch', `id-${n}`, '17'], ['board-batch-request', `id-${n}`, 'abc']]) {
        expect(derivedId(...parts)).toBe(await originalDerivedId(...parts))
      }
    }
    // A batch under an id lands its roots at derivedId('board-batch', id, i), and the event after the first root at the request's.
    const before = head(b)
    const tasks = plans[0]!.tasks
    const made = batch(b, tasks, { id: 'release-7' })
    for (const [i, root] of made.tasks.entries()) {
      expect(eventIdAt(b, Number(root.id))).toBe(await originalDerivedId('board-batch', 'release-7', String(i)))
      expect(root.thread).toBe(await originalDerivedId('board-batch', 'release-7', String(i)))
    }
    const first = Number(made.tasks[0]!.id)
    expect(eventIdAt(b, first + 1)).toBe(await originalDerivedId('board-batch-request', 'release-7', await originalBatchRequest({ channel: 'dev', tasks })))
    expect(taskEventsAfter(b, before).map((e) => e.type)).toEqual(['message.posted', 'task.created', 'message.posted', 'task.created'])
    // With its own `request`, that one is the digest.
    const own = batch(b, [{ text: 'solo' }], { id: 'release-8', request: 'my-digest' })
    expect(eventIdAt(b, Number(own.tasks[0]!.id) + 1)).toBe(await originalDerivedId('board-batch-request', 'release-8', 'my-digest'))
  })
})

