import { afterEach, expect, it } from 'vitest'
import { createBoardClient } from '../../src/client/client.ts'
import { getBoardInsights } from '../../src/client/insights.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'
import { ada, openTestBoard, providerFor } from '../conformance/fixtures.ts'

const cleanup: (() => void)[] = []
afterEach(() => { while (cleanup.length) cleanup.pop()!() })

function fixture(now?: () => number) {
  const { board, close } = openTestBoard(':memory:', { now })
  cleanup.push(close)
  const make = (identity: ReturnType<typeof ada>) => createBoardClient(new InProcessTransport({ board, identity }),
    { selection: { mode: 'in-process', reason: 'test', source: 'option:service' } })
  return { member: make(ada()), restricted: make(providerFor({ userId: 'viewer', can: 'public=read' })) }
}

it('groups tasks by phase, counts a lapsed claim as ready, and matches run labels literally', async () => {
  const { member } = fixture(() => Date.now() - 3_600_000)
  const run = "a|b's"
  await member.tasks.create('work', { text: 'do it', labels: { run, phase: 'Build' }, claim: true, lease: 60 })
  await member.tasks.create('work', { text: 'also do it', labels: { run } })
  await member.tasks.create('work', { text: 'other', labels: { run: 'a' } })
  const report = await getBoardInsights(member, { channel: 'work', view: 'progress', run })
  expect(report.rows).toMatchObject([{ phase: 'Build', ready: 1, claimed: 0, total: 1 },
    { phase: 'Unassigned phase', ready: 1, total: 1 }])
  expect(report.coverage).toMatchObject({ truncated: false, rowsTruncated: false })
})

it('counts only live agent posts, attributes replies to their run and honors channel read grants', async () => {
  const { member, restricted } = fixture()
  const root = await member.as('w1').post('work', { text: 'question', labels: { run: 'green' } })
  await member.as('w2').reply(root.id, 'answer')
  await member.reply(root.id, 'human')
  await member.as('w1').post('work', 'off run')
  const removed = await member.as('w2').reply(root.id, 'withdrawn')
  await member.as('w2').delete(removed.id)
  const report = await getBoardInsights(member, { channel: 'work', view: 'activity', run: 'green' })
  expect(report.rows).toMatchObject([{ actor: root.by.actor, posts: 1, replies: 0 }, { posts: 1, replies: 1 }])
  for (const view of ['unanswered', 'activity', 'progress'] as const) {
    expect((await getBoardInsights(restricted, { channel: 'work', view })).rows).toEqual([])
  }
})

it('counts live replies across the whole thread and distinguishes row and source truncation', async () => {
  const { member } = fixture()
  const roots = await Promise.all(['one', 'two', 'three'].map(text => member.post('work', text)))
  await member.reply(roots[0]!.id, 'answer')
  const deleted = await member.reply(roots[1]!.id, 'deleted answer')
  await member.delete(deleted.id)
  const result = await getBoardInsights(member, { channel: 'work', view: 'unanswered', limit: 1 })
  expect(result.rows).toHaveLength(1)
  expect(result.coverage).toMatchObject({ scanned: 3, truncated: false, rowsTruncated: true })
  const all = await getBoardInsights(member, { channel: 'work', view: 'unanswered' })
  expect(all.rows.map(row => row.text)).toEqual(['three', 'two'])
  await expect(getBoardInsights(member, { channel: 'work/', view: 'activity' })).rejects.toMatchObject({ code: 'invalid_request' })
})

it('marks a bounded source window as partial even when only one actor is returned', async () => {
  const { member } = fixture()
  const agent = member.as('w1')
  const root = await agent.post('work', { text: 'run root', labels: { run: 'r' } })
  for (let i = 0; i < 500; i++) await agent.reply(root.id, 'update')
  const report = await getBoardInsights(member, { channel: 'work', view: 'activity', run: 'r' })
  expect(report.coverage).toMatchObject({ scanned: 499, truncated: true, rowsTruncated: false })
  expect(report.rows).toMatchObject([{ actor: root.by.actor, posts: 499, replies: 499 }])
})
