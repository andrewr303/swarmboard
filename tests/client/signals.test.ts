// HS-192 (CON-2, F24): linking a call's signal to the transport's long-lived signals leaves no listener and no
// memory behind. Runs the leak check in a child Node process spawned with execArgv `--expose-gc` against an
// un-mocked InProcessTransport and real dispatch.ts (no vi.mock, no v8.setFlagsFromString).
import { execFile } from 'node:child_process'
import { getEventListeners } from 'node:events'
import { join, resolve } from 'node:path'
import { afterAll, describe, expect, it } from 'vitest'
import { linkSignals } from '../../src/client/dispatch.ts'
import { removeTempDirs, tempDir } from '../conformance/fixtures.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

interface Hs192ChildResult {
  readonly longLivedCount: number
  readonly before: readonly number[]
  readonly grown: number
  readonly after200k: readonly number[]
  readonly afterZeroWaits: readonly number[]
  readonly afterFeed: readonly number[]
  readonly rounds: number
  readonly posted: number
  readonly callerListeners: number
}

const CHILD = `
import { getEventListeners } from 'node:events'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

if (typeof globalThis.gc !== 'function') {
  throw new Error('HS-192 child expected --expose-gc to expose globalThis.gc')
}

const root = process.env.HS192_ROOT
const dbPath = process.env.HS192_DB
const load = (rel) => import(pathToFileURL(join(root, rel)).href)

const [{ BoardService, SqliteUnifiedStore }, { localIdentity }, { InProcessTransport }] = await Promise.all([
  load('src/core/public.ts'),
  load('src/client/identity.ts'),
  load('src/client/transport-inproc.ts'),
])

const store = new SqliteUnifiedStore({ path: dbPath })
const board = new BoardService(store)
const identity = localIdentity({ userId: 'ada', profiles: ['w1', 'w2'], member: true })
const t = new InProcessTransport({ board, identity, owned: { store, close: () => store.close() } })

try {
  // Capture the transport's 3 private long-lived AbortSignals (close, watch.stopSignal, watch.epochSignal)
  // during one probe call without mocking dispatch.ts, then restore the prototype before running the workload.
  const probeSignal = new AbortController().signal
  const internalSet = new Set()
  const hadOwn = Object.hasOwn(AbortSignal.prototype, 'addEventListener')
  const origAdd = AbortSignal.prototype.addEventListener
  AbortSignal.prototype.addEventListener = function (type, listener, options) {
    if (type === 'abort' && this !== probeSignal) internalSet.add(this)
    return origAdd.call(this, type, listener, options)
  }
  try {
    await t.call('me', {}, { signal: probeSignal })
  } finally {
    if (hadOwn) AbortSignal.prototype.addEventListener = origAdd
    else delete AbortSignal.prototype.addEventListener
  }

  const longLived = [...internalSet]
  const counts = () => longLived.map((s) => getEventListeners(s, 'abort').length)
  const before = counts()

  for (let i = 0; i < 1_000; i++) await t.call('me', {}, { signal: new AbortController().signal })
  globalThis.gc()
  const heap0 = process.memoryUsage().heapUsed
  for (let i = 0; i < 200_000; i++) await t.call('me', {}, { signal: new AbortController().signal })
  globalThis.gc()
  const grown = process.memoryUsage().heapUsed - heap0
  const after200k = counts()

  for (let i = 0; i < 1_000; i++) await t.call('events', { wait: 0 }, { signal: new AbortController().signal })
  const afterZeroWaits = counts()

  const controller = new AbortController()
  let rounds = 0
  let posted = 0
  const consumer = (async () => {
    for await (const page of t.events({ channel: 'dev' }, { signal: controller.signal })) {
      rounds += 1
      posted += page.events.filter((e) => e.type === 'message.posted').length
      if (posted >= 200) break
    }
  })()
  for (let i = 0; i < 200; i++) {
    await t.call('post', { channel: 'dev', text: 'p' + i })
    await new Promise((r) => setImmediate(r))
  }
  await consumer

  const afterFeed = counts()
  const callerListeners = getEventListeners(controller.signal, 'abort').length
  process.stdout.write(
    '\\n@@HS192@@' +
      JSON.stringify({
        longLivedCount: longLived.length,
        before,
        grown,
        after200k,
        afterZeroWaits,
        afterFeed,
        rounds,
        posted,
        callerListeners,
      }) +
      '\\n',
  )
} finally {
  await t.close()
}
`

function runHs192Child(dbPath: string): Promise<Hs192ChildResult> {
  return new Promise((resolvePromise, reject) => {
    execFile(
      process.execPath,
      ['--expose-gc', '--no-warnings', '--input-type=module', '-e', CHILD],
      {
        env: { ...process.env, HS192_ROOT: ROOT, HS192_DB: dbPath },
        timeout: 110_000,
        maxBuffer: 16 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error) return reject(new Error(`HS-192 child failed: ${error.message}\n${stderr}`))
        const marker = stdout.lastIndexOf('@@HS192@@')
        if (marker < 0) return reject(new Error(`HS-192 child printed no result\n${stdout}\n${stderr}`))
        resolvePromise(JSON.parse(stdout.slice(marker + '@@HS192@@'.length)) as Hs192ChildResult)
      },
    )
  })
}

afterAll(() => removeTempDirs())

describe('signals (HS-192)', () => {
  it('HS-192 linkSignals: dispose twice is fine, removes both listeners, and a later abort no longer reaches the link', () => {
    const a = new AbortController()
    const b = new AbortController()
    const link = linkSignals(a.signal, undefined, b.signal)
    expect(getEventListeners(a.signal, 'abort')).toHaveLength(1)
    expect(getEventListeners(b.signal, 'abort')).toHaveLength(1)
    link.dispose()
    link.dispose()
    expect(getEventListeners(a.signal, 'abort')).toHaveLength(0)
    expect(getEventListeners(b.signal, 'abort')).toHaveLength(0)
    b.abort(new Error('late'))
    expect(link.signal.aborted).toBe(false)

    const c = new AbortController()
    const linked = linkSignals(c.signal, a.signal)
    const reason = new Error('first')
    c.abort(reason)
    expect(linked.signal.aborted).toBe(true)
    expect(linked.signal.reason).toBe(reason)
    expect(getEventListeners(a.signal, 'abort')).toHaveLength(0)
    linked.dispose()

    const pre = linkSignals(AbortSignal.abort('already'), a.signal)
    expect(pre.signal.reason).toBe('already')
    expect(getEventListeners(a.signal, 'abort')).toHaveLength(0)
  })

  it(
    'HS-192 200,000 signalled calls, 1,000 zero waits and 200 feed rounds leave no listener and < 5 MB of heap (child --expose-gc, un-mocked)',
    async () => {
      const path = join(tempDir(), 'board.db')
      const res = await runHs192Child(path)
      expect(res.longLivedCount).toBe(3)
      expect(res.before).toEqual([0, 0, 0])
      expect(res.grown).toBeLessThan(5 * 1024 * 1024)
      expect(res.after200k).toEqual(res.before)
      expect(res.afterZeroWaits).toEqual(res.before)
      expect(res.posted).toBe(200)
      expect(res.rounds).toBeGreaterThan(0)
      expect(res.afterFeed).toEqual(res.before)
      expect(res.callerListeners).toBe(0)
    },
    120_000,
  )
})
