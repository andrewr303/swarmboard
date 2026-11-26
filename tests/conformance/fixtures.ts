// Shared fixtures for the transport tests (HOST123_DESIGN 5.8, stage B4): identities, board builders with a
// deterministic clock and ids, the minimal fixture input of every op (CF-02), the bad-input table (CF-03), the
// placeholder normalization (CF-12) and the error-code recorder (HS-71).
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { BoardService, createLocalCaller, SqliteUnifiedStore, type BoardServiceOptions, type SqliteStoreOptions } from '../../src/core/public.ts'
import type { ConformanceTarget, IdentitySpec } from '../../src/client/conformance.ts'
import { isBoardError } from '../../src/client/errors.ts'
import { fixedIdentity, localIdentity, type IdentityProvider } from '../../src/client/identity.ts'
import { OPS, UNIVERSAL_ERRORS, type OpName } from '../../src/client/ops.ts'
import { InProcessTransport } from '../../src/client/transport-inproc.ts'
import type { BoardTransport, CallOptions } from '../../src/client/types.ts'

// ---- identities

/** The conformance identities: `ada` is every target's transport identity, `bob` the default peer. */
export const IDS: Readonly<Record<string, IdentitySpec>> = Object.freeze({
  ada: { userId: 'ada', profiles: ['w1', 'w2'] },
  bob: { userId: 'bob' },
  eve: { userId: 'eve', can: 'pub=all' },
  blind: { userId: 'blind', can: 'drop=post' },
  /** ada narrowed to reading `conf` (the original's x-board-can check, :878). */
  adaRead: { userId: 'ada', can: 'conf=read' },
  /** The board owner (grants). */
  boss: { userId: 'boss', owner: true },
  /** Not a member: admitted only by an explicit grant. */
  carl: { userId: 'carl', member: false },
})

/** A provider for a spec: a narrowed (`can`) caller is fixed; anything else a local identity, member by default. */
export function providerFor(spec: IdentitySpec): IdentityProvider {
  if (spec.can !== undefined) {
    return fixedIdentity(
      createLocalCaller({
        userId: spec.userId,
        handle: spec.userId,
        member: spec.member ?? true,
        owner: spec.owner ?? false,
        profile: spec.profile ?? null,
        canHeader: spec.can,
      }),
    )
  }
  return localIdentity({
    userId: spec.userId,
    member: spec.member ?? true,
    owner: spec.owner ?? false,
    profiles: spec.profiles ?? (spec.profile !== undefined ? [spec.profile] : []),
    defaultProfile: spec.profile ?? null,
  })
}

/** The B4 fixture identity: localIdentity({userId:'ada', profiles:['w1','w2'], member:true}). */
export const ada = (): IdentityProvider => localIdentity({ userId: 'ada', profiles: ['w1', 'w2'], member: true })

// ---- boards

const dirs: string[] = []

export function tempDir(prefix = 'cb-b4-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}

export function removeTempDirs(): void {
  while (dirs.length > 0) {
    const dir = dirs.pop()!
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // best effort
    }
  }
}

/** A clock that only moves when told to; starts at a fixed instant. */
export function manualClock(start = Date.parse('2026-11-24T10:00:00.000Z')): { now: () => number; advance(ms: number): void } {
  let t = start
  return {
    now: () => t,
    advance(ms: number) {
      t += ms
    },
  }
}

/** Deterministic board and instance ids. */
export function idSequence(seed = 'fx'): (prefix: 'b_' | 'i_') => string {
  let n = 0
  return (prefix) => `${prefix}${seed}${String(++n).padStart(20, '0')}`
}

export interface TestBoard {
  readonly store: SqliteUnifiedStore
  readonly board: BoardService
  close(): void
}

/** A store and a service on `path` (':memory:' or a file), optionally with a clock, ids and store hooks. */
export function openTestBoard(
  path: string,
  opts: { now?: () => number; newId?: (prefix: 'b_' | 'i_') => string; testHooks?: SqliteStoreOptions['testHooks']; boardOptions?: BoardServiceOptions } = {},
): TestBoard {
  const testHooks = { ...(opts.testHooks ?? {}), ...(opts.newId !== undefined ? { newId: opts.newId } : {}) }
  const store = new SqliteUnifiedStore({ path, testHooks })
  const board = new BoardService(store, { ...(opts.now !== undefined ? { now: opts.now } : {}), ...(opts.boardOptions ?? {}) })
  return {
    store,
    board,
    close() {
      try {
        store.close()
      } catch {
        // already closed
      }
    },
  }
}

// ---- the in-process conformance target (Mode 0 on a file board)

/** A clock that follows real time, shifted by advance(). */
export function shiftedClock(): { now: () => number; advance(ms: number): void } {
  let offset = 0
  return {
    now: () => Date.now() + offset,
    advance(ms: number) {
      offset += ms
    },
  }
}

/**
 * The `in-process` target: a file board per open(), the transport owning its store; peers and external posts use
 * other connections to the same file (another SqliteUnifiedStore and BoardService, so each has its own key guard).
 */
export function inProcessTarget(name = 'in-process'): ConformanceTarget {
  return {
    name,
    features: { crossProcess: false, busyRetry: false, lanes: false, identityEvents: false, crashInjection: false, clock: true },
    async open(dir, ids) {
      const path = join(dir, 'board.db')
      const clock = shiftedClock()
      const closers: (() => Promise<void> | void)[] = []
      const connect = (spec: IdentitySpec): BoardTransport => {
        const { store, board } = openTestBoard(path, { now: clock.now })
        const t = new InProcessTransport({ board, identity: providerFor(spec), owned: { store, close: () => store.close() } })
        closers.push(() => t.close())
        return recorded(t)
      }
      const spec = (as: string): IdentitySpec => {
        const found = ids[as]
        if (found === undefined) throw new Error(`no identity ${as}`)
        return found
      }
      const transport = connect(spec('ada'))
      const external = openTestBoard(path, { now: clock.now })
      closers.push(() => external.close())
      const poster = createLocalCaller({ userId: 'ext', handle: 'ext', member: true })
      return {
        transport,
        peer: async (as = 'bob') => connect(spec(as)),
        async externalPost(channel, text) {
          const { message } = external.board.postMessage(poster, { channel, text }) as { message: { id: string } }
          return { id: message.id, index: external.store.getHeadIndex() }
        },
        clock,
        async close() {
          for (const close of closers.reverse()) await close()
        },
      }
    },
  }
}

// ---- placeholders (CF-12)

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi
const ATT = /\batt_[A-Za-z0-9_-]+/g
const UPLOAD = /\bup_[A-Za-z0-9_-]+/g
const TOKEN = /(?<![A-Za-z0-9_-])[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-])/g
const LEASE = /\b(?:ls|lease)_[A-Za-z0-9_-]+/g

/**
 * The JSON form of a value with minted ids replaced by stable placeholders in order of first appearance: thread
 * UUIDs, att_/up_ ids, leases and 43-character tokens. Bytes compare by content.
 */
export function placeholders(value: unknown): unknown {
  const seen = new Map<string, string>()
  const swap = (kind: string) => (found: string): string => {
    let p = seen.get(found)
    if (p === undefined) {
      p = `<${kind}${seen.size + 1}>`
      seen.set(found, p)
    }
    return p
  }
  // Claim tokens the core mints are 22 characters: any string under a `token` key is a placeholder too.
  const text = JSON.stringify(value, (k, v: unknown) =>
    v instanceof Uint8Array ? { bytes: Buffer.from(v).toString('base64') } : k === 'token' && typeof v === 'string' ? swap('token')(v) : v,
  )
  if (text === undefined) return undefined
  const replaced = text
    .replace(UUID, swap('uuid'))
    .replace(ATT, swap('att'))
    .replace(UPLOAD, swap('up'))
    .replace(LEASE, swap('lease'))
    .replace(TOKEN, swap('token'))
  return JSON.parse(replaced) as unknown
}

/** How a call settled, as JSON: the value, or the error's status, code and message. */
export async function settle(run: () => unknown): Promise<unknown> {
  try {
    return { ok: placeholders(await run()) }
  } catch (error) {
    if (isBoardError(error)) return { error: { status: error.status, code: error.code, message: error.message } }
    return { thrown: String(error) }
  }
}

// ---- error-code recorder (HS-71)

/** Every (op, code) a recorded transport rejected with, across the file. */
export const SEEN_ERRORS: { op: string; code: string }[] = []

/**
 * A transport that delegates to `t` and records the (op, code) of every BoardErrorLike its calls reject with
 * (HS-71). A delegate, not a prototype copy: transports keep their state in private fields.
 */
export function recorded<T extends BoardTransport>(t: T): BoardTransport & { readonly inner: T } {
  return {
    inner: t,
    get capabilities() {
      return t.capabilities
    },
    get closed() {
      return t.closed
    },
    async call(op: OpName, input: unknown, opts?: CallOptions) {
      try {
        return await t.call(op, input as never, opts)
      } catch (error) {
        if (isBoardError(error)) SEEN_ERRORS.push({ op, code: error.code })
        throw error
      }
    },
    events: (query, opts) => t.events(query, opts),
    close: () => t.close(),
  } as BoardTransport & { readonly inner: T }
}

/** The recorded pairs whose code is neither universal nor listed for the op. */
export function unlistedErrors(pairs: readonly { op: string; code: string }[] = SEEN_ERRORS): string[] {
  const out = new Set<string>()
  for (const { op, code } of pairs) {
    if (UNIVERSAL_ERRORS.includes(code)) continue
    const spec = (OPS as Readonly<Record<string, { errors: readonly string[] }>>)[op]
    if (spec !== undefined && spec.errors.includes(code)) continue
    out.add(`${op}: ${code}`)
  }
  return [...out].sort()
}

// ---- fixture inputs (CF-02)

type Rec = Record<string, unknown>
type Fixture = (t: BoardTransport) => Promise<Rec>
const call = (t: BoardTransport, op: OpName, input: Rec, opts?: CallOptions): Promise<Rec> =>
  t.call(op, input as never, opts) as unknown as Promise<Rec>
const any = (v: unknown): Rec => v as Rec

export const platformUser = (id: string, handle = 'malte'): Rec => ({ id, handle, name: 'Malte Ubl', avatar: null, isBot: false })

export async function fxPost(t: BoardTransport, text = 'fixture', channel = 'dev', extra: Rec = {}): Promise<Rec> {
  return any((await call(t, 'post', { channel, text, ...extra }))['message'])
}
export async function fxTask(t: BoardTransport, text = 'fixture task', channel = 'work'): Promise<Rec> {
  return any((await call(t, 'createTask', { channel, text }))['task'])
}
export async function fxClaim(t: BoardTransport): Promise<{ id: unknown; epoch: number; token: string }> {
  const task = await fxTask(t)
  const claimed = await call(t, 'claimTask', { id: task['id'] })
  const claim = any(claimed['claim'])
  return { id: task['id'], epoch: claim['epoch'] as number, token: claim['token'] as string }
}
const fxSync = (t: BoardTransport): Promise<Rec> => call(t, 'register', { watch: {}, sync: [{ key: 'slack', platform: 'slack' }] })
const fxGrant = async (t: BoardTransport): Promise<Rec> =>
  call(t, 'createGrant', { principals: [{ kind: 'user', userId: 'bob' }], can: { fx: ['read'] } })
const TARGET = 'slack:C1:1700.1'

/** The minimal valid input of every op, with what it needs set up first through the same transport (as ada). */
export const FIXTURES: Readonly<Record<OpName, Fixture>> = {
  ack: async (t) => {
    await call(t, 'register', { watch: { w: { tail: 'dev' } } })
    await fxPost(t, 'for the watcher')
    const [match] = (await call(t, 'matches', {})) as unknown as Rec[]
    return { id: match?.['id'] ?? 'm_none', lease: match?.['lease'] ?? 'none' }
  },
  ackAllNotifications: async () => ({}),
  ackNotification: async (t) => {
    await call(t, 'post', { channel: 'dev', text: 'ping @ada' }, { as: 'w1' })
    const page = await call(t, 'notifications', {})
    const list = page['notifications'] as Rec[]
    return { id: String(list[0]?.['id'] ?? '1') }
  },
  actors: async () => ({}),
  addGroupMembers: async (t) => {
    await call(t, 'createGroup', { handle: 'fx-team', name: 'Fixture Team' })
    return { handle: 'fx-team', members: ['bob'] }
  },
  agentInbox: async () => ({}),
  assignTask: async (t) => ({ id: (await fxTask(t))['id'], for: null }),
  attachment: async (t) => ({ id: (await call(t, 'upload', { name: 'a.txt', type: 'text/plain', data: new Uint8Array([104, 105]) }))['id'] }),
  blockTask: async (t) => ({ id: (await fxTask(t))['id'], reason: 'waiting' }),
  cancelSchedule: async (t) => ({ id: (await call(t, 'schedule', { channel: 'dev', text: 'later', in: '1h' }))['id'] }),
  cancelTask: async (t) => ({ id: (await fxTask(t))['id'], reason: 'not needed' }),
  channelMessages: async () => ({ channel: 'dev' }),
  channelTree: async () => ({}),
  channels: async () => ({}),
  claimReadyTask: async (t) => {
    await fxTask(t, 'ready to claim')
    return { channel: 'work' }
  },
  claimTask: async (t) => ({ id: (await fxTask(t))['id'] }),
  completeTask: async (t) => ({ ...(await fxClaim(t)), result: 'done' }),
  createChannel: async () => ({ path: 'fx' }),
  createGrant: async () => ({ principals: [{ kind: 'user', userId: 'bob' }], can: { fx: ['read'] } }),
  createGrants: async () => ({ grants: [{ principals: [{ kind: 'user', userId: 'bob' }], can: { fx: ['read'] } }] }),
  createGroup: async () => ({ handle: 'fx-team', name: 'Fixture Team' }),
  createSchema: async () => ({ name: 'fx', version: 1, schema: { type: 'object' } }),
  createTask: async () => ({ channel: 'work', text: 'a task' }),
  createTasks: async () => ({ channel: 'work', tasks: [{ text: 'one' }, { text: 'two' }] }),
  createdTasks: async (t) => {
    await call(t, 'createTasks', { channel: 'work', id: 'fx-batch', tasks: [{ text: 'one' }] })
    return { id: 'fx-batch' }
  },
  delete: async (t) => ({ id: (await fxPost(t))['id'] }),
  deleteGroup: async (t) => {
    await call(t, 'createGroup', { handle: 'fx-team', name: 'Fixture Team' })
    return { handle: 'fx-team' }
  },
  edit: async (t) => ({ id: (await fxPost(t))['id'], text: 'edited' }),
  ensureDm: async () => ({ peer: 'bob' }),
  events: async () => ({}),
  explain: async () => ({ channel: 'dev' }),
  failTask: async (t) => ({ ...(await fxClaim(t)), reason: 'it broke' }),
  grants: async () => ({}),
  group: async (t) => {
    await call(t, 'createGroup', { handle: 'fx-team', name: 'Fixture Team' })
    return { handle: 'fx-team' }
  },
  groups: async () => ({}),
  inbox: async (t) => {
    await fxSync(t)
    return { key: 'slack' }
  },
  inboxAck: async (t) => {
    await fxSync(t)
    await call(t, 'inboxPush', {
      key: 'slack',
      events: [{ id: 'ev-1', event: { kind: 'deleted', channel: 'slack:C1', thread: TARGET, subthread: null, message: '1700.1' }, raw: {} }],
    })
    const [item] = (await call(t, 'inboxNext', { key: 'slack' })) as unknown as Rec[]
    return { key: 'slack', id: item?.['id'] ?? 'none', lease: item?.['lease'] ?? 'none' }
  },
  inboxNext: async (t) => {
    await fxSync(t)
    return { key: 'slack' }
  },
  inboxPush: async (t) => {
    await fxSync(t)
    return {
      key: 'slack',
      events: [{ id: 'ev-1', event: { kind: 'deleted', channel: 'slack:C1', thread: TARGET, subthread: null, message: '1700.1' }, raw: {} }],
    }
  },
  label: async (t) => ({ id: (await fxPost(t))['id'], set: { state: 'open' } }),
  markChannelRead: async (t) => {
    await fxPost(t, 'read me', 'dev')
    return { channel: 'dev' }
  },
  matches: async (t) => {
    await call(t, 'register', { watch: { w: { tail: 'dev' } } })
    return {}
  },
  me: async () => ({}),
  message: async (t) => ({ id: (await fxPost(t))['id'] }),
  notificationCount: async () => ({}),
  notifications: async () => ({}),
  pinMessage: async (t) => ({ id: (await fxPost(t))['id'], scope: 'channel' }),
  pins: async () => ({}),
  post: async () => ({ channel: 'dev', text: 'hello' }),
  posted: async (t) => {
    await fxPost(t, 'with a client id', 'dev', { id: 'fx-client-1' })
    return { id: 'fx-client-1' }
  },
  presence: async () => ({}),
  react: async (t) => ({ id: (await fxPost(t))['id'], emoji: 'eyes' }),
  register: async () => ({ watch: { w: { tail: 'dev' } } }),
  releaseTask: async (t) => {
    const { id, epoch, token } = await fxClaim(t)
    return { id, epoch, token }
  },
  removeGroupMembers: async (t) => {
    await call(t, 'createGroup', { handle: 'fx-team', name: 'Fixture Team', members: ['bob'] })
    return { handle: 'fx-team', members: ['bob'] }
  },
  renewTask: async (t) => {
    const { id, epoch, token } = await fxClaim(t)
    return { id, epoch, token }
  },
  reopenTask: async (t) => {
    const { id, epoch, token } = await fxClaim(t)
    await call(t, 'failTask', { id, epoch, token, reason: 'for reopen' })
    return { id }
  },
  revokeGrant: async (t) => ({ id: any((await fxGrant(t)))['id'] }),
  schedule: async () => ({ channel: 'dev', text: 'later', in: '1h' }),
  schedules: async () => ({}),
  schema: async (t) => {
    await call(t, 'createSchema', { name: 'fx', version: 1, schema: { type: 'object' } })
    return { id: 'fx@1' }
  },
  schemas: async () => ({}),
  search: async () => ({ query: 'fixture' }),
  setPresence: async () => ({ status: 'active', channel: 'dev', note: 'testing' }),
  setTaskNeeds: async (t) => {
    const a = await fxTask(t, 'needs another')
    const b = await fxTask(t, 'needed')
    return { id: a['id'], needs: [String(b['id'])] }
  },
  sync: async (t) => {
    await fxSync(t)
    return { id: (await fxPost(t))['id'], target: TARGET }
  },
  syncCopies: async (t) => ({ message: [String((await fxPost(t))['id'])] }),
  syncFind: async () => ({ thread: TARGET }),
  syncImport: async (t) => {
    await fxSync(t)
    return { op: 'post', author: platformUser('slack:U1'), from: 'slack', channel: 'dev', text: 'from slack' }
  },
  syncReceipt: async (t) => {
    await fxSync(t)
    const id = (await fxPost(t))['id']
    await call(t, 'sync', { id, target: TARGET })
    return { kind: 'message', message: id, target: TARGET, external: { thread: TARGET, message: '1700.1' } }
  },
  syncThread: async (t) => {
    await fxSync(t)
    return { thread: String((await fxPost(t))['thread']) }
  },
  synced: async (t) => ({ id: (await fxPost(t))['id'] }),
  tasks: async () => ({}),
  threads: async () => ({}),
  unblockTask: async (t) => {
    const task = await fxTask(t)
    await call(t, 'blockTask', { id: task['id'], reason: 'waiting' })
    return { id: task['id'] }
  },
  unpinMessage: async (t) => {
    const msg = await fxPost(t)
    await call(t, 'pinMessage', { id: msg['id'], scope: 'channel' })
    return { id: msg['id'] }
  },
  updateChannel: async (t) => {
    await call(t, 'createChannel', { path: 'fx' })
    return { path: 'fx', topic: 'updated topic' }
  },
  updateGrant: async (t) => ({ id: any(await fxGrant(t))['id'], can: { fx: ['read', 'post'] } }),
  updateGroup: async (t) => {
    await call(t, 'createGroup', { handle: 'fx-team', name: 'Fixture Team' })
    return { handle: 'fx-team', description: 'updated desc' }
  },
  upload: async () => ({ name: 'a.txt', type: 'text/plain', data: new Uint8Array([104, 105]) }),
  uploadFinish: async (t) => ({ id: (await call(t, 'uploadStart', { name: 'b.bin', size: 2 }))['id'], data: new Uint8Array([1, 2]) }),
  uploadStart: async () => ({ name: 'b.bin', size: 2 }),
  waitNotifications: async () => ({ wait: 0 }),
  watchers: async () => ({}),
}

// ---- the bad-input table (CF-03, HS-62)

export interface BadInput {
  readonly name: string
  readonly op: string
  readonly input: unknown
  /** Text the 400's message must contain. */
  readonly names?: string
  /** The core method the input would bind to (a spy on it must see 0 calls). */
  readonly method: { readonly service: 'board' | 'tasks'; readonly name: string }
}

export const BAD_INPUTS: readonly BadInput[] = [
  { name: 'a non-object input', op: 'post', input: 5, method: { service: 'board', name: 'postMessage' } },
  { name: 'a missing ref param', op: 'edit', input: { text: 'x' }, names: 'id', method: { service: 'board', name: 'editMessage' } },
  { name: 'a fractional ref', op: 'edit', input: { id: 1.5, text: 'x' }, names: 'id', method: { service: 'board', name: 'editMessage' } },
  { name: 'an object ref', op: 'edit', input: { id: {}, text: 'x' }, names: 'id', method: { service: 'board', name: 'editMessage' } },
  { name: 'a string int param', op: 'inbox', input: { key: 'k', limit: '50' }, names: 'limit', method: { service: 'board', name: 'listInbox' } },
  { name: 'a key on a bodiless op', op: 'me', input: { x: 1 }, names: 'x: not a field of me', method: { service: 'board', name: 'me' } },
  {
    name: 'a Date in the body',
    op: 'post',
    input: { channel: 'dev', text: 't', labels: { d: new Date(0) } },
    names: 'labels.d',
    method: { service: 'board', name: 'postMessage' },
  },
  { name: 'a function in the body', op: 'search', input: { query: 'x', filter: () => true }, names: 'filter', method: { service: 'board', name: 'search' } },
]
