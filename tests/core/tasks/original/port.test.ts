// AT-39 and AT-41 (M2_DESIGN 2.11): cases from the original's test/tasks.test.ts and
// test/tasks-batch.test.ts, run through the HTTP-shaped adapter (./adapter.ts) with their status,
// code and message strings verbatim. The same suite runs twice: AT-39 with the hook registry empty,
// AT-41 with a pass-through hook in every phase. The changes from the original are only these: the
// callers are local ones (ADA is local:user:u_ada, WEB local:user:web, CI local:user:ci, a grant to
// CI a narrowing of its token), the board's timers are its sweep, and cases that need the original's
// HTTP transport, JWT tokens, upload handle, CLI or a store double are left out (see the deferral list).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { MessageView } from '../../../../src/core/index.ts'
import { ADA, BO, ci, grantCi, person, setup as open, web, WEB, CI, type Answer, type Call, type Variant } from './adapter.ts'

const SECOND = 1000
const MINUTE = 60 * SECOND
const T0 = Date.parse('2026-10-07T12:00:00.000Z')
const at = (ms: number) => new Date(T0 + ms).toISOString()

type BoardEventView = { type: string; cursor: string; payload: any; message?: MessageView | null; actor?: any }

/** A task in a thread of its own, as `call` makes it. */
async function task(call: Call, text: string, body: Record<string, unknown> = {}): Promise<MessageView> {
  const made = await call('POST', '/tasks', { channel: 'work', text, ...body })
  expect(made.status, JSON.stringify(made.body)).toBe(201)
  return made.body.task
}

/** A claim of task `id` by `call`: what the claim's own writes carry. */
async function claim(call: Call, id: string, body: Record<string, unknown> = {}): Promise<{ epoch: number; token: string; until: string }> {
  const claimed = await call('POST', `/tasks/${id}/claim`, body)
  expect(claimed.status, JSON.stringify(claimed.body)).toBe(200)
  return claimed.body.claim
}

const read = async (call: Call, id: string): Promise<MessageView> => (await call('GET', `/messages/${id}`)).body.message
const stateOf = async (call: Call, id: string) => (await read(call, id)).task?.state
/** Every board event after `after`, as the feed shows them with `all`. */
const events = async (call: Call, after: string | number = 0, query = ''): Promise<BoardEventView[]> =>
  (await call('GET', `/events?after=${after}${query}`)).body.events
const types = (found: BoardEventView[]) => found.map((event) => event.type)
const code = (answer: Answer) => [answer.status, answer.body?.error?.code]
/** The feed's head: where a reader that tails from now starts. */
const head = async (call: Call): Promise<string> => {
  let cursor = '0'
  for (;;) {
    const page = (await call('GET', `/events?after=${cursor}&all=1`)).body
    if (page.events.length === 0) return page.cursor
    cursor = page.cursor
  }
}

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

  describe(`${id} a task`, () => {
    it(`${id} is a thread: its root says what, wears its state as board.task, and reads like any message`, async () => {
      const { ada, bo } = setup()
      const made = await ada('POST', '/tasks', { channel: 'work', text: 'fix CVE-123 in acme/web', labels: { step: 'fix' } })
      expect(made.status).toBe(201)
      const root = made.body.task as MessageView
      expect(root).toMatchObject({ channel: 'work', text: 'fix CVE-123 in acme/web', re: null, by: { actor: ADA }, labels: { step: 'fix', 'board.task': 'ready' } })
      expect(root.task).toEqual({ state: 'ready', owner: ADA, by: ADA, for: null, needs: [], epoch: 0, claim: null, blocked: null, result: null, reason: null })
      expect(made.body.claim).toBeUndefined()

      // Anyone who reads the channel reads it, replies in it, and finds it by its state.
      expect((await bo('POST', '/messages', { re: root.id, text: 'patched, running the tests' })).status).toBe(201)
      const thread = (await bo('GET', `/messages/${root.id}`)).body
      expect(thread.message.task).toEqual(root.task)
      expect(thread.replies.map((reply: MessageView) => reply.text)).toEqual(['patched, running the tests'])
      expect((await bo('GET', '/threads?channel=work&label=board.task=ready')).body.threads.map((t: { message: MessageView }) => t.message.id)).toContain(root.id)
      expect((await bo('GET', '/threads?label=board.task=ready&label=step=fix')).body.threads.map((t: { message: MessageView }) => t.message.id)).toEqual([root.id])
      expect((await bo('GET', '/threads?label=board.task=claimed')).body.threads).toEqual([])
    })

    it(`${id} can be a thread that was there: whoever makes it one owns it, and it stays as it was written`, async () => {
      const { ada, bo } = setup()
      const issue = (await bo('POST', '/messages', { channel: 'issues', text: 'export times out past 10k rows', labels: { kind: 'bug' } })).body.message
      const reply = (await bo('POST', '/messages', { re: issue.id, text: 'still happening' })).body.message
      const made = await ada('POST', '/tasks', { re: issue.id })
      expect(made.status).toBe(201)
      expect(made.body.task).toMatchObject({ id: issue.id, text: 'export times out past 10k rows', by: { actor: BO }, labels: { kind: 'bug', 'board.task': 'ready' }, task: { state: 'ready', owner: ADA } })

      expect(code(await ada('POST', '/tasks', { re: issue.id }))).toEqual([409, 'already_a_task'])
      expect(code(await bo('POST', '/tasks', { re: issue.id }))).toEqual([409, 'already_a_task'])
      // A task is its thread's root, while it's there.
      expect(code(await ada('POST', '/tasks', { re: reply.id }))).toEqual([400, 'invalid_request'])
      expect(code(await ada('POST', '/tasks', { re: '999' }))).toEqual([404, 'message_not_found'])
      const gone = (await bo('POST', '/messages', { channel: 'issues', text: 'never mind' })).body.message
      await bo('POST', `/messages/${gone.id}/delete`, {})
      expect(code(await ada('POST', '/tasks', { re: gone.id }))).toEqual([400, 'message_deleted'])
      // `re` takes the thread as it is: its text and labels are its author's.
      expect(code(await ada('POST', '/tasks', { re: reply.id, text: 'mine now' }))).toEqual([400, 'invalid_request'])
      expect(code(await ada('POST', '/tasks', { channel: 'work' }))).toEqual([400, 'invalid_request'])
      expect(code(await ada('POST', '/tasks', { channel: 'work', re: issue.id, text: 'both' }))).toEqual([400, 'invalid_request'])
    })

    it(`${id} is made once for a client id, and a retry gets the task back without the claim it was made with`, async () => {
      const { ada } = setup()
      const first = await ada('POST', '/tasks', { channel: 'work', text: 'deploy a1b2c3', id: 'deploy-a1b2c3', claim: true })
      expect(first.status).toBe(201)
      expect(first.body.claim).toMatchObject({ epoch: 1, until: at(15 * MINUTE) })
      const again = await ada('POST', '/tasks', { channel: 'work', text: 'deploy a1b2c3', id: 'deploy-a1b2c3', claim: true })
      expect(again.body.task.id).toBe(first.body.task.id)
      // The claim's secret was answered once: the task is still held by the claim that made it.
      expect(again.body.claim).toBeUndefined()
      expect(again.body.task.task).toMatchObject({ state: 'claimed', epoch: 1 })
      expect((await ada('GET', '/messages?channel=work')).body.messages).toHaveLength(1)
      // The claim it was made with still settles it.
      expect((await ada('POST', `/tasks/${first.body.task.id}/complete`, { epoch: 1, token: first.body.claim.token })).status).toBe(200)

      // One that can post where it can't read gets its task back too, as its own write made it.
      const { ada: reader, board } = setup()
      grantCi(board, { intake: ['post'] })
      await reader('POST', '/messages', { channel: 'work', text: 'hello' })
      const workflow = ci(board)
      const filed = await workflow('POST', '/tasks', { channel: 'intake', text: 'triage the outage', id: 'outage-1' })
      expect(filed.status).toBe(201)
      expect(code(await workflow('GET', `/messages/${filed.body.task.id}`))).toEqual([404, 'message_not_found'])
      // What others did since isn't its to see: the task comes back as it made it.
      await reader('POST', `/tasks/${filed.body.task.id}/claim`, {})
      const refiled = await workflow('POST', '/tasks', { channel: 'intake', text: 'triage the outage', id: 'outage-1' })
      expect(refiled.body.task).toMatchObject({ id: filed.body.task.id, text: 'triage the outage', task: { state: 'ready', owner: CI, epoch: 0, claim: null } })

      // An id a plain post took is that post's, not a task's.
      await ada('POST', '/messages', { channel: 'work', text: 'just a note', id: 'a-note' })
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'just a note', id: 'a-note' }))).toEqual([409, 'duplicate_id'])
    })

    it(`${id} needs \`post\` to start a thread as one, \`label\` for its labels or to make a thread one, and \`label\` to claim`, async () => {
      const { board, ada } = setup()
      grantCi(board, { work: ['read', 'post'], triage: ['read', 'post', 'label'], audit: ['read'] })
      const runner = ci(board)
      // Posting is enough for a new thread: the board writes board.task itself.
      const made = await runner('POST', '/tasks', { channel: 'work', text: 'bump the lockfile' })
      expect(made.status).toBe(201)
      expect(made.body.task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { owner: CI } })
      // Its labels need `label`, as a labeled post's do, and so does a claim made with it.
      expect(code(await runner('POST', '/tasks', { channel: 'work', text: 'labeled', labels: { step: 'fix' } }))).toEqual([403, 'forbidden'])
      expect(code(await runner('POST', '/tasks', { channel: 'work', text: 'claimed', claim: true }))).toEqual([403, 'forbidden'])
      expect((await runner('POST', '/tasks', { channel: 'triage', text: 'labeled', labels: { step: 'fix' }, claim: true })).status).toBe(201)
      expect(code(await runner('POST', '/tasks', { channel: 'audit', text: 'read-only here' }))).toEqual([403, 'forbidden'])
      expect(code(await runner('POST', '/tasks', { channel: 'elsewhere', text: 'no access here' }))).toEqual([403, 'forbidden'])
      expect((await ada('GET', '/messages?channel=work')).body.messages.map((m: MessageView) => m.text)).toEqual(['bump the lockfile'])

      // Making a thread a task changes its state, which is what `label` gives.
      const plain = (await ada('POST', '/messages', { channel: 'work', text: 'a thread' })).body.message
      expect(code(await runner('POST', '/tasks', { re: plain.id }))).toEqual([403, 'forbidden'])
      const hidden = (await ada('POST', '/messages', { channel: 'elsewhere', text: 'out of sight' })).body.message
      expect(code(await runner('POST', '/tasks', { re: hidden.id }))).toEqual([404, 'message_not_found'])

      // Without `label`, even its own task is not its to claim; where it has it, anyone's is.
      expect(code(await runner('POST', `/tasks/${made.body.task.id}/claim`, {}))).toEqual([403, 'forbidden'])
      expect(code(await runner('POST', '/tasks/claim', { channel: 'work' }))).toEqual([403, 'forbidden'])
      const theirs = await task(ada, 'triage the queue', { channel: 'triage' })
      expect((await runner('POST', `/tasks/${theirs.id}/claim`, {})).body.task.task).toMatchObject({ state: 'claimed', claim: { actor: CI } })
      // What it can't read isn't there.
      const secret = await task(ada, 'rotate the keys', { channel: 'elsewhere' })
      expect(code(await runner('POST', `/tasks/${secret.id}/claim`, {}))).toEqual([404, 'message_not_found'])
      expect(code(await runner('POST', `/tasks/${plain.id}/claim`, {}))).toEqual([404, 'not_a_task'])
    })
  })

  describe(`${id} a claim`, () => {
    it(`${id} holds a task for its lease, and settles it: released, completed, or failed`, async () => {
      const { ada, bo } = setup()
      const { id } = await task(ada, 'fix CVE-123')
      const held = await bo('POST', `/tasks/${id}/claim`, {})
      expect(held.status).toBe(200)
      // 15 minutes when it asks for none, as the claim and the task both say.
      expect(held.body.claim).toEqual({ epoch: 1, token: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/), until: at(15 * MINUTE) })
      expect(held.body.task).toMatchObject({ labels: { 'board.task': 'claimed' }, task: { state: 'claimed', epoch: 1, claim: { actor: BO, until: at(15 * MINUTE) } } })
      const { epoch, token } = held.body.claim

      expect(code(await ada('POST', `/tasks/${id}/claim`, {}))).toEqual([409, 'task_claimed'])
      const released = await bo('POST', `/tasks/${id}/release`, { epoch, token })
      expect(released.body.task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', epoch: 1, claim: null } })

      const second = await claim(ada, id)
      expect(second.epoch).toBe(2)
      const failed = await ada('POST', `/tasks/${id}/fail`, { ...second, reason: 'the tests need a database' })
      expect(failed.body.task).toMatchObject({ labels: { 'board.task': 'failed' }, task: { state: 'failed', claim: null, reason: 'the tests need a database', result: null } })
      expect(code(await bo('POST', `/tasks/${id}/claim`, {}))).toEqual([409, 'task_finished'])
      // Reopened, it's tried again in place.
      expect((await ada('POST', `/tasks/${id}/reopen`)).body.task.task).toMatchObject({ state: 'ready', reason: null })

      const third = await claim(bo, id)
      const done = await bo('POST', `/tasks/${id}/complete`, { ...third, result: 'fixed in a1b2c3, tests pass' })
      expect(done.body.task).toMatchObject({ labels: { 'board.task': 'completed' }, task: { state: 'completed', epoch: 3, claim: null, result: 'fixed in a1b2c3, tests pass' } })
      expect(code(await ada('POST', `/tasks/${id}/claim`, {}))).toEqual([409, 'task_finished'])
      expect(code(await ada('POST', `/tasks/${id}/reopen`))).toEqual([409, 'task_finished'])
      // A result is optional, and a reason isn't.
      const quiet = await task(ada, 'tidy up')
      expect((await ada('POST', `/tasks/${quiet.id}/complete`, await claim(ada, quiet.id))).body.task.task).toMatchObject({ state: 'completed', result: null })
      const other = await task(ada, 'try it')
      expect(code(await ada('POST', `/tasks/${other.id}/fail`, await claim(ada, other.id)))).toEqual([400, 'invalid_request'])
    })

    it(`${id} lands once of any that race, and the rest are told it is claimed`, async () => {
      const { ada, bo, board } = setup()
      const { id } = await task(ada, 'one for whoever gets there first')
      const racing = await Promise.all([ada, bo, web(board), ada, bo].map((call) => call('POST', `/tasks/${id}/claim`, {})))
      expect(racing.map(code).sort()).toEqual([[200, undefined], [409, 'task_claimed'], [409, 'task_claimed'], [409, 'task_claimed'], [409, 'task_claimed']])
      const won = racing.find((answer) => answer.status === 200)!
      expect(won.body.claim.epoch).toBe(1)
      // The log holds the one claim.
      expect(types(await events(ada)).filter((type) => type === 'task.claimed')).toHaveLength(1)
      expect((await read(ada, id)).task).toMatchObject({ epoch: 1, claim: { actor: won.body.task.task.claim.actor } })
    })

    it(`${id} holds its own limits on a task, which no request schema checks for it: a root's text and files, a note, a hold's kind, and the owners a claim takes from`, async () => {
      const { ada } = setup()
      const refused = async (answer: Answer, words: string) => {
        expect([...code(answer), answer.body.error?.message]).toEqual([400, 'invalid_request', words])
      }
      // A task's root is a message: its text is as long as one's, and it carries as many files.
      const long = await ada('POST', '/tasks', { channel: 'work', text: 'x'.repeat(10_001) })
      expect([...code(long), long.body.error.hint]).toEqual([400, 'text_too_long', expect.stringMatching(/attach it to a message/)])
      expect((await ada('POST', '/tasks', { channel: 'work', text: 'x'.repeat(10_000) })).status).toBe(201)
      const files = (count: number) => Array.from({ length: count }, (_, n) => `${'A'.repeat(21)}${String.fromCharCode(65 + n)}`)
      await refused(await ada('POST', '/tasks', { channel: 'work', text: 'with a trace', attachments: files(11) }), 'attachments: a message carries at most 10')
      // Ten are within it: they're looked up, and these aren't files.
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'with a trace', attachments: files(10) }))).toEqual([404, 'attachment_not_found'])

      // A result or a reason is a line or two, and a kind a short name.
      const { id } = await task(ada, 'a long build')
      const held = await claim(ada, id)
      const note = 'x'.repeat(1001)
      await refused(await ada('POST', `/tasks/${id}/complete`, { ...held, result: note }), "result: a task's result is at most 1,000 characters")
      await refused(await ada('POST', `/tasks/${id}/fail`, { ...held, reason: note }), "reason: a task's reason is at most 1,000 characters")
      await refused(await ada('POST', `/tasks/${id}/block`, { ...held, reason: note }), "reason: a task's reason is at most 1,000 characters")
      await refused(await ada('POST', `/tasks/${id}/block`, { ...held, reason: 'approve the deploy?', kind: 'k'.repeat(65) }), 'kind: a kind is up to 64 lowercase letters, numbers, and _.-')
      await refused(await ada('POST', `/tasks/${id}/cancel`, { reason: note }), "reason: a task's reason is at most 1,000 characters")
      // None of them changed it, and what's within them does.
      expect((await read(ada, id)).task).toMatchObject({ state: 'claimed', epoch: 1 })
      expect((await ada('POST', `/tasks/${id}/block`, { ...held, reason: 'x'.repeat(1000), kind: 'k'.repeat(64) })).body.task.task).toMatchObject({ state: 'blocked', blocked: { kind: 'k'.repeat(64) } })

      // A claim takes tasks from 32 owners beside its caller.
      const owners = (count: number) => Array.from({ length: count }, (_, n) => `vercel:user:u_${n}`)
      await refused(await ada('POST', '/tasks/claim', { channel: 'work', from: owners(33) }), 'from: a claim takes tasks from at most 32 owners')
      expect((await ada('POST', '/tasks/claim', { channel: 'work', label: { step: 'none-has-this' }, from: owners(32) })).body).toEqual({ task: null })
    })

    it(`${id} takes a lease of 30 seconds to an hour, says when it ends, and renews from now`, async () => {
      const { ada } = setup()
      const { id } = await task(ada, 'a long build')
      for (const lease of [29, 3601, -1, '5m']) expect(code(await ada('POST', `/tasks/${id}/claim`, { lease })), String(lease)).toEqual([400, 'invalid_request'])
      // The same for a claim of the next ready task, and for one a task is made with: nothing is claimed, and nothing made.
      const next = await ada('POST', '/tasks/claim', { channel: 'work', lease: 3601 })
      expect([...code(next), next.body.error.message]).toEqual([400, 'invalid_request', 'lease: a lease is 30 to 3600 seconds'])
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'made and claimed', claim: true, lease: 29 }))).toEqual([400, 'invalid_request'])
      expect((await ada('GET', '/tasks?channel=work&state=all')).body.tasks.map((found: { message: MessageView }) => [found.message.id, found.message.task?.state])).toEqual([[id, 'ready']])
      const held = await claim(ada, id, { lease: 30 })
      expect(held.until).toBe(at(30 * SECOND))
      vi.setSystemTime(T0 + 20 * SECOND)
      const renewed = await ada('POST', `/tasks/${id}/renew`, { epoch: held.epoch, token: held.token, lease: 3600 })
      expect(renewed.body).toMatchObject({ until: at(20 * SECOND + 60 * MINUTE), task: { task: { state: 'claimed', epoch: 1, claim: { until: at(20 * SECOND + 60 * MINUTE) } } } })
      // Without one, a renewal gets the default again.
      expect((await ada('POST', `/tasks/${id}/renew`, { epoch: held.epoch, token: held.token })).body.until).toBe(at(20 * SECOND + 15 * MINUTE))
      expect(code(await ada('POST', `/tasks/${id}/renew`, { epoch: held.epoch, token: held.token, lease: 7200 }))).toEqual([400, 'invalid_request'])
    })

    it(`${id} fences what it does: once another claim holds the task, its writes are lost and change nothing`, async () => {
      const { ada, bo } = setup()
      const { id } = await task(ada, 'migrate the table')
      const stalled = await claim(ada, id, { lease: 30 })
      // The wrong secret, or another epoch, is no claim at all.
      expect(code(await ada('POST', `/tasks/${id}/complete`, { epoch: stalled.epoch, token: 'not-the-token' }))).toEqual([409, 'claim_lost'])
      expect(code(await ada('POST', `/tasks/${id}/complete`, { epoch: 2, token: stalled.token }))).toEqual([409, 'claim_lost'])
      expect(await stateOf(ada, id)).toBe('claimed')

      // Ada stalls past her lease, and Bo takes the task over.
      vi.setSystemTime(T0 + 31 * SECOND)
      const before = await head(ada)
      const taken = await claim(bo, id)
      expect(taken.epoch).toBe(2)
      // The log says what happened to the first claim, in the same write as the second.
      expect((await events(ada, before)).map((event) => [event.type, (event.payload as { epoch: number }).epoch])).toEqual([['task.expired', 1], ['task.claimed', 2]])

      const now = await head(ada)
      for (const [verb, body] of [
        ['complete', { result: 'done, I think' }],
        ['fail', { reason: 'gave up' }],
        ['release', {}],
        ['renew', {}],
        ['block', { reason: 'approve?' }],
      ] as const)
        expect(code(await ada('POST', `/tasks/${id}/${verb}`, { epoch: stalled.epoch, token: stalled.token, ...body })), verb).toEqual([409, 'claim_lost'])
      // Nothing landed, and Bo still holds it.
      expect(await head(ada)).toBe(now)
      expect((await read(ada, id)).task).toMatchObject({ state: 'claimed', epoch: 2, claim: { actor: BO }, result: null })
      // Even Bo's secret doesn't work at Ada's epoch, nor after Bo lets go.
      expect(code(await bo('POST', `/tasks/${id}/complete`, { epoch: 1, token: taken.token }))).toEqual([409, 'claim_lost'])
      expect((await bo('POST', `/tasks/${id}/release`, taken)).status).toBe(200)
      expect(code(await bo('POST', `/tasks/${id}/complete`, taken))).toEqual([409, 'claim_lost'])
      expect(await stateOf(ada, id)).toBe('ready')
    })

    it(`${id} is over when its lease runs out, even before anyone takes the task: its own write is lost`, async () => {
      const { ada } = setup()
      const { id } = await task(ada, 'a short one')
      const held = await claim(ada, id, { lease: 30 })
      vi.setSystemTime(T0 + 29 * SECOND)
      expect((await ada('POST', `/tasks/${id}/renew`, { epoch: held.epoch, token: held.token, lease: 30 })).status).toBe(200)
      vi.setSystemTime(T0 + 59 * SECOND)
      expect(code(await ada('POST', `/tasks/${id}/complete`, { epoch: held.epoch, token: held.token }))).toEqual([409, 'claim_lost'])
      expect((await read(ada, id)).task).toMatchObject({ state: 'claimed', result: null })
    })

    it(`${id} expires when its lease runs out, on the board's own clock, unless it was renewed`, async () => {
      const { ada, bo, advance } = setup()
      const { id } = await task(ada, 'watch the canary')
      const held = await claim(ada, id)
      await advance(10 * MINUTE)
      expect((await ada('POST', `/tasks/${id}/renew`, { epoch: held.epoch, token: held.token })).body.until).toBe(at(25 * MINUTE))
      // The first lease's timer fires into a claim that was renewed since: nothing happens.
      await advance(5 * MINUTE)
      expect((await read(bo, id)).task).toMatchObject({ state: 'claimed', claim: { until: at(25 * MINUTE) } })
      const before = await head(ada)
      await advance(10 * MINUTE)
      // The board says so itself: the task is ready, and its label with it.
      expect(await read(bo, id)).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', epoch: 1, claim: null } })
      expect((await events(bo, before)).map((event) => [event.type, event.payload])).toEqual([['task.expired', { id, thread: expect.any(String), epoch: 1 }]])
      expect(code(await ada('POST', `/tasks/${id}/complete`, { epoch: held.epoch, token: held.token }))).toEqual([409, 'claim_lost'])
      // A claim settled before its lease ran out leaves its timer nothing to do.
      const next = await claim(bo, id)
      await bo('POST', `/tasks/${id}/complete`, next)
      const settled = await head(ada)
      await advance(20 * MINUTE)
      expect(await events(bo, settled)).toEqual([])
      expect(await stateOf(bo, id)).toBe('completed')
    })

    it(`${id} checks the clock where the board has no timers: a lapsed claim is ready to whoever asks`, async () => {
      const { ada, bo } = setup()
      const { id } = await task(ada, 'a job on a board without a scheduler')
      await claim(ada, id, { lease: 60 })
      expect((await bo('GET', '/tasks?state=ready')).body.tasks).toEqual([])
      expect((await bo('GET', '/tasks?state=claimed')).body.tasks.map((t: { message: MessageView }) => t.message.id)).toEqual([id])
      vi.setSystemTime(T0 + 61 * SECOND)
      // Nothing told the label yet, and the task is ready all the same.
      expect((await read(bo, id)).labels['board.task']).toBe('claimed')
      expect((await bo('GET', '/tasks?state=ready')).body.tasks.map((t: { message: MessageView }) => t.message.id)).toEqual([id])
      expect((await bo('GET', '/tasks?state=claimed')).body.tasks).toEqual([])
      const taken = await ada('POST', '/tasks/claim', { channel: 'work' })
      expect(taken.body).toMatchObject({ task: { id, task: { state: 'claimed', epoch: 2 } }, claim: { epoch: 2 } })
    })
  })

  describe(`${id} a task that needs others`, () => {
    it(`${id} waits until each has completed, and is ready in the same write as the last`, async () => {
      const { ada, bo } = setup()
      const fix = await task(ada, 'fix CVE-123')
      const docs = await task(ada, 'write the advisory', { channel: 'docs' })
      const review = await task(ada, 'review both', { needs: [fix.id, docs.id, fix.id] })
      expect(review).toMatchObject({ labels: { 'board.task': 'waiting' }, task: { state: 'waiting', needs: [fix.id, docs.id] } })
      expect(code(await bo('POST', `/tasks/${review.id}/claim`, {}))).toEqual([409, 'task_waiting'])
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'ship it', needs: [review.id], claim: true }))).toEqual([409, 'task_waiting'])

      await bo('POST', `/tasks/${fix.id}/complete`, await claim(bo, fix.id))
      expect(await stateOf(ada, review.id)).toBe('waiting')
      const before = await head(ada)
      await bo('POST', `/tasks/${docs.id}/complete`, await claim(bo, docs.id))
      // One append: the completion, then what it readied, with nothing in between.
      const landed = await events(ada, before)
      expect(landed.map((event) => [event.type, event.message?.id])).toEqual([['task.claimed', docs.id], ['task.completed', docs.id], ['task.ready', review.id]])
      expect(Number(landed[2]!.cursor)).toBe(Number(landed[1]!.cursor) + 1)
      expect(await read(ada, review.id)).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready' } })
      expect((await bo('POST', `/tasks/${review.id}/claim`, {})).status).toBe(200)

      // A task waits for at most 20 others here: more is refused before any of them is looked up.
      const many = (count: number) => ({ channel: 'work', text: 'ship it all', needs: Array.from({ length: count }, (_, i) => String(1000 + i)) })
      expect(code(await ada('POST', '/tasks', many(21)))).toEqual([400, 'invalid_request'])
      expect(code(await ada('POST', '/tasks', many(20)))).toEqual([400, 'invalid_needs'])

      // One whose prerequisites completed already is ready from the start.
      expect(await task(ada, 'announce it', { needs: [fix.id, docs.id] })).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', needs: [fix.id, docs.id] } })
    })

    it(`${id} keeps waiting for one that failed or was canceled, until the failed one is reopened and completes`, async () => {
      const { ada } = setup()
      const build = await task(ada, 'build the image')
      const deploy = await task(ada, 'deploy it', { needs: [build.id] })
      await ada('POST', `/tasks/${build.id}/fail`, { ...(await claim(ada, build.id)), reason: 'registry is down' })
      expect(await stateOf(ada, deploy.id)).toBe('waiting')
      expect(code(await ada('POST', `/tasks/${deploy.id}/claim`, {}))).toEqual([409, 'task_waiting'])
      await ada('POST', `/tasks/${build.id}/reopen`)
      expect(await stateOf(ada, deploy.id)).toBe('waiting')
      await ada('POST', `/tasks/${build.id}/complete`, await claim(ada, build.id))
      expect(await stateOf(ada, deploy.id)).toBe('ready')

      const lint = await task(ada, 'lint')
      const merge = await task(ada, 'merge', { needs: [lint.id] })
      expect((await ada('POST', `/tasks/${lint.id}/cancel`, { reason: 'not needed after all' })).body.task.task).toMatchObject({ state: 'canceled', reason: 'not needed after all' })
      expect(await stateOf(ada, merge.id)).toBe('waiting')
      expect((await ada('GET', `/tasks?needs=${lint.id}`)).body.tasks.map((t: { message: MessageView }) => t.message.id)).toEqual([merge.id])
    })

    it(`${id} refuses a prerequisite that was canceled, which can never complete, when a task is made and when a thread is made one`, async () => {
      const { board, ada } = setup()
      const dropped = await task(ada, 'migrate the old table')
      const build = await task(ada, 'build the image')
      await ada('POST', `/tasks/${dropped.id}/cancel`, { reason: 'not needed after all' })
      const plain = (await ada('POST', '/messages', { channel: 'work', text: 'a thread to make a task' })).body.message
      // Both ways of making a task hear it at once, alone or among prerequisites that are fine, and nothing is made.
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'drop the old table', needs: [dropped.id] }))).toEqual([400, 'invalid_needs'])
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'drop the old table', needs: [build.id, dropped.id] }))).toEqual([400, 'invalid_needs'])
      expect(code(await ada('POST', '/tasks', { re: plain.id, needs: [dropped.id] }))).toEqual([400, 'invalid_needs'])
      expect((await ada('GET', '/messages?channel=work')).body.messages.map((m: MessageView) => [m.text, m.task?.state])).toEqual([
        ['migrate the old table', 'canceled'],
        ['build the image', 'ready'],
        ['a thread to make a task', undefined],
      ])
      // One whose root was deleted was canceled with it.
      const gone = await task(ada, 'gone soon')
      await ada('POST', `/messages/${gone.id}/delete`, {})
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'after what is gone', needs: [gone.id] }))).toEqual([400, 'invalid_needs'])
      // A failed one can be reopened, so it's still something to wait for.
      await ada('POST', `/tasks/${build.id}/fail`, { ...(await claim(ada, build.id)), reason: 'registry is down' })
      expect((await task(ada, 'deploy it', { needs: [build.id] })).task).toMatchObject({ state: 'waiting', needs: [build.id] })
      expect((await ada('POST', '/tasks', { re: plain.id, needs: [build.id] })).body.task.task).toMatchObject({ state: 'waiting', needs: [build.id] })
      // One the caller can't read says nothing of having been canceled: it answers as what isn't there.
      grantCi(board, { work: ['read', 'post', 'label'] })
      const runner = ci(board)
      const secret = await task(ada, 'rotate the keys', { channel: 'elsewhere' })
      await ada('POST', `/tasks/${secret.id}/cancel`, { reason: 'rotated by hand' })
      const hidden = await runner('POST', '/tasks', { channel: 'work', text: 'after that', needs: [secret.id] })
      const missing = await runner('POST', '/tasks', { channel: 'work', text: 'after that', needs: ['999'] })
      expect(code(hidden)).toEqual([400, 'invalid_needs'])
      expect(hidden.body.error.message).toBe(missing.body.error.message.replace('999', secret.id))
    })

    it(`${id} names only tasks the caller can read, and never itself`, async () => {
      const { board, ada } = setup()
      grantCi(board, { work: ['read', 'post', 'label'] })
      const runner = ci(board)
      const plain = (await ada('POST', '/messages', { channel: 'work', text: 'not a task' })).body.message
      const secret = await task(ada, 'rotate the keys', { channel: 'elsewhere' })
      const mine = await task(runner, 'bump the lockfile')
      for (const needs of [[plain.id], ['999'], ['nope'], [secret.id], [mine.id, plain.id]])
        expect(code(await runner('POST', '/tasks', { channel: 'work', text: 'after that', needs })), JSON.stringify(needs)).toEqual([400, 'invalid_needs'])
      // What it can't read answers as what isn't there.
      const missing = await runner('POST', '/tasks', { channel: 'work', text: 'after that', needs: ['999'] })
      const hidden = await runner('POST', '/tasks', { channel: 'work', text: 'after that', needs: [secret.id] })
      expect(hidden.body.error.message).toBe(missing.body.error.message.replace('999', secret.id))
      expect(code(await runner('POST', '/tasks', { re: plain.id, needs: [plain.id] }))).toEqual([400, 'invalid_needs'])
      expect((await runner('GET', '/messages?channel=work')).body.messages.map((m: MessageView) => m.text)).toEqual(['not a task', 'bump the lockfile'])
      expect((await runner('POST', '/tasks', { re: plain.id, needs: [mine.id] })).body.task.task).toMatchObject({ state: 'waiting', needs: [mine.id] })
    })
  })

  describe(`${id} what a task needs, changed`, () => {
    const needs = (call: Call, id: string, ids: string[]) => call('POST', `/tasks/${id}/needs`, { needs: ids })
    const changes = async (call: Call, after: string | number, id: string) =>
      (await events(call, after)).filter((event) => event.message?.id === id).map((event) => [event.type, event.message?.task?.state])

    it(`${id} waits for the new ones from that write, and is ready once they have completed, or at once with none`, async () => {
      const { ada, bo } = setup()
      const fix = await task(ada, 'fix CVE-123')
      const docs = await task(ada, 'write the advisory')
      const review = await task(ada, 'review it', { needs: [fix.id] })
      let cursor = await head(ada)
      // It waits for another task in place of the one it waited for.
      const moved = await needs(ada, review.id, [docs.id])
      expect(moved.status).toBe(200)
      expect(moved.body.task).toMatchObject({ id: review.id, labels: { 'board.task': 'waiting' }, task: { state: 'waiting', needs: [docs.id] } })
      const [changed] = (await events(ada, cursor)).filter((event) => event.message?.id === review.id)
      expect(changed).toMatchObject({ type: 'task.needs_changed', payload: { id: review.id, thread: review.thread, needs: [docs.id], by: { actor: ADA, principal: ADA, profile: null } }, actor: { id: ADA } })
      // What it no longer waits for doesn't ready it, and what it waits for now does.
      await bo('POST', `/tasks/${fix.id}/complete`, await claim(bo, fix.id))
      expect(await stateOf(ada, review.id)).toBe('waiting')
      expect((await ada('GET', `/tasks?needs=${fix.id}`)).body.tasks).toEqual([])
      await bo('POST', `/tasks/${docs.id}/complete`, await claim(bo, docs.id))
      expect(await stateOf(ada, review.id)).toBe('ready')

      // A ready task waits again for one that hasn't completed.
      const ship = await task(ada, 'ship it')
      cursor = await head(ada)
      expect((await needs(ada, review.id, [ship.id, docs.id])).body.task.task).toMatchObject({ state: 'waiting', needs: [ship.id, docs.id] })
      expect(code(await bo('POST', `/tasks/${review.id}/claim`, {}))).toEqual([409, 'task_waiting'])
      expect(await changes(ada, cursor, review.id)).toEqual([['task.needs_changed', 'waiting']])
      // For ones that have all completed, it waits in the change itself, and its task.ready follows in the same write.
      cursor = await head(ada)
      expect((await needs(ada, review.id, [fix.id, docs.id])).body.task.task).toMatchObject({ state: 'ready', needs: [fix.id, docs.id] })
      const landed = (await events(ada, cursor)).filter((event) => event.message?.id === review.id)
      expect(landed.map((event) => [event.type, event.message?.task?.state])).toEqual([['task.needs_changed', 'waiting'], ['task.ready', 'ready']])
      expect(Number(landed[1]!.cursor)).toBe(Number(landed[0]!.cursor) + 1)
      // The same set, in any order and said twice, changes nothing.
      cursor = await head(ada)
      expect((await needs(ada, review.id, [docs.id, fix.id, docs.id])).body.task.task).toMatchObject({ state: 'ready', needs: [fix.id, docs.id] })
      expect(await events(ada, cursor)).toEqual([])
      // With none, it's ready, and nothing says it became so but the change.
      await needs(ada, review.id, [ship.id])
      cursor = await head(ada)
      expect((await needs(ada, review.id, [])).body.task.task).toMatchObject({ state: 'ready', needs: [] })
      expect(await changes(ada, cursor, review.id)).toEqual([['task.needs_changed', 'ready']])
      expect((await bo('POST', `/tasks/${review.id}/claim`, {})).status).toBe(200)
    })

    it(`${id} takes what a new task takes: tasks the caller reads, none canceled, at most 20, and never itself`, async () => {
      const { board, ada } = setup()
      const root = await task(ada, 'ship it')
      const failed = await task(ada, 'build the image')
      await ada('POST', `/tasks/${failed.id}/fail`, { ...(await claim(ada, failed.id)), reason: 'registry is down' })
      const dropped = await task(ada, 'migrate the old table')
      await ada('POST', `/tasks/${dropped.id}/cancel`, { reason: 'not needed after all' })
      const plain = (await ada('POST', '/messages', { channel: 'work', text: 'just a thread' })).body.message
      const reply = (await ada('POST', '/messages', { re: root.id, text: 'a reply' })).body.message
      const secret = await task(ada, 'rotate the keys', { channel: 'secret' })
      for (const [refused, why] of [[dropped.id, 'canceled'], [plain.id, 'no task'], [reply.id, 'a reply'], ['99999', 'not there'], [root.id, 'itself']] as const)
        expect(code(await needs(ada, root.id, [failed.id, refused])), why).toEqual([400, 'invalid_needs'])
      // One the caller can't read is no task to it, as when it makes one.
      const narrowed = person(board, 'ada', { 'x-board-can': '*=post;work=read,post,label' })
      expect(code(await needs(narrowed, root.id, [secret.id]))).toEqual([400, 'invalid_needs'])
      // It waits for at most 20 tasks here, a limit of this board's own: more is refused before any of them is looked up.
      const many = await needs(ada, root.id, Array.from({ length: 21 }, (_, i) => String(1000 + i)))
      expect([...code(many), many.body.error.message]).toEqual([400, 'invalid_request', 'needs: a task waits for at most 20 tasks'])
      // Twenty of them, however often each is named, are within it: they're looked up, and these aren't tasks.
      expect(code(await needs(ada, root.id, Array.from({ length: 40 }, (_, i) => String(1000 + (i % 20)))))).toEqual([400, 'invalid_needs'])
      expect(code(await ada('POST', `/tasks/${root.id}/needs`, {}))).toEqual([400, 'invalid_request'])
      expect((await read(ada, root.id)).task).toMatchObject({ state: 'ready', needs: [] })
      // A failed one may be reopened, so it's something to wait for.
      expect((await needs(ada, root.id, [failed.id])).body.task.task).toMatchObject({ state: 'waiting', needs: [failed.id] })
      // The set is checked as it's given before it's found to be the same: one canceled since, or out of this caller's sight, is refused.
      const gone = await task(ada, 'needed for now')
      const waits = await task(ada, 'waits for it, and for a secret', { needs: [gone.id, secret.id] })
      expect(code(await needs(narrowed, waits.id, [secret.id, gone.id]))).toEqual([400, 'invalid_needs'])
      await ada('POST', `/tasks/${gone.id}/cancel`, { reason: 'not needed after all' })
      expect(code(await needs(ada, waits.id, [gone.id, secret.id]))).toEqual([400, 'invalid_needs'])
      expect((await read(ada, waits.id)).task).toMatchObject({ state: 'waiting', needs: [gone.id, secret.id] })
      // What names no task isn't one whose needs change.
      expect(code(await needs(ada, plain.id, []))).toEqual([404, 'not_a_task'])
      expect(code(await needs(ada, reply.id, []))).toEqual([404, 'not_a_task'])
      expect(code(await needs(ada, '99999', []))).toEqual([404, 'message_not_found'])
    })

    it(`${id} never leaves a task waiting for itself: a change that would close a cycle is refused, however many tasks around`, async () => {
      const { ada } = setup()
      const a = await task(ada, 'a')
      const b = await task(ada, 'b', { needs: [a.id] })
      const c = await task(ada, 'c', { needs: [b.id] })
      const other = await task(ada, 'on its own')
      // A new task can't be waited for, so only a change can close one: straight back, or around through others.
      const back = await needs(ada, a.id, [b.id])
      expect(code(back)).toEqual([400, 'invalid_needs'])
      expect(back.body.error.message).toBe(`needs: #${b.id} waits for #${a.id} already: they would wait for each other`)
      const around = await needs(ada, a.id, [other.id, c.id])
      expect(code(around)).toEqual([400, 'invalid_needs'])
      expect(around.body.error.message).toBe(`needs: #${c.id} waits for #${a.id} already: they would wait for each other`)
      expect((await read(ada, a.id)).task).toMatchObject({ state: 'ready', needs: [] })
      // Once what was in the way waits for something else, the same change lands.
      expect((await needs(ada, b.id, [other.id])).status).toBe(200)
      expect((await needs(ada, a.id, [other.id, c.id])).body.task.task).toMatchObject({ state: 'waiting', needs: [other.id, c.id] })
      // And the cycle it would now close the other way is refused too.
      expect(code(await needs(ada, other.id, [a.id]))).toEqual([400, 'invalid_needs'])
      expect(code(await needs(ada, b.id, [a.id]))).toEqual([400, 'invalid_needs'])
    })
  })

  describe(`${id} a hold for a person`, () => {
    it(`${id} keeps a task from being claimed until its owner lifts it, back to where it stood`, async () => {
      const { ada, bo } = setup()
      const { id } = await task(ada, 'deploy to prod')
      // `edited` is the board's own kind: a hold that asked for it would read as an edit no one made.
      expect(code(await ada('POST', `/tasks/${id}/block`, { reason: 'looks edited', kind: 'edited' }))).toEqual([400, 'invalid_request'])
      expect(await stateOf(ada, id)).toBe('ready')
      const held = await ada('POST', `/tasks/${id}/block`, { reason: 'approve the prod deploy?', kind: 'awaiting_approval' })
      expect(held.body.task).toMatchObject({ labels: { 'board.task': 'blocked' }, task: { state: 'blocked', blocked: { kind: 'awaiting_approval', reason: 'approve the prod deploy?' } } })
      expect(code(await bo('POST', `/tasks/${id}/claim`, {}))).toEqual([409, 'task_blocked'])
      expect(code(await ada('POST', `/tasks/${id}/block`, { reason: 'again' }))).toEqual([409, 'task_blocked'])
      expect((await ada('POST', `/tasks/${id}/unblock`)).body.task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready', blocked: null } })
      // Lifting a hold that isn't there leaves the task as it is.
      const before = await head(ada)
      expect((await ada('POST', `/tasks/${id}/unblock`)).body.task.task.state).toBe('ready')
      expect(await head(ada)).toBe(before)
      expect((await ada('POST', `/tasks/${id}/block`, { reason: 'no kind' })).body.task.task.blocked).toEqual({ kind: null, reason: 'no kind' })
      expect(code(await ada('POST', `/tasks/${id}/block`, { reason: '' }))).toEqual([400, 'invalid_request'])
    })

    it(`${id} returns a task to waiting while what it needs has not completed, and to ready once it has`, async () => {
      const { ada } = setup()
      const first = await task(ada, 'first')
      const second = await task(ada, 'second', { needs: [first.id] })
      await ada('POST', `/tasks/${second.id}/block`, { reason: 'is this still wanted?' })
      expect((await ada('POST', `/tasks/${second.id}/unblock`)).body.task).toMatchObject({ labels: { 'board.task': 'waiting' }, task: { state: 'waiting' } })
      // Held while its prerequisite completes: nothing readies it then, and lifting the hold does.
      await ada('POST', `/tasks/${second.id}/block`, { reason: 'hold on' })
      await ada('POST', `/tasks/${first.id}/complete`, await claim(ada, first.id))
      expect(await stateOf(ada, second.id)).toBe('blocked')
      expect((await ada('POST', `/tasks/${second.id}/unblock`)).body.task).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready' } })
    })

    it(`${id} is its claimant's to place on a claimed task, which ends the claim`, async () => {
      const { ada, bo } = setup()
      const { id } = await task(ada, 'migrate the table')
      const held = await claim(bo, id, { lease: 60 })
      // Its owner waits for the claim, or cancels the task.
      expect(code(await ada('POST', `/tasks/${id}/block`, { reason: 'wait' }))).toEqual([409, 'task_claimed'])
      expect(code(await bo('POST', `/tasks/${id}/block`, { reason: 'half a claim', epoch: held.epoch }))).toEqual([400, 'invalid_request'])
      const blocked = await bo('POST', `/tasks/${id}/block`, { reason: 'drop the old column too?', kind: 'needs_input', epoch: held.epoch, token: held.token })
      expect(blocked.body.task.task).toMatchObject({ state: 'blocked', claim: null, blocked: { kind: 'needs_input', reason: 'drop the old column too?' } })
      expect(code(await bo('POST', `/tasks/${id}/complete`, held))).toEqual([409, 'claim_lost'])
      // A claim whose lease ran out holds nothing: its owner holds the task then.
      await ada('POST', `/tasks/${id}/unblock`)
      await claim(bo, id, { lease: 30 })
      vi.setSystemTime(T0 + 31 * SECOND)
      expect((await ada('POST', `/tasks/${id}/block`, { reason: 'bo went quiet' })).body.task.task).toMatchObject({ state: 'blocked', claim: null })
    })
  })

  describe(`${id} a task's owner`, () => {
    it(`${id} changes it, as does manage in its channel, and no one else`, async () => {
      const { board, ada } = setup()
      const deployment = web(board)
      const own = await task(deployment, 'rebuild the index')
      expect(own.task?.owner).toBe(WEB)
      // Ada manages every channel: she changes a task she doesn't own.
      const theirs = await task(ada, 'rotate the keys')
      for (const [verb, body] of [
        ['block', { reason: 'not yet' }],
        ['unblock', undefined],
        ['reopen', undefined],
        ['assign', { for: `${ADA}+fixer` }],
        ['cancel', { reason: 'mine now' }],
      ] as const)
        expect(code(await deployment('POST', `/tasks/${theirs.id}/${verb}`, body)), verb).toEqual([403, 'task_not_owned'])
      expect((await read(ada, theirs.id)).task).toMatchObject({ state: 'ready', for: null })
      // It may claim and settle it all the same: that takes `label`, not the task.
      expect((await deployment('POST', `/tasks/${theirs.id}/complete`, await claim(deployment, theirs.id))).status).toBe(200)

      expect((await deployment('POST', `/tasks/${own.id}/block`, { reason: 'waiting on infra' })).status).toBe(200)
      expect((await ada('POST', `/tasks/${own.id}/unblock`)).body.task.task.state).toBe('ready')
      expect((await ada('POST', `/tasks/${own.id}/assign`, { for: `${WEB}+indexer` })).body.task.task.for).toBe(`${WEB}+indexer`)
      expect((await ada('POST', `/tasks/${own.id}/cancel`, { reason: 'superseded' })).body.task.task).toMatchObject({ state: 'canceled', reason: 'superseded' })
      expect(code(await deployment('POST', `/tasks/${own.id}/cancel`, { reason: 'again' }))).toEqual([409, 'task_finished'])
      expect(code(await deployment('POST', `/tasks/${own.id}/block`, { reason: 'too late' }))).toEqual([409, 'task_finished'])
      expect(code(await deployment('POST', `/tasks/${own.id}/unblock`))).toEqual([409, 'task_finished'])
      expect(code(await deployment('POST', `/tasks/${own.id}/assign`, { for: null }))).toEqual([409, 'task_finished'])
    })

    it(`${id} is held to its own as a profile: a profile changes the tasks it made, and its principal as itself any of them`, async () => {
      const { ada, board } = setup()
      // A sandbox's agent: one of Ada's profiles, with what a sandbox policy gives it, and no manage.
      const can = { 'x-board-can': '*=read,post,react,label' }
      const triage = person(board, 'ada', { 'x-board-profile': 'triage', ...can })
      const herself = person(board, 'ada', can)
      const hers = await task(ada, 'rotate the keys', { for: `${ADA}+fixer` })
      const fixers = await task(person(board, 'ada', { 'x-board-profile': 'fixer', ...can }), 'patch the parser')
      // Its principal's other tasks aren't its own to change: it would assign itself another profile's work.
      for (const made of [hers, fixers])
        for (const [verb, body] of [
          ['assign', { for: `${ADA}+triage` }],
          ['block', { reason: 'mine' }],
          ['unblock', undefined],
          ['reopen', undefined],
          ['cancel', { reason: 'mine' }],
        ] as const)
          expect(code(await triage('POST', `/tasks/${made.id}/${verb}`, body)), verb).toEqual([403, 'task_not_owned'])
      expect(code(await triage('POST', `/tasks/${hers.id}/claim`, {}))).toEqual([409, 'task_assigned'])
      expect((await read(ada, hers.id)).task).toMatchObject({ state: 'ready', for: `${ADA}+fixer` })
      // What it made is its own, and every view of a task says which of Ada's actors made it: who changes it as its owner.
      const own = await task(triage, 'sort the queue')
      expect(own.task).toMatchObject({ owner: ADA, by: `${ADA}+triage` })
      expect([hers, fixers].map((made) => made.task?.by)).toEqual([ADA, `${ADA}+fixer`])
      expect((await read(ada, own.id)).task?.by).toBe(`${ADA}+triage`)
      expect((await ada('GET', '/tasks?channel=work')).body.tasks.map((listed: { message: MessageView }) => listed.message.task?.by)).toEqual([ADA, `${ADA}+fixer`, `${ADA}+triage`])
      expect((await events(ada, 0)).filter((event) => event.type === 'task.created').map((event) => event.message?.task?.by)).toEqual([ADA, `${ADA}+fixer`, `${ADA}+triage`])
      expect((await triage('POST', `/tasks/${own.id}/assign`, { for: `${ADA}+fixer` })).body.task.task.for).toBe(`${ADA}+fixer`)
      // Ada as herself, narrowed the same way, changes what any of her profiles made: it stays the profile's.
      expect((await herself('POST', `/tasks/${own.id}/assign`, { for: null })).body.task.task).toMatchObject({ for: null, by: `${ADA}+triage` })
      expect((await herself('POST', `/tasks/${fixers.id}/cancel`, { reason: 'superseded' })).body.task.task.state).toBe('canceled')
    })

    it(`${id} is its principal only while it may still write there: a token narrowed to reading changes nothing`, async () => {
      const { ada, board } = setup()
      const { id } = await task(ada, 'rotate the keys')
      const sandboxed = person(board, 'ada', { 'x-board-can': 'work=read' })
      expect(code(await sandboxed('POST', `/tasks/${id}/cancel`, { reason: 'from a sandbox' }))).toEqual([403, 'task_not_owned'])
      expect(await stateOf(ada, id)).toBe('ready')
      const posting = person(board, 'ada', { 'x-board-can': 'work=read,post' })
      expect((await posting('POST', `/tasks/${id}/cancel`, { reason: 'from one that posts' })).status).toBe(200)
    })

    it(`${id} assigns it to one of its own profiles, the only actor that claims it then, lease or no lease`, async () => {
      const { ada, bo, board } = setup()
      const fixer = person(board, 'ada', { 'x-board-profile': 'fixer' })
      const reviewer = person(board, 'ada', { 'x-board-profile': 'reviewer' })
      const made = await task(ada, 'fix CVE-123', { for: `${ADA}+fixer` })
      expect(made.task?.for).toBe(`${ADA}+fixer`)
      for (const call of [ada, reviewer, bo]) expect(code(await call('POST', `/tasks/${made.id}/claim`, {}))).toEqual([409, 'task_assigned'])
      const held = await claim(fixer, made.id, { lease: 30 })
      expect((await read(ada, made.id)).task?.claim).toMatchObject({ actor: `${ADA}+fixer` })
      // A quiet agent keeps its work: the lease runs out, and it's still only the fixer's.
      vi.setSystemTime(T0 + 31 * SECOND)
      expect(code(await reviewer('POST', `/tasks/${made.id}/claim`, {}))).toEqual([409, 'task_assigned'])
      expect((await reviewer('POST', '/tasks/claim', { channel: 'work' })).body).toEqual({ task: null })
      expect((await fixer('POST', `/tasks/${made.id}/claim`, {})).body.claim.epoch).toBe(held.epoch + 1)

      // Assigned later, only that actor; back to the pool, anyone who may.
      const other = await task(ada, 'review the fix')
      expect((await ada('POST', `/tasks/${other.id}/assign`, { for: `${ADA}+reviewer` })).body.task.task.for).toBe(`${ADA}+reviewer`)
      expect(code(await fixer('POST', `/tasks/${other.id}/claim`, {}))).toEqual([409, 'task_assigned'])
      expect((await ada('POST', `/tasks/${other.id}/assign`, { for: null })).body.task.task.for).toBeNull()
      expect((await fixer('POST', `/tasks/${other.id}/claim`, {})).status).toBe(200)

      // Only the owner's own actors: another principal's, or one that isn't a profile of it, is refused.
      for (const actor of [`${BO}+fixer`, ADA, `${ADA}+`, `${ADA}+Not A Profile`, 'fixer'])
        expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'for someone else', for: actor })), actor).toEqual([400, 'invalid_request'])
      expect(code(await ada('POST', `/tasks/${other.id}/assign`, { for: `${BO}+fixer` }))).toEqual([400, 'invalid_request'])
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'claimed for another', for: `${ADA}+fixer`, claim: true }))).toEqual([409, 'task_assigned'])
      expect((await fixer('POST', '/tasks', { channel: 'work', text: 'mine from the start', for: `${ADA}+fixer`, claim: true })).body.task.task).toMatchObject({ state: 'claimed', claim: { actor: `${ADA}+fixer` } })
    })
  })

  describe(`${id} a task assigned to a profile`, () => {
    it(`${id} isn't taken by another principal whose own ID reads the same as that actor's`, async () => {
      const { ada, board } = setup()
      // An actor is its principal, then `+` and a profile. This principal's own ID ends that way: the
      // same string as Ada's `fixer`, and nothing of hers.
      const lookalike = person(board, 'ada+fixer')
      const made = await task(ada, 'fix CVE-123', { for: `${ADA}+fixer` })
      // It names no owner, so it takes only its own: Ada's task isn't one, whoever it's for.
      expect((await lookalike('POST', '/tasks/claim', { channel: 'work' })).body).toEqual({ task: null })
      expect(code(await lookalike('POST', `/tasks/${made.id}/claim`, {}))).toEqual([409, 'task_assigned'])
      expect(await stateOf(ada, made.id)).toBe('ready')
      // The actor it's for is Ada's, and takes it.
      const fixer = person(board, 'ada', { 'x-board-profile': 'fixer' })
      expect((await fixer('POST', '/tasks/claim', { channel: 'work' })).body.task.id).toBe(made.id)
    })
  })

  describe(`${id} claiming the next ready task`, () => {
    it(`${id} takes the oldest in a channel or its subtree that has every label asked for`, async () => {
      const { ada } = setup()
      const review = await task(ada, 'review the fix', { labels: { step: 'review' } })
      const fix = await task(ada, 'fix CVE-123', { labels: { step: 'fix', area: 'web' } })
      const later = await task(ada, 'fix CVE-456', { channel: 'work/api', labels: { step: 'fix' } })
      await task(ada, 'elsewhere', { channel: 'ops', labels: { step: 'fix' } })

      expect((await ada('POST', '/tasks/claim', { channel: 'work', label: { step: 'fix', area: 'api' } })).body).toEqual({ task: null })
      const first = await ada('POST', '/tasks/claim', { channel: 'work/', label: { step: 'fix' }, lease: 60 })
      expect(first.body).toMatchObject({ task: { id: fix.id, task: { state: 'claimed' } }, claim: { epoch: 1, until: at(MINUTE) } })
      // The channel alone leaves out what's under it; the subtree has both.
      expect((await ada('POST', '/tasks/claim', { channel: 'work', label: { step: 'fix' } })).body).toEqual({ task: null })
      expect((await ada('POST', '/tasks/claim', { channel: 'work/', label: { step: 'fix' } })).body.task.id).toBe(later.id)
      expect((await ada('POST', '/tasks/claim', { channel: 'work/' })).body.task.id).toBe(review.id)
      expect((await ada('POST', '/tasks/claim', { channel: 'work/' })).body).toEqual({ task: null })
      expect(code(await ada('POST', '/tasks/claim', { channel: 'Not A Channel' }))).toEqual([400, 'invalid_request'])
    })

    it(`${id} takes the caller's own tasks, and another owner's only when it names them`, async () => {
      const { ada, bo, board } = setup()
      const deployment = web(board)
      const hers = await task(ada, "ada's")
      const theirs = await task(deployment, "the deployment's")
      const his = await task(bo, "bo's")
      // A task's text is instructions: Bo's agents take them from Bo, unless he says who else.
      expect((await bo('POST', '/tasks/claim', { channel: 'work' })).body.task.id).toBe(his.id)
      expect((await bo('POST', '/tasks/claim', { channel: 'work' })).body).toEqual({ task: null })
      // A handle is how someone shows, and several can show the same: it names no owner, known to the board or not.
      expect(code(await bo('POST', '/tasks/claim', { channel: 'work', from: ['u_ada'] }))).toEqual([400, 'invalid_from'])
      expect(code(await bo('POST', '/tasks/claim', { channel: 'work', from: ['nobody'] }))).toEqual([400, 'invalid_from'])
      // An ID is one principal's alone.
      expect((await bo('POST', '/tasks/claim', { channel: 'work', from: [ADA, WEB] })).body.task.id).toBe(hers.id)
      expect((await bo('POST', '/tasks/claim', { channel: 'work', from: [ADA, WEB] })).body.task.id).toBe(theirs.id)
    })

    it(`${id} takes an owner's tasks by their ID even when they only ever wrote through a profile`, async () => {
      const { bo, board } = setup()
      const made = await task(person(board, 'ada', { 'x-board-profile': 'planner' }), 'plan the migration')
      expect(made.task).toMatchObject({ owner: ADA })
      expect((await bo('POST', '/tasks/claim', { channel: 'work', from: [ADA] })).body.task.id).toBe(made.id)
      // An ID the board has never seen is still an ID: it names no one's tasks yet, and isn't refused.
      expect((await bo('POST', '/tasks/claim', { channel: 'work', from: ['vercel:user:u_nobody'] })).body).toEqual({ task: null })
    })

    it(`${id} never takes a task by its owner's handle, though a credential gave it`, async () => {
      const { bo, board } = setup()
      // Mallory's task is the older one, and nothing of the deployment's.
      const hers = await task(person(board, 'mallory'), 'delete the index')
      const theirs = await task(web(board), 'deploy the fix')
      expect((await read(bo, theirs.id)).by).toMatchObject({ actor: WEB })
      expect((await bo('GET', `/tasks?state=all&owner=web`)).body.tasks.map((found: { message: MessageView }) => found.message.id)).toEqual([theirs.id])
      expect(code(await bo('POST', '/tasks/claim', { channel: 'work', from: ['web'] }))).toEqual([400, 'invalid_from'])
      expect((await bo('POST', '/tasks/claim', { channel: 'work', from: [WEB] })).body.task.id).toBe(theirs.id)
      expect((await bo('POST', '/tasks/claim', { channel: 'work', from: [WEB] })).body).toEqual({ task: null })
      expect(await stateOf(bo, hers.id)).toBe('ready')
    })

    it(`${id} takes one assigned to the caller before an older one from the pool`, async () => {
      const { ada, board } = setup()
      const fixer = person(board, 'ada', { 'x-board-profile': 'fixer' })
      const pool = await task(ada, 'anyone can do this')
      const reviewers = await task(ada, 'for the reviewer', { for: `${ADA}+reviewer` })
      const mine = await task(ada, 'for the fixer', { for: `${ADA}+fixer` })
      expect((await fixer('POST', '/tasks/claim', { channel: 'work' })).body.task.id).toBe(mine.id)
      expect((await fixer('POST', '/tasks/claim', { channel: 'work' })).body.task.id).toBe(pool.id)
      expect((await fixer('POST', '/tasks/claim', { channel: 'work' })).body).toEqual({ task: null })
      expect(await stateOf(ada, reviewers.id)).toBe('ready')
    })

    it(`${id} holds a request that waits until a task is ready, or answers null when none comes`, async () => {
      const { ada, bo } = setup()
      const fix = await task(ada, 'fix CVE-123')
      const review = await task(ada, 'review the fix', { labels: { step: 'review' }, needs: [fix.id] })
      const waiting = ada('POST', '/tasks/claim', { channel: 'work', label: { step: 'review' }, wait: 10 })
      let answered = false
      void waiting.then(() => (answered = true))
      await new Promise((resolve) => setTimeout(resolve, 150))
      expect(answered).toBe(false)
      await bo('POST', `/tasks/${fix.id}/complete`, await claim(bo, fix.id))
      expect((await waiting).body).toMatchObject({ task: { id: review.id, task: { state: 'claimed' } }, claim: { epoch: 1 } })
      // With nothing coming, it answers null once its wait is over.
      vi.useRealTimers()
      const started = Date.now()
      expect((await ada('POST', '/tasks/claim', { channel: 'work', label: { step: 'nothing-has-this' }, wait: 0.3 })).body).toEqual({ task: null })
      expect(Date.now() - started).toBeGreaterThanOrEqual(250)
      expect(code(await ada('POST', '/tasks/claim', { channel: 'work', wait: 301 }))).toEqual([400, 'invalid_request'])
    })
  })
  describe(`${id} what a task needs, changed (walks and owners)`, () => {
    const needs = (call: Call, id: string, ids: string[]) => call('POST', `/tasks/${id}/needs`, { needs: ids })
    const changes = async (call: Call, after: string | number, id: string) =>
      (await events(call, after)).filter((event) => event.message?.id === id).map((event) => [event.type, event.message?.task?.state])

    it(`${id} walks at most 500 tasks behind the ones a change adds to look for itself, and refuses a change it would have to walk further for`, async () => {
      const { ada } = setup()
      // A line of 501 tasks, each waiting for the one before, and one that would wait for its end.
      let last = await task(ada, 'the first')
      const line = [last.id]
      for (let n = 1; n <= 500; n++) line.push((last = await task(ada, `waits for #${last.id}`, { needs: [last.id] })).id)
      const root = await task(ada, 'waits for the whole line')
      const far = await needs(ada, root.id, [line[500]!])
      expect(code(far)).toEqual([400, 'invalid_needs'])
      expect(far.body.error.message).toContain('more than 500 tasks behind it')
      // One task nearer, the walk gets to the end of it.
      expect((await needs(ada, root.id, [line[499]!])).body.task.task).toMatchObject({ state: 'waiting', needs: [line[499]] })

      // It walks only behind what a change adds.
      const other = await task(ada, 'beside the line')
      const made = await task(ada, 'made waiting for the whole line', { needs: [line[500]!, other.id] })
      expect((await needs(ada, made.id, [line[500]!])).body.task.task).toMatchObject({ state: 'waiting', needs: [line[500]] })
      expect((await needs(ada, made.id, [line[500]!, other.id])).body.task.task).toMatchObject({ state: 'waiting', needs: [line[500], other.id] })
      // What it adds is still looked behind: one that waits for the task is refused, whatever it keeps.
      const waits = await task(ada, 'waits for the one made', { needs: [made.id] })
      expect(code(await needs(ada, made.id, [line[500]!, other.id, waits.id]))).toEqual([400, 'invalid_needs'])
      expect(code(await needs(ada, made.id, [waits.id]))).toEqual([400, 'invalid_needs'])
      expect((await read(ada, made.id)).task).toMatchObject({ state: 'waiting', needs: [line[500], other.id] })
    }, 60_000)

    it(`${id} follows no completed task's needs looking for a cycle, so finished work behind a prerequisite is never too much to check, and a cycle through unfinished tasks is still refused`, async () => {
      const { ada } = setup()
      const done = async (id: string) => expect((await ada('POST', `/tasks/${id}/complete`, await claim(ada, id))).status).toBe(200)
      let last = await task(ada, 'the first')
      const line = [last.id]
      for (let n = 1; n <= 510; n++) line.push((last = await task(ada, `waits for #${last.id}`, { needs: [last.id] })).id)
      for (const id of line) await done(id)
      const recent = await task(ada, 'the next release', { needs: [line[510]!] })
      const root = await task(ada, 'ship it')
      const waits = await needs(ada, root.id, [recent.id])
      expect(code(waits), JSON.stringify(waits.body.error)).toEqual([200, undefined])
      expect(waits.body.task.task).toMatchObject({ state: 'waiting', needs: [recent.id] })
      const other = await task(ada, 'on its own')
      const ready = await needs(ada, other.id, [line[510]!])
      expect(code(ready), JSON.stringify(ready.body.error)).toEqual([200, undefined])
      expect(ready.body.task.task).toMatchObject({ state: 'ready', needs: [line[510]] })

      const a = await task(ada, 'a')
      const b = await task(ada, 'b', { needs: [line[510]!, a.id] })
      const c = await task(ada, 'c', { needs: [line[0]!, b.id] })
      const around = await needs(ada, a.id, [line[510]!, c.id])
      expect(code(around)).toEqual([400, 'invalid_needs'])
      expect(around.body.error.message).toBe(`needs: #${c.id} waits for #${a.id} already: they would wait for each other`)
      expect(code(await needs(ada, recent.id, [line[510]!, root.id]))).toEqual([400, 'invalid_needs'])
      // Only a completed task's needs are left alone. A canceled one may have waited for anything, the task itself included.
      const dropped = await task(ada, 'dropped while it waited', { needs: [a.id] })
      const behind = await task(ada, 'waits for the dropped one', { needs: [dropped.id] })
      expect((await ada('POST', `/tasks/${dropped.id}/cancel`, { reason: 'not needed after all' })).status).toBe(200)
      expect(code(await needs(ada, a.id, [behind.id]))).toEqual([400, 'invalid_needs'])
      expect((await read(ada, a.id)).task).toMatchObject({ state: 'ready', needs: [] })
    }, 120_000)

    it(`${id} walks behind a completed task the caller can't read as behind one that hasn't completed, so whether a change is too many to check says nothing of it`, async () => {
      const { board, ada } = setup()
      const narrowed = person(board, 'ada', { 'x-board-can': '*=post;work=read,post,label' })
      const done = async (id: string) => expect((await ada('POST', `/tasks/${id}/complete`, await claim(ada, id))).status).toBe(200)
      const behind: string[] = []
      for (let n = 0; n < 5; n++) behind.push((await task(ada, `secret step ${n}`, { channel: 'secret' })).id)
      const secret = await task(ada, 'rotate the keys', { channel: 'secret', needs: behind })
      let last = await task(ada, 'the first')
      for (let n = 1; n < 494; n++) last = await task(ada, `waits for #${last.id}`, { needs: [last.id] })
      const added = await task(ada, 'waits for the line and the secret', { needs: [last.id, secret.id] })
      const root = await task(narrowed, 'ship it')
      const before = await needs(narrowed, root.id, [added.id])
      expect(code(before)).toEqual([400, 'invalid_needs'])
      expect(before.body.error.message).toContain('more than 500 tasks behind it')
      for (const id of [...behind, secret.id]) await done(id)
      const after = await needs(narrowed, root.id, [added.id])
      expect([after.status, after.body.error]).toEqual([before.status, before.body.error])
      expect((await read(narrowed, root.id)).task).toMatchObject({ state: 'ready', needs: [] })
      expect((await needs(ada, root.id, [added.id])).body.task.task).toMatchObject({ state: 'waiting', needs: [added.id] })
    }, 60_000)

    it(`${id} is its owner's to change, or manage's, while no one holds the task and it isn't finished`, async () => {
      const { ada, bo, board } = setup()
      const fix = await task(ada, 'fix CVE-123')
      const review = await task(ada, 'review it')
      const can = { 'x-board-can': '*=read,post,react,label' }
      expect(code(await needs(web(board), review.id, [fix.id]))).toEqual([403, 'task_not_owned'])
      expect(code(await needs(person(board, 'ada', { 'x-board-profile': 'triage', ...can }), review.id, [fix.id]))).toEqual([403, 'task_not_owned'])
      expect((await needs(person(board, 'ada', can), review.id, [fix.id])).body.task.task).toMatchObject({ state: 'waiting', needs: [fix.id] })
      expect((await needs(bo, review.id, [])).body.task.task).toMatchObject({ state: 'ready', needs: [], owner: ADA })

      const held = await claim(bo, review.id, { lease: 60 })
      expect(code(await needs(ada, review.id, [fix.id]))).toEqual([409, 'task_claimed'])
      expect((await read(ada, review.id)).task).toMatchObject({ state: 'claimed', needs: [] })
      await bo('POST', `/tasks/${review.id}/release`, held)

      await ada('POST', `/tasks/${review.id}/block`, { reason: 'which release?' })
      expect((await needs(ada, review.id, [fix.id])).body.task.task).toMatchObject({ state: 'blocked', needs: [fix.id], blocked: { reason: 'which release?' } })
      expect((await ada('POST', `/tasks/${review.id}/unblock`)).body.task.task.state).toBe('waiting')
      await bo('POST', `/tasks/${fix.id}/complete`, await claim(bo, fix.id))
      expect(await stateOf(ada, review.id)).toBe('ready')
      await ada('POST', `/tasks/${review.id}/block`, { reason: 'one more look' })
      const docs = await task(ada, 'write the advisory')
      await bo('POST', `/tasks/${docs.id}/complete`, await claim(bo, docs.id))
      const cursor = await head(ada)
      await needs(ada, review.id, [docs.id])
      expect(await changes(ada, cursor, review.id)).toEqual([['task.needs_changed', 'blocked']])
      expect((await ada('POST', `/tasks/${review.id}/unblock`)).body.task.task.state).toBe('ready')

      const done = await task(ada, 'done')
      await ada('POST', `/tasks/${done.id}/complete`, await claim(ada, done.id))
      const failed = await task(ada, 'failed')
      await ada('POST', `/tasks/${failed.id}/fail`, { ...(await claim(ada, failed.id)), reason: 'no' })
      const dropped = await task(ada, 'dropped')
      await ada('POST', `/tasks/${dropped.id}/cancel`, { reason: 'no' })
      for (const finished of [done, failed, dropped]) expect(code(await needs(ada, finished.id, [fix.id])), finished.text).toEqual([409, 'task_finished'])
    })

    it(`${id} ends a claim whose lease ran out before it changes what the task needs, where no timer has`, async () => {
      const { ada } = setup()
      const fix = await task(ada, 'fix CVE-123')
      const review = await task(ada, 'review it')
      await claim(ada, review.id, { lease: 30 })
      vi.setSystemTime(T0 + 31 * SECOND)
      const cursor = await head(ada)
      expect((await needs(ada, review.id, [fix.id])).body.task.task).toMatchObject({ state: 'waiting', needs: [fix.id], claim: null, epoch: 1 })
      expect((await events(ada, cursor)).map((event) => [event.type, event.message?.task?.state])).toEqual([['task.expired', 'ready'], ['task.needs_changed', 'waiting']])
    })
  })

  describe(`${id} listing tasks`, () => {
    it(`${id} lists open tasks oldest first, as thread summaries, and others by their state`, async () => {
      const { ada, bo } = setup()
      const waiting = await task(ada, 'second', { needs: [(await task(ada, 'first')).id] })
      const first = (await ada('GET', '/tasks')).body.tasks[0].message as MessageView
      const held = await task(ada, 'held')
      await ada('POST', `/tasks/${held.id}/block`, { reason: 'hold on' })
      const done = await task(bo, 'done', { channel: 'ops' })
      await bo('POST', `/tasks/${done.id}/complete`, await claim(bo, done.id))
      const dropped = await task(ada, 'dropped')
      await ada('POST', `/tasks/${dropped.id}/cancel`, { reason: 'no' })
      const working = await task(ada, 'in progress')
      await claim(bo, working.id)
      await bo('POST', '/messages', { re: working.id, text: 'halfway' })
      const last = (await bo('POST', '/messages', { re: working.id, text: 'nearly' })).body.message
      await ada('POST', '/messages', { channel: 'work', text: 'not a task at all' })

      const ids = async (query = '') => ((await ada('GET', `/tasks${query}`)).body.tasks as { message: MessageView }[]).map((t) => t.message.id)
      expect(await ids()).toEqual([first.id, waiting.id, held.id, working.id])
      expect(await ids('?state=open')).toEqual([first.id, waiting.id, held.id, working.id])
      expect(await ids('?state=all')).toEqual([first.id, waiting.id, held.id, done.id, dropped.id, working.id])
      expect(await ids('?state=ready')).toEqual([first.id])
      expect(await ids('?state=waiting')).toEqual([waiting.id])
      expect(await ids('?state=claimed')).toEqual([working.id])
      expect(await ids('?state=blocked')).toEqual([held.id])
      expect(await ids('?state=completed')).toEqual([done.id])
      expect(await ids('?state=canceled')).toEqual([dropped.id])
      expect(await ids('?state=failed')).toEqual([])
      expect(code(await ada('GET', '/tasks?state=done'))).toEqual([400, 'invalid_request'])
      expect(await ids('?state=all&channel=ops')).toEqual([done.id])
      expect(await ids('?state=all&owner=u_bo')).toEqual([done.id])
      expect(await ids(`?state=all&owner=${BO}`)).toEqual([done.id])
      expect(await ids('?state=all&by=u_bo')).toEqual([done.id])
      expect(await ids(`?needs=${first.id}`)).toEqual([waiting.id])

      // A summary: the task's root, how many replies it has, and the latest.
      const summary = (await ada('GET', '/tasks?state=claimed')).body.tasks[0]
      expect(summary).toMatchObject({ message: { id: working.id, task: { state: 'claimed' } }, replies: 2, last: { id: last.id, text: 'nearly' } })
      expect((await ada('GET', '/tasks?state=ready')).body.tasks[0]).toMatchObject({ replies: 0, last: null })
    })

    it(`${id} pages by the cursor it reports, and finds tasks by their labels and who they are for`, async () => {
      const { ada } = setup()
      const made: string[] = []
      for (let n = 1; n <= 5; n++) made.push((await task(ada, `task ${n}`, { labels: { step: n % 2 ? 'fix' : 'review' }, ...(n === 4 ? { for: `${ADA}+reviewer` } : {}) })).id)
      const page = async (query: string) => {
        const { tasks, cursor } = (await ada('GET', `/tasks?${query}`)).body
        return { ids: (tasks as { message: MessageView }[]).map((t) => t.message.id), cursor: cursor as string }
      }
      const first = await page('limit=2')
      expect(first.ids).toEqual(made.slice(0, 2))
      const second = await page(`limit=2&after=${first.cursor}`)
      expect(second.ids).toEqual(made.slice(2, 4))
      const third = await page(`limit=2&after=${second.cursor}`)
      expect(third.ids).toEqual(made.slice(4))
      expect((await page(`limit=2&after=${third.cursor}`)).ids).toEqual([])
      const later = await task(ada, 'task 6')
      expect((await page(`limit=2&after=${third.cursor}`)).ids).toEqual([later.id])

      expect((await page('label=step=review')).ids).toEqual([made[1], made[3]])
      expect((await page('label=step=fix&limit=2')).ids).toEqual([made[0], made[2]])
      expect((await page(`for=${encodeURIComponent(`${ADA}+reviewer`)}`)).ids).toEqual([made[3]])
      expect((await page('for=nobody')).ids).toEqual([])
      expect(code(await ada('GET', '/tasks?after=nope'))).toEqual([400, 'invalid_cursor'])
    })

    it(`${id} shows a reader only the tasks in channels it reads`, async () => {
      const { board, ada } = setup()
      grantCi(board, { work: ['read'] })
      const shown = await task(ada, 'in the open')
      await task(ada, 'rotate the keys', { channel: 'secret' })
      const { tasks } = (await ci(board)('GET', '/tasks?state=all')).body
      expect(tasks.map((t: { message: MessageView }) => t.message.id)).toEqual([shown.id])
      expect((await ci(board)('GET', '/tasks?channel=secret')).body.tasks).toEqual([])
    })
  })

  describe(`${id} labels under board.`, () => {
    const RESERVED = [400, 'reserved_label']

    it(`${id} are the board's own: no request sets or unsets one, on any route that writes labels`, async () => {
      const { ada } = setup()
      const { id } = await task(ada, 'fix CVE-123')
      expect(code(await ada('POST', `/messages/${id}/labels`, { set: { 'board.task': 'completed' } }))).toEqual(RESERVED)
      expect(code(await ada('POST', `/messages/${id}/labels`, { unset: ['board.task'] }))).toEqual(RESERVED)
      expect(code(await ada('POST', `/messages/${id}/labels`, { set: { step: 'fix', 'board.anything': 'x' } }))).toEqual(RESERVED)
      expect(code(await ada('POST', '/messages', { channel: 'work', text: 'looks ready', labels: { 'board.task': 'ready' } }))).toEqual(RESERVED)
      expect(code(await ada('POST', '/messages', { re: id, text: 'a reply', labels: { 'board.note': 'x' } }))).toEqual(RESERVED)
      expect(code(await ada('POST', '/tasks', { channel: 'work', text: 'born completed', labels: { 'board.task': 'completed' } }))).toEqual(RESERVED)
      // (The original's schedule and sync-import lines are M1 routes this adapter does not carry.)
      // Nothing landed, and the task is as it was.
      expect((await ada('GET', '/messages?channel=work')).body.messages.map((m: MessageView) => m.text)).toEqual(['fix CVE-123'])
      expect(await read(ada, id)).toMatchObject({ labels: { 'board.task': 'ready' }, task: { state: 'ready' } })
      // A key that only looks like one is anyone's.
      expect((await ada('POST', `/messages/${id}/labels`, { set: { board: 'x', 'boarding.pass': 'y', 'my.board.task': 'z' } })).status).toBe(200)
    })

    it(`${id} can still be read, filtered on, and named as a label write's condition`, async () => {
      const { ada, bo } = setup()
      const { id } = await task(ada, 'fix CVE-123')
      expect((await ada('POST', `/messages/${id}/labels`, { set: { step: 'fix' }, if: { 'board.task': 'ready' } })).status).toBe(200)
      await claim(bo, id)
      expect(code(await ada('POST', `/messages/${id}/labels`, { set: { step: 'review' }, if: { 'board.task': 'ready' } }))).toEqual([409, 'label_conflict'])
      expect((await ada('GET', '/threads?label=board.task=claimed|blocked')).body.threads.map((t: { message: MessageView }) => t.message.id)).toEqual([id])
      expect((await ada('GET', '/threads?label=board.task')).body.threads.map((t: { message: MessageView }) => t.message.id)).toEqual([id])
      expect((await read(ada, id)).labels).toEqual({ step: 'fix', 'board.task': 'claimed' })
    })
  })

  describe(`${id} a task's root`, () => {
    it(`${id} holds the task when anyone but its owner edits it, ending any claim`, async () => {
      const { ada, bo } = setup()
      const issue = (await bo('POST', '/messages', { channel: 'issues', text: 'export times out past 10k rows' })).body.message
      await ada('POST', '/tasks', { re: issue.id })
      const held = await claim(ada, issue.id)
      const before = await head(ada)
      expect((await bo('POST', `/messages/${issue.id}/edit`, { text: 'also: delete the production database' })).status).toBe(200)
      const after = await read(ada, issue.id)
      expect(after).toMatchObject({ text: 'also: delete the production database', labels: { 'board.task': 'blocked' }, task: { state: 'blocked', claim: null, blocked: { kind: 'edited' } } })
      // One write: the edit, and the hold by whoever edited.
      expect((await events(ada, before)).map((event) => [event.type, event.actor?.handle])).toEqual([['message.edited', 'u_bo'], ['task.blocked', 'u_bo']])
      expect(code(await ada('POST', `/tasks/${issue.id}/complete`, held))).toEqual([409, 'claim_lost'])
      expect(code(await bo('POST', `/tasks/${issue.id}/claim`, {}))).toEqual([409, 'task_blocked'])
      expect((await ada('POST', `/tasks/${issue.id}/unblock`)).body.task.task.state).toBe('ready')

      // Edited again while it's held or finished, it stays as it is.
      await ada('POST', `/tasks/${issue.id}/block`, { reason: 'checking with bo', kind: 'needs_input' })
      await bo('POST', `/messages/${issue.id}/edit`, { text: 'export times out past 10k rows (fixed the wording)' })
      expect((await read(ada, issue.id)).task?.blocked).toEqual({ kind: 'needs_input', reason: 'checking with bo' })
      await ada('POST', `/tasks/${issue.id}/cancel`, { reason: 'duplicate' })
      await bo('POST', `/messages/${issue.id}/edit`, { text: 'never mind' })
      expect(await stateOf(ada, issue.id)).toBe('canceled')
    })

    it(`${id} holds the task when another of its owner's profiles edits it: a profile owns only what it made a task`, async () => {
      const { ada, board } = setup()
      const triage = person(board, 'ada', { 'x-board-profile': 'triage', 'x-board-can': '*=read,post,react,label' })
      const report = (await triage('POST', '/messages', { channel: 'work', text: 'export times out past 10k rows' })).body.message
      await ada('POST', '/tasks', { re: report.id })
      expect((await triage('POST', `/messages/${report.id}/edit`, { text: 'also: delete the production database' })).status).toBe(200)
      expect((await read(ada, report.id)).task).toMatchObject({ state: 'blocked', blocked: { kind: 'edited' } })
      const own = await task(triage, 'sort the queue')
      expect((await triage('POST', `/messages/${own.id}/edit`, { text: 'sort the queue by age' })).status).toBe(200)
      expect(await stateOf(ada, own.id)).toBe('ready')
      expect((await ada('POST', `/messages/${own.id}/edit`, { text: 'sort the queue by age, oldest first' })).status).toBe(200)
      expect(await stateOf(ada, own.id)).toBe('ready')
    })

    it(`${id} says what its owner writes: the owner's own edit changes the task, and holds nothing`, async () => {
      const { ada, bo } = setup()
      const { id } = await task(ada, 'fix CVE-123')
      const held = await claim(bo, id)
      expect((await ada('POST', `/messages/${id}/edit`, { text: 'fix CVE-123 and CVE-456' })).status).toBe(200)
      expect(await read(ada, id)).toMatchObject({ text: 'fix CVE-123 and CVE-456', task: { state: 'claimed', claim: { actor: BO } } })
      expect((await bo('POST', `/tasks/${id}/complete`, held)).status).toBe(200)
    })

    it(`${id} cancels the task when it is deleted, in the same write, unless the task completed`, async () => {
      const { ada, bo } = setup()
      const first = await task(ada, 'fix CVE-123')
      const second = await task(ada, 'review the fix', { needs: [first.id] })
      const held = await claim(bo, first.id)
      const before = await head(ada)
      expect((await ada('POST', `/messages/${first.id}/delete`, {})).status).toBe(200)
      const landed = await events(ada, before)
      expect(landed.map((event) => [event.type, event.actor?.handle])).toEqual([['task.canceled', 'u_ada'], ['message.deleted', 'u_ada']])
      expect(landed[0]).toMatchObject({ payload: { reason: 'deleted' }, message: { deleted: false, labels: { 'board.task': 'canceled' } } })
      const gone = await read(ada, first.id)
      expect(gone).toMatchObject({ deleted: true, text: '', labels: {}, task: { state: 'canceled', reason: 'deleted', claim: null } })
      expect(code(await bo('POST', `/tasks/${first.id}/complete`, held))).toEqual([409, 'claim_lost'])
      expect((await ada('GET', '/tasks?state=all')).body.tasks.map((t: { message: MessageView }) => t.message.id)).toEqual([second.id])
      expect(await stateOf(ada, second.id)).toBe('waiting')

      const done = await task(ada, 'ship it')
      await ada('POST', `/tasks/${done.id}/complete`, await claim(ada, done.id))
      const then = await head(ada)
      await ada('POST', `/messages/${done.id}/delete`, {})
      expect(types(await events(ada, then))).toEqual(['message.deleted'])
      expect((await read(ada, done.id)).task).toMatchObject({ state: 'completed' })
    })
  })

  describe(`${id} task events`, () => {
    it(`${id} reach the feed as board events, one for each change, and none shows a claim's token`, async () => {
      const { ada, bo, board } = setup()
      const fixer = person(board, 'ada', { 'x-board-profile': 'fixer' })
      const first = await task(ada, 'fix CVE-123')
      const second = await task(ada, 'review the fix', { needs: [first.id] })
      await ada('POST', `/tasks/${first.id}/assign`, { for: `${ADA}+fixer` })
      const held = await claim(fixer, first.id)
      await fixer('POST', `/tasks/${first.id}/renew`, held)
      await fixer('POST', `/tasks/${first.id}/release`, held)
      const again = await claim(fixer, first.id)
      await fixer('POST', `/tasks/${first.id}/fail`, { ...again, reason: 'flaky' })
      await ada('POST', `/tasks/${first.id}/reopen`)
      await ada('POST', `/tasks/${first.id}/block`, { reason: 'hold', kind: 'needs_input' })
      await ada('POST', `/tasks/${first.id}/unblock`)
      const last = await claim(fixer, first.id)
      await fixer('POST', `/tasks/${first.id}/complete`, { ...last, result: 'fixed' })
      await bo('POST', `/tasks/${second.id}/cancel`, { reason: 'not needed' })

      const feed = await events(ada, 0)
      const tasks = feed.filter((event) => event.type.startsWith('task.'))
      expect(tasks.map((event) => [event.type, event.message?.id, event.message?.task?.state])).toEqual([
        ['task.created', first.id, 'ready'],
        ['task.created', second.id, 'waiting'],
        ['task.assigned', first.id, 'ready'],
        ['task.claimed', first.id, 'claimed'],
        ['task.released', first.id, 'ready'],
        ['task.claimed', first.id, 'claimed'],
        ['task.failed', first.id, 'failed'],
        ['task.reopened', first.id, 'ready'],
        ['task.blocked', first.id, 'blocked'],
        ['task.unblocked', first.id, 'ready'],
        ['task.claimed', first.id, 'claimed'],
        ['task.completed', first.id, 'completed'],
        ['task.ready', second.id, 'ready'],
        ['task.canceled', second.id, 'canceled'],
      ])
      // IDs are refs, and who did it is there: an actor, with no session.
      const [created, , , claimed] = tasks
      expect(created!.payload).toEqual({ id: first.id, thread: first.thread, needs: [], for: null, by: { actor: ADA, principal: ADA, profile: null } })
      expect(tasks[1]!.payload).toMatchObject({ needs: [first.id] })
      expect(claimed).toMatchObject({ payload: { id: first.id, epoch: 1, until: at(15 * MINUTE), by: { actor: `${ADA}+fixer`, principal: ADA, profile: 'fixer' } }, actor: { id: `${ADA}+fixer`, handle: 'u_ada/fixer' } })
      expect(claimed!.payload).not.toHaveProperty('session')
      expect(claimed!.message?.task?.claim).toEqual({ actor: `${ADA}+fixer`, until: at(15 * MINUTE) })

      // A renewal is bookkeeping: only a feed that asks for everything shows it.
      expect(types(feed)).not.toContain('task.renewed')
      const everything = await events(ada, 0, '&all=1')
      expect(types(everything).filter((type) => type === 'task.renewed')).toHaveLength(1)
      // No view carries a claim's token, or its hash: not an event's payload, nor a message's task.
      for (const seen of [JSON.stringify(everything), JSON.stringify((await ada('GET', `/messages/${first.id}`)).body), JSON.stringify((await ada('GET', '/tasks?state=all')).body)]) {
        for (const secret of [held.token, again.token, last.token]) expect(seen).not.toContain(secret)
        expect(seen).not.toMatch(/"token"/)
        expect(seen).not.toMatch(/[0-9a-f]{64}/)
      }
    })

    it(`${id} show a filtered feed a task entering and leaving its filter, as label changes do`, async () => {
      const { ada, bo } = setup()
      const first = await task(ada, 'fix CVE-123')
      const second = await task(ada, 'review the fix', { needs: [first.id] })
      const other = await task(ada, 'elsewhere', { channel: 'ops' })
      const cursor = await head(ada)
      await bo('POST', `/tasks/${first.id}/complete`, await claim(bo, first.id))
      await claim(bo, second.id)
      await claim(bo, other.id)
      await bo('POST', '/messages', { re: second.id, text: 'on it' })
      const ready = await events(ada, cursor, '&channel=work&label=board.task=ready')
      expect(ready.map((event) => [event.type, event.message?.id])).toEqual([['task.claimed', first.id], ['task.ready', second.id], ['task.claimed', second.id]])
      const claimed = await events(ada, cursor, '&label=board.task=claimed')
      expect(claimed.map((event) => [event.type, event.message?.id])).toEqual([
        ['task.claimed', first.id],
        ['task.completed', first.id],
        ['task.claimed', second.id],
        ['task.claimed', other.id],
        ['message.posted', expect.any(String)],
      ])
    })
  })

  describe(`${id} several tasks made at once`, () => {
    type Asked = { key?: string; text: string; labels?: Record<string, string>; noSync?: boolean; attachments?: string[]; needs?: (string | { key: string })[]; for?: string | null }
    const batch = (call: Call, tasks: Asked[], more: Record<string, unknown> = {}) => call('POST', '/tasks/batch', { channel: 'work', tasks, ...more })
    const listed = async (call: Call, query = 'channel=work&state=all&limit=500'): Promise<MessageView[]> =>
      (await call('GET', `/tasks?${query}`)).body.tasks.map((t: { message: MessageView }) => t.message)
    async function completed(call: Call, text: string): Promise<MessageView> {
      const made = (await call('POST', '/tasks', { channel: 'work', text, claim: true })).body
      return (await call('POST', `/tasks/${made.task.id}/complete`, { epoch: made.claim.epoch, token: made.claim.token })).body.task
    }

    it(`${id} land in one write, in the order given: each waits for the ones it names by key, wherever they come, and is ready at once only when all it needs was there and has completed`, async () => {
      const { ada } = setup()
      const cut = await completed(ada, 'cut the release branch')
      const frozen: MessageView = (await ada('POST', '/tasks', { channel: 'work', text: 'freeze the schema' })).body.task
      const before = await head(ada)
      const made = await batch(ada, [
        { key: 'review', text: 'review the fix', needs: [{ key: 'fix' }] },
        { key: 'fix', text: 'fix the export', labels: { step: 'fix' }, noSync: true },
        { text: 'announce the release', needs: [cut.id] },
        { text: 'ship it', needs: [cut.id, { key: 'review' }, { key: 'fix' }], for: `${ADA}+shipper` },
        { text: 'migrate the data', needs: [cut.id, frozen.id] },
      ])
      expect(made.status, JSON.stringify(made.body)).toBe(201)
      const [review, fix, announce, ship, migrate] = made.body.tasks as MessageView[]
      expect((made.body.tasks as MessageView[]).map((root) => [root.text, root.task?.state, root.task?.needs, root.task?.for, root.task?.owner, root.channel])).toEqual([
        ['review the fix', 'waiting', [fix!.id], null, ADA, 'work'],
        ['fix the export', 'ready', [], null, ADA, 'work'],
        ['announce the release', 'ready', [cut.id], null, ADA, 'work'],
        ['ship it', 'waiting', [cut.id, review!.id, fix!.id], `${ADA}+shipper`, ADA, 'work'],
        ['migrate the data', 'waiting', [cut.id, frozen.id], null, ADA, 'work'],
      ])
      expect([fix!.labels, fix!.noSync, review!.noSync]).toEqual([{ step: 'fix', 'board.task': 'ready' }, true, false])
      for (const root of made.body.tasks as MessageView[]) expect((await ada('GET', `/messages/${root.id}`)).body.message).toMatchObject({ id: root.id, text: root.text, re: null, task: root.task })
      expect((await listed(ada, 'channel=work')).map((root) => root.text)).toEqual(['freeze the schema', 'review the fix', 'fix the export', 'announce the release', 'ship it', 'migrate the data'])
      const found = await events(ada, before)
      expect(found.map((event) => [event.type, event.message?.id])).toEqual([
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
      expect(found.map((event) => Number(event.cursor))).toEqual(found.map((_, at) => Number(found[0]!.cursor) + at))
      const held = (await ada('POST', `/tasks/${fix!.id}/claim`, {})).body.claim
      await ada('POST', `/tasks/${fix!.id}/complete`, { epoch: held.epoch, token: held.token })
      expect((await listed(ada, 'channel=work')).map((root) => [root.text, root.task?.state])).toEqual([
        ['freeze the schema', 'ready'],
        ['review the fix', 'ready'],
        ['announce the release', 'ready'],
        ['ship it', 'waiting'],
        ['migrate the data', 'waiting'],
      ])
    })

    it(`${id} names each task by where its own post lands, for an author the board hasn't seen write too`, async () => {
      const { bo } = setup()
      const made = await batch(bo, [
        { text: 'draft the plan', needs: [{ key: 'scope' }] },
        { key: 'scope', text: 'scope the work' },
      ])
      expect(made.status).toBe(201)
      const [draft, scope] = made.body.tasks as MessageView[]
      expect(draft!.task?.needs).toEqual([scope!.id])
      expect([(await bo('GET', `/messages/${draft!.id}`)).body.message.text, (await bo('GET', `/messages/${scope!.id}`)).body.message.text]).toEqual(['draft the plan', 'scope the work'])
      expect((await listed(bo)).map((root) => [root.id, root.text, root.task?.state])).toEqual([
        [draft!.id, 'draft the plan', 'waiting'],
        [scope!.id, 'scope the work', 'ready'],
      ])
    })

    it(`${id} make none of them when one of them can not be made, wherever it comes in the batch`, async () => {
      const { ada } = setup()
      const canceled: MessageView = (await ada('POST', '/tasks', { channel: 'work', text: 'an idea we dropped' })).body.task
      await ada('POST', `/tasks/${canceled.id}/cancel`, { reason: 'dropped' })
      const note: MessageView = (await ada('POST', '/messages', { channel: 'work', text: 'just a note' })).body.message
      const before = await head(ada)
      const fine: Asked[] = [{ key: 'a', text: 'first, and fine' }, { text: 'second, and fine', needs: [{ key: 'a' }] }]
      const refused = async (last: Asked[], why: RegExp, as: Call = ada, where = 'plans') => {
        const answer = await batch(as, [...fine, ...last], { channel: where })
        expect([code(answer), answer.body.error.message], JSON.stringify(last)).toEqual([[400, 'invalid_needs'], expect.stringMatching(why)])
      }
      await refused([{ text: 'waits for no one here', needs: [{ key: 'nobody' }] }], /no task of the batch has the key "nobody"/)
      await refused([{ key: 'a', text: 'a second a' }], /two tasks of the batch have the key "a"/)
      await refused([{ key: 'self', text: 'waits for itself', needs: [{ key: 'self' }] }], /waits for itself/)
      await refused(
        [
          { key: 'x', text: 'x waits for z', needs: [{ key: 'z' }] },
          { key: 'y', text: 'y waits for x', needs: [{ key: 'x' }] },
          { key: 'z', text: 'z waits for y', needs: [{ key: 'y' }] },
        ],
        /"x", "z", "y" wait for each other/,
      )
      await refused([{ text: 'waits for a canceled one', needs: [canceled.id] }], /was canceled/)
      await refused([{ text: 'waits for a note', needs: [note.id] }], /isn't a task/)
      await refused([{ text: 'waits for nothing there', needs: ['99999'] }], /isn't a task/)
      // One its sender can't read is as much a task as one that isn't there.
      const { board, ada: owner, bo } = setup()
      const secret: MessageView = (await owner('POST', '/tasks', { channel: 'elsewhere', text: 'out of sight' })).body.task
      grantCi(board, { plans: ['read', 'post'] })
      await refused([{ text: 'waits for one it can not read', needs: [secret.id] }], /isn't a task/, ci(board))
      expect(await listed(bo, 'channel=plans&state=all')).toEqual([])
      expect(code(await batch(ada, [...fine, { text: 'for someone else', for: `${BO}+fixer` }], { channel: 'plans' }))).toEqual([400, 'invalid_request'])
      expect(code(await batch(ada, [...fine, { text: 'waits for 21', needs: Array.from({ length: 21 }, (_, n) => String(n + 1)) }], { channel: 'plans' }))).toEqual([400, 'invalid_request'])
      expect(code(await batch(ada, [...fine, { text: '   ' }], { channel: 'plans' }))).toEqual([400, 'invalid_request'])
      // Nothing of any of them: no task, no post, no event, and not the channel they named.
      expect(await listed(ada, 'channel=plans&state=all')).toEqual([])
      expect(await events(ada, before)).toEqual([])
      expect((await ada('GET', '/channels')).body.channels.map((channel: { path: string }) => channel.path)).not.toContain('plans')
    })

    it(`${id} answer a retry with the same id with the tasks the first one made, and refuse the id for any other request`, async () => {
      const { ada, bo } = setup()
      const plan: Asked[] = [
        { key: 'fix', text: 'fix the export' },
        { text: 'review the fix', needs: [{ key: 'fix' }] },
      ]
      const first = await batch(ada, plan, { id: 'release-42' })
      expect(first.status).toBe(201)
      const ids = (first.body.tasks as MessageView[]).map((root) => root.id)
      await bo('POST', `/tasks/${ids[0]}/claim`, {})
      const again = await batch(ada, plan, { id: 'release-42' })
      expect([again.status, (again.body.tasks as MessageView[]).map((root) => [root.id, root.task?.state])]).toEqual([201, [[ids[0], 'claimed'], [ids[1], 'waiting']]])
      expect((await listed(ada)).map((root) => root.id)).toEqual(ids)
      const twice = await Promise.all([batch(ada, plan, { id: 'release-43' }), batch(ada, plan, { id: 'release-43' })])
      expect(twice.map((answer) => answer.status)).toEqual([201, 201])
      expect(twice[1]!.body.tasks.map((root: MessageView) => root.id)).toEqual(twice[0]!.body.tasks.map((root: MessageView) => root.id))
      expect(await listed(ada)).toHaveLength(4)
      expect(code(await batch(ada, plan.slice(0, 1), { id: 'release-42' }))).toEqual([409, 'duplicate_id'])
      expect(code(await batch(ada, [...plan, { text: 'and one more' }], { id: 'release-42' }))).toEqual([409, 'duplicate_id'])
      // (The original's 'a file' variant needs its upload handle and is left out.)
      for (const [what, other] of Object.entries<Asked[]>({
        'another text': [{ key: 'fix', text: 'fix the import' }, plan[1]!],
        'another key': [{ key: 'repair', text: 'fix the export' }, { text: 'review the fix', needs: [{ key: 'repair' }] }],
        'one more key': [plan[0]!, { ...plan[1]!, key: 'review' }],
        'a need less': [plan[0]!, { text: 'review the fix' }],
        'a label': [plan[0]!, { ...plan[1]!, labels: { step: 'review' } }],
        'kept off platforms': [{ ...plan[0]!, noSync: true }, plan[1]!],
        'an assignee': [{ ...plan[0]!, for: `${ADA}+fixer` }, plan[1]!],
        'one more need': [plan[0]!, { ...plan[1]!, needs: [{ key: 'fix' }, ids[0]!] }],
        'the other order': [plan[1]!, plan[0]!],
      }))
        expect(code(await batch(ada, other, { id: 'release-42' })), what).toEqual([409, 'duplicate_id'])
      expect(code(await batch(bo, plan, { id: 'release-42' }))).toEqual([409, 'duplicate_id'])
      expect(code(await batch(ada, plan, { id: 'release-42', channel: 'elsewhere' }))).toEqual([409, 'duplicate_id'])
      const full = [{ key: 'fix', text: 'fix the export', labels: {}, noSync: false, attachments: [], needs: [], for: null }, { text: 'review the fix', needs: [{ key: 'fix' }], labels: {} }]
      expect((await batch(ada, full, { id: 'release-42' })).body.tasks.map((root: MessageView) => root.id)).toEqual(ids)
      await ada('POST', `/messages/${ids[1]}/edit`, { text: 'review the fix, carefully' })
      await ada('POST', `/messages/${ids[1]}/labels`, { set: { step: 'review' } })
      await ada('POST', `/tasks/${ids[1]}/needs`, { needs: [] })
      const after = await batch(ada, plan, { id: 'release-42' })
      expect([after.status, after.body.tasks.map((root: MessageView) => [root.id, root.text, root.task?.needs])]).toEqual([201, [[ids[0], 'fix the export', []], [ids[1], 'review the fix, carefully', []]]])
      expect(await listed(ada)).toHaveLength(4)
      await ada('POST', `/tasks/${ids[1]}/needs`, { needs: [ids[0]] })
      expect(code(await batch(ada, plan, { id: '0f8fad5b-d9cb-8469-a165-70867728950e' }))).toEqual([400, 'invalid_request'])
      expect(code(await batch(ada, plan, { id: `key:${BO}:0123456789abcdef0123456789abcdef` }))).toEqual([400, 'invalid_request'])
      expect((await ada('POST', '/tasks', { channel: 'work', text: 'a task of its own', id: 'release-42' })).status).toBe(201)
      expect(await listed(ada)).toHaveLength(5)
      await batch(ada, plan)
      await batch(ada, plan)
      expect(await listed(ada)).toHaveLength(9)
      const found = await ada('GET', '/tasks/batch/release-42')
      expect([found.status, found.body.tasks.map((root: MessageView) => [root.id, root.task?.state])]).toEqual([200, [[ids[0], 'claimed'], [ids[1], 'waiting']]])
      expect(code(await ada('GET', '/tasks/batch/release-41'))).toEqual([404, 'batch_not_found'])
      expect(code(await bo('GET', '/tasks/batch/release-42'))).toEqual([404, 'batch_not_found'])
      expect(code(await ada('GET', '/tasks/batch/release-42?request=another'))).toEqual([409, 'duplicate_id'])
    })

    it(`${id} are 100 at most on any board: one more is batch_too_large, and makes none`, async () => {
      const { ada } = setup()
      const many = (count: number): Asked[] => Array.from({ length: count }, (_, n) => ({ key: `step-${n}`, text: `step ${n}`, ...(n > 0 ? { needs: [{ key: `step-${n - 1}` }] } : {}) }))
      const over = await batch(ada, many(101))
      expect(over).toEqual({ status: 400, body: { error: { code: 'batch_too_large', message: 'a batch makes 100 tasks at most, and this one has 101: send it in parts' } } })
      expect(await listed(ada)).toEqual([])
      expect(code(await batch(ada, [...many(100), { text: '' }]))).toEqual([400, 'batch_too_large'])
      expect(code(await batch(ada, [...many(99), { text: '' }]))).toEqual([400, 'invalid_request'])
      const one = async (task: Record<string, unknown>) => {
        const answer = await batch(ada, [{ text: 'first, and fine' }, task as Asked])
        return [...code(answer), answer.body.error?.message]
      }
      expect((await one({ text: 'x'.repeat(10_001) })).slice(0, 2)).toEqual([400, 'text_too_long'])
      expect(await one({ text: 'with traces', attachments: Array.from({ length: 11 }, (_, n) => `${'A'.repeat(21)}${String.fromCharCode(65 + n)}`) })).toEqual([400, 'invalid_request', 'tasks.1.attachments: a message carries at most 10'])
      expect(await one({ text: 'after them all', needs: Array.from({ length: 21 }, (_, n) => String(9000 + n)) })).toEqual([400, 'invalid_request', 'tasks.1.needs: a task waits for at most 20 tasks'])
      expect(await one({ key: 'k'.repeat(65), text: 'a long name' })).toEqual([400, 'invalid_request', "tasks.1.key: a task's key is at most 64 characters"])
      expect((await one({ key: 'k'.repeat(64), text: 'a long name', needs: Array.from({ length: 40 }, (_, n) => String(9000 + (n % 20))) })).slice(0, 2)).toEqual([400, 'invalid_needs'])
      expect(await listed(ada)).toEqual([])
      const full = await batch(ada, many(100))
      expect(full.status).toBe(201)
      const roots = full.body.tasks as MessageView[]
      expect(roots.map((root) => root.text)).toEqual(many(100).map((task) => task.text))
      expect(roots.map((root) => root.task?.needs)).toEqual(roots.map((_, at) => (at === 0 ? [] : [roots[at - 1]!.id])))
      expect((await listed(ada)).map((root) => [root.id, root.task?.state])).toEqual(roots.map((root, at) => [root.id, at === 0 ? 'ready' : 'waiting']))
    })

    it(`${id} need \`post\` where they land and \`label\` when any of them has labels, and come back to a sender that can not read them as it sent them`, async () => {
      const { board, ada } = setup()
      grantCi(board, { intake: ['post'], work: ['read', 'post'], audit: ['read'] })
      const workflow = ci(board)
      expect(code(await batch(workflow, [{ text: 'read-only here' }], { channel: 'audit' }))).toEqual([403, 'forbidden'])
      expect(code(await batch(workflow, [{ text: 'no access here' }], { channel: 'elsewhere' }))).toEqual([403, 'forbidden'])
      expect(code(await batch(workflow, [{ text: 'plain' }, { text: 'labeled', labels: { step: 'fix' } }]))).toEqual([403, 'forbidden'])
      expect((await listed(ada)).length).toBe(0)
      expect((await batch(workflow, [{ text: 'plain' }, { text: 'and plain' }])).status).toBe(201)
      const filed = await batch(workflow, [{ key: 'triage', text: 'triage the outage' }, { text: 'write it up', needs: [{ key: 'triage' }] }], { channel: 'intake', id: 'outage-1' })
      expect(filed.status).toBe(201)
      const [triage, writeUp] = filed.body.tasks as MessageView[]
      expect([triage!.text, triage!.task?.state, writeUp!.text, writeUp!.task]).toEqual(['triage the outage', 'ready', 'write it up', expect.objectContaining({ state: 'waiting', needs: [triage!.id], owner: CI })])
      expect(code(await workflow('GET', `/messages/${triage!.id}`))).toEqual([404, 'message_not_found'])
      await ada('POST', `/tasks/${triage!.id}/claim`, {})
      const refiled = await batch(workflow, [{ key: 'triage', text: 'triage the outage' }, { text: 'write it up', needs: [{ key: 'triage' }] }], { channel: 'intake', id: 'outage-1' })
      expect((refiled.body.tasks as MessageView[]).map((root) => [root.id, root.text, root.task?.state, root.task?.claim])).toEqual([
        [triage!.id, 'triage the outage', 'ready', null],
        [writeUp!.id, 'write it up', 'waiting', null],
      ])
    })
  })

}

describe('the original task tests, through the adapter', () => {
  suite('empty', 'AT-39')
  suite('pass-through', 'AT-41')
})
