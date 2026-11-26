// AT-40 scale smoke (T-BENCH, M2_DESIGN 2.11): a complete's transaction does not grow with the number
// of waiting tasks on the board, and claim next stays fast with 1k ready tasks over 33 owners. Only
// generous bounds are asserted, so a slow or busy machine does not fail them; the measured numbers are
// printed for docs/m2/BENCH.md. The strict 20% bound is tests/bench/tasks.bench.ts, run by hand.
import { describe, expect, it } from 'vitest'
import type { CallerContext } from '../../../src/core/index.ts'
import { alice, makeBoard, type Board } from './helpers.ts'
import { userWith } from './verb-helpers.ts'

const quantile = (xs: number[], q: number): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}

/** A board with `waiting` tasks that wait on a prerequisite no one finishes, and `targets` claimed tasks with one dependent each. */
function seeded(waiting: number, targets: number): { b: Board; claimed: Array<{ id: string; epoch: number; token: string }> } {
  const b = makeBoard()
  const blocker = b.board.tasks.createTask(alice, { channel: 'dev', text: 'never done' }).task.id
  for (let start = 0; start < waiting; start += 100) {
    const n = Math.min(100, waiting - start)
    b.board.tasks.createTasks(alice, {
      channel: 'dev/backlog',
      tasks: Array.from({ length: n }, (_, i) => ({ text: `waiting ${start + i}`, needs: [blocker] })),
    })
  }
  const claimed: Array<{ id: string; epoch: number; token: string }> = []
  for (let i = 0; i < targets; i++) {
    const id = b.board.tasks.createTask(alice, { channel: 'dev', text: `target ${i}` }).task.id
    b.board.tasks.createTask(alice, { channel: 'dev', text: `after ${i}`, needs: [id] })
    const { claim } = b.board.tasks.claimTask(alice, id, {})
    claimed.push({ id, epoch: claim.epoch, token: claim.token })
  }
  return { b, claimed }
}

function completeTimes(waiting: number): number[] {
  const { b, claimed } = seeded(waiting, 60)
  try {
    const times: number[] = []
    for (const c of claimed) {
      const start = performance.now()
      b.board.tasks.completeTask(alice, c.id, { epoch: c.epoch, token: c.token })
      times.push(performance.now() - start)
    }
    // The first few warm the statement cache.
    return times.slice(10)
  } finally {
    b.close()
  }
}

describe('AT-40 scale smoke', () => {
  it('AT-40 a complete with a dependent takes about as long with 10k waiting tasks on the board as with 100', () => {
    const small = completeTimes(100)
    const large = completeTimes(10_000)
    const p50Small = quantile(small, 0.5)
    const p50Large = quantile(large, 0.5)
    console.log(
      `AT-40 complete p50: ${p50Small.toFixed(3)} ms with 100 waiting, ${p50Large.toFixed(3)} ms with 10k waiting ` +
        `(ratio ${(p50Large / p50Small).toFixed(2)}); p95 ${quantile(small, 0.95).toFixed(3)} / ${quantile(large, 0.95).toFixed(3)} ms`,
    )
    // The design's target is within 20%; asserted generously (2x plus 1 ms) so a noisy machine passes,
    // while a scan of the waiting tasks (100x the rows) would still fail it.
    expect(p50Large).toBeLessThan(p50Small * 2 + 1)
  }, 120_000)

  // The design bound itself (within 20%, best of five interleaved rounds) is a timing claim that a
  // loaded machine fails at random (gate judge: 2 of 7 runs at load 12-20, ratios 0.85 to 1.77 on the
  // same code), so it runs by hand, out of the default suite (lead decision D4):
  //   node tests/bench/tasks.bench.ts
  // It prints the numbers for docs/m2/BENCH.md and exits 1 when the best ratio is over 1.2.

  it('AT-40 claim next with 1k ready tasks over 33 owners: p50 and p95 recorded, both well under a frame', () => {
    const b = makeBoard()
    try {
      const owners: CallerContext[] = Array.from({ length: 32 }, (_, i) => userWith(`owner${i}`))
      const worker = userWith('worker')
      const all = [...owners, worker]
      // 1,023 ready tasks: 31 for each of the 33 owners, the worker's own among them.
      for (const owner of all) {
        b.board.tasks.createTasks(owner, { channel: 'dev', tasks: Array.from({ length: 31 }, (_, i) => ({ text: `job ${i}` })) })
      }
      expect(b.board.tasks.listTasks(alice, { state: 'ready', limit: 1 }).tasks).toHaveLength(1)
      const from = owners.map((o) => o.principal.id)
      const times: number[] = []
      for (let i = 0; i < 500; i++) {
        const start = performance.now()
        const got = b.board.tasks.claimReadyOnce(worker, { channel: 'dev', from })
        times.push(performance.now() - start)
        expect(got.task).not.toBeNull()
      }
      const p50 = quantile(times, 0.5)
      const p95 = quantile(times, 0.95)
      console.log(`AT-40 claimReady with 1k ready over 33 owners: p50 ${p50.toFixed(3)} ms, p95 ${p95.toFixed(3)} ms`)
      expect(p50).toBeLessThan(25)
      expect(p95).toBeLessThan(50)
    } finally {
      b.close()
    }
  }, 120_000)
})
