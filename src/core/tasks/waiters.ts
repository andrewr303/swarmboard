// Waits for a claim next (M2_DESIGN 2.7.10 WaiterHub): one hub per TaskService, a FIFO of waiters per
// scope. On an event that can make a task claimable it runs one read-only probe per scope, and hands
// the turn to the oldest waiter there only when the probe finds a candidate; when that waiter wins and
// candidates remain, the next one gets the turn. Idle waiters stay off the write lock.
import type { StoredEvent } from '../storage.ts'

/** Event types after which some task may have become claimable. */
const WAKING: ReadonlySet<string> = new Set([
  'task.created',
  'task.ready',
  'task.released',
  'task.expired',
  'task.unblocked',
  'task.reopened',
  'task.assigned',
  'task.needs_changed',
  'labels.changed',
])

export type Waiter = {
  readonly key: string
  /** A read-only probe: whether this waiter's claim would find a task now. */
  readonly probe: () => boolean
  /** Set while it waits: hands it its turn. */
  wake: ((why: 'turn') => void) | null
  /** A turn that came while it was busy trying, taken on its next wait. */
  missed: boolean
}

export type WakeSource = (listener: (ev: StoredEvent) => void) => () => void

export class WaiterHub {
  private readonly queues = new Map<string, Waiter[]>()
  private unsubscribe: (() => void) | null = null
  private scheduled = false
  private readonly source: WakeSource

  constructor(source: WakeSource) {
    this.source = source
  }

  /** Joins the end of its scope's queue. */
  register(key: string, probe: () => boolean): Waiter {
    if (!this.unsubscribe) {
      this.unsubscribe = this.source((ev) => {
        if (WAKING.has(ev.type)) this.schedule()
      })
    }
    const waiter: Waiter = { key, probe, wake: null, missed: false }
    const queue = this.queues.get(key)
    if (queue) queue.push(waiter)
    else this.queues.set(key, [waiter])
    return waiter
  }

  /** Whether `w` is the oldest waiter of its scope: only it takes a turn. */
  isHead(w: Waiter): boolean {
    return this.queues.get(w.key)?.[0] === w
  }

  /** Leaves the queue (it claimed, gave up, or was aborted); the next waiter may get the turn. */
  done(w: Waiter): void {
    const queue = this.queues.get(w.key)
    if (!queue) return
    const at = queue.indexOf(w)
    if (at >= 0) queue.splice(at, 1)
    if (queue.length === 0) this.queues.delete(w.key)
    else if (at === 0) this.schedule()
    if (this.queues.size === 0 && this.unsubscribe) {
      this.unsubscribe()
      this.unsubscribe = null
    }
  }

  /** Waits for `w`'s turn, `ms`, or `signal`, whichever is first. */
  wait(w: Waiter, ms: number, signal?: AbortSignal): Promise<'turn' | 'timer' | 'abort'> {
    if (signal?.aborted) return Promise.resolve('abort')
    if (w.missed) {
      w.missed = false
      return Promise.resolve('turn')
    }
    return new Promise((resolve) => {
      const finish = (why: 'turn' | 'timer' | 'abort'): void => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        w.wake = null
        resolve(why)
      }
      const onAbort = (): void => finish('abort')
      const timer = setTimeout(() => finish('timer'), Math.max(0, ms))
      signal?.addEventListener('abort', onAbort, { once: true })
      w.wake = finish
    })
  }

  /** One pump per tick, however many events came. */
  private schedule(): void {
    if (this.scheduled) return
    this.scheduled = true
    setImmediate(() => {
      this.scheduled = false
      this.pump()
    })
  }

  /** For each scope, one probe; a candidate gives its oldest waiter the turn. */
  private pump(): void {
    for (const queue of this.queues.values()) {
      const head = queue[0]
      if (!head) continue
      let found = false
      try {
        found = head.probe()
      } catch {
        // A probe that fails (a closed store) wakes no one; the waiter's own poll still runs.
      }
      if (!found) continue
      if (head.wake) head.wake('turn')
      else head.missed = true
    }
  }
}
