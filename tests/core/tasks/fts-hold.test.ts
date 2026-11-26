// M2 slice A verification round 1, F2 (concurrency): a new task root, and each root of a batch, must
// not run `DELETE FROM fts_messages WHERE message_id = ?`. message_id is an UNINDEXED fts5 column, so
// that DELETE scans the whole message index while the write lock is held, and for a brand-new message
// it deletes nothing (decision 15 keeps full-text writes off the hot task path; AT-40 wants the write
// flat as the board grows). An edit still replaces its row.
import { afterEach, describe, expect, it, vi } from 'vitest'
import { alice, makeBoard, type Board } from './helpers.ts'

const boards: Board[] = []
const open = (): Board => {
  const b = makeBoard()
  boards.push(b)
  return b
}
afterEach(() => {
  vi.restoreAllMocks()
  while (boards.length > 0) boards.pop()!.close()
})

const FTS_DELETE = /DELETE\s+FROM\s+fts_messages/i

/** The SQL texts `fn` prepares on the board's connection. */
function preparedBy(b: Board, fn: () => void): string[] {
  const seen: string[] = []
  const db = b.store.db
  const real = db.prepare.bind(db)
  const spy = vi.spyOn(db, 'prepare').mockImplementation((sql: string) => {
    seen.push(sql)
    return real(sql)
  })
  try {
    fn()
  } finally {
    spy.mockRestore()
  }
  return seen
}

/** Pads fts_messages with `n` rows no message owns, as a big board's index would hold. */
function pad(b: Board, n: number): void {
  b.store.transaction(() => {
    const stmt = b.store.db.prepare('INSERT INTO fts_messages (message_id, channel, thread, body) VALUES (?, ?, ?, ?)')
    for (let i = 0; i < n; i++) stmt.run(String(10_000_000 + i), 'pad', String(10_000_000 + i), `padding row ${i} lorem ipsum`)
  })
}

const roots = (n: number, tag: string) => Array.from({ length: n }, (_, i) => ({ text: `${tag} job ${i}` }))

describe('F2 new task roots stay off the fts_messages scan', () => {
  it('a task root, a batch of roots and a plain post issue no fts DELETE; an edit still does, and search finds each', () => {
    const b = open()
    const one = preparedBy(b, () => b.board.tasks.createTask(alice, { channel: 'dev', text: 'single root zebra' }))
    expect(one.filter((s) => FTS_DELETE.test(s))).toEqual([])
    const many = preparedBy(b, () => b.board.tasks.createTasks(alice, { channel: 'dev', tasks: roots(5, 'batched quokka') }))
    expect(many.filter((s) => FTS_DELETE.test(s))).toEqual([])
    let posted = ''
    const plain = preparedBy(b, () => {
      posted = b.board.postMessage(alice, { channel: 'dev', text: 'plain post narwhal' }).message.id
    })
    expect(plain.filter((s) => FTS_DELETE.test(s))).toEqual([])
    // Edits keep replacing their row: no stale text left behind, the new text found.
    const edit = preparedBy(b, () => b.board.editMessage(alice, posted, { text: 'edited post walrus' }))
    expect(edit.filter((s) => FTS_DELETE.test(s)).length).toBeGreaterThan(0)
    const hits = (q: string): number => b.board.search(alice, { query: q }).filter((h) => h.kind === 'message').length
    expect([hits('zebra'), hits('quokka'), hits('walrus'), hits('narwhal')]).toEqual([1, 5, 1, 0])
  })

  it('a 100-root batch on a 50k-row message index holds the write about as long as on an empty one', () => {
    const b = open()
    const time = (tag: string): number => {
      const started = performance.now()
      b.board.tasks.createTasks(alice, { channel: 'dev', tasks: roots(100, tag) })
      return performance.now() - started
    }
    time('warm')
    const empty = Math.min(time('e1'), time('e2'))
    pad(b, 50_000)
    // With the scan, 100 roots x a 50k-row scan is several hundred ms against tens; generous bound.
    const bound = empty * 3 + 60
    // HOST-0 closeout F5: under the full parallel suite one round can stall on a busy machine, so the best of
    // up to three rounds (two batches each) is asserted. A batch that scans the index is slow in every round.
    let padded = Number.POSITIVE_INFINITY
    for (let round = 0; round < 3 && !(padded < bound); round++) {
      padded = Math.min(padded, time(`p${2 * round + 1}`), time(`p${2 * round + 2}`))
    }
    expect(padded).toBeLessThan(bound)
  })
})
