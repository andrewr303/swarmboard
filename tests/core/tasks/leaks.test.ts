// AT-36 (M2_DESIGN 2.11): no claim token leaks. Every answer, the feed with all=true, watcher matches,
// FTS hits, board_messages.data, board_versions.data and the JSONL audit are scanned after a script that
// takes every claim path (create with claim, claim by ID, claim next, takeover, batch, list), ported
// from the original's tasks.test.ts:1527-1582. The plain token appears nowhere a claimer did not get it
// back; its sha256 appears only in task.claimed payloads, board_tasks and the JSONL audit.
import { createHash } from 'node:crypto'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import type { TaskClaim } from '../../../src/core/index.ts'
import { alice, makeBoard, type Board } from './helpers.ts'
import { aliceAs, bob } from './verb-helpers.ts'

const hashOf = (token: string): string => createHash('sha256').update(token).digest('hex')

let dispose: Array<() => void> = []
afterEach(() => {
  for (const d of dispose.splice(0)) d()
})

function fileBoard(): { b: Board; path: string } {
  const dir = mkdtempSync(join(tmpdir(), 'swarmboard-leaks-'))
  const path = join(dir, 'board.db')
  const b = makeBoard({ path })
  dispose.push(() => {
    b.close()
    rmSync(dir, { recursive: true, force: true })
  })
  return { b, path }
}

/** The whole feed with all=true, page by page. */
async function everything(b: Board, query: Record<string, unknown>): Promise<{ events: Array<{ type: string }> }> {
  const events: Array<{ type: string }> = []
  let after = '0'
  for (;;) {
    const page = await b.board.getEvents(alice, { all: true, after, ...query })
    events.push(...page.events)
    if (page.events.length === 0 || page.cursor === after) return { events }
    after = page.cursor
  }
}

describe('AT-36 no token leaks', () => {
  it('AT-36 the plain token is in no answer but its claimer\'s, and its hash only in task.claimed, board_tasks and the JSONL audit', async () => {
    const { b, path } = fileBoard()
    const fixer = aliceAs('fixer')
    b.board.registerWatchers(alice, { url: null, watch: { work: { tail: 'dev' } }, sync: [] })

    const answers: unknown[] = []
    const claims: TaskClaim[] = []
    /** Keeps an answer for the scan, its own claim taken out: that one is its claimer's to have. */
    const keep = <T extends object>(answer: T): T & { claim?: TaskClaim } => {
      const { claim, ...rest } = answer as T & { claim?: TaskClaim }
      if (claim) {
        claims.push(claim)
        answers.push(rest, { epoch: claim.epoch, until: claim.until })
      } else answers.push(answer)
      return answer
    }

    const first = keep(b.board.tasks.createTask(alice, { channel: 'dev', text: 'fix CVE-123 searchable', claim: true })).task
    const second = keep(b.board.tasks.createTask(alice, { channel: 'dev', text: 'review the fix', needs: [first.id] })).task
    const batch = keep(
      b.board.tasks.createTasks(alice, { channel: 'dev', id: 'plan-1', tasks: [{ text: 'cut a release', key: 'cut' }, { text: 'announce it', needs: [{ key: 'cut' }] }] }),
    )
    const [cut] = batch.tasks
    // A create's claim, renewed, released; a claim by ID with the caller's own token; a fail, reopen, block, unblock.
    const made = claims[0]!
    keep(b.board.tasks.renewTask(alice, first.id, { epoch: made.epoch, token: made.token, lease: 60 }))
    keep(b.board.tasks.releaseTask(alice, first.id, { epoch: made.epoch, token: made.token }))
    keep(b.board.tasks.assignTask(alice, first.id, { for: fixer.actor.id }))
    const own = keep(b.board.tasks.claimTask(fixer, first.id, { token: 'T'.repeat(43) })).claim!
    keep(b.board.tasks.failTask(fixer, first.id, { epoch: own.epoch, token: own.token, reason: 'flaky' }))
    keep(b.board.tasks.reopenTask(alice, first.id))
    keep(b.board.tasks.blockTask(alice, first.id, { reason: 'hold', kind: 'needs_input' }))
    keep(b.board.tasks.unblockTask(alice, first.id))
    // A claim that lapses and is taken over, then completed: promotion follows.
    const lapsing = keep(b.board.tasks.claimTask(fixer, first.id, { lease: 30 })).claim!
    b.clock.now += 31_000
    const taken = keep(b.board.tasks.claimTask(fixer, first.id, {})).claim!
    expect(taken.epoch).toBe(lapsing.epoch + 1)
    keep(b.board.tasks.completeTask(fixer, first.id, { epoch: taken.epoch, token: taken.token, result: 'fixed searchable' }))
    // Claim next, and the sweep: a claim that runs out with no one to take it over.
    const next = keep((await b.board.tasks.claimReady(bob, { channel: 'dev', from: [alice.principal.id], lease: 30 })) as { claim?: TaskClaim })
    expect(next.claim).toBeDefined()
    b.clock.now += 31_000
    answers.push(b.board.tasks.expireDueClaims())
    const cutClaim = keep(b.board.tasks.claimTask(bob, cut!.id, {})).claim!
    keep(b.board.tasks.completeTask(bob, cut!.id, { epoch: cutClaim.epoch, token: cutClaim.token }))
    keep(b.board.tasks.cancelTask(alice, second.id, { reason: 'not needed' }))
    // A non-owner's edit holds a claimed task; a delete cancels one.
    const edited = keep(b.board.tasks.createTask(alice, { channel: 'dev', text: 'to be edited' })).task
    keep(b.board.tasks.claimTask(bob, edited.id, {}))
    b.board.editMessage(alice, edited.id, { text: 'edited by the owner' })
    const deleted = keep(b.board.tasks.createTask(alice, { channel: 'dev', text: 'to be deleted', claim: true })).task
    answers.push(b.board.deleteMessage(alice, deleted.id))

    // Every read a client has: lists, the batch, threads, the feed, matches, search.
    answers.push(b.board.tasks.listTasks(alice, { state: 'all' }), b.board.tasks.listTasks(bob, { state: 'all', channel: 'dev' }))
    answers.push(b.board.tasks.getBatch(alice, 'plan-1'))
    for (const id of [first.id, second.id, cut!.id, edited.id, deleted.id]) answers.push(b.board.getMessageThread(alice, id))
    const feed = await everything(b, {})
    const orgFeed = await everything(b, { include: 'org' })
    // Matches are leased as they are pulled: pull until none is left.
    const matches: unknown[] = []
    for (let round = 0; round < 50; round++) {
      const page = b.board.pullWatcherMatches(alice, { limit: 50 })
      if (page.length === 0) break
      matches.push(...page)
    }
    const hits = b.board.search(alice, { query: 'searchable' })
    expect(feed.events.filter((e) => e.type === 'task.claimed').length).toBeGreaterThanOrEqual(7)
    expect(matches.length).toBeGreaterThan(0)
    expect(hits.length).toBeGreaterThan(0)
    answers.push(feed, orgFeed, matches, hits)

    const tokens = claims.map((c) => c.token)
    const hashes = tokens.map(hashOf)
    expect(tokens.length).toBeGreaterThanOrEqual(8)

    const db = b.store.db
    const rows = (sql: string): string[] => (db.prepare(sql).all() as Array<{ v: string | null }>).map((r) => String(r.v ?? ''))
    const views = JSON.stringify(answers)
    const messages = rows('SELECT data AS v FROM board_messages')
    const versions = rows('SELECT data AS v FROM board_versions')
    const fts = rows("SELECT task_id || ' ' || channel || ' ' || state || ' ' || COALESCE(body, '') || ' ' || COALESCE(result, '') AS v FROM fts_tasks")
    expect(fts.length).toBeGreaterThan(0)
    const claimedPayloads = rows("SELECT payload_json AS v FROM board_events WHERE type = 'task.claimed'")
    const otherPayloads = rows("SELECT payload_json AS v FROM board_events WHERE type != 'task.claimed'")
    const indexHashes = rows('SELECT claim_token_hash AS v FROM board_tasks WHERE claim_token_hash IS NOT NULL')
    const jsonl = readFileSync(`${path}.jsonl`, 'utf8')

    // The plain token: nowhere. Not in a view, a row, a snapshot, a payload, the audit.
    for (const token of tokens) {
      for (const [where, text] of [
        ['answers', views],
        ['board_messages', messages.join('\n')],
        ['board_versions', versions.join('\n')],
        ['fts_tasks', fts.join('\n')],
        ['board_events', claimedPayloads.concat(otherPayloads).join('\n')],
        ['jsonl', jsonl],
      ] as const) {
        expect(text.includes(token), `${where} holds a claim token`).toBe(false)
      }
    }
    // The hash: only in task.claimed, board_tasks and the audit sidecar.
    expect(views).not.toMatch(/[0-9a-f]{64}/)
    expect(views).not.toMatch(/"token"/)
    for (const [where, text] of [
      ['board_messages', messages.join('\n')],
      ['board_versions', versions.join('\n')],
      ['fts_tasks', fts.join('\n')],
      ['other events', otherPayloads.join('\n')],
    ] as const) {
      for (const hash of hashes) expect(text.includes(hash), `${where} holds a token hash`).toBe(false)
      expect(text, where).not.toMatch(/"token"/)
    }
    const claimedText = claimedPayloads.join('\n')
    for (const hash of hashes) {
      expect(claimedText.includes(hash), 'each claim\'s hash is in its task.claimed').toBe(true)
      expect(jsonl.includes(hash), 'the audit sidecar writes each event whole').toBe(true)
    }
    // The live claims' hashes are the index's, and only theirs.
    for (const h of indexHashes) expect(hashes).toContain(h)
  })
})
