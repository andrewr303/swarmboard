// HS-178..HS-181: Mode 1 keyed claim replay + token hygiene (SQLite, .jsonl, logs), post & createTask crash
// after COMMIT replay (SIGKILL), and TransportLogRecord redaction/shape.
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it } from 'vitest'
import { keyedId, mintClaimToken } from '../../src/client/idempotency.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { SharedFileTransport, type TransportLogRecord } from '../../src/client/transport-file.ts'
import { realHostFor } from './host-stub.ts'
import { call, head, messageOf, post, readAll, rejection, type Rec } from './suite/util.ts'

const CRASH_CHILD = resolve(import.meta.dirname, 'proc', 'crash-child.ts')

const dirs: string[] = []
const transports: SharedFileTransport[] = []

function freshDb(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hs-idem-')))
  dirs.push(dir)
  return join(dir, 'board.db')
}

function runCrashChild(args: Record<string, unknown>): Promise<{ code: number | null; signal: NodeJS.Signals | null; stdout: string; stderr: string }> {
  return new Promise((res, rej) => {
    const child = spawn(process.execPath, [CRASH_CHILD, JSON.stringify(args)], {
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => {
      stdout += String(d)
    })
    child.stderr.on('data', (d) => {
      stderr += String(d)
    })
    child.on('error', rej)
    child.on('exit', (code, signal) => res({ code, signal, stdout, stderr }))
  })
}

afterEach(async () => {
  while (transports.length > 0) {
    await transports.pop()!.close().catch(() => {})
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

describe('Mode 1 idempotency, token hygiene, crash replay, and log redaction (HS-178..HS-181)', () => {
  it('HS-178 keyed createTask(claim:true, token) replays claim & keeps clear token out of SQLite, .jsonl, and logs; without token replays task without claim', async () => {
    const db = freshDb()
    const logs: TransportLogRecord[] = []
    const t = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
      host: realHostFor(db),
      log: (rec) => logs.push(rec),
    })
    transports.push(t)
    await t.ready()

    const start = await head(t)
    const token = mintClaimToken()
    const first = (await call(
      t,
      'createTask',
      { channel: 'work', text: 'keyed-claim', claim: true, token },
      { idempotencyKey: 'K-ct' },
    )) as { task: Rec; claim: Rec }
    const second = (await call(
      t,
      'createTask',
      { channel: 'work', text: 'keyed-claim', claim: true, token },
      { idempotencyKey: 'K-ct' },
    )) as { task: Rec; claim: Rec }

    expect(second.task['id']).toBe(first.task['id'])
    expect(second.claim['epoch']).toBe(first.claim['epoch'])
    expect(second.claim['token']).toBe(token)

    const evs = await readAll(t, start)
    expect(evs.filter((e) => e.type === 'task.created' && String(e.message?.id) === String(first.task['id']))).toHaveLength(1)

    // Without token: second replay returns same task id and NO claim (caller token was not provided)
    const noTok1 = (await call(
      t,
      'createTask',
      { channel: 'work', text: 'no-token-claim', claim: true },
      { idempotencyKey: 'K-ct-notok' },
    )) as { task: Rec; claim?: Rec | null }
    const noTok2 = (await call(
      t,
      'createTask',
      { channel: 'work', text: 'no-token-claim', claim: true },
      { idempotencyKey: 'K-ct-notok' },
    )) as { task: Rec; claim?: Rec | null }
    expect(noTok2.task['id']).toBe(noTok1.task['id'])
    expect(noTok1.claim).toBeTruthy()
    expect(noTok2.claim ?? null).toBeNull()

    await t.close()

    // Byte search for clear text of `token` across SQLite tables, .jsonl, and TransportLogRecords
    expect(JSON.stringify(logs)).not.toContain(token)
    const jsonlText = fs.readFileSync(`${db}.jsonl`, 'utf8')
    expect(jsonlText).not.toContain(token)

    const expectedHash = createHash('sha256').update(token).digest('hex')
    const raw = new DatabaseSync(db, { readOnly: true })
    try {
      const eventRows = raw.prepare('SELECT payload_json FROM board_events').all() as { payload_json: string }[]
      for (const r of eventRows) expect(r.payload_json).not.toContain(token)

      const versionRows = raw.prepare('SELECT data FROM board_versions').all() as { data: string }[]
      for (const r of versionRows) expect(r.data).not.toContain(token)

      const taskRows = raw.prepare('SELECT * FROM board_tasks').all() as Record<string, unknown>[]
      for (const r of taskRows) expect(JSON.stringify(r)).not.toContain(token)

      const claimedRow = raw
        .prepare('SELECT claim_token_hash FROM board_tasks WHERE task_id = ?')
        .get(Number(first.task['id'])) as { claim_token_hash: string } | undefined
      expect(claimedRow?.claim_token_hash).toBe(expectedHash)
    } finally {
      raw.close()
    }
  })

  it(
    'HS-179 crash-child keyed post SIGKILLs after COMMIT; parent retries key and replays single event (×5)',
    async () => {
      const db = freshDb()
      const parent = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
      })
      transports.push(parent)
      await parent.ready()

      for (let i = 0; i < 5; i++) {
        const key = `K-crash-post-${i}`
        const res = await runCrashChild({
          db,
          op: 'post',
          input: { channel: 'dev', text: `after-commit-${i}` },
          idempotencyKey: key,
          userId: 'ada',
        })
        expect(res.signal).toBe('SIGKILL')
        expect(res.stdout).toBe('')

        const expectedKeyId = keyedId('local:user:ada', null, 'post', key)
        const replayed = await post(parent, 'dev', `after-commit-${i}`, {}, { idempotencyKey: key })
        const postedLookup = messageOf(await call(parent, 'posted', { id: expectedKeyId }))
        expect(replayed['id']).toBe(postedLookup['id'])

        const raw = new DatabaseSync(db, { readOnly: true })
        try {
          const row = raw
            .prepare('SELECT COUNT(*) AS n FROM board_events WHERE event_id = ?')
            .get(expectedKeyId) as { n: number }
          expect(row.n).toBe(1)
        } finally {
          raw.close()
        }
      }
    },
    60_000,
  )

  it(
    'HS-180 crash-child keyed createTask(claim:true, token) SIGKILLs after COMMIT; parent retries and completes task with replayed claim',
    async () => {
      const db = freshDb()
      const parent = new SharedFileTransport({
        path: db,
        identity: localIdentity({ userId: 'ada', profiles: [], member: true }),
        host: realHostFor(db),
      })
      transports.push(parent)
      await parent.ready()

      const key = 'K-crash-task'
      const token = mintClaimToken()
      const crashed = await runCrashChild({
        db,
        op: 'createTask',
        input: { channel: 'work', text: 'crash-claimed', claim: true, token },
        idempotencyKey: key,
        userId: 'ada',
      })
      expect(crashed.signal).toBe('SIGKILL')
      expect(crashed.stdout).toBe('')

      const replayed = (await call(
        parent,
        'createTask',
        { channel: 'work', text: 'crash-claimed', claim: true, token },
        { idempotencyKey: key },
      )) as { task: Rec; claim: Rec }
      expect(replayed.claim['token']).toBe(token)
      expect(replayed.claim['epoch']).toBe(1)

      const completed = (await call(parent, 'completeTask', {
        id: replayed.task['id'],
        epoch: replayed.claim['epoch'],
        token,
        result: 'finished',
      })) as { task: Rec }
      expect((completed.task['task'] as Rec)['state']).toBe('completed')
    },
    30_000,
  )

  it('HS-181 TransportLogRecord carries op, 12-hex lane, attempts, ms, outcome (and status/code on error) and leaks no key, derived id, token, or message text', async () => {
    const db = freshDb()
    const logs: TransportLogRecord[] = []
    const t = new SharedFileTransport({
      path: db,
      identity: localIdentity({ userId: 'ada', profiles: ['w1'], member: true }),
      host: realHostFor(db),
      log: (rec) => logs.push(rec),
    })
    transports.push(t)
    await t.ready()

    const keyPost = 'K-LOG-POST-SECRET'
    const keyClaim = 'K-LOG-CLAIM-SECRET'
    const token = mintClaimToken()
    const derivedPostId = keyedId('local:user:ada', 'w1', 'post', keyPost)

    await post(t, 'dev', 'SECRET-TEXT', {}, { idempotencyKey: keyPost, as: 'w1' })
    const task = ((await call(t, 'createTask', { channel: 'work', text: 't' })) as { task: Rec }).task
    await call(t, 'claimTask', { id: task['id'], token }, { idempotencyKey: keyClaim, as: 'w1' })
    await rejection(call(t, 'message', { id: '999999' }, { as: 'w1' }))

    expect(logs).toHaveLength(4)
    const dump = JSON.stringify(logs)
    expect(dump).not.toContain(keyPost)
    expect(dump).not.toContain(keyClaim)
    expect(dump).not.toContain(derivedPostId)
    expect(dump).not.toContain(token)
    expect(dump).not.toContain('SECRET-TEXT')

    for (const rec of logs) {
      expect(typeof rec.op).toBe('string')
      expect(rec.lane).toMatch(/^[0-9a-f]{12}$/)
      expect(typeof rec.attempts).toBe('number')
      expect(typeof rec.ms).toBe('number')
      expect(rec.outcome === 'ok' || rec.outcome === 'error').toBe(true)
    }
    const errRec = logs[3]!
    expect(errRec).toMatchObject({ op: 'message', outcome: 'error', status: 404, code: 'message_not_found' })
  })
})
