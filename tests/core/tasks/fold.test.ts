import { describe, expect, it } from 'vitest'
import { foldTask, TASK_EVENT_TYPES, toTaskView, type FoldRoot, type TaskRow } from '../../../src/core/index.ts'
import { pick, prng, refFold, refView, type RefMessage, type RefTaskState } from './reference-fold.ts'

const OWNER = 'local:user:alice'
const BY = { actor: OWNER, principal: OWNER, profile: null }
const ASSIGNEES = [null, `${OWNER}+x`, `${OWNER}+y`] as const
const BASE_MS = Date.UTC(2026, 10, 23, 12, 0, 0)

const hex = (rand: () => number): string =>
  Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(rand() * 16)]).join('')

/** A random task event about #1, legal or not, shaped as the original's events are (contract/events.ts:150-180). */
function randomEvent(rand: () => number, epoch: number): { type: string; payload: Record<string, unknown> } {
  const type = pick(rand, TASK_EVENT_TYPES)
  const about = { id: 1, thread: 't-1' }
  const ep = Math.max(1, epoch + Math.floor(rand() * 3) - 1)
  const until = new Date(BASE_MS + Math.floor(rand() * 3_600_000)).toISOString()
  const needs = [2, 3, 4, 5].filter(() => rand() < 0.3)
  switch (type) {
    case 'task.created':
      return { type, payload: { ...about, needs, for: pick(rand, ASSIGNEES), by: BY } }
    case 'task.assigned':
      return { type, payload: { ...about, for: pick(rand, ASSIGNEES), by: BY } }
    case 'task.needs_changed':
      return { type, payload: { ...about, needs, by: BY } }
    case 'task.ready':
      return { type, payload: about }
    case 'task.claimed':
      return { type, payload: { ...about, epoch: rand() < 0.7 ? epoch + 1 : ep, until, token: hex(rand), by: BY } }
    case 'task.renewed':
      return { type, payload: { ...about, epoch: rand() < 0.7 ? epoch : ep, until, by: BY } }
    case 'task.released':
      return { type, payload: { ...about, epoch: rand() < 0.7 ? epoch : ep, by: BY } }
    case 'task.expired':
      return { type, payload: { ...about, epoch: rand() < 0.7 ? epoch : ep } }
    case 'task.completed':
      return { type, payload: { ...about, epoch: rand() < 0.7 ? epoch : ep, result: rand() < 0.5 ? null : 'done', by: BY } }
    case 'task.failed':
      return { type, payload: { ...about, epoch: rand() < 0.7 ? epoch : ep, reason: 'broke', by: BY } }
    case 'task.blocked':
      return { type, payload: { ...about, kind: rand() < 0.5 ? null : 'person', reason: 'held', by: BY } }
    case 'task.unblocked':
    case 'task.reopened':
      return { type, payload: { ...about, by: BY } }
    default:
      return { type, payload: { ...about, reason: 'no longer', by: BY } }
  }
}

/**
 * The transition table of M2_DESIGN 2.7.1, transcribed from original folds.ts:206-325 as data: the
 * states each event lands from, and where it goes. A second, declarative oracle besides the reference fold.
 */
type Row = { from: readonly RefTaskState[]; epoch?: 'next' | 'same'; to: (s: RefTaskState, needs: number) => RefTaskState }
const ALL: readonly RefTaskState[] = ['waiting', 'ready', 'claimed', 'blocked', 'completed', 'failed', 'canceled']
const TABLE: Record<string, Row> = {
  'task.assigned': { from: ALL, to: (s) => s },
  'task.needs_changed': { from: ['waiting', 'ready', 'blocked'], to: (s, n) => (s === 'blocked' ? s : n > 0 ? 'waiting' : 'ready') },
  'task.ready': { from: ['waiting'], to: () => 'ready' },
  'task.claimed': { from: ['ready'], epoch: 'next', to: () => 'claimed' },
  'task.renewed': { from: ['claimed'], epoch: 'same', to: () => 'claimed' },
  'task.released': { from: ['claimed'], epoch: 'same', to: () => 'ready' },
  'task.expired': { from: ['claimed'], epoch: 'same', to: () => 'ready' },
  'task.completed': { from: ['claimed'], epoch: 'same', to: () => 'completed' },
  'task.failed': { from: ['claimed'], epoch: 'same', to: () => 'failed' },
  'task.blocked': { from: ['waiting', 'ready', 'claimed'], to: () => 'blocked' },
  'task.unblocked': { from: ['blocked'], to: (_s, n) => (n > 0 ? 'waiting' : 'ready') },
  'task.canceled': { from: ['waiting', 'ready', 'claimed', 'blocked', 'failed'], to: () => 'canceled' },
  'task.reopened': { from: ['failed'], to: () => 'ready' },
}

const root = (over: Partial<FoldRoot> = {}): FoldRoot => ({ id: 1, channel: 'dev', thread: 't-1', re: null, deleted: false, ...over })

describe('AT-01 fold table', () => {
  it('AT-01 random task event sequences fold exactly as the original fold and the transition table say', () => {
    let folded = 0
    let refused = 0
    for (let seed = 1; seed <= 1000; seed++) {
      const rand = prng(seed)
      const message: RefMessage = { id: 1, re: rand() < 0.1 ? 7 : null, deleted: rand() < 0.1 }
      const fr = root({ re: message.re, deleted: message.deleted })
      let row: TaskRow | null = null
      let expirations = 0
      for (let step = 0; step < 40; step++) {
        const ev = randomEvent(rand, row?.epoch ?? 0)
        const before = row ? structuredClone(row) : null
        const beforeState = message.task?.state
        const refChanged = refFold(message, ev)
        const next = foldTask(row, fr, ev)
        // The port never changes its input.
        expect(row).toEqual(before)
        if (!refChanged) {
          expect(next, `seed ${seed} step ${step}: ${ev.type} from ${row?.state}`).toBe(false)
          refused += 1
          continue
        }
        expect(next, `seed ${seed} step ${step}: ${ev.type} from ${row?.state}`).not.toBe(false)
        if (next === false) return
        // The declarative table agrees on the from-state and the to-state.
        if (ev.type !== 'task.created') {
          const t = TABLE[ev.type]!
          expect(t.from).toContain(beforeState)
          if (t.epoch === 'next') expect(ev.payload.epoch).toBe(before!.epoch + 1)
          if (t.epoch === 'same') expect(ev.payload.epoch).toBe(before!.epoch)
          expect(next.state).toBe(t.to(beforeState!, next.needs.length))
        }
        if (ev.type === 'task.expired') expirations += 1
        const task = message.task!
        expect(toTaskView(next)).toEqual(refView(task))
        expect(next.claim_token_hash).toBe(task.claim?.token ?? null)
        expect(next.claim_until_ms).toBe(task.claim ? Date.parse(task.claim.until) : null)
        expect(next.expirations).toBe(expirations)
        expect([next.task_id, next.channel, next.thread]).toEqual([1, 'dev', 't-1'])
        row = next
        folded += 1
      }
    }
    // The generator exercises both sides.
    expect(folded).toBeGreaterThan(3000)
    expect(refused).toBeGreaterThan(3000)
  })

  it('AT-01 every event but task.created is refused on a root that is no task, and task.created only lands on a live root', () => {
    for (const type of TASK_EVENT_TYPES) {
      if (type === 'task.created') continue
      expect(foldTask(null, root(), { type, payload: { id: 1, thread: 't-1', epoch: 1, by: BY } })).toBe(false)
    }
    const created = { type: 'task.created', payload: { id: 1, thread: 't-1', needs: [], for: null, by: BY } }
    expect(foldTask(null, root({ deleted: true }), created)).toBe(false)
    expect(foldTask(null, root({ re: 3 }), created)).toBe(false)
    const row = foldTask(null, root(), created)
    expect(row).not.toBe(false)
    if (row === false) return
    expect(row.state).toBe('ready')
    expect(foldTask(row, root(), created)).toBe(false)
    expect(foldTask(null, root(), { type: 'task.unknown', payload: { id: 1 } })).toBe(false)
  })

  it('AT-01 malformed payloads fold to a no-op rather than to a corrupt row', () => {
    const made = foldTask(null, root(), { type: 'task.created', payload: { id: 1, thread: 't', needs: [], for: null, by: BY } })
    if (made === false) throw new Error('created')
    expect(foldTask(null, root(), { type: 'task.created', payload: { needs: 'x', for: null, by: BY } })).toBe(false)
    expect(foldTask(null, root(), { type: 'task.created', payload: { needs: [], for: null } })).toBe(false)
    expect(foldTask(made, root(), { type: 'task.claimed', payload: { epoch: 1, until: 'not a date', token: 'a', by: BY } })).toBe(false)
    expect(foldTask(made, root(), { type: 'task.claimed', payload: { epoch: '1', until: new Date().toISOString(), token: 'a', by: BY } })).toBe(false)
  })

  it('AT-01 needs keep first appearance and drop repeats, as every writer of the original sends them', () => {
    const made = foldTask(null, root(), { type: 'task.created', payload: { id: 1, thread: 't', needs: [4, 2, 4, 3, 2], for: null, by: BY } })
    if (made === false) throw new Error('created')
    expect(made.needs).toEqual([4, 2, 3])
    expect(made.state).toBe('waiting')
  })
})
