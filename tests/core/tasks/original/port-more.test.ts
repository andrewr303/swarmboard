// AT-39 and AT-41, continued (round-1 F4): more cases from the original's test/tasks.test.ts and
// test/tasks-batch.test.ts, run as port.test.ts runs its own (the HTTP-shaped adapter, both registry
// variants) with their status, code and message strings verbatim. Cases the original drives through
// its board handle (`board.tasks.*`) are run through the routes the handle calls; the handle's own
// owner ('board:client') and its retries are the handle's, not slice A's, and are left out of them.
// What is not ported, and why, is listed at the end of this file.
import { execFile } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { promisify } from 'node:util'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createLocalCaller, foldTask, type FoldRoot, type MessageView, type TaskRow } from '../../../../src/core/index.ts'
import { ADA, BO, setup as open, type Answer, type Call, type Variant } from './adapter.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND
const T0 = Date.parse('2026-10-07T12:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()

/** The original's contract/blocks.ts block(): a fenced JSON block naming its schema. */
const block = (id: string, data: Record<string, unknown>): string => `\`\`\`json#${id}\n${JSON.stringify(data, null, 2)}\n\`\`\``

async function task(call: Call, text: string, body: Record<string, unknown> = {}): Promise<MessageView> {
  const made = await call('POST', '/tasks', { channel: 'work', text, ...body })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return made.body.task
}

async function claim(call: Call, id: string, body: Record<string, unknown> = {}): Promise<{ epoch: number; token: string; until: string }> {
  const claimed = await call('POST', `/tasks/${id}/claim`, body)
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200)
  return claimed.body.claim
}

const read = async (call: Call, id: string): Promise<MessageView> => (await call('GET', `/messages/${id}`)).body.message
const code = (answer: Answer) => [answer.status, answer.body?.error?.code]
const batch = (call: Call, tasks: Record<string, unknown>[], more: Record<string, unknown> = {}) =>
  call('POST', '/tasks/batch', { channel: 'work', tasks, ...more })

function suite(variant: Variant, id: 'AT-39' | 'AT-41'): void {
  const opened: Array<() => void> = []
  const setup = () => {
    const made = open(variant)
    opened.push(made.close)
    return made
  }
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'] })
    vi.setSystemTime(T0)
  })
  afterEach(() => {
    vi.useRealTimers()
    while (opened.length > 0) opened.pop()!()
  })

  describe(`${id} a task (more)`, () => {
    it(`${id} has its root's blocks checked as a post's are, and carries them`, async () => {
      const { ada } = setup()
      const sha = 'a'.repeat(40)
      // A block that doesn't fit its schema is the post's to refuse: no thread is started, and no task.
      const wrong = await ada('POST', '/tasks', { channel: 'work', text: `revert this\n\n${block('git-commit@1', { sha })}` })
      expect(code(wrong)).toEqual([400, 'invalid_block'])
      expect((await ada('GET', '/tasks?channel=work')).body.tasks).toEqual([])
      const made = await task(ada, `revert this\n\n${block('git-commit@1', { sha, title: 'ship the index' })}`)
      expect(made).toMatchObject({ task: { state: 'ready' }, blocks: [{ schema: 'git-commit', version: 1, data: { sha, title: 'ship the index' } }] })
    })
  })

  describe(`${id} several tasks made at once (more)`, () => {
    it(`${id} have each root checked as a post's is: its blocks, its length, its labels`, async () => {
      const { ada } = setup()
      const fine = { text: 'first, and fine' }
      const sha = 'a'.repeat(40)
      expect(code(await batch(ada, [fine, { text: `revert this\n\n${block('git-commit@1', { sha })}` }]))).toEqual([400, 'invalid_block'])
      expect(code(await batch(ada, [fine, { text: 'x'.repeat(10_001) }]))).toEqual([400, 'text_too_long'])
      expect(code(await batch(ada, [fine, { text: 'wears a state', labels: { 'board.task': 'completed' } }]))).toEqual([400, 'reserved_label'])
      expect((await ada('GET', '/tasks?channel=work&state=all')).body.tasks).toEqual([])
      const made = (await batch(ada, [{ text: `revert this\n\n${block('git-commit@1', { sha, title: 'ship the index' })}` }])).body.tasks as MessageView[]
      expect(made.map((root) => [root.text.split('\n')[0], root.task?.state, root.blocks.map((found) => found.schema)])).toEqual([['revert this', 'ready', ['git-commit']]])
    })
  })

  describe(`${id} claiming the next ready task (more)`, () => {
    it(`${id} claims nothing for a caller that stopped waiting`, async () => {
      const { ada, bo, board } = setup()
      const fix = await task(ada, 'fix CVE-123')
      const review = await task(ada, 'review the fix', { labels: { step: 'review' }, needs: [fix.id] })
      vi.useRealTimers()
      const caller = new AbortController()
      const asAda = createLocalCaller({ userId: 'u_ada', handle: 'u_ada', owner: true })
      const waiting = board.board.tasks.claimReady(asAda, { channel: 'work', label: { step: 'review' }, wait: 10 }, caller.signal)
      // Long enough in that the board is between two looks, a while from its next.
      await new Promise((resolve) => setTimeout(resolve, 800))
      caller.abort()
      // What becomes ready now is no one's: a claim for a caller that's gone would sit out its lease.
      await bo('POST', `/tasks/${fix.id}/complete`, await claim(bo, fix.id))
      expect(await waiting).toEqual({ task: null })
      await new Promise((resolve) => setTimeout(resolve, 1200))
      expect((await read(ada, review.id)).task).toMatchObject({ state: 'ready', epoch: 0, claim: null })
    })

    it(`${id} claims the next task in a channel whose path is as long as a path may be, and in its subtree`, async () => {
      const { ada } = setup()
      const longest = `work/${'a'.repeat(2043)}`
      const made = await task(ada, 'deep in the tree', { channel: longest })
      const first = await ada('POST', '/tasks/claim', { channel: longest })
      expect(first.body.task.id).toBe(made.id)
      await ada('POST', `/tasks/${made.id}/release`, { epoch: first.body.claim.epoch, token: first.body.claim.token })
      // With the `/` that names it and what's under it, one character more.
      expect((await ada('POST', '/tasks/claim', { channel: `${longest}/` })).body.task.id).toBe(made.id)
      // A path longer than any channel's names none.
      expect(code(await ada('POST', '/tasks/claim', { channel: `${longest}b/` }))).toEqual([400, 'invalid_request'])
    })

    it(`${id} waits for a task that becomes ready while it asks`, async () => {
      const { ada } = setup()
      vi.useRealTimers()
      const waiting = ada('POST', '/tasks/claim', { channel: 'work', wait: 5, lease: 30 })
      await new Promise((resolve) => setTimeout(resolve, 150))
      const made = await task(ada, 'just in time')
      const got = (await waiting).body
      expect(got.task.id).toBe(made.id)
      expect(Date.parse(got.claim.until) - Date.now()).toBeGreaterThan(25 * SECOND)
      // With nothing coming, it gives up when its wait runs out.
      const started = Date.now()
      expect((await ada('POST', '/tasks/claim', { channel: 'work', wait: 0.4 })).body).toEqual({ task: null })
      expect(Date.now() - started).toBeGreaterThanOrEqual(350)
    })

    it(`${id} claims by id, holds a claim from its epoch and token alone, and changes a task as its owner`, async () => {
      const { ada } = setup()
      const issue = (await ada('POST', '/messages', { channel: 'issues', text: 'export times out past 10k rows' })).body.message as MessageView
      const adopted = (await ada('POST', '/tasks', { re: issue.id, claim: true, lease: 120 })).body
      expect(adopted.task.id).toBe(issue.id)
      expect(adopted.claim).toMatchObject({ epoch: 1, until: at(2 * MINUTE) })
      expect(code(await ada('POST', `/tasks/${issue.id}/claim`, {}))).toEqual([409, 'task_claimed'])
      // Another process that kept the claim's epoch and token acts on it.
      const kept = { epoch: adopted.claim.epoch, token: adopted.claim.token }
      const renewed = (await ada('POST', `/tasks/${issue.id}/renew`, { ...kept, lease: 600 })).body
      // The route answers the task and the new `until`; the handle's answer adds the epoch and token it kept.
      expect(renewed).toMatchObject({ until: at(10 * MINUTE), task: { id: issue.id, task: { epoch: 1 } } })
      const held = (await ada('POST', `/tasks/${issue.id}/block`, { ...kept, reason: 'which export?', kind: 'needs_input' })).body
      expect(held.task.task).toMatchObject({ state: 'blocked', blocked: { kind: 'needs_input', reason: 'which export?' } })
      expect(code(await ada('POST', `/tasks/${issue.id}/release`, kept))).toEqual([409, 'claim_lost'])

      expect((await ada('POST', `/tasks/${issue.id}/unblock`)).body.task.task.state).toBe('ready')
      expect((await ada('POST', `/tasks/${issue.id}/block`, { reason: 'hold on' })).body.task.task.state).toBe('blocked')
      await ada('POST', `/tasks/${issue.id}/unblock`)
      const failing = await claim(ada, issue.id, { lease: 60 })
      expect(failing.until).toBe(at(MINUTE))
      expect((await ada('POST', `/tasks/${issue.id}/fail`, { epoch: failing.epoch, token: failing.token, reason: 'no repro' })).body.task.task).toMatchObject({
        state: 'failed',
        reason: 'no repro',
      })
      expect((await ada('POST', `/tasks/${issue.id}/reopen`)).body.task.task.state).toBe('ready')
      const again = await claim(ada, issue.id)
      expect((await ada('POST', `/tasks/${issue.id}/release`, { epoch: again.epoch, token: again.token })).body.task.task.state).toBe('ready')
      expect((await ada('POST', `/tasks/${issue.id}/cancel`, { reason: 'duplicate' })).body.task.task).toMatchObject({ state: 'canceled', reason: 'duplicate' })
      // A client id makes it once.
      const once = await task(ada, 'deploy a1b2c3', { id: 'deploy-a1b2c3' })
      expect((await task(ada, 'deploy a1b2c3', { id: 'deploy-a1b2c3' })).id).toBe(once.id)
      expect((await ada('GET', '/tasks?channel=work')).body.tasks).toHaveLength(1)
    })
  })
}

describe('the original task tests, through the adapter (more)', () => {
  suite('empty', 'AT-39')
  suite('pass-through', 'AT-41')
})

describe('AT-39 a task that needs others, in a script', () => {
  it('answers a completion that readies another in a script with nothing else running', async () => {
    // A write that waited on the board's own background work (or a timer that kept the process alive)
    // would leave a short script hanging or exiting before it answered.
    const core = JSON.stringify(pathToFileURL(new URL('../../../../src/core/index.ts', import.meta.url).pathname).href)
    const script = `
      const { BoardService, SqliteUnifiedStore, createLocalCaller } = await import(${core})
      const board = new BoardService(new SqliteUnifiedStore({ path: ':memory:' }))
      const me = createLocalCaller({ userId: 'u_ada', handle: 'u_ada', owner: true })
      const fix = board.tasks.createTask(me, { channel: 'work', text: 'fix CVE-123' })
      const review = board.tasks.createTask(me, { channel: 'work', text: 'review the fix', needs: [fix.task.id] })
      const claim = board.tasks.claimTask(me, fix.task.id, {})
      const done = board.tasks.completeTask(me, fix.task.id, { epoch: claim.claim.epoch, token: claim.claim.token, result: 'fixed' })
      const { message } = board.getMessageThread(me, review.task.id)
      console.log(done.task.task.state, message.task.state)
    `
    const ran = await promisify(execFile)(process.execPath, ['--input-type=module', '-e', script], { timeout: 20_000 }).catch(
      (error: { code?: number; stdout?: string }) => error,
    )
    expect({ code: 'code' in ran ? ran.code : 0, stdout: ran.stdout?.trim() }).toEqual({ code: 0, stdout: 'completed ready' })
  }, 30_000)
})

describe("AT-39 the fold, for whoever folds the board's events themselves", () => {
  // The original folds whole messages (foldMessages); the port's fold is the task part of it, foldTask,
  // where `false` is the original's "changes nothing". Labels and versions are M1's message fold.
  const by = { actor: ADA, principal: ADA, profile: null }
  const other = { actor: BO, principal: BO, profile: null }
  const until = at(15 * MINUTE)
  const about = { id: 1, thread: 'root' }
  const root: FoldRoot = { id: 1, channel: 'work', thread: 'root', re: null, deleted: false }
  /** The task after `payloads` (null when it is no task), and how many of them changed it. */
  function folded(payloads: [type: string, payload: object][], on: FoldRoot = root): { task: TaskRow | null; changed: number } {
    let row: TaskRow | null = null
    let changed = 0
    for (const [type, payload] of payloads) {
      const next = foldTask(row, on, { type, payload: payload as Record<string, unknown> } as never)
      if (next === false) continue
      row = next
      changed++
    }
    return { task: row, changed }
  }
  const created: [string, object] = ['task.created', { ...about, needs: [], for: null, by }]
  const claimed = (epoch: number, who = by): [string, object] => ['task.claimed', { ...about, epoch, until, token: 'a'.repeat(64), by: who }]

  it('lets a write change nothing once its task has moved on: an older epoch, a finished task, a second creation', () => {
    // A claim's writes at an epoch the task has left.
    const taken = folded([
      created,
      claimed(1),
      ['task.expired', { ...about, epoch: 1 }],
      claimed(2, other),
      ['task.completed', { ...about, epoch: 1, result: 'late', by }],
      ['task.released', { ...about, epoch: 1, by }],
      ['task.renewed', { ...about, epoch: 1, until: at(60 * MINUTE), by }],
    ])
    expect(taken.task).toMatchObject({ state: 'claimed', epoch: 2, claim_actor: BO, claim_until_ms: Date.parse(until), result: null })
    // The last event that changed it is the second claim: the stale ones change nothing.
    expect(taken.changed).toBe(4)
    // A claim that skips an epoch, or lands on a task someone holds, isn't a claim.
    expect(folded([created, claimed(2)]).task).toMatchObject({ state: 'ready', epoch: 0, claim_actor: null })
    expect(folded([created, claimed(1), claimed(2, other)]).task).toMatchObject({ epoch: 1, claim_actor: ADA })
    // A completed task stays completed, whatever is written to it after.
    const done = folded([
      created,
      claimed(1),
      ['task.completed', { ...about, epoch: 1, result: 'fixed', by }],
      ['task.canceled', { ...about, reason: 'deleted', by }],
      ['task.blocked', { ...about, kind: null, reason: 'hold', by }],
      ['task.reopened', { ...about, by }],
      ['task.failed', { ...about, epoch: 1, reason: 'no', by }],
    ])
    expect(done.task).toMatchObject({ state: 'completed', result: 'fixed', reason: null, blocked_kind: null })
    expect(done.changed).toBe(3)
    // Only a failed task reopens, and a thread is made a task once, by whoever did first.
    expect(folded([created, ['task.canceled', { ...about, reason: 'no', by }], ['task.reopened', { ...about, by }]]).task?.state).toBe('canceled')
    expect(folded([created, ['task.created', { ...about, needs: [], for: null, by: other }]]).task?.owner).toBe(ADA)
  })

  it("changes what a task needs only while no one holds it and it isn't finished, and leaves a held one held", () => {
    const needsOf = (...payloads: [string, object][]) => folded(payloads).task
    const rewired: [string, object] = ['task.needs_changed', { ...about, needs: [7, 8], by }]
    expect(needsOf(created, rewired)).toMatchObject({ state: 'waiting', needs: [7, 8] })
    expect(needsOf(created, rewired, ['task.ready', about], ['task.needs_changed', { ...about, needs: [], by }])).toMatchObject({ state: 'ready', needs: [] })
    expect(needsOf(created, ['task.blocked', { ...about, kind: null, reason: 'hold', by }], rewired)).toMatchObject({ state: 'blocked', needs: [7, 8] })
    // One a claim holds, or that's finished, has moved on from it.
    expect(needsOf(created, claimed(1), rewired)).toMatchObject({ state: 'claimed', needs: [] })
    expect(needsOf(created, claimed(1), ['task.completed', { ...about, epoch: 1, result: null, by }], rewired)).toMatchObject({ state: 'completed', needs: [] })
    expect(needsOf(created, claimed(1), ['task.failed', { ...about, epoch: 1, reason: 'no', by }], rewired)).toMatchObject({ state: 'failed', needs: [] })
    expect(needsOf(created, ['task.canceled', { ...about, reason: 'no', by }], rewired)).toMatchObject({ state: 'canceled', needs: [] })
    // And it changes no task it didn't change, or a reply.
    expect(folded([created, claimed(1), rewired]).changed).toBe(2)
    expect(folded([['task.needs_changed', { id: 2, thread: 'root', needs: [7], by }]], { ...root, id: 2, re: 1 }).task).toBeNull()
  })

  it('keeps tasks on roots that are there: a reply is no task, and a deleted root is made no task', () => {
    expect(folded([['task.created', { id: 2, thread: 'root', needs: [], for: null, by }]], { ...root, id: 2, re: 1 }).task).toBeNull()
    expect(folded([created], { ...root, deleted: true }).task).toBeNull()
  })
})

// Not ported, with why (F4 deferral list). The original's handle, CLI, middleware, board-in-front,
// watchers, sync routes and upload handle are outside slice A and the adapter:
//   tasks.test.ts "takes files on its root as a post does ..." (needs the upload handle)
//   tasks.test.ts "are refused the board's own code too: its handle, a watcher, and what the middleware adds"
//   tasks.test.ts "wake a watcher whose tail they match ..." (watcher dispatch; M1's)
//   tasks.test.ts "holds the task when a platform edits it through sync" (sync import routes; the same
//     semantics are AT-34 in tests/core/tasks/sweep.test.ts "an external sync edit always holds the task")
//   tasks.test.ts "the handle's tasks": "runs a worker as the spec writes it", "asks a board again,
//     never holding one request past 25 seconds" (client retry loop)
//   tasks.test.ts "a task's client id, from the board's own code" (both: board.as(...) handle actors)
//   tasks-batch.test.ts the four middleware cases, "answer a retry through a board in front", and
//     "are a handle's own by their id ..."
//   tasks-batch.test.ts "have each root checked ...": its files part (the upload handle); the rest is above
// And the races the original stages with a store double that lands a write between a look and an
// append (landingBefore): "is refused when another lands between its look at the task and its write",
// "is what a claim / a completion / a lifted hold goes by as it lands", "goes by what it would wait for
// as it lands", "holds a task made of the thread while its author was editing it", "cancels a task made
// of the thread while its author was deleting it", and "claims nothing for a caller that stops while
// the board looks". Here every write reads and writes under one BEGIN IMMEDIATE, so no write can land
// between them; the serialized outcomes are the sequential tests of claim/needs/owner/sweep.test.ts,
// the in-lock abort check is claim-ready.test.ts "claims nothing for a caller that stopped", and
// cross-process contention is tests/core/tasks/proc.
