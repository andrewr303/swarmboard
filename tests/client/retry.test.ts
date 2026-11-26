// HOST123_DESIGN Stage B6 (HS-55 retry.ts, HS-103, HS-104): thin retry wrapper with full jitter,
// call/streak budgets (CON-1), abort cleanup, and zero runtime imports.
import { getEventListeners } from 'node:events'
import { join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import {
  backoffCeiling,
  DEFAULT_BUSY_RETRY,
  RETRY_STREAK_BREAK_MS,
  withRetry,
  type RetryContext,
} from '../../src/client/retry.ts'
import { asUrl, importGraph } from '../core/host0/import-graph.ts'

const ROOT = resolve(import.meta.dirname, '..', '..')

describe('HS-55 src/client/retry.ts thin import boundary', () => {
  it('HS-55 resolves zero runtime edges (no src/core, no zod)', async () => {
    const file = join(ROOT, 'src', 'client', 'retry.ts')
    const edges = await importGraph([file])
    const ownEdges = edges.filter(([parent]) => parent === asUrl(file))
    expect(ownEdges.length).toBeLessThanOrEqual(15)
    expect(ownEdges).toEqual([])
    for (const [, child] of ownEdges) {
      expect(child).not.toContain('/src/core/')
      expect(child).not.toMatch(/\/node_modules\/(\.pnpm\/[^/]*\/node_modules\/)?zod\//)
    }
  }, 60_000)
})

describe('retry backoff and success path (HS-103)', () => {
  it('HS-103 DEFAULT_BUSY_RETRY and backoffCeiling match full-jitter exponential spec', () => {
    expect(Object.isFrozen(DEFAULT_BUSY_RETRY)).toBe(true)
    expect(DEFAULT_BUSY_RETRY).toEqual({
      baseMs: 5,
      capMs: 100,
      budgetMs: 30_000,
      maxAttempts: 10_000,
    })
    expect(RETRY_STREAK_BREAK_MS).toBe(1_000)
    expect(backoffCeiling(1, DEFAULT_BUSY_RETRY)).toBe(5)
    expect(backoffCeiling(2, DEFAULT_BUSY_RETRY)).toBe(10)
    expect(backoffCeiling(3, DEFAULT_BUSY_RETRY)).toBe(20)
    expect(backoffCeiling(4, DEFAULT_BUSY_RETRY)).toBe(40)
    expect(backoffCeiling(5, DEFAULT_BUSY_RETRY)).toBe(80)
    expect(backoffCeiling(6, DEFAULT_BUSY_RETRY)).toBe(100)
    expect(backoffCeiling(2_000, DEFAULT_BUSY_RETRY)).toBe(100)
    expect(backoffCeiling(2_000, { baseMs: 0, capMs: 100, budgetMs: 1000, maxAttempts: 10 })).toBe(0)
  })

  it('HS-103 retries busy twice with sleeps [4, 9] at random=0.999 then returns 7; tracks attempt and elapsedMs', async () => {
    const busy1 = new Error('busy-1')
    const busy2 = new Error('busy-2')
    const sleeps: number[] = []
    const attempts: number[] = []
    const elapsed: number[] = []
    const retryEvents: Array<{ attempt: number; delayMs: number; error: unknown }> = []
    let t = 1000

    const result = await withRetry(
      (ctx: RetryContext) => {
        attempts.push(ctx.attempt)
        elapsed.push(ctx.elapsedMs)
        t += 1
        if (ctx.attempt === 1) throw busy1
        if (ctx.attempt === 2) throw busy2
        return 7
      },
      {
        isRetryable: (e) => e === busy1 || e === busy2,
        random: () => 0.999,
        now: () => t,
        sleep: async (ms) => {
          sleeps.push(ms)
          t += ms
        },
        onRetry: (info) => retryEvents.push(info),
      },
    )

    expect(result).toBe(7)
    expect(attempts).toEqual([1, 2, 3])
    expect(sleeps).toEqual([4, 9])
    expect(elapsed[0]).toBe(0)
    expect(elapsed[1]).toBeGreaterThanOrEqual(elapsed[0]!)
    expect(elapsed[2]).toBeGreaterThanOrEqual(elapsed[1]!)
    expect(retryEvents).toEqual([
      { attempt: 1, delayMs: 4, error: busy1 },
      { attempt: 2, delayMs: 9, error: busy2 },
    ])
  })

  it('HS-103 synchronous fn returning a value resolves in the same macrotask with zero sleeps', async () => {
    let sleepCalls = 0
    let macrotaskFired = false
    const timer = setTimeout(() => {
      macrotaskFired = true
    }, 0)
    try {
      const value = await withRetry(() => 42, {
        isRetryable: () => true,
        sleep: async () => {
          sleepCalls += 1
        },
      })
      expect(value).toBe(42)
      expect(sleepCalls).toBe(0)
      expect(macrotaskFired).toBe(false)
    } finally {
      clearTimeout(timer)
    }
  })
})

describe('retry limits, aborts, onRetry faults, and streak budget (HS-104)', () => {
  it('HS-104 budget exhaustion rethrows the exact last thrown object once elapsed + delay > budgetMs', async () => {
    let t = 0
    let attempts = 0
    let lastThrown: Error | null = null

    let caught: unknown
    try {
      await withRetry(
        () => {
          attempts += 1
          t += 10
          lastThrown = new Error(`busy-${attempts}`)
          throw lastThrown
        },
        {
          isRetryable: () => true,
          policy: { budgetMs: 200 },
          now: () => t,
          random: () => 0.5,
          sleep: async (ms) => {
            t += ms
          },
        },
      )
    } catch (e) {
      caught = e
    }

    expect(caught).toBe(lastThrown)
    expect(attempts).toBeLessThan(20)
    expect(attempts).toBeGreaterThan(1)
  })

  it('HS-104 maxAttempts stops at 3 and rethrows the 3rd error unchanged', async () => {
    const errors = [new Error('e1'), new Error('e2'), new Error('e3'), new Error('e4')]
    let attempts = 0
    let caught: unknown
    try {
      await withRetry(
        () => {
          const err = errors[attempts]!
          attempts += 1
          throw err
        },
        {
          isRetryable: () => true,
          policy: { maxAttempts: 3 },
          now: () => 0,
          random: () => 0,
          sleep: async () => {},
        },
      )
    } catch (e) {
      caught = e
    }
    expect(attempts).toBe(3)
    expect(caught).toBe(errors[2])
  })

  it('HS-104 non-retryable 409 rejects at attempt 1 with the identical object and zero sleeps', async () => {
    const conflict = Object.assign(new Error('conflict'), { status: 409 })
    let attempts = 0
    let sleeps = 0
    let caught: unknown
    try {
      await withRetry(
        () => {
          attempts += 1
          throw conflict
        },
        {
          isRetryable: () => false,
          sleep: async () => {
            sleeps += 1
          },
        },
      )
    } catch (e) {
      caught = e
    }
    expect(attempts).toBe(1)
    expect(sleeps).toBe(0)
    expect(caught).toBe(conflict)
  })

  it('HS-104 abort during sleep rejects within 5 ms with the last busy error and cleans up abort listeners', async () => {
    const controller = new AbortController()
    const busy = new Error('locked')
    let abortedAt = 0

    const p = withRetry(
      () => {
        throw busy
      },
      {
        isRetryable: () => true,
        policy: { baseMs: 5_000, capMs: 5_000, budgetMs: 30_000 },
        random: () => 0.999,
        signal: controller.signal,
      },
    )

    await new Promise((r) => setTimeout(r, 15))
    expect(getEventListeners(controller.signal, 'abort').length).toBe(1)
    abortedAt = performance.now()
    controller.abort(new Error('caller cancelled'))

    let caught: unknown
    try {
      await p
    } catch (e) {
      caught = e
    }
    const elapsedSinceAbort = performance.now() - abortedAt
    expect(caught).toBe(busy)
    expect(elapsedSinceAbort).toBeLessThan(5)
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
  })

  it('HS-104 a normal sleep cleans up its abort listener when completing without abort', async () => {
    const controller = new AbortController()
    let n = 0
    const res = await withRetry(
      () => {
        n += 1
        if (n === 1) throw new Error('busy')
        return 'ok'
      },
      {
        isRetryable: () => true,
        policy: { baseMs: 2, capMs: 2 },
        random: () => 0,
        signal: controller.signal,
      },
    )
    expect(res).toBe('ok')
    expect(getEventListeners(controller.signal, 'abort').length).toBe(0)
  })

  it('HS-104 an onRetry callback that throws does not stop retries', async () => {
    let attempts = 0
    const res = await withRetry(
      () => {
        attempts += 1
        if (attempts < 3) throw new Error('busy')
        return 'recovered'
      },
      {
        isRetryable: () => true,
        random: () => 0,
        sleep: async () => {},
        onRetry: () => {
          throw new Error('observer crashed')
        },
      },
    )
    expect(attempts).toBe(3)
    expect(res).toBe('recovered')
  })

  it("HS-104 budgetFrom: 'streak' restarts budget after a >= 1000 ms attempt while capping sustained quick failures", async () => {
    // 1. Attempt 1 runs 45,000 ms then throws busy -> retried, attempt 2 sees elapsedMs >= 45,000 and succeeds.
    {
      let t = 0
      const seenElapsed: number[] = []
      const res = await withRetry(
        (ctx) => {
          seenElapsed.push(ctx.elapsedMs)
          if (ctx.attempt === 1) {
            t += 45_000
            throw new Error('late-busy')
          }
          return 'claimed'
        },
        {
          isRetryable: () => true,
          budgetFrom: 'streak',
          policy: { budgetMs: 30_000 },
          now: () => t,
          random: () => 0.5,
          sleep: async (ms) => {
            t += ms
          },
        },
      )
      expect(res).toBe('claimed')
      expect(seenElapsed).toHaveLength(2)
      expect(seenElapsed[0]).toBe(0)
      expect(seenElapsed[1]).toBeGreaterThanOrEqual(45_000)
    }

    // 2. Quick failures (10 ms each) under 'streak' give up once 30,000 ms have passed since call start.
    {
      let t = 0
      let attempts = 0
      let last: Error | null = null
      let caught: unknown
      try {
        await withRetry(
          () => {
            attempts += 1
            t += 10
            last = new Error(`quick-${attempts}`)
            throw last
          },
          {
            isRetryable: () => true,
            budgetFrom: 'streak',
            policy: { budgetMs: 30_000 },
            now: () => t,
            random: () => 0.5,
            sleep: async (ms) => {
              t += ms
            },
          },
        )
      } catch (e) {
        caught = e
      }
      expect(caught).toBe(last)
      // Last attempt starts within budget (<= 30_000) and takes 10 ms before giving up.
      expect(t).toBeLessThanOrEqual(30_010)
      expect(t).toBeGreaterThan(29_800)
    }

    // 3. After a 45 s attempt fails, subsequent quick failures give up 30,000 ms after that attempt's failure (~75 s).
    {
      let t = 0
      let attempts = 0
      let lastStart = 0
      let last: Error | null = null
      let caught: unknown
      try {
        await withRetry(
          (ctx) => {
            attempts += 1
            lastStart = t
            t += ctx.attempt === 1 ? 45_000 : 10
            last = new Error(`after-long-${attempts}`)
            throw last
          },
          {
            isRetryable: () => true,
            budgetFrom: 'streak',
            policy: { budgetMs: 30_000 },
            now: () => t,
            random: () => 0.5,
            sleep: async (ms) => {
              t += ms
            },
          },
        )
      } catch (e) {
        caught = e
      }
      expect(caught).toBe(last)
      expect(attempts).toBeGreaterThan(10)
      expect(lastStart).toBeLessThanOrEqual(75_000)
      expect(t).toBeLessThanOrEqual(75_010)
      expect(t).toBeGreaterThan(74_800)
    }

    // 4. Exact boundary: 999 ms does NOT restart budget; 1000 ms (RETRY_STREAK_BREAK_MS) DOES restart budget.
    {
      const runWithAttemptDuration = async (longMs: number): Promise<number> => {
        let t = 0
        let attempts = 0
        try {
          await withRetry(
            (ctx) => {
              attempts += 1
              if (ctx.attempt === 1) t += longMs
              else return 'ok'
              throw new Error('busy')
            },
            {
              isRetryable: () => true,
              budgetFrom: 'streak',
              policy: { budgetMs: 900 },
              now: () => t,
              random: () => 0,
              sleep: async (ms) => {
                t += ms
              },
            },
          )
        } catch {
          // expected when not reset
        }
        return attempts
      }
      expect(await runWithAttemptDuration(RETRY_STREAK_BREAK_MS - 1)).toBe(1) // 999 ms > budget 900, no reset
      expect(await runWithAttemptDuration(RETRY_STREAK_BREAK_MS)).toBe(2) // 1000 ms resets budget -> attempt 2 runs
    }

    // 5. With budgetFrom: 'call' (and default), a 45 s-then-busy fn rejects at attempt 1.
    for (const budgetFrom of ['call', undefined] as const) {
      let t = 0
      let attempts = 0
      const err = new Error('late-busy-call')
      let caught: unknown
      try {
        await withRetry(
          () => {
            attempts += 1
            t += 45_000
            throw err
          },
          {
            isRetryable: () => true,
            ...(budgetFrom ? { budgetFrom } : {}),
            policy: { budgetMs: 30_000 },
            now: () => t,
            random: () => 0.5,
            sleep: async (ms) => {
              t += ms
            },
          },
        )
      } catch (e) {
        caught = e
      }
      expect(attempts).toBe(1)
      expect(caught).toBe(err)
    }
  })
})
