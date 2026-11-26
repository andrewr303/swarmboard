// HOST-0 stage 3, CR-8 (HOST0_DESIGN 3.9 and HT-101): BoardServiceOptions.tasks reaches the task engine.
import * as fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { BoardService, createLocalCaller, SqliteUnifiedStore } from '../../../src/core/index.ts'

const owner = createLocalCaller({ userId: 'alice', handle: 'alice', owner: true })
const dirs: string[] = []
const stores: SqliteUnifiedStore[] = []

afterEach(() => {
  vi.useRealTimers()
  for (const s of stores.splice(0)) {
    try {
      s.close()
    } catch {
      // Closed already.
    }
  }
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true })
})

describe('BoardServiceOptions.tasks', () => {
  it('HT-101 a host arms the task engine safety poll through BoardService', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'] })
    const dir = fs.mkdtempSync(join(tmpdir(), 'swarmboard-opts-'))
    dirs.push(dir)
    const path = join(dir, 'board.db')
    const open = (): SqliteUnifiedStore => {
      const s = new SqliteUnifiedStore({ path })
      stores.push(s)
      return s
    }
    const storeA1 = open()
    const storeA0 = open()
    const storeB = open()
    const boardA1 = new BoardService(storeA1, { tasks: { wake: (l) => storeA1.onEvent(l), armedSafetyPollMs: 1500 } })
    const boardA0 = new BoardService(storeA0)
    const boardB = new BoardService(storeB)

    let settled0: string | null | undefined
    let settled1: string | null | undefined
    const w0 = boardA0.tasks.claimReady(owner, { channel: 'c0', wait: 10 }).then((r) => (settled0 = r.task?.id ?? null))
    const w1 = boardA1.tasks.claimReady(owner, { channel: 'c1', wait: 10 }).then((r) => (settled1 = r.task?.id ?? null))
    await vi.advanceTimersByTimeAsync(150)
    const t0 = boardB.tasks.createTask(owner, { channel: 'c0', text: 'for A0' }).task.id
    const t1 = boardB.tasks.createTask(owner, { channel: 'c1', text: 'for A1' }).task.id
    // Nothing is pumped: only the engine's own probes can find the tasks.
    await vi.advanceTimersByTimeAsync(850)
    expect(settled0).toBe(t0)
    expect(settled1).toBeUndefined()
    await vi.advanceTimersByTimeAsync(700)
    expect(settled1).toBe(t1)
    await Promise.all([w0, w1])
  })
})
