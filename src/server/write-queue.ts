// Fair single-loop FIFO write queue (HOST-9, Swarmboard v2 launch design §4.2).
// Runs one SQLite write at a time in strict arrival order and yields via setImmediate between
// dequeues so concurrent reads, timers, and SSE heartbeats never starve. Sheds overflow past
// maxDepth (default 512) with 503 backpressure_shed (Retry-After: 1).
import { clientError } from '../client/errors.ts'

export const DEFAULT_WRITE_QUEUE_MAX = 512

interface QueueEntry<T> {
  readonly fn: () => T | Promise<T>
  readonly signal: AbortSignal | undefined
  readonly resolve: (value: T) => void
  readonly reject: (reason: unknown) => void
  readonly cleanup: () => void
  settled: boolean
}

export interface WriteQueueOptions {
  /** Maximum waiting writes behind the currently running write (default 512). */
  readonly maxDepth?: number
}

export interface WriteQueueStats {
  readonly depth: number
  readonly inFlight: number
  readonly maxDepth: number
  readonly processed: number
  readonly shed: number
}

export class WriteQueue {
  readonly #maxDepth: number
  readonly #queue: QueueEntry<unknown>[] = []
  readonly #drainWaiters: Array<() => void> = []
  #running = false
  #scheduled = false
  #processed = 0
  #shed = 0
  #closedError: Error | null = null

  constructor(opts: WriteQueueOptions = {}) {
    const maxDepth = opts.maxDepth ?? DEFAULT_WRITE_QUEUE_MAX
    if (!Number.isInteger(maxDepth) || maxDepth < 1) {
      throw new RangeError(`WriteQueue maxDepth must be a positive integer: ${String(maxDepth)}`)
    }
    this.#maxDepth = maxDepth
  }

  /** Number of writes currently waiting in the queue (excludes the active in-flight write). */
  get depth(): number {
    return this.#queue.length
  }

  /** 1 while a write is executing, 0 when idle. */
  get inFlight(): number {
    return this.#running ? 1 : 0
  }

  /** Total pending writes (waiting + active). */
  get totalPending(): number {
    return this.#queue.length + (this.#running ? 1 : 0)
  }

  stats(): WriteQueueStats {
    return Object.freeze({
      depth: this.#queue.length,
      inFlight: this.#running ? 1 : 0,
      maxDepth: this.#maxDepth,
      processed: this.#processed,
      shed: this.#shed,
    })
  }

  enqueue<T>(fn: () => T | Promise<T>, signal?: AbortSignal): Promise<T> {
    if (this.#closedError !== null) {
      return Promise.reject(this.#closedError)
    }
    if (signal?.aborted) {
      return Promise.reject(signal.reason ?? clientError('unavailable', 'request aborted'))
    }
    if (this.#queue.length >= this.#maxDepth) {
      this.#shed += 1
      return Promise.reject(
        clientError('backpressure_shed', 'write queue is full: retry shortly', {
          hint: 'server write queue reached capacity',
          retryAfter: 1,
          details: { queueDepth: this.#queue.length, maxDepth: this.#maxDepth },
        }),
      )
    }

    return new Promise<T>((resolve, reject) => {
      const onAbort = (): void => {
        if (entry.settled) return
        entry.settled = true
        const idx = this.#queue.indexOf(entry as QueueEntry<unknown>)
        if (idx >= 0) this.#queue.splice(idx, 1)
        entry.cleanup()
        reject(signal!.reason ?? clientError('unavailable', 'request aborted'))
        this.#checkDrained()
      }

      const entry: QueueEntry<T> = {
        fn,
        signal,
        resolve,
        reject,
        settled: false,
        cleanup: () => {
          signal?.removeEventListener('abort', onAbort)
        },
      }

      this.#queue.push(entry as QueueEntry<unknown>)
      signal?.addEventListener('abort', onAbort, { once: true })

      if (!this.#running && !this.#scheduled) {
        this.#pumpNext()
      }
    })
  }

  /** Resolves once the currently active write and all queued writes have completed. */
  drain(): Promise<void> {
    if (!this.#running && this.#queue.length === 0) {
      return Promise.resolve()
    }
    return new Promise<void>((resolve) => {
      this.#drainWaiters.push(resolve)
    })
  }

  /** Rejects all waiting writes (not the currently executing one) and blocks future enqueues. */
  rejectAll(error: Error): void {
    this.#closedError = error
    const pending = this.#queue.splice(0)
    for (const entry of pending) {
      if (entry.settled) continue
      entry.settled = true
      entry.cleanup()
      entry.reject(error)
    }
    this.#checkDrained()
  }

  #pumpNext(): void {
    if (this.#running) return
    while (this.#queue.length > 0) {
      const entry = this.#queue.shift()!
      if (entry.settled) continue
      entry.settled = true
      entry.cleanup()
      if (entry.signal?.aborted) {
        entry.reject(entry.signal.reason ?? clientError('unavailable', 'request aborted'))
        continue
      }
      this.#running = true
      this.#runEntry(entry)
      return
    }
    this.#checkDrained()
  }

  #runEntry(entry: QueueEntry<unknown>): void {
    let result: Promise<unknown>
    try {
      result = Promise.resolve(entry.fn())
    } catch (err) {
      result = Promise.reject(err)
    }
    result.then(
      (value) => {
        this.#processed += 1
        this.#running = false
        entry.resolve(value)
        this.#scheduleNext()
      },
      (err) => {
        this.#processed += 1
        this.#running = false
        entry.reject(err)
        this.#scheduleNext()
      },
    )
  }

  #scheduleNext(): void {
    if (this.#queue.length === 0) {
      this.#checkDrained()
      return
    }
    if (this.#scheduled) return
    this.#scheduled = true
    // Yield between dequeues so concurrent reads, SSE heartbeats, and timers never starve.
    setImmediate(() => {
      this.#scheduled = false
      this.#pumpNext()
    })
  }

  #checkDrained(): void {
    if (this.#running || this.#queue.length > 0) return
    const waiters = this.#drainWaiters.splice(0)
    for (const resolve of waiters) resolve()
  }
}
