// AT-40 strict bench (T-BENCH, M2_DESIGN 2.11; lead decision D4): the design bound itself, run by hand,
// never by the default suite (vitest includes only tests/**/*.test.ts).
//
//   node tests/bench/tasks.bench.ts
//
// A complete with a dependent, on a board with 10k waiting tasks, must take within 20% of the same
// complete on a board with 100 (p50). Sub-millisecond medians move with the machine's load, so each
// round measures both boards back to back, alternating which goes first, and the bound is on the
// best of five rounds: timing noise moves single rounds both ways, while a cost that grows with the
// waiting tasks (a scan of their 100x as many rows) misses it in every round. It also records claim
// next with 1k ready tasks over 33 owners. It prints Markdown for docs/m2/BENCH.md and exits 1 when
// the best ratio is over 1.2. The loose scaling bound (2x + 1 ms) stays in
// tests/core/tasks/bench.test.ts, where every run checks it.
import os from 'node:os'
import { createLocalCaller, type CallerContext } from '../../src/core/index.ts'
import { alice, makeBoard, type Board } from '../core/tasks/helpers.ts'

const ROUNDS = 5
const BOUND = 1.2
const SMALL = 100
const LARGE = 10_000
/** Claimed targets per board, each with one dependent; the first WARM of them warm the statement cache. */
const TARGETS = 60
const WARM = 10
const CLAIMS = 500

const quantile = (xs: number[], q: number): number => {
  const sorted = [...xs].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]!
}
const ms = (x: number): string => x.toFixed(3)

/** A board with `waiting` tasks that wait on a prerequisite no one finishes, and TARGETS claimed tasks with one dependent each. */
function seeded(waiting: number): { b: Board; claimed: Array<{ id: string; epoch: number; token: string }> } {
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
  for (let i = 0; i < TARGETS; i++) {
    const id = b.board.tasks.createTask(alice, { channel: 'dev', text: `target ${i}` }).task.id
    b.board.tasks.createTask(alice, { channel: 'dev', text: `after ${i}`, needs: [id] })
    const { claim } = b.board.tasks.claimTask(alice, id, {})
    claimed.push({ id, epoch: claim.epoch, token: claim.token })
  }
  return { b, claimed }
}

/** The time of each complete (after the warm-up ones), in ms. */
function completeTimes(waiting: number): number[] {
  const { b, claimed } = seeded(waiting)
  try {
    const times: number[] = []
    for (const c of claimed) {
      const start = performance.now()
      const done = b.board.tasks.completeTask(alice, c.id, { epoch: c.epoch, token: c.token })
      times.push(performance.now() - start)
      if (done.task.task?.state !== 'completed') throw new Error(`#${c.id} did not complete`)
    }
    return times.slice(WARM)
  } finally {
    b.close()
  }
}

type Round = { first: 'small' | 'large'; small: { p50: number; p95: number }; large: { p50: number; p95: number }; ratio: number }

function round(n: number): Round {
  const first = n % 2 === 0 ? 'small' : 'large'
  const times: Record<'small' | 'large', number[]> = { small: [], large: [] }
  for (const which of first === 'small' ? (['small', 'large'] as const) : (['large', 'small'] as const)) {
    times[which] = completeTimes(which === 'small' ? SMALL : LARGE)
  }
  const at = (xs: number[]): { p50: number; p95: number } => ({ p50: quantile(xs, 0.5), p95: quantile(xs, 0.95) })
  const small = at(times.small)
  const large = at(times.large)
  return { first, small, large, ratio: large.p50 / small.p50 }
}

/** Claim next on 1,023 ready tasks, 31 for each of 33 owners, the worker's own among them. */
function claimReadyTimes(): number[] {
  const b = makeBoard()
  try {
    const owners: CallerContext[] = Array.from({ length: 32 }, (_, i) => createLocalCaller({ userId: `owner${i}`, handle: `owner${i}` }))
    const worker = createLocalCaller({ userId: 'worker', handle: 'worker' })
    for (const owner of [...owners, worker]) {
      b.board.tasks.createTasks(owner, { channel: 'dev', tasks: Array.from({ length: 31 }, (_, i) => ({ text: `job ${i}` })) })
    }
    const from = owners.map((o) => o.principal.id)
    const times: number[] = []
    for (let i = 0; i < CLAIMS; i++) {
      const start = performance.now()
      const got = b.board.tasks.claimReadyOnce(worker, { channel: 'dev', from })
      times.push(performance.now() - start)
      if (!got.task) throw new Error(`claim ${i} found no task`)
    }
    return times
  } finally {
    b.close()
  }
}

const load = (): string => os.loadavg().map((x) => x.toFixed(2)).join(' / ')
const loadBefore = load()
const started = performance.now()
const rounds: Round[] = []
for (let n = 0; n < ROUNDS; n++) rounds.push(round(n))
const claims = claimReadyTimes()
const best = rounds.reduce((a, b) => (b.ratio < a.ratio ? b : a))
const pass = best.ratio <= BOUND
const cpu = os.cpus()[0]?.model ?? 'unknown cpu'

const lines = [
  `### AT-40 bench: \`node tests/bench/tasks.bench.ts\``,
  '',
  `- Run: ${new Date().toISOString()}, Node ${process.version}, ${os.platform()} ${os.arch()}, ${cpu} (${os.cpus().length} cores)`,
  `- Load average (1 / 5 / 15 min): ${loadBefore} before, ${load()} after; took ${((performance.now() - started) / 1000).toFixed(1)} s`,
  `- Complete with one dependent: ${TARGETS - WARM} timed completes per board (after ${WARM} warm-up), ${ROUNDS} interleaved rounds`,
  '',
  '| Round | First | p50, 100 waiting (ms) | p95, 100 waiting (ms) | p50, 10k waiting (ms) | p95, 10k waiting (ms) | p50 ratio 10k/100 |',
  '|---|---|---|---|---|---|---|',
  ...rounds.map(
    (r, n) => `| ${n + 1} | ${r.first === 'small' ? '100' : '10k'} | ${ms(r.small.p50)} | ${ms(r.small.p95)} | ${ms(r.large.p50)} | ${ms(r.large.p95)} | ${r.ratio.toFixed(3)} |`,
  ),
  '',
  `- Best p50 ratio: **${best.ratio.toFixed(3)}** (round ${rounds.indexOf(best) + 1}); bound ${BOUND}: **${pass ? 'PASS' : 'FAIL'}**`,
  `- Ratios by round: ${rounds.map((r) => r.ratio.toFixed(3)).join(', ')}`,
  '',
  `| Claim next, 1,023 ready over 33 owners (${CLAIMS} claims) | p50 (ms) | p95 (ms) |`,
  '|---|---|---|',
  `| claimReadyOnce | ${ms(quantile(claims, 0.5))} | ${ms(quantile(claims, 0.95))} |`,
]
console.log(lines.join('\n'))
if (!pass) {
  console.error(`AT-40 FAIL: the best p50 ratio of ${ROUNDS} rounds is ${best.ratio.toFixed(3)}, over ${BOUND}`)
  process.exitCode = 1
}
