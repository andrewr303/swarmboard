// Per-identity FIFO write lanes (HOST123_DESIGN 3, 6.3, CR-15). Thin: runtime imports only ./errors.ts.
// Writes for one identity run one at a time in arrival order; reads and waits bypass the lane.
import type { CallerContext } from '../core/public.ts'
import { clientError, type BoardErrorLike } from './errors.ts'

interface QueuedWrite {
  readonly signal: AbortSignal | undefined
  readonly run: () => void
  readonly reject: (error: unknown) => void
  readonly cleanup: () => void
  settled: boolean
}

interface LaneState {
  running: boolean
  readonly queue: QueuedWrite[]
}

export class Lanes {
  private readonly max: number
  private readonly lanes = new Map<string, LaneState>()

  constructor(opts: { max: number }) {
    if (!Number.isInteger(opts.max) || opts.max < 0) {
      throw new RangeError(`lane max must be a non-negative integer: ${String(opts.max)}`)
    }
    this.max = opts.max
  }

  /**
   * Writes FIFO per key, one at a time; 'read' and 'wait' run at once. `max` counts the writes WAITING in a lane,
   * not the one running (CR-15): with max 2 a lane accepts 1 running + 2 waiting, and a 4th write rejects
   * ClientError 503 backpressure_shed (retryAfter 1) without running. A queued write whose signal aborts leaves
   * the queue and rejects with signal.reason.
   */
  run<T>(key: string, kind: 'read' | 'write' | 'wait', fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (kind !== 'write') {
      try {
        return Promise.resolve(fn())
      } catch (error) {
        return Promise.reject(error)
      }
    }

    if (signal?.aborted) {
      return Promise.reject(signal.reason)
    }

    const existing = this.lanes.get(key)
    if (!existing || !existing.running) {
      const lane: LaneState = existing ?? { running: true, queue: [] }
      lane.running = true
      this.lanes.set(key, lane)
      return new Promise<T>((resolve, reject) => {
        this.startWrite(key, lane, fn, resolve, reject)
      })
    }

    if (existing.queue.length >= this.max) {
      return Promise.reject(
        clientError('backpressure_shed', 'too many queued writes for this identity: try again', { retryAfter: 1 }),
      )
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (entry.settled) return
        entry.settled = true
        const idx = existing.queue.indexOf(entry)
        if (idx >= 0) existing.queue.splice(idx, 1)
        entry.cleanup()
        reject(signal!.reason)
      }

      const entry: QueuedWrite = {
        signal,
        settled: false,
        run: () => {
          this.startWrite(key, existing, fn, resolve, reject)
        },
        reject,
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort)
        },
      }

      existing.queue.push(entry)
      signal?.addEventListener('abort', onAbort, { once: true })
    })
  }

  /** Lanes with queued or running writes. Empty lanes are deleted. */
  size(): number {
    return this.lanes.size
  }

  /** Board stopped: every queued entry across all lanes rejects with `error`. */
  rejectAll(error: BoardErrorLike): void {
    for (const [key, lane] of this.lanes) {
      const pending = lane.queue.splice(0)
      for (const entry of pending) {
        if (entry.settled) continue
        entry.settled = true
        entry.cleanup()
        entry.reject(error)
      }
      if (!lane.running && lane.queue.length === 0) {
        this.lanes.delete(key)
      }
    }
  }

  private startWrite<T>(
    key: string,
    lane: LaneState,
    fn: () => Promise<T>,
    resolve: (value: T) => void,
    reject: (reason?: unknown) => void,
  ): void {
    let promise: Promise<T>
    try {
      promise = Promise.resolve(fn())
    } catch (error) {
      promise = Promise.reject(error)
    }
    promise.then(
      (value) => {
        this.advance(key, lane)
        resolve(value)
      },
      (error) => {
        this.advance(key, lane)
        reject(error)
      },
    )
  }

  private advance(key: string, lane: LaneState): void {
    while (lane.queue.length > 0) {
      const next = lane.queue.shift()!
      if (next.settled) continue
      next.settled = true
      next.cleanup()
      if (next.signal?.aborted) {
        next.reject(next.signal.reason)
        continue
      }
      next.run()
      return
    }
    lane.running = false
    this.lanes.delete(key)
  }
}

export const laneKey = (caller: CallerContext): string => `${caller.principal.id}\u001f${caller.profile ?? ''}`
