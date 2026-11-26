// HS-91, HS-92, HS-175, HS-185, HS-189 (connect clause), HS-193: SDK composition root connect() for Mode 0 & Mode 1.
import { createHash } from 'node:crypto'
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { readTickLease } from '../../src/core/internal.ts'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../src/core/public.ts'
import { clientError, isBoardError } from '../../src/client/errors.ts'
import { localIdentity } from '../../src/client/identity.ts'
import { clientErrorPayload } from '../../src/client/normalize.ts'
import type { ExplainStep } from '../../src/client/resolve.ts'
import type { SharedFileTransport } from '../../src/client/transport-file.ts'
import type { Selection } from '../../src/client/types.ts'
import { connect } from '../../src/host/connect.ts'
import type { TickReport } from '../../src/host/tick.ts'
import { makeLegacyFile } from '../core/host0/legacy.ts'

const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []
const clients: Array<{ close(): Promise<void> }> = []

function tmp(): string {
  const dir = fs.realpathSync(fs.mkdtempSync(join(tmpdir(), 'hs-connect-')))
  dirs.push(dir)
  return dir
}

afterEach(async () => {
  vi.restoreAllMocks()
  while (clients.length > 0) {
    await clients.pop()!.close()
  }
  while (stores.length > 0) {
    stores.pop()!.close()
  }
  while (dirs.length > 0) {
    fs.rmSync(dirs.pop()!, { recursive: true, force: true })
  }
})

const sha = (p: string): string => createHash('sha256').update(fs.readFileSync(p)).digest('hex')
const listing = (dir: string): string[] => fs.readdirSync(dir).sort()

async function expectError(fn: () => Promise<unknown>, match: { status: number; code: string; hint?: RegExp }) {
  try {
    await fn()
    expect.unreachable(`expected throw ${match.status} ${match.code}`)
  } catch (e) {
    expect(isBoardError(e), String(e)).toBe(true)
    if (!isBoardError(e)) return
    expect(e.status).toBe(match.status)
    expect(e.code).toBe(match.code)
    if (match.hint) expect(e.hint ?? '').toMatch(match.hint)
    return e
  }
}

describe('HS-91 connect() Mode 0 happy paths', () => {
  it('HS-91 inProcess file board opens, writes manifest, logs selection, posts as caller, and closes store', async () => {
    const dir = tmp()
    const db = join(dir, 'b', 'board.db')
    const caller = createLocalCaller({ userId: 'ada', profile: 'w1' })
    const logged: Array<{ selection: Selection; explain: readonly ExplainStep[] }> = []

    const client = await connect({
      inProcess: true,
      db,
      caller,
      context: { env: {}, cwd: dir, home: dir },
      log: (ev) => logged.push(ev),
    })
    clients.push(client)

    expect(client.selection).toEqual({
      mode: 'in-process',
      reason: 'inProcess option',
      source: 'flag:db',
    })
    expect(client.caps).toBe(client.raw.capabilities)
    expect(client.profile).toBe('w1')
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(true)

    const msg = await client.post('dev', 'hi')
    expect(msg.by.actor).toBe('local:user:ada+w1')

    expect(logged).toHaveLength(1)
    expect(logged[0]!.selection).toEqual(client.selection)
    expect(logged[0]!.explain.length).toBeGreaterThan(0)

    await client.close()
    expect(client.raw.closed).toBe(true)
    await expectError(() => client.me(), { status: 503, code: 'unavailable' })
  })

  it('HS-91 service option borrows BoardService without closing it on client.close()', async () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const service = new BoardService(store)
    const caller = createLocalCaller({ userId: 'ada', profile: 'w1' })
    const logged: Array<{ selection: Selection; explain: readonly ExplainStep[] }> = []

    const client = await connect({ service, caller, log: (ev) => logged.push(ev) })
    clients.push(client)

    expect(client.selection).toEqual({
      mode: 'in-process',
      reason: 'service option',
      source: 'option:service',
    })
    expect(client.resolution).toBeNull()
    expect(logged).toHaveLength(1)

    const msg = await client.post('dev', 'borrowed')
    expect(msg.by.actor).toBe('local:user:ada+w1')

    await client.close()
    expect(client.raw.closed).toBe(true)
    // Borrowed service & store remain open
    expect(service.boardInfo().boardId).toBeTypeOf('string')
  })

  it('HS-91 :memory: with inProcess:true and env profile ignored when caller differs', async () => {
    const dir = tmp()
    const logged: Array<{ selection: Selection; explain: readonly ExplainStep[] }> = []
    const client = await connect({
      inProcess: true,
      db: ':memory:',
      caller: createLocalCaller({ userId: 'ada', profile: 'w1' }),
      context: { env: { SWARMBOARD_AGENT: 'w2' }, cwd: dir, home: dir },
      log: (ev) => logged.push(ev),
    })
    clients.push(client)
    expect(client.profile).toBe('w1')
    expect(logged[0]!.explain.some((s) => s.topic === 'identity' && s.outcome === 'ignored')).toBe(true)
    expect((await client.me()).actor).toBe('local:user:ada+w1')
  })
})

describe('HS-92 connect() refusals and ordering with zero FS side effects', () => {
  // Note: HS-92's B5 clause (1) (connect({db}) without inProcess -> 501) is superseded in Stage B9 by HS-185 (CR-12).
  it('HS-92 (2) connect({ inProcess: true, url }) -> 400 conflicting_options', async () => {
    const dir = tmp()
    await expectError(
      () =>
        connect({
          inProcess: true,
          url: 'https://h/api/board',
          context: { env: {}, cwd: dir, home: dir },
        }),
      { status: 400, code: 'conflicting_options' },
    )
  })

  it('HS-92 (3) SWARMBOARD_URL connects via Mode 4 HttpTransport (never falls back locally)', async () => {
    const dir = tmp()
    // Unreachable remote URL fails with 503 unavailable (never silently creates a local board.db)
    await expectError(
      () =>
        connect({
          context: { env: { SWARMBOARD_URL: 'https://board.invalid/api/board' }, cwd: dir, home: dir },
          fetch: async () => {
            throw new TypeError('connect ECONNREFUSED')
          },
        }),
      { status: 503, code: 'unavailable' },
    )
    expect(fs.existsSync(join(dir, '.swarmboard'))).toBe(false)
  })

  it('HS-92 (4) connect({ inProcess: true, db }) without caller/identity -> 400 invalid_request and 0 files created', async () => {
    const dir = tmp()
    const targetDir = join(dir, 'missing-id')
    const db = join(targetDir, 'board.db')

    await expectError(
      () => connect({ inProcess: true, db, context: { env: {}, cwd: dir, home: dir } }),
      { status: 400, code: 'invalid_request' },
    )
    expect(fs.existsSync(targetDir)).toBe(false)
    expect(fs.existsSync(db)).toBe(false)

    // Also service without identity/caller -> 400 invalid_request
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const service = new BoardService(store)
    await expectError(() => connect({ service }), { status: 400, code: 'invalid_request' })
  })

  it('HS-92 / HS-03 symlinked board.db preserves ClientError 403 unsafe_location (never 500)', async () => {
    const dir = tmp()
    const realTarget = join(dir, 'real.db')
    fs.writeFileSync(realTarget, '')
    const symDb = join(dir, 'board.db')
    fs.symlinkSync(realTarget, symDb)
    await expectError(
      () =>
        connect({
          inProcess: true,
          db: symDb,
          caller: createLocalCaller({ userId: 'ada', profile: 'w1' }),
          context: { env: {}, cwd: dir, home: dir },
        }),
      { status: 403, code: 'unsafe_location' },
    )
  })
})

describe('HS-193 connect() admission preflight and profile preservation', () => {
  it('HS-193 member:false warns with topic identity naming member: true; member:true has no warn and uses defaultProfile', async () => {
    const dir = tmp()
    const db = join(dir, 'board.db')
    const logged: Array<{ selection: Selection; explain: readonly ExplainStep[] }> = []

    const unmember = await connect({
      inProcess: true,
      db,
      identity: localIdentity({ userId: 'ada', profiles: ['w1'], defaultProfile: 'w1' }),
      context: { env: {}, cwd: dir, home: dir },
      log: (ev) => logged.push(ev),
    })
    clients.push(unmember)

    expect(unmember.profile).toBeUndefined()
    const warns = unmember.warnings.filter((w) => w.topic === 'identity' && w.outcome === 'warn')
    expect(warns).toHaveLength(1)
    expect(warns[0]!.note).toContain('member: true')
    expect(logged[0]!.explain.filter((w) => w.topic === 'identity' && w.outcome === 'warn')).toEqual(warns)

    await expectError(() => unmember.me(), { status: 403, code: 'forbidden' })
    await unmember.close()

    // With member: true -> no warn step, me() resolves with defaultProfile 'w1'
    const member = await connect({
      inProcess: true,
      db,
      identity: localIdentity({ userId: 'ada', profiles: ['w1'], defaultProfile: 'w1', member: true }),
      context: { env: {}, cwd: dir, home: dir },
    })
    clients.push(member)
    expect(member.profile).toBeUndefined()
    expect(member.warnings.filter((w) => w.topic === 'identity')).toHaveLength(0)
    const me = await member.me()
    expect(me.actor).toBe('local:user:ada+w1')
  })

  it('HS-193 non-403 preflight error rejects normalized and closes the opened store', async () => {
    const dir = tmp()
    const db = join(dir, 'board.db')
    const closeSpy = vi.spyOn(SqliteUnifiedStore.prototype, 'close')
    vi.spyOn(BoardService.prototype, 'me').mockImplementationOnce(() => {
      throw clientError('unavailable', 'temporarily down', { retryAfter: 1 })
    })

    await expectError(
      () =>
        connect({
          inProcess: true,
          db,
          caller: createLocalCaller({ userId: 'ada', profile: 'w1' }),
          context: { env: {}, cwd: dir, home: dir },
        }),
      { status: 503, code: 'unavailable' },
    )
    expect(closeSpy).toHaveBeenCalledTimes(1)

    // Non-BoardError thrown from me() becomes 500 internal and still closes store
    closeSpy.mockClear()
    vi.spyOn(BoardService.prototype, 'me').mockImplementationOnce(() => {
      throw new TypeError('unexpected boom')
    })
    await expectError(
      () =>
        connect({
          inProcess: true,
          db,
          caller: createLocalCaller({ userId: 'ada', profile: 'w1' }),
          context: { env: {}, cwd: dir, home: dir },
        }),
      { status: 500, code: 'internal' },
    )
    expect(closeSpy).toHaveBeenCalledTimes(1)
  })

  it('HS-193 / OD-11 deployment-kind principal refusal fails connect() with 403 and closes owned store (not swallowed as warning)', async () => {
    const dir = tmp()
    const db = join(dir, 'board.db')
    const base = createLocalCaller({ userId: 'sys', member: true, owner: true })
    const deployCaller = {
      ...base,
      principal: { ...base.principal, kind: 'deployment' as const },
    }
    const deployIdentity = {
      kind: 'local' as const,
      base: { principal: deployCaller.principal.id, profile: null },
      callerFor: () => deployCaller,
    }
    const logged: Array<{ selection: Selection; explain: readonly ExplainStep[] }> = []
    const closeSpy = vi.spyOn(SqliteUnifiedStore.prototype, 'close')

    const err = await expectError(
      () =>
        connect({
          inProcess: true,
          db,
          identity: deployIdentity,
          context: { env: {}, cwd: dir, home: dir },
          log: (ev) => logged.push(ev),
        }),
      { status: 403, code: 'forbidden' },
    )
    expect(err?.origin).toBe('handle')
    expect(err?.message).toContain('deployment')
    expect(logged).toHaveLength(0)
    expect(closeSpy).toHaveBeenCalledTimes(1)

    // Borrowed service path also rejects 403 and leaves borrowed service open
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const service = new BoardService(store)
    const errBorrowed = await expectError(
      () => connect({ service, identity: deployIdentity, log: (ev) => logged.push(ev) }),
      { status: 403, code: 'forbidden' },
    )
    expect(errBorrowed?.origin).toBe('handle')
    expect(errBorrowed?.message).toContain('deployment')
    expect(logged).toHaveLength(0)
    expect(service.boardInfo().boardId).toBeTypeOf('string')
  })
})

describe('HS-189 (connect clause) foreign/text/0-byte/legacy/empty-sqlite through connect()', () => {
  const caller = createLocalCaller({ userId: 'ada', profile: 'w1' })
  const fresh = (): { dir: string; db: string } => {
    const root = tmp()
    const dir = join(root, 'f')
    fs.mkdirSync(dir, { mode: 0o700 })
    return { dir, db: join(dir, 'board.db') }
  }
  const journalMode = (db: string): string => {
    const r = new DatabaseSync(db, { readOnly: true })
    try {
      return String((r.prepare('PRAGMA journal_mode').get() as { journal_mode: string }).journal_mode)
    } finally {
      r.close()
    }
  }

  it('HS-189 (a) foreign SQLite db (journal delete) via connect() -> 409 foreign, unchanged', async () => {
    const { dir, db } = fresh()
    const w = new DatabaseSync(db)
    w.exec("CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine')")
    w.close()
    const hash = sha(db)

    const e = await expectError(
      () => connect({ inProcess: true, db, caller, context: { env: {}, cwd: dir, home: dir } }),
      { status: 409, code: 'manifest_mismatch' },
    )
    expect(e?.details).toEqual({ reason: 'foreign', path: db })
    expect(sha(db)).toBe(hash)
    expect(journalMode(db)).toBe('delete')
    expect(listing(dir)).toEqual(['board.db'])
  })

  it('HS-189 (b) closed foreign WAL db via connect() -> 409 foreign, dir listing unchanged', async () => {
    const { dir, db } = fresh()
    const w = new DatabaseSync(db)
    w.exec("PRAGMA journal_mode = WAL; CREATE TABLE notes (body TEXT); INSERT INTO notes VALUES ('mine')")
    w.close()
    const before = listing(dir)
    const hash = sha(db)

    const e = await expectError(
      () => connect({ inProcess: true, db, caller, context: { env: {}, cwd: dir, home: dir } }),
      { status: 409, code: 'manifest_mismatch' },
    )
    expect(e?.details).toEqual({ reason: 'foreign', path: db })
    expect(listing(dir)).toEqual(before)
    expect(sha(db)).toBe(hash)
  })

  it('HS-189 (c) text file via connect() -> 409 not_sqlite, file unchanged', async () => {
    const { dir, db } = fresh()
    fs.writeFileSync(db, 'hello, I am a text file\n')
    const hash = sha(db)

    const e = await expectError(
      () => connect({ inProcess: true, db, caller, context: { env: {}, cwd: dir, home: dir } }),
      { status: 409, code: 'manifest_mismatch' },
    )
    expect(e?.details).toEqual({ reason: 'not_sqlite', path: db })
    expect(sha(db)).toBe(hash)
    expect(listing(dir)).toEqual(['board.db'])
  })

  it('HS-189 (d) 0-byte board.db via connect() -> opens and writes manifest', async () => {
    const { dir, db } = fresh()
    fs.writeFileSync(db, '', { mode: 0o600 })

    const client = await connect({ inProcess: true, db, caller, context: { env: {}, cwd: dir, home: dir } })
    clients.push(client)
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(true)
    expect(client.caps.boardId).toBeTypeOf('string')
  })

  it('HS-189 (e) legacy board file via connect() -> opens and writes manifest', async () => {
    const { dir, db } = fresh()
    makeLegacyFile(db, 'sliceA', 3)

    const client = await connect({ inProcess: true, db, caller, context: { env: {}, cwd: dir, home: dir } })
    clients.push(client)
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(true)
    expect(client.caps.writable).toBe(true)
    expect(JSON.parse(fs.readFileSync(`${db}.manifest.json`, 'utf8'))).toMatchObject({
      boardId: client.caps.boardId,
    })
  })

  it('HS-189 (f) SQLite file with zero tables via connect() -> opens', async () => {
    const { dir, db } = fresh()
    const w = new DatabaseSync(db)
    w.exec('CREATE TABLE t (x); DROP TABLE t')
    w.close()

    const client = await connect({ inProcess: true, db, caller, context: { env: {}, cwd: dir, home: dir } })
    clients.push(client)
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(true)
    expect(client.caps.boardId).toBeTypeOf('string')
  })
})

describe('HS-185 connect() Mode 1 (shared-file), policy refusals, ticker release, and CR-4 error preservation', () => {
  const caller = createLocalCaller({ userId: 'ada', profile: 'w1' })

  it('HS-185 default auto mode opens Mode 1 shared-file with tick-lease, round-trips post, and releases lease on close()', async () => {
    const dir = tmp()
    const db = join(dir, 'b', 'board.db')
    let resolveRan!: (r: TickReport) => void
    const firstRan = new Promise<TickReport>((r) => {
      resolveRan = r
    })

    const client = await connect({
      db,
      caller,
      context: { env: {}, cwd: dir, home: dir },
      fileHost: {
        ticker: {
          intervalMs: 50,
          ttlMs: 1_000,
          onReport: (r) => {
            if (r.outcome === 'ran') resolveRan(r)
          },
        },
      },
    })
    clients.push(client)

    expect(client.selection).toEqual({
      mode: 'shared-file',
      reason: 'auto: no live daemon',
      source: 'flag:db',
    })
    expect(client.caps.schedules).toBe('tick-lease')
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(true)

    const posted = await client.post('dev', 'hello mode 1')
    expect(posted.text).toBe('hello mode 1')
    expect(posted.by.actor).toBe('local:user:ada+w1')

    // CR-13: await the first 'ran' TickReport before close(), then assert lease released (until: 0) with same holder & fence
    const ran = await firstRan
    expect(ran.holder).toBeTypeOf('string')
    expect(ran.fence).toBeTypeOf('number')

    await client.close()

    const checkStore = new SqliteUnifiedStore({ path: db })
    stores.push(checkStore)
    const lease = readTickLease(checkStore)
    expect(lease).toMatchObject({ holder: ran.holder, fence: ran.fence, until: 0 })
  })

  it('HS-185 mode: file -> reason "mode file"; mode: daemon/service -> 501; auth.enforce -> 403 daemon_required; boardOptions -> 400; OD-1 missing identity -> 400; .wakeup symlink -> 403 unsafe_location', async () => {
    // mode: 'file'
    {
      const dir = tmp()
      const db = join(dir, 'f', 'board.db')
      const client = await connect({
        db,
        mode: 'file',
        caller,
        context: { env: {}, cwd: dir, home: dir },
      })
      clients.push(client)
      expect(client.selection).toEqual({
        mode: 'shared-file',
        reason: 'mode file',
        source: 'flag:db',
      })
      await client.close()
    }

    // mode: 'service' when no daemon is running -> 503 daemon_unavailable, 0 files created (no silent downgrade)
    {
      const dir = tmp()
      const targetDir = join(dir, 's')
      const db = join(targetDir, 'board.db')
      await expectError(() => connect({ db, mode: 'service', caller, context: { env: {}, cwd: dir, home: dir } }), {
        status: 503,
        code: 'daemon_unavailable',
      })
      expect(fs.existsSync(targetDir)).toBe(false)
    }

    // mode: 'daemon' with spawn failure falls back to Mode 1 when !authEnforce (recording selection.fallback)
    {
      const dir = tmp()
      const db = join(dir, 'fb', 'board.db')
      const runDir = join(dir, 'fb-run')
      const client = await connect({
        db,
        mode: 'daemon',
        caller,
        context: { env: {}, cwd: dir, home: dir },
        daemon: { runDir, daemonScript: join(dir, 'nonexistent.mjs'), spawnTimeoutMs: 400 },
      })
      clients.push(client)
      expect(client.selection.mode).toBe('shared-file')
      expect(client.selection.fallback).toBe('daemon_unavailable')
      await client.close()
    }

    // project config auth.enforce: true -> 403 daemon_required, 0 board files created
    {
      const repo = tmp()
      fs.mkdirSync(join(repo, '.git'))
      fs.mkdirSync(join(repo, '.swarmboard'), { mode: 0o700 })
      fs.writeFileSync(
        join(repo, '.swarmboard', 'config.json'),
        JSON.stringify({ version: 1, auth: { enforce: true } }),
      )
      await expectError(() => connect({ caller, context: { env: {}, cwd: repo, home: repo } }), {
        status: 403,
        code: 'daemon_required',
      })
      expect(fs.existsSync(join(repo, '.swarmboard', 'board.db'))).toBe(false)
    }

    // boardOptions without inProcess -> 400 conflicting_options, 0 files created
    {
      const dir = tmp()
      const targetDir = join(dir, 'bo')
      const db = join(targetDir, 'board.db')
      await expectError(
        () =>
          connect({
            db,
            caller,
            boardOptions: { now: () => 0 },
            context: { env: {}, cwd: dir, home: dir },
          }),
        { status: 400, code: 'conflicting_options' },
      )
      expect(fs.existsSync(targetDir)).toBe(false)
    }

    // OD-1: Mode 1 without caller/identity -> 400 invalid_request, 0 files created
    {
      const dir = tmp()
      const targetDir = join(dir, 'no-id')
      const db = join(targetDir, 'board.db')
      await expectError(() => connect({ db, context: { env: {}, cwd: dir, home: dir } }), {
        status: 400,
        code: 'invalid_request',
      })
      expect(fs.existsSync(targetDir)).toBe(false)
    }

    // CR-4: .wakeup symlink -> ClientError 403 unsafe_location (never 500) + clientErrorPayload check
    {
      const dir = tmp()
      const bdir = join(dir, 'sym')
      fs.mkdirSync(bdir, { mode: 0o700 })
      const db = join(bdir, 'board.db')
      const realWake = join(dir, 'elsewhere.wakeup')
      fs.writeFileSync(realWake, '')
      fs.symlinkSync(realWake, `${db}.wakeup`)

      const err = await expectError(
        () => connect({ db, caller, context: { env: {}, cwd: dir, home: dir } }),
        { status: 403, code: 'unsafe_location' },
      )
      expect(err?.origin).toBe('handle')
      expect(clientErrorPayload(err)).toMatchObject({
        status: 403,
        payload: { error: { code: 'unsafe_location' } },
      })
    }

    // OD-11: deployment-kind principal refused 403 in Mode 1 and store closed
    {
      const dir = tmp()
      const db = join(dir, 'dep', 'board.db')
      const base = createLocalCaller({ userId: 'sys', member: true, owner: true })
      const deployCaller = { ...base, principal: { ...base.principal, kind: 'deployment' as const } }
      const deployIdentity = {
        kind: 'local' as const,
        base: { principal: deployCaller.principal.id, profile: null },
        callerFor: () => deployCaller,
      }
      const err = await expectError(
        () => connect({ db, identity: deployIdentity, context: { env: {}, cwd: dir, home: dir } }),
        { status: 403, code: 'forbidden' },
      )
      expect(err?.origin).toBe('handle')
      expect(err?.message).toContain('deployment')
    }
  })

  it('HS-185 / B9-F1 default tick:lease Mode 1 client: caps never throws after replaced or close(), and me()/events() reject with replacedError (not storage is closed)', async () => {
    // (a) Replaced while tick: 'lease' is active
    {
      const repo = tmp()
      fs.mkdirSync(join(repo, '.git'))
      const cbDir = join(repo, '.swarmboard')
      fs.mkdirSync(cbDir, { mode: 0o700 })
      fs.writeFileSync(join(cbDir, 'config.json'), JSON.stringify({ version: 1, wake: { safetyPollMs: 150 } }))
      const db = join(cbDir, 'board.db')

      let resolveRan!: () => void
      const firstRan = new Promise<void>((r) => {
        resolveRan = r
      })

      const client = await connect({
        caller,
        context: { env: {}, cwd: repo, home: repo },
        fileHost: {
          ticker: {
            intervalMs: 50,
            ttlMs: 1_000,
            onReport: (r) => {
              if (r.outcome === 'ran') resolveRan()
            },
          },
        },
      })
      clients.push(client)
      await firstRan
      expect(client.caps.schedules).toBe('tick-lease')

      const feedErrP = (async () => {
        try {
          for await (const _ of client.events({})) {
            // waiting
          }
          return null
        } catch (e) {
          return e
        }
      })()

      const copy = join(repo, 'copy.db')
      const vac = new DatabaseSync(db)
      vac.exec(`VACUUM INTO '${copy.replace(/'/g, "''")}'`)
      vac.close()
      fs.renameSync(copy, db)

      // Wait for WakeBridge safety poll (150ms) to detect replaced, close store, and stop ticker
      const feedErr = await feedErrP
      expect(isBoardError(feedErr)).toBe(true)
      expect(feedErr).toMatchObject({
        status: 503,
        code: 'unavailable',
        details: { reason: 'replaced', path: db },
      })

      // Reading client.caps MUST NOT throw 'storage is closed'
      expect(() => client.caps).not.toThrow()
      expect(Object.isFrozen(client.caps)).toBe(true)

      // Subsequent client.me() and client.events() MUST reject with replacedError, never 'storage is closed'
      const meErr = await expectError(() => client.me(), { status: 503, code: 'unavailable' })
      expect(meErr?.details).toEqual({ reason: 'replaced', path: db })
      expect(meErr?.message).not.toBe('storage is closed')

      let secondFeedErr: unknown = null
      try {
        for await (const _ of client.events({})) {
          // unreachable
        }
      } catch (e) {
        secondFeedErr = e
      }
      expect(secondFeedErr).toMatchObject({
        status: 503,
        code: 'unavailable',
        details: { reason: 'replaced', path: db },
      })
    }

    // (b) Normal close() while tick: 'lease' is active: client.caps MUST NOT throw 'storage is closed'
    {
      const dir = tmp()
      const db = join(dir, 'close-caps', 'board.db')
      let resolveRan!: () => void
      const firstRan = new Promise<void>((r) => {
        resolveRan = r
      })
      const client = await connect({
        db,
        caller,
        context: { env: {}, cwd: dir, home: dir },
        fileHost: {
          ticker: {
            intervalMs: 50,
            ttlMs: 1_000,
            onReport: (r) => {
              if (r.outcome === 'ran') resolveRan()
            },
          },
        },
      })
      clients.push(client)
      await firstRan
      const snapBefore = client.caps
      await client.close()
      expect(() => client.caps).not.toThrow()
      expect(client.caps).toBe(snapBefore)
    }
  })
})

describe('HS-175 legacy write-refused board (tasks_schema=99) via connect() in Mode 1 and owned Mode 0', () => {
  it('HS-175 opens read-only with writable:false, null ids, no manifest, manifest-unverified warning, refused writes and refused tick', async () => {
    const dir = tmp()
    const bdir = join(dir, 'legacy')
    fs.mkdirSync(bdir, { mode: 0o700 })
    const db = join(bdir, 'board.db')
    makeLegacyFile(db, 'sliceA')
    const raw = new DatabaseSync(db)
    raw.prepare("INSERT OR REPLACE INTO board_meta (key, value) VALUES ('tasks_schema', '99')").run()
    const eventCountBefore = Number(
      (raw.prepare('SELECT COUNT(*) AS n FROM board_events').get() as { n: number }).n,
    )
    raw.close()

    const ada = createLocalCaller({ userId: 'ada' })
    const expectedMsg = 'this board was written by a newer Swarmboard (tasks_schema 99)'

    // Mode 1 via connect({ db }) with real FileHost
    let resolveTick!: (r: TickReport) => void
    const firstTick = new Promise<TickReport>((r) => {
      resolveTick = r
    })
    const m1 = await connect({
      db,
      caller: ada,
      context: { env: {}, cwd: dir, home: dir },
      fileHost: {
        ticker: {
          intervalMs: 50,
          ttlMs: 1_000,
          onReport: (r) => resolveTick(r),
        },
      },
    })
    clients.push(m1)

    expect(m1.caps.writable).toBe(false)
    expect(m1.caps.boardId).toBeNull()
    expect(m1.caps.instanceId).toBeNull()
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(false)
    expect(m1.warnings.some((w) => w.topic === 'manifest' && w.note.includes('manifest-unverified'))).toBe(true)

    expect((await m1.me()).actor).toBe('local:user:ada')
    await expect(m1.channel('dev').messages()).resolves.toBeDefined()

    const m1PostErr = await expectError(() => m1.post('dev', 'blocked'), { status: 503, code: 'unavailable' })
    expect(m1PostErr?.message).toBe(expectedMsg)
    expect(m1PostErr?.retryAfter).toBeUndefined()
    expect((m1.raw as SharedFileTransport).stats().busyRetries).toBe(0)

    const tickReport = await firstTick
    expect(tickReport.outcome).toBe('refused')
    await m1.close()

    // Owned Mode 0 via connect({ inProcess: true, db })
    const m0 = await connect({
      inProcess: true,
      db,
      caller: ada,
      context: { env: {}, cwd: dir, home: dir },
    })
    clients.push(m0)

    expect(m0.caps.writable).toBe(false)
    expect(m0.caps.boardId).toBeNull()
    expect(m0.caps.instanceId).toBeNull()
    expect(fs.existsSync(`${db}.manifest.json`)).toBe(false)
    expect(m0.warnings.some((w) => w.topic === 'manifest' && w.note.includes('manifest-unverified'))).toBe(true)

    expect((await m0.me()).actor).toBe('local:user:ada')
    await expect(m0.channel('dev').messages()).resolves.toBeDefined()

    const m0PostErr = await expectError(() => m0.post('dev', 'blocked'), { status: 503, code: 'unavailable' })
    expect(m0PostErr?.message).toBe(expectedMsg)
    expect(m0PostErr?.retryAfter).toBeUndefined()
    await m0.close()

    const check = new DatabaseSync(db, { readOnly: true })
    try {
      const eventCountAfter = Number(
        (check.prepare('SELECT COUNT(*) AS n FROM board_events').get() as { n: number }).n,
      )
      expect(eventCountAfter).toBe(eventCountBefore)
    } finally {
      check.close()
    }
  })
})

describe('V2-17 connect() Mode 2 (daemon), Mode 3 (service), auto live discovery & Mode 4 (remote HTTP)', () => {
  it('connect({ mode: "auto" }) discovers live daemon, mode: "service" binds live daemon, and connect({ url }) uses HttpTransport', async () => {
    const { runDaemonServer } = await import('../../src/host/daemon/index.ts')
    const dir = tmp()
    const db = join(dir, 'board.db')
    const runDir = join(dir, 'run')

    const handle = await runDaemonServer({
      db,
      runDir,
      idleExitS: 0,
      tcp: { host: '127.0.0.1', port: 0 },
      tick: 'off',
    })
    try {
      // 1. mode: 'auto' discovers live daemon over UDS without spawning a second one
      const autoClient = await connect({
        db,
        mode: 'auto',
        as: 'agy',
        context: { env: {}, cwd: dir, home: dir },
        daemon: { runDir },
      })
      clients.push(autoClient)
      expect(autoClient.selection.mode).toBe('service')
      expect(autoClient.caps.transport).toBe('uds')
      const posted = await autoClient.post('dev', 'hello via auto->uds')
      expect(posted.text).toBe('hello via auto->uds')
      await autoClient.close()

      // 2. mode: 'service' connects over UDS to the live daemon
      const svcClient = await connect({
        db,
        mode: 'service',
        as: 'codex',
        context: { env: {}, cwd: dir, home: dir },
        daemon: { runDir },
      })
      clients.push(svcClient)
      expect(svcClient.selection.mode).toBe('service')
      const msgs = await svcClient.channel('dev').messages()
      expect(msgs.messages.some((m) => m.text === 'hello via auto->uds')).toBe(true)
      await svcClient.close()

      // 3. Mode 4 URL target connects via HttpTransport to loopback HTTP endpoint
      const urlClient = await connect({
        url: handle.tcp!.url,
        as: 'claude',
        context: { env: {}, cwd: dir, home: dir },
      })
      clients.push(urlClient)
      expect(urlClient.selection.mode).toBe('remote')
      expect(urlClient.caps.transport).toBe('tcp')
      const reply = await urlClient.reply(posted.id, 'reply over Mode 4 HTTP')
      expect(reply.text).toBe('reply over Mode 4 HTTP')
      await urlClient.close()
    } finally {
      await handle.close()
    }
  })
})
