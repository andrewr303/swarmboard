// M2 slice A closeout F-1 (2): a batch that landed under the limits of its day stands when the board's
// limits change. The original answers a retry under a landed `id` from the landed batch before its own
// limits (serve.ts:982-994 createdTasks runs before a2.ts:656-660). Here the board's text limit is
// lowered at run time, as an upgrade would, through a module mock kept to this file.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { alice, eventCount, makeBoard, type Board } from './helpers.ts'
import { refusal } from './verb-helpers.ts'

const limit = vi.hoisted(() => ({ text: undefined as number | undefined, key: undefined as number | undefined }))
vi.mock('../../../src/core/schemas.ts', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/core/schemas.ts')>()
  return {
    ...real,
    get MESSAGE_TEXT_MAX(): number {
      return limit.text ?? real.MESSAGE_TEXT_MAX
    },
    get TASK_KEY_MAX(): number {
      return limit.key ?? real.TASK_KEY_MAX
    },
  }
})

const boards: Board[] = []
afterEach(() => {
  limit.text = undefined
  limit.key = undefined
  while (boards.length > 0) boards.pop()!.close()
})

describe('closeout F-1 (2): a landed batch outlives a limit change', () => {
  it('closeout F-1 (2) a retry after the text and key limits are lowered answers the landed batch; a new id is held to them', () => {
    const b = makeBoard()
    boards.push(b)
    const tasks = [{ key: 'a-rather-long-key', text: 'a root of forty characters, give or take' }, { text: 'and one more after it' }]
    const first = b.board.tasks.createTasks(alice, { channel: 'dev', id: 'L1', tasks })
    // The board now holds a root to 10 characters and a key to 4.
    limit.text = 10
    limit.key = 4
    expect(refusal(() => b.board.tasks.createTasks(alice, { channel: 'dev', id: 'L2', tasks: [{ text: 'x'.repeat(11) }] }))[1]).toBe('text_too_long')
    expect(refusal(() => b.board.tasks.createTasks(alice, { channel: 'dev', id: 'L2', tasks: [{ key: 'abcde', text: 'short' }] }))[1]).toBe(
      'invalid_request',
    )
    const events = eventCount(b)
    const again = b.board.tasks.createTasks(alice, { channel: 'dev', id: 'L1', tasks })
    expect(again).toEqual(b.board.tasks.getBatch(alice, 'L1'))
    expect(again.tasks.map((root) => [root.id, root.text])).toEqual(first.tasks.map((root) => [root.id, root.text]))
    expect(eventCount(b)).toBe(events)
    // Without an id the same request is a new one, and is held to today's limits.
    expect(refusal(() => b.board.tasks.createTasks(alice, { channel: 'dev', tasks }))[1]).toBe('invalid_request')
    expect(eventCount(b)).toBe(events)
  })
})
