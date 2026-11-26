// The IDs and digest a batch is found again by (M2_DESIGN 2.7.4), bit-exact with the original's
// client/ids.ts:13-21 derivedId and server/serve.ts:625-632 batchRequest, and the batch plan,
// ported from contract/task-batch.ts:16-59. Synchronous: node:crypto in place of WebCrypto.
import { createHash } from 'node:crypto'

const sha256Hex = (text: string): string => createHash('sha256').update(text, 'utf8').digest('hex')

/**
 * A UUIDv8 from `parts`, exactly as the original's derivedId makes one: the first 16 bytes of
 * sha256(JSON.stringify(parts)), version 8 and variant 10 set. These are the board's own IDs, which
 * no request may post with.
 */
export function derivedId(...parts: string[]): string {
  const bytes = createHash('sha256').update(JSON.stringify(parts), 'utf8').digest().subarray(0, 16)
  bytes[6] = (bytes[6]! & 15) | 128
  bytes[8] = (bytes[8]! & 63) | 128
  const text = bytes.toString('hex')
  return `${text.slice(0, 8)}-${text.slice(8, 12)}-${text.slice(12, 16)}-${text.slice(16, 20)}-${text.slice(20, 32)}`
}

/** What a batch's task waits for: a task's ID, or `{ key }` for a task of the same batch. */
export type BatchNeed = string | { key: string }

/** A batch's task as its digest reads it. */
export type DigestTask = {
  key?: string | undefined
  text: string
  labels?: Record<string, string> | undefined
  noSync?: boolean | undefined
  attachments?: readonly string[] | undefined
  needs?: readonly BatchNeed[] | undefined
  for?: string | null | undefined
}

/**
 * A digest of what a batch asks for, as it was given: its channel and its tasks, in order, each with
 * its key, text, labels (sorted by key), `noSync`, files, needs and assignee; a field left out is its
 * empty value. The first 32 hex digits of a sha256.
 */
export function batchDigest(channel: string, tasks: readonly DigestTask[]): string {
  const asked = tasks.map((task) => [
    task.key ?? null,
    task.text,
    Object.entries(task.labels ?? {}).sort(([a], [b]) => (a < b ? -1 : 1)),
    task.noSync ?? false,
    task.attachments ?? [],
    task.needs ?? [],
    task.for ?? null,
  ])
  return sha256Hex(JSON.stringify([channel, asked])).slice(0, 32)
}

/** The ID a batch's root `at` posts with, under the batch's `id`. */
export const batchRootId = (id: string, at: number): string => derivedId('board-batch', id, String(at))

/** The ID of the event right after a batch's first root, which says what the batch was asked for. */
export const batchAskedId = (id: string, request: string): string => derivedId('board-batch-request', id, request)

/** What a batch's task is, as far as waiting goes. */
export type BatchTask = { key?: string | undefined; needs?: readonly BatchNeed[] | undefined }

/**
 * For each task of a batch, the batch's tasks it waits for, by their place in it (first appearance
 * kept), and an order to make them in; or a `problem` when two tasks share a key, a task waits for a
 * key no task has or for itself, or tasks wait for each other.
 */
export function batchPlan(tasks: readonly BatchTask[]): { inside: number[][]; order: number[] } | { problem: string } {
  const named = new Map<string, number>()
  for (const [at, task] of tasks.entries()) {
    if (task.key === undefined) continue
    if (named.has(task.key)) return { problem: `two tasks of the batch have the key ${JSON.stringify(task.key)}` }
    named.set(task.key, at)
  }
  const inside: number[][] = []
  for (const [at, task] of tasks.entries()) {
    const waits = new Set<number>()
    for (const need of task.needs ?? []) {
      if (typeof need === 'string') continue
      const found = named.get(need.key)
      if (found === undefined) return { problem: `no task of the batch has the key ${JSON.stringify(need.key)}` }
      if (found === at) return { problem: `the task with the key ${JSON.stringify(need.key)} waits for itself` }
      waits.add(found)
    }
    inside.push([...waits])
  }
  // Each task after what it waits for, without recursion: a plan can be a long chain.
  const order: number[] = []
  const state = new Uint8Array(tasks.length)
  for (let start = 0; start < tasks.length; start++) {
    if (state[start] !== 0) continue
    const path: { at: number; next: number }[] = [{ at: start, next: 0 }]
    state[start] = 1
    while (path.length > 0) {
      const top = path.at(-1)!
      const need = inside[top.at]![top.next++]
      if (need === undefined) {
        state[top.at] = 2
        order.push(top.at)
        path.pop()
      } else if (state[need] === 1) {
        const loop = path.slice(path.findIndex((step) => step.at === need)).map((step) => JSON.stringify(tasks[step.at]!.key))
        return { problem: `the tasks with the keys ${loop.join(', ')} wait for each other` }
      } else if (state[need] === 0) {
        state[need] = 1
        path.push({ at: need, next: 0 })
      }
    }
  }
  return { inside, order }
}
