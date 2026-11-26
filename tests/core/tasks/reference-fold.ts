// An independent transcription of the original's task fold, on the original's own shapes
// (board/packages/board/src/contract/folds.ts:19-38 Task, :206-213 task.created, :244-325 foldTask).
// It shares no code with src/core/tasks/fold.ts: AT-01 and AT-02 check the port against it.

export type RefTaskState = 'waiting' | 'ready' | 'claimed' | 'blocked' | 'completed' | 'failed' | 'canceled'

export type RefTask = {
  state: RefTaskState
  owner: string
  by: string
  for: string | null
  needs: number[]
  epoch: number
  claim: { actor: string; until: string; token: string } | null
  blocked: { kind: string | null; reason: string } | null
  result: string | null
  reason: string | null
}

export type RefMessage = { id: number; re: number | null; deleted: boolean; task?: RefTask }

type P = Record<string, any>

const holds = (task: RefTask, epoch: number) => task.state === 'claimed' && task.epoch === epoch

/** original folds.ts:206-213: a thread becomes a task once, at its root, while the root is there. */
export function refCreate(message: RefMessage | undefined, payload: P): boolean {
  if (!message || message.deleted || message.re !== null || message.task) return false
  const { needs, by } = payload
  message.task = {
    state: needs.length > 0 ? 'waiting' : 'ready',
    owner: by.principal,
    by: by.actor,
    for: payload.for,
    needs: [...needs],
    epoch: 0,
    claim: null,
    blocked: null,
    result: null,
    reason: null,
  }
  return true
}

/** original folds.ts:252-325, verbatim but for the event's type annotation. */
export function refFoldTask(task: RefTask, event: { type: string; payload: P }): boolean {
  switch (event.type) {
    case 'task.assigned':
      if (task.for === event.payload.for) return false
      task.for = event.payload.for
      return true
    case 'task.needs_changed':
      if (task.state !== 'waiting' && task.state !== 'ready' && task.state !== 'blocked') return false
      task.needs = [...event.payload.needs]
      if (task.state !== 'blocked') task.state = task.needs.length > 0 ? 'waiting' : 'ready'
      return true
    case 'task.ready':
      if (task.state !== 'waiting') return false
      task.state = 'ready'
      return true
    case 'task.claimed': {
      const { epoch, until, token, by } = event.payload
      if (task.state !== 'ready' || epoch !== task.epoch + 1) return false
      task.state = 'claimed'
      task.epoch = epoch
      task.claim = { actor: by.actor, until, token }
      return true
    }
    case 'task.renewed':
      if (!holds(task, event.payload.epoch)) return false
      task.claim!.until = event.payload.until
      return true
    case 'task.released':
    case 'task.expired':
      if (!holds(task, event.payload.epoch)) return false
      task.state = 'ready'
      task.claim = null
      return true
    case 'task.completed':
      if (!holds(task, event.payload.epoch)) return false
      task.state = 'completed'
      task.claim = null
      task.result = event.payload.result
      return true
    case 'task.failed':
      if (!holds(task, event.payload.epoch)) return false
      task.state = 'failed'
      task.claim = null
      task.reason = event.payload.reason
      return true
    case 'task.blocked':
      if (task.state !== 'waiting' && task.state !== 'ready' && task.state !== 'claimed') return false
      task.state = 'blocked'
      task.claim = null
      task.blocked = { kind: event.payload.kind, reason: event.payload.reason }
      return true
    case 'task.unblocked':
      if (task.state !== 'blocked') return false
      task.state = task.needs.length > 0 ? 'waiting' : 'ready'
      task.blocked = null
      return true
    case 'task.canceled':
      if (task.state === 'completed' || task.state === 'canceled') return false
      task.state = 'canceled'
      task.claim = null
      task.blocked = null
      task.reason = event.payload.reason
      return true
    case 'task.reopened':
      if (task.state !== 'failed') return false
      task.state = 'ready'
      task.reason = null
      return true
  }
  return false
}

/** One task event on a message, as the original's foldMessage dispatches it (folds.ts:206-230). */
export function refFold(message: RefMessage | undefined, event: { type: string; payload: P }): boolean {
  if (event.type === 'task.created') return refCreate(message, event.payload)
  if (!message?.task) return false
  return refFoldTask(message.task, event)
}

/** The view the original renders of a task (feed.ts:118-126): needs as refs, the claim without its token. */
export const refView = (task: RefTask) => ({
  state: task.state,
  owner: task.owner,
  by: task.by,
  for: task.for,
  needs: task.needs.map(String),
  epoch: task.epoch,
  claim: task.claim ? { actor: task.claim.actor, until: task.claim.until } : null,
  blocked: task.blocked ? { ...task.blocked } : null,
  result: task.result,
  reason: task.reason,
})

/** mulberry32: a seeded PRNG, so a failing property case is reproducible from its seed. */
export function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

export const pick = <T>(rand: () => number, items: readonly T[]): T => items[Math.floor(rand() * items.length)]!
