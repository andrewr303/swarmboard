import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  createLocalCaller,
  LABEL_CONDITIONS_MAX,
  LABEL_FILTER_VALUES_MAX,
  SqliteUnifiedStore,
  toErrorPayload,
} from '../../src/core/index.ts'

const stores: SqliteUnifiedStore[] = []

function setup(): { store: SqliteUnifiedStore; board: BoardService } {
  const store = new SqliteUnifiedStore({ path: ':memory:' })
  stores.push(store)
  return { store, board: new BoardService(store, { seedDefaultGrants: false }) }
}

afterEach(() => {
  while (stores.length > 0) {
    stores.pop()!.close()
  }
})

describe('FTS5 Hybrid Search & ACL Filtering (F14)', () => {
  it('indexes messages, updates on edit, purges on delete, and searches tasks/knowledge', () => {
    const { store, board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })

    const { message: m1 } = board.postMessage(admin, {
      channel: 'work/backend',
      text: 'Implement SQLite WAL transaction isolation for Swarmboard',
      labels: { area: 'storage' },
    })
    const { message: m2 } = board.postMessage(admin, {
      channel: 'work/frontend',
      text: 'Build executive digest panel for human drop-in',
    })

    // Seed task & knowledge FTS5 entries
    store.transaction(() => {
      store.db
        .prepare("INSERT INTO fts_tasks (task_id, channel, state, body, result) VALUES (?, ?, 'ready', ?, ?)")
        .run('100', 'work/backend', 'Verify FTS5 porter stemming for transactions', '')
      store.db
        .prepare(
          "INSERT INTO knowledge_entries (id, channel, dept_id, title, body, citations_json, promoted_by, valid, created_at, updated_at) VALUES (?, ?, ?, ?, ?, '[]', 'admin', 1, ?, ?)",
        )
        .run(
          'k-1',
          'work/backend',
          'dept-be',
          'WAL Checkpoint Tuning',
          'Always use BEGIN IMMEDIATE for SQLite WAL writes.',
          '2026-11-22T23:00:00.000Z',
          '2026-11-22T23:00:00.000Z',
        )
      store.db
        .prepare(
          "INSERT INTO fts_knowledge (entry_id, channel, dept_id, title, body, citations) VALUES (?, ?, ?, ?, ?, '')",
        )
        .run('k-1', 'work/backend', 'dept-be', 'WAL Checkpoint Tuning', 'Always use BEGIN IMMEDIATE for SQLite WAL writes.')
    })

    // Porter stemming matches "transactions" -> "transaction"
    const hits = board.search(admin, { query: 'transactions' })
    expect(hits.some((h) => h.kind === 'message' && h.id === m1.id)).toBe(true)
    expect(hits.some((h) => h.kind === 'task' && h.id === '100')).toBe(true)

    const knowHits = board.search(admin, { query: 'IMMEDIATE', scope: 'knowledge', deptId: 'dept-be' })
    expect(knowHits).toHaveLength(1)
    expect(knowHits[0]!.title).toBe('WAL Checkpoint Tuning')

    // Edit updates FTS index
    board.editMessage(admin, m2.id, { text: 'Build escalation radar cockpit' })
    expect(board.search(admin, { query: 'digest' }).some((h) => h.id === m2.id)).toBe(false)
    expect(board.search(admin, { query: 'radar' }).some((h) => h.id === m2.id)).toBe(true)

    // Delete purges tombstone from FTS index
    board.deleteMessage(admin, m1.id)
    expect(board.search(admin, { query: 'Swarmboard' }).some((h) => h.id === m1.id)).toBe(false)
  })

  it('filters search results by caller read ACL and maps invalid FTS5 syntax to 400 invalid_fts_query', () => {
    const { board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })

    board.createGrant(admin, {
      principals: [{ kind: 'user', userId: 'reader' }],
      can: { 'public/': ['read'] },
    })

    board.postMessage(admin, { channel: 'public/news', text: 'Quarterly architecture review published' })
    board.postMessage(admin, { channel: 'secret/keys', text: 'Quarterly credentials rotation secret' })

    const reader = createLocalCaller({ userId: 'reader', handle: 'reader', member: true })
    const hits = board.search(reader, { query: 'Quarterly' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.channel).toBe('public/news')

    try {
      board.search(reader, { query: '"unclosed quote' })
      expect.unreachable()
    } catch (e) {
      expect(e).toBeInstanceOf(BoardError)
      expect((e as BoardError).status).toBe(400)
      expect((e as BoardError).code).toBe('invalid_fts_query')
    }

    // Empty/whitespace-only FTS5 phrases must also throw 400 invalid_fts_query
    for (const emptyPhrase of ['""', '"   "', 'foo AND ""']) {
      try {
        board.search(reader, { query: emptyPhrase })
        expect.unreachable()
      } catch (e) {
        expect(e).toBeInstanceOf(BoardError)
        expect((e as BoardError).status).toBe(400)
        expect((e as BoardError).code).toBe('invalid_fts_query')
      }
    }
  })

  it('prevents ACL starvation under limit and excludes deleted task messages from fts_tasks', () => {
    const { store, board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })

    board.createGrant(admin, {
      principals: [{ kind: 'user', userId: 'reader' }],
      can: { 'public/': ['read'] },
    })

    // Post 60 high-BM25 matches in secret/vault (unreadable) and 2 in public/docs (readable)
    for (let i = 0; i < 60; i++) {
      board.postMessage(admin, {
        channel: 'secret/vault',
        text: `Quarterly quarterly quarterly audit token ${i}`,
      })
    }
    const pub1 = board.postMessage(admin, {
      channel: 'public/docs',
      text: 'Quarterly engineering note 1',
    })
    const pub2 = board.postMessage(admin, {
      channel: 'public/docs',
      text: 'Quarterly engineering note 2',
    })

    const reader = createLocalCaller({ userId: 'reader', handle: 'reader', member: true })
    const hits = board.search(reader, { query: 'Quarterly', limit: 2 })
    expect(hits).toHaveLength(2)
    expect(hits.map((h) => h.id).sort()).toEqual([pub1.message.id, pub2.message.id].sort())

    // Deleted task root message must not appear in fts_tasks results
    const { message: taskMsg } = board.postMessage(admin, {
      channel: 'public/docs',
      text: 'Quarterly tombstoned task root',
    })
    store.transaction(() => {
      store.db
        .prepare("INSERT INTO fts_tasks (task_id, channel, state, body, result) VALUES (?, ?, 'ready', ?, '')")
        .run(taskMsg.id, 'public/docs', 'Quarterly tombstoned task root')
    })
    expect(board.search(admin, { query: 'tombstoned', scope: 'tasks' })).toHaveLength(1)
    board.deleteMessage(admin, taskMsg.id)
    expect(board.search(admin, { query: 'tombstoned', scope: 'tasks' })).toHaveLength(0)
  })
})

// M1 gate iteration 2 (V3): a label filter holds for every scope, not only messages.
describe('a label-filtered search finds only hits that carry the label', () => {
  it('keeps out tasks without the label and every knowledge entry', () => {
    const { store, board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })
    const { message: labelled } = board.postMessage(admin, { channel: 'dev', text: 'alpha labelled', labels: { kind: 'a' } })
    const { message: plain } = board.postMessage(admin, { channel: 'dev', text: 'alpha plain' })
    store.transaction(() => {
      const task = store.db.prepare("INSERT INTO fts_tasks (task_id, channel, state, body, result) VALUES (?, 'dev', 'ready', ?, '')")
      task.run(labelled.id, 'alpha task on the labelled message')
      task.run(plain.id, 'alpha task on the plain message')
      task.run('900', 'alpha task with no message')
      store.db
        .prepare("INSERT INTO fts_knowledge (entry_id, channel, dept_id, title, body, citations) VALUES ('k1', 'dev', NULL, 'alpha', 'alpha entry', '')")
        .run()
    })
    const found = (labels: { key: string; values: string[] | null }[]) =>
      board
        .search(admin, { query: 'alpha', labels })
        .map((hit) => `${hit.kind}:${hit.id}`)
        .sort()
    expect(found([{ key: 'kind', values: ['zzz'] }])).toEqual([])
    expect(found([{ key: 'kind', values: ['a'] }])).toEqual([`message:${labelled.id}`, `task:${labelled.id}`].sort())
    expect(found([{ key: 'kind', values: null }])).toEqual([`message:${labelled.id}`, `task:${labelled.id}`].sort())
    expect(found([])).toHaveLength(6)
  })
})

// M1 gate iteration 3 (Q1): the one paging loop every scope shares fills a page past batches a filter empties.
describe('a filtered search reads on until it fills the page, in every scope', () => {
  it('finds the few hits a filter keeps among hundreds, for messages and knowledge alike', () => {
    const { store, board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })
    store.transaction(() => {
      for (let i = 0; i < 250; i++) {
        board.postMessage(admin, { channel: 'dev', text: `needle number ${i}` })
        store.db
          .prepare('INSERT INTO fts_knowledge (entry_id, channel, dept_id, title, body) VALUES (?, ?, ?, ?, ?)')
          .run(`k${i}`, 'dev', null, `needle ${i}`, `needle body ${i}`)
      }
    })
    const keep = (hit: { kind: string; snippet: string }) => / (?:7|107|207)\]?$/.test(hit.snippet.replace(/[[\]]/g, ''))
    for (const scope of ['messages', 'knowledge'] as const) {
      const hits = store.ftsSearch({ query: 'needle', scope, limit: 3, filter: keep })
      expect(hits, scope).toHaveLength(3)
    }
    expect(store.ftsSearch({ query: 'needle', scope: 'messages', limit: 5, filter: keep })).toHaveLength(3)
  })
})

// M1 gate iteration 4 (F4): a label filter too large for SQLite is the request's 400, never a bad FTS query.
describe('a search label filter offers a bounded number of values', () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      const { status, payload } = toErrorPayload(error)
      return [status, payload.error.code]
    }
    throw new Error('expected a refusal')
  }

  it('answers too many values as 400 invalid_request, and takes the most it may', () => {
    const { store, board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })
    board.postMessage(admin, { channel: 'dev', text: 'needle', labels: { kind: 'v1' } })
    const values = (n: number) => Array.from({ length: n }, (_, i) => `v${i}`)
    expect(refusal(() => board.search(admin, { query: 'needle', labels: [{ key: 'kind', values: values(40000) }] }))).toEqual([
      400,
      'invalid_request',
    ])
    const sixteen = Array.from({ length: 16 }, () => ({ key: 'kind', values: values(LABEL_FILTER_VALUES_MAX + 1) }))
    expect(refusal(() => board.search(admin, { query: 'needle', labels: sixteen }))).toEqual([400, 'invalid_request'])
    const most = Array.from({ length: 16 }, () => ({ key: 'kind', values: values(LABEL_FILTER_VALUES_MAX) }))
    expect(board.search(admin, { query: 'needle', labels: most }).map((h) => h.kind)).toEqual(['message'])
    // The store itself, which no schema guards, calls a statement too large for SQLite its own failure.
    expect(refusal(() => store.ftsSearch({ query: 'needle', labels: [{ key: 'kind', values: values(40000) }] }))).toEqual([
      500,
      'internal',
    ])
  })
})

// M1 follow-up (S1): FTS5 writes a quote inside a quoted phrase doubled. That is content, not a close
// followed by an open, so a phrase that holds or ends in an escaped quote is not an empty phrase.
describe('a doubled quote inside an FTS5 phrase is a literal quote, not an empty phrase', () => {
  const refusal = (fn: () => unknown) => {
    try {
      fn()
    } catch (error) {
      const { status, payload } = toErrorPayload(error)
      return [status, payload.error.code]
    }
    throw new Error('expected a refusal')
  }

  it('finds the row for valid escaped-quote phrases and still refuses a truly empty phrase', () => {
    const { board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })
    board.postMessage(admin, { channel: 'dev', text: 'she said "hi" and left' })
    // `said "hi"`, `said "hi" and` and `"hi" and`, each written the way FTS5 asks for a quote in a phrase.
    for (const query of ['"said ""hi"""', '"said ""hi"" and"', '"""hi"" and"']) {
      expect(board.search(admin, { query }).map((hit) => hit.kind), query).toEqual(['message'])
    }
    // A phrase with nothing in it is still the query's 400, wherever it sits.
    for (const empty of ['""', '"   "', 'said AND ""', '"" ""', '"said" ""']) {
      expect(refusal(() => board.search(admin, { query: empty })), empty).toEqual([400, 'invalid_fts_query'])
    }
  })
})

// M1 follow-up (W-1): the thread and event label filters are bounded like the search filter. A filter
// too large for SQLite is the request's 400, never SQLite's own 500.
describe('a thread or event label filter is bounded', () => {
  const refusal = async (run: () => unknown) => {
    try {
      await run()
    } catch (error) {
      const { status, payload } = toErrorPayload(error)
      return [status, payload.error.code]
    }
    throw new Error('expected a refusal')
  }
  const conditions = (n: number) => Array.from({ length: n }, (_, i) => `k${i}`)
  const valuesOf = (n: number) => `kind=${Array.from({ length: n }, (_, i) => `v${i}`).join('|')}`

  it('answers too many conditions or too many values as 400 invalid_request, and takes the most it may', async () => {
    const { board } = setup()
    const admin = createLocalCaller({ userId: 'admin', handle: 'admin', owner: true })
    board.postMessage(admin, { channel: 'dev', text: 'needle', labels: { kind: 'v1' } })
    for (const query of [{ label: conditions(LABEL_CONDITIONS_MAX + 1) }, { label: [valuesOf(LABEL_FILTER_VALUES_MAX + 1)] }, { label: conditions(2000) }]) {
      expect(await refusal(() => board.listThreads(admin, query))).toEqual([400, 'invalid_request'])
      expect(await refusal(() => board.getEvents(admin, query))).toEqual([400, 'invalid_request'])
    }
    // The most it may offer still works, as conditions and as values.
    expect(board.listThreads(admin, { label: conditions(LABEL_CONDITIONS_MAX - 1).concat('kind') }).threads).toHaveLength(0)
    expect(board.listThreads(admin, { label: [valuesOf(LABEL_FILTER_VALUES_MAX)] }).threads).toHaveLength(1)
    // Events start from the head unless told where to read from, so read from the beginning.
    expect((await board.getEvents(admin, { after: '0', label: [valuesOf(LABEL_FILTER_VALUES_MAX)] })).events.length).toBeGreaterThan(0)
  })
})
