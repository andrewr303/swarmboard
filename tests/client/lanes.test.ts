// HOST123_DESIGN Stage B6 (HS-55 lanes.ts, HS-111): per-identity FIFO write lanes with read/wait bypass,
// max waiting queue backpressure shedding (CR-15), abort removal, and rejectAll.
import { getEventListeners } from 'node:events'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import { createLocalCaller } from '../../src/core/public.ts'
import { clientError, isBoardError } from '../../src/client/errors.ts'
import { laneKey, Lanes } from '../../src/client/lanes.ts'
import { asUrl, importGraph } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

function deferred<T = void>(): {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (error: unknown) => void
} {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

describe('HS-55 src/client/lanes.ts thin import boundary', () => {
  it('HS-55 resolves only ./errors.ts at runtime (no src/core, no zod, <= 15 edges)', async () => {
    const file = join(ROOT, 'src', 'client', 'lanes.ts')
    const edges = await importGraph([file])
    const ownEdges = edges.filter(([parent]) => parent === asUrl(file))
    expect(ownEdges.length).toBeLessThanOrEqual(15)
    for (const [, child] of ownEdges) {
      expect(child).not.toContain('/src/core/')
      expect(child).not.toMatch(/\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?zod\//)
    }
    const targets = ownEdges.map(([, c]) => c.slice(c.lastIndexOf('/') + 1)).sort()
    expect(targets).toEqual(['errors.ts'])
  }, 60_000)
})

describe('Lanes (HS-111)', () => {
  it('HS-111 laneKey separates principal and profile with US (0x1f)', () => {
    const base = createLocalCaller({ userId: 'ada', profile: null })
    const w1 = createLocalCaller({ userId: 'ada', profile: 'w1' })
    const w2 = createLocalCaller({ userId: 'ada', profile: 'w2' })
    expect(laneKey(base)).toBe('local:user:ada\u001f')
    expect(laneKey(w1)).toBe('local:user:ada\u001fw1')
    expect(laneKey(w2)).toBe('local:user:ada\u001fw2')
    expect(laneKey(base)).not.toBe(laneKey(w1))
  })

  it('HS-111 validates constructor max and supports max: 0 (1 running, 0 waiting)', async () => {
    for (const bad of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => new Lanes({ max: bad })).toThrow(RangeError)
    }
    const lanes = new Lanes({ max: 0 })
    const gate = deferred<string>()
    const first = lanes.run('a', 'write', () => gate.promise)
    let secondRan = false
    const second = lanes.run('a', 'write', async () => {
      secondRan = true
      return 'nope'
    })
    await expect(second).rejects.toMatchObject({ status: 503, code: 'backpressure_shed', retryAfter: 1, origin: 'handle' })
    expect(secondRan).toBe(false)
    gate.resolve('ok')
    expect(await first).toBe('ok')
    expect(lanes.size()).toBe(0)
  })

  it('HS-111 max: 2 accepts 1 running + 2 waiting in strict FIFO order, sheds 4th, bypasses reads/waits and other lanes', async () => {
    const lanes = new Lanes({ max: 2 })
    expect(lanes.size()).toBe(0)

    const order: string[] = []
    let activeInA = 0
    let maxActiveInA = 0
    const g1 = deferred<void>()
    const g2 = deferred<void>()
    const g3 = deferred<void>()

    const w1 = lanes.run('a', 'write', async () => {
      activeInA += 1
      maxActiveInA = Math.max(maxActiveInA, activeInA)
      order.push('w1-start')
      await g1.promise
      order.push('w1-end')
      activeInA -= 1
      return 'r1'
    })
    const w2 = lanes.run('a', 'write', async () => {
      activeInA += 1
      maxActiveInA = Math.max(maxActiveInA, activeInA)
      order.push('w2-start')
      await g2.promise
      order.push('w2-end')
      activeInA -= 1
      return 'r2'
    })
    const w3 = lanes.run('a', 'write', async () => {
      activeInA += 1
      maxActiveInA = Math.max(maxActiveInA, activeInA)
      order.push('w3-start')
      await g3.promise
      order.push('w3-end')
      activeInA -= 1
      return 'r3'
    })

    expect(lanes.size()).toBe(1)
    expect(order).toEqual(['w1-start'])

    // 4th write rejects immediately with ClientError 503 backpressure_shed (retryAfter 1) without running.
    let w4Ran = false
    let shedErr: unknown
    try {
      await lanes.run('a', 'write', async () => {
        w4Ran = true
        return 'r4'
      })
    } catch (e) {
      shedErr = e
    }
    expect(w4Ran).toBe(false)
    expect(isBoardError(shedErr)).toBe(true)
    expect(shedErr).toMatchObject({ status: 503, code: 'backpressure_shed', retryAfter: 1, origin: 'handle' })

    // Read and wait in lane 'a' run immediately while writes are queued.
    const readVal = await lanes.run('a', 'read', async () => {
      order.push('a-read')
      return 'read-ok'
    })
    const waitVal = await lanes.run('a', 'wait', async () => {
      order.push('a-wait')
      return 'wait-ok'
    })
    expect(readVal).toBe('read-ok')
    expect(waitVal).toBe('wait-ok')

    // Write in lane 'b' runs at once without waiting for lane 'a'.
    const bVal = await lanes.run('b', 'write', async () => {
      expect(lanes.size()).toBe(2)
      order.push('b-write')
      return 'b-ok'
    })
    expect(bVal).toBe('b-ok')
    expect(lanes.size()).toBe(1)

    // Unblock w1, w2, w3 sequentially and verify strict FIFO ordering and zero overlap.
    g1.resolve()
    expect(await w1).toBe('r1')
    g2.resolve()
    expect(await w2).toBe('r2')
    g3.resolve()
    expect(await w3).toBe('r3')

    expect(maxActiveInA).toBe(1)
    expect(order).toEqual([
      'w1-start',
      'a-read',
      'a-wait',
      'b-write',
      'w1-end',
      'w2-start',
      'w2-end',
      'w3-start',
      'w3-end',
    ])
    expect(lanes.size()).toBe(0)
  })

  it('HS-111 aborted queued write leaves the queue, rejects with signal.reason, never runs, and frees its slot', async () => {
    const lanes = new Lanes({ max: 2 })
    const g1 = deferred<void>()
    const w1 = lanes.run('a', 'write', async () => {
      await g1.promise
      return 1
    })

    const ac = new AbortController()
    let abortedRan = false
    const w2 = lanes.run(
      'a',
      'write',
      async () => {
        abortedRan = true
        return 2
      },
      ac.signal,
    )
    const w3 = lanes.run('a', 'write', async () => 3)
    expect(getEventListeners(ac.signal, 'abort').length).toBe(1)

    const reason = new Error('stop-waiting')
    ac.abort(reason)
    let caught: unknown
    try {
      await w2
    } catch (e) {
      caught = e
    }
    expect(caught).toBe(reason)
    expect(abortedRan).toBe(false)
    expect(getEventListeners(ac.signal, 'abort').length).toBe(0)

    // Slot freed: a new write is accepted into the queue instead of shedding.
    const w4 = lanes.run('a', 'write', async () => 4)

    // Already-aborted write rejects immediately without running.
    let preAbortedRan = false
    const preReason = new Error('already-aborted')
    await expect(
      lanes.run(
        'a',
        'write',
        async () => {
          preAbortedRan = true
          return 5
        },
        AbortSignal.abort(preReason),
      ),
    ).rejects.toBe(preReason)
    expect(preAbortedRan).toBe(false)

    g1.resolve()
    expect(await Promise.all([w1, w3, w4])).toEqual([1, 3, 4])
    expect(lanes.size()).toBe(0)
  })

  it('HS-111 rejectAll rejects every queued write with the given BoardErrorLike and cleans up listeners', async () => {
    const lanes = new Lanes({ max: 4 })
    const gA = deferred<void>()
    const gB = deferred<void>()
    const ac1 = new AbortController()
    const ac2 = new AbortController()
    let queuedRan = 0

    const runA = lanes.run('a', 'write', async () => {
      await gA.promise
      return 'a-ran'
    })
    const qA1 = lanes.run(
      'a',
      'write',
      async () => {
        queuedRan += 1
        return 'nope'
      },
      ac1.signal,
    )
    const qA2 = lanes.run('a', 'write', async () => {
      queuedRan += 1
      return 'nope'
    })
    const runB = lanes.run('b', 'write', async () => {
      await gB.promise
      return 'b-ran'
    })
    const qB1 = lanes.run(
      'b',
      'write',
      async () => {
        queuedRan += 1
        return 'nope'
      },
      ac2.signal,
    )

    expect(lanes.size()).toBe(2)
    const stopErr = clientError('unavailable', 'board stopped')
    lanes.rejectAll(stopErr)

    const results = await Promise.allSettled([qA1, qA2, qB1])
    for (const r of results) {
      expect(r.status).toBe('rejected')
      if (r.status === 'rejected') expect(r.reason).toBe(stopErr)
    }
    expect(queuedRan).toBe(0)
    expect(getEventListeners(ac1.signal, 'abort').length).toBe(0)
    expect(getEventListeners(ac2.signal, 'abort').length).toBe(0)

    // Running writes still finish and drain size() to 0.
    gA.resolve()
    gB.resolve()
    expect(await Promise.all([runA, runB])).toEqual(['a-ran', 'b-ran'])
    expect(lanes.size()).toBe(0)
  })

  it('HS-111 a throwing write does not stall subsequent queued writes and drains cleanly', async () => {
    const lanes = new Lanes({ max: 2 })
    const boom = new Error('sync-boom')
    const p1 = lanes.run('constructor', 'write', () => {
      throw boom
    })
    const p2 = lanes.run('constructor', 'write', async () => 'after-boom')
    await expect(p1).rejects.toBe(boom)
    expect(await p2).toBe('after-boom')
    expect(lanes.size()).toBe(0)
  })
})
