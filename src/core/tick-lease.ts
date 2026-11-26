// HOST-0 C7 (HOST0_DESIGN 3.10): the tick lease, a single-holder lease kept in board_meta through
// getMeta/casMeta. Internal (internal.ts only). It is an efficiency measure: two tickers that both believe
// they hold it still cannot double-send, because every send is a compare-and-set on the schedule's next_at
// (BoardService.fireScheduleInTx). Lease writes append no event and emit no wakeup.
import type { StorageBackend } from './storage.ts'

export const TICK_LEASE_KEY = 'host.tick.lease'
export const TICK_LEASE_TTL_MIN_MS = 1_000
export const TICK_LEASE_TTL_MAX_MS = 300_000

/** What board_meta[key] holds, as JSON with the keys in this order. Never deleted: a release writes `until: 0`. */
export type TickLeaseRecord = { v: 1; holder: string; fence: number; until: number; at: number }
/** A held lease: the record's identity at acquire time. `until` is informational for the holder. */
export type TickLease = Readonly<{ key: string; holder: string; fence: number; until: number }>
export type LeaseClock = () => number
export type MetaStore = Pick<StorageBackend, 'transaction' | 'getMeta' | 'casMeta'>
export type AcquireResult =
  | { acquired: true; lease: TickLease; takeover: boolean; corrupt: boolean }
  | { acquired: false; holder: string; fence: number; until: number }

const HOLDER = /^[\x21-\x7e]{1,200}$/

function checkKey(key: string): void {
  if (typeof key !== 'string' || !key.startsWith('host.')) throw new RangeError(`tick lease key must start with "host.": ${String(key)}`)
}
function checkTtl(ttlMs: number): void {
  if (!Number.isInteger(ttlMs) || ttlMs < TICK_LEASE_TTL_MIN_MS || ttlMs > TICK_LEASE_TTL_MAX_MS) {
    throw new RangeError(`ttlMs must be an integer from ${TICK_LEASE_TTL_MIN_MS} to ${TICK_LEASE_TTL_MAX_MS}: ${String(ttlMs)}`)
  }
}
function checkHolder(holder: string): void {
  if (typeof holder !== 'string' || !HOLDER.test(holder)) throw new RangeError('holder must be 1 to 200 printable ASCII characters without spaces')
}

function parseRecord(raw: string | undefined): TickLeaseRecord | null {
  if (raw === undefined) return null
  let value: unknown
  try {
    value = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof value !== 'object' || value === null) return null
  const r = value as Record<string, unknown>
  if (
    r.v !== 1 ||
    typeof r.holder !== 'string' ||
    !HOLDER.test(r.holder) ||
    typeof r.fence !== 'number' ||
    !Number.isSafeInteger(r.fence) ||
    r.fence < 1 ||
    typeof r.until !== 'number' ||
    !Number.isFinite(r.until) ||
    typeof r.at !== 'number' ||
    !Number.isFinite(r.at)
  ) {
    return null
  }
  return { v: 1, holder: r.holder, fence: r.fence, until: r.until, at: r.at }
}

/** The fence a damaged record still carries: a JSON object with a positive safe-integer `fence`, else 0 (SEC-7). */
function carriedFence(raw: string | undefined): number {
  if (raw === undefined) return 0
  try {
    const value = JSON.parse(raw) as unknown
    if (typeof value === 'object' && value !== null) {
      const f = (value as { fence?: unknown }).fence
      if (typeof f === 'number' && Number.isSafeInteger(f) && f > 0) return f
    }
  } catch {
    // Not parseable at all: the one case the fence restarts.
  }
  return 0
}

const encode = (holder: string, fence: number, until: number, at: number): string =>
  JSON.stringify({ v: 1, holder, fence, until, at } satisfies TickLeaseRecord)

/** Unlocked read. Null when the key is absent or its record is unparseable or invalid. Works on a refused board. */
export function readTickLease(store: Pick<MetaStore, 'getMeta'>, key: string = TICK_LEASE_KEY): TickLeaseRecord | null {
  checkKey(key)
  return parseRecord(store.getMeta(key))
}

/**
 * Takes the lease for `ttlMs`, or says who holds it. A lease is live while `until > now` and may be taken
 * over at `now >= until`, never earlier. A holder that is not live anywhere costs one unlocked read.
 *
 * `holder` must be unique per process instance, for example `${os.hostname()}:${process.pid}:${randomUUID()}`
 * minted once at process start (SEC-7). A same-holder acquire is treated as the same process re-acquiring
 * (the fence is kept and `until` extended), so two processes that share a holder string would both believe
 * they hold the lease. Correctness still holds through the next_at compare-and-set, but the lease's
 * efficiency purpose is lost without notice.
 *
 * The clock is read after the write lock is taken. On a refused file (a newer schema, a replaced file) this
 * throws the refusal.
 */
export function acquireTickLease(
  store: MetaStore,
  opts: { holder: string; ttlMs: number; now: LeaseClock; key?: string },
): AcquireResult {
  const key = opts.key ?? TICK_LEASE_KEY
  checkKey(key)
  checkHolder(opts.holder)
  checkTtl(opts.ttlMs)
  const { holder, ttlMs, now } = opts

  const pre = readTickLease(store, key)
  if (pre !== null && pre.holder !== holder && pre.until > now()) {
    return { acquired: false, holder: pre.holder, fence: pre.fence, until: pre.until }
  }
  return store.transaction((): AcquireResult => {
    const raw = store.getMeta(key)
    const t = now()
    const cur = parseRecord(raw)
    const corrupt = raw !== undefined && cur === null
    if (cur !== null && cur.holder !== holder && cur.until > t) {
      return { acquired: false, holder: cur.holder, fence: cur.fence, until: cur.until }
    }
    const live = cur !== null && cur.holder === holder && cur.until > t
    const fence = cur !== null ? (live ? cur.fence : cur.fence + 1) : carriedFence(raw) + 1
    const until = t + ttlMs
    if (!store.casMeta(key, raw, encode(holder, fence, until, t))) {
      return { acquired: false, holder: cur?.holder ?? '', fence: cur?.fence ?? 0, until: cur?.until ?? 0 }
    }
    return {
      acquired: true,
      lease: Object.freeze({ key, holder, fence, until }),
      takeover: cur !== null && cur.holder !== holder,
      corrupt,
    }
  })
}

/**
 * Extends a held lease to `now + ttlMs`. Null when it was lost: another holder, another fence, or released.
 * A lease that expired but that nobody took over is renewed with its fence.
 */
export function renewTickLease(store: MetaStore, lease: TickLease, opts: { ttlMs: number; now: LeaseClock }): TickLease | null {
  checkTtl(opts.ttlMs)
  return store.transaction((): TickLease | null => {
    const raw = store.getMeta(lease.key)
    const t = opts.now()
    const cur = parseRecord(raw)
    if (cur === null || cur.holder !== lease.holder || cur.fence !== lease.fence || cur.until === 0) return null
    const until = t + opts.ttlMs
    if (!store.casMeta(lease.key, raw, encode(cur.holder, cur.fence, until, t))) return null
    return Object.freeze({ key: lease.key, holder: cur.holder, fence: cur.fence, until })
  })
}

/** Gives the lease up (`until: 0`, the fence kept). True when this call released it; false, with no write, when it was not this lease any more. */
export function releaseTickLease(store: MetaStore, lease: TickLease, opts: { now: LeaseClock }): boolean {
  return store.transaction((): boolean => {
    const raw = store.getMeta(lease.key)
    const t = opts.now()
    const cur = parseRecord(raw)
    if (cur === null || cur.holder !== lease.holder || cur.fence !== lease.fence || cur.until === 0) return false
    return store.casMeta(lease.key, raw, encode(cur.holder, cur.fence, 0, t))
  })
}
