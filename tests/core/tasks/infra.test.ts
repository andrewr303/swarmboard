import * as fs from 'node:fs'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import {
  BoardError,
  BoardService,
  conflict,
  loadAllRows,
  loadRow,
  SqliteUnifiedStore,
  TASKS_SCHEMA_VERSION,
  type PlannedTaskEvent,
  type StoredMessage,
  type TaskRootOption,
} from '../../../src/core/index.ts'
import { alice, AUTHOR, created, ev, eventCount, HASH_A, makeBoard, message_, post, T0, type Board } from './helpers.ts'

const boards: Board[] = []
const open = (options: Parameters<typeof makeBoard>[0] = {}): Board => {
  const b = makeBoard(options)
  boards.push(b)
  return b
}
const dirs: string[] = []
const tempDir = (): string => {
  const dir = fs.mkdtempSync(join(import.meta.dirname, '.tmp-tasks-'))
  dirs.push(dir)
  return dir
}
afterEach(() => {
  while (boards.length > 0) boards.pop()!.close()
  while (dirs.length > 0) fs.rmSync(dirs.pop()!, { recursive: true, force: true })
})

/** A root option whose emit makes the root a task: created, then ready when `ready`. */
function rootOption(over: Partial<TaskRootOption> & { ready?: boolean; needs?: number[] } = {}): TaskRootOption & { calls: string[]; landed: StoredMessage[] } {
  const calls: string[] = []
  const landed: StoredMessage[] = []
  return {
    calls,
    landed,
    ...(over.eventId !== undefined ? { eventId: over.eventId } : {}),
    prepare:
      over.prepare ??
      ((tx) => {
        calls.push(`prepare@${tx.now}`)
        return { along: over.ready ? 2 : 1 }
      }),
    emit:
      over.emit ??
      ((root, postIndex) => {
        calls.push(`emit@${postIndex}`)
        const out: PlannedTaskEvent[] = [created(root, over.needs ?? [])]
        if (over.ready) out.push(ev(root, 'task.ready'))
        return out
      }),
    replay:
      over.replay ??
      ((m) => {
        calls.push('replay')
        landed.push(m)
      }),
  }
}

describe('A0 storage: the task tables, their indexes and the tasks_schema gate', () => {
  it('creates board_tasks, board_task_needs and the partial claim-probe indexes', () => {
    const b = open()
    const objects = b.store.db
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE tbl_name IN ('board_tasks', 'board_task_needs') ORDER BY name")
      .all() as Array<{ type: string; name: string; sql: string | null }>
    const names = objects.map((o) => o.name)
    for (const name of [
      'board_tasks',
      'board_task_needs',
      'board_tasks_mine',
      'board_tasks_pool',
      'board_tasks_lease',
      'board_tasks_state',
      'board_tasks_owner',
      'board_task_needs_need',
    ]) {
      expect(names).toContain(name)
    }
    const sql = (name: string) => objects.find((o) => o.name === name)!.sql!
    expect(sql('board_tasks_mine')).toMatch(/WHERE state = 'ready'/)
    expect(sql('board_tasks_pool')).toMatch(/WHERE state = 'ready' AND for_actor IS NULL/)
    expect(sql('board_tasks_lease')).toMatch(/WHERE state = 'claimed'/)
    expect(sql('board_task_needs')).toMatch(/WITHOUT ROWID/)
    // The state CHECK refuses a state the fold never writes.
    expect(() =>
      b.store.db
        .prepare("INSERT INTO board_tasks (task_id, channel, thread, state, owner, by_actor, created_index, updated_index) VALUES (1, 'c', 't', 'lost', 'o', 'o', 1, 1)")
        .run(),
    ).toThrow(/CHECK/)
  })

  it('AT-38 writes tasks_schema=1 on open, leaves user_version to the schema ladder, and opens again without change', () => {
    const dir = tempDir()
    const path = join(dir, 'board.db')
    const s1 = new SqliteUnifiedStore({ path })
    expect(TASKS_SCHEMA_VERSION).toBe(1)
    expect(s1.db.prepare("SELECT value FROM board_meta WHERE key = 'tasks_schema'").get()).toEqual({ value: '1' })
    expect(s1.writeRefusal()).toBeNull()
    s1.close()
    const s2 = new SqliteUnifiedStore({ path })
    expect(s2.db.prepare("SELECT value FROM board_meta WHERE key = 'tasks_schema'").get()).toEqual({ value: '1' })
    expect(s2.db.prepare('PRAGMA user_version').get()).toEqual({ user_version: 1 })
    s2.close()
  })

  it('AT-38 a file a newer build wrote (tasks_schema 2) refuses every write with 503 and can still be read', () => {
    const dir = tempDir()
    const path = join(dir, 'board.db')
    const s1 = new SqliteUnifiedStore({ path })
    const b1 = new BoardService(s1)
    b1.postMessage(alice, { channel: 'dev', text: 'before the upgrade' })
    s1.db.prepare("UPDATE board_meta SET value = '2' WHERE key = 'tasks_schema'").run()
    s1.close()

    const s2 = new SqliteUnifiedStore({ path })
    const refusal = s2.writeRefusal()
    expect(refusal).toBeInstanceOf(BoardError)
    expect(refusal!.status).toBe(503)
    expect(refusal!.code).toBe('unavailable')
    expect(refusal!.message).toBe('this board was written by a newer Swarmboard (tasks_schema 2)')
    const b2 = new BoardService(s2)
    expect(b2.listThreads(alice, { channel: 'dev' }).threads).toHaveLength(1)
    const before = eventCount({ store: s2 } as Board)
    expect(() => b2.postMessage(alice, { channel: 'dev', text: 'after' })).toThrow(refusal!)
    expect(() => s2.appendEvent({ type: 'x.y', payload: {} })).toThrow(refusal!)
    expect(eventCount({ store: s2 } as Board)).toBe(before)
    s2.close()
  })

  it('AT-38 a file whose log holds task events but whose index is empty is rebuilt on open', () => {
    const dir = tempDir()
    const path = join(dir, 'board.db')
    const s1 = new SqliteUnifiedStore({ path })
    const b1 = new BoardService(s1, { now: () => T0 })
    const a = post({ store: s1, board: b1 } as Board, 'a')
    const c = post({ store: s1, board: b1 } as Board, 'c')
    b1.tasks.transition(a.id, [created(a)])
    b1.tasks.transition(c.id, [created(c, [a.id])])
    const live = loadAllRows(s1.db)
    // As a log another build wrote would leave it: events, no index, no gate.
    s1.db.exec("DELETE FROM board_tasks; DELETE FROM board_task_needs; DELETE FROM board_meta WHERE key = 'tasks_schema'")
    s1.close()
    const s2 = new SqliteUnifiedStore({ path })
    expect(loadAllRows(s2.db)).toEqual(live)
    expect(s2.db.prepare("SELECT value FROM board_meta WHERE key = 'tasks_schema'").get()).toEqual({ value: '1' })
    s2.close()
  })

  it('testHooks: onBeginImmediate runs before each outermost BEGIN IMMEDIATE, beforeCommit before its COMMIT', () => {
    let begins = 0
    let fail = false
    const b = open({
      testHooks: {
        onBeginImmediate: () => {
          begins += 1
        },
        beforeCommit: () => {
          if (fail) throw new Error('killed before commit')
        },
      },
    })
    const start = begins
    b.store.transaction(() => {
      b.store.transaction(() => b.store.appendEvent({ type: 'probe.one', payload: {} }))
    })
    expect(begins).toBe(start + 1)
    const before = eventCount(b)
    fail = true
    expect(() => b.store.appendEvent({ type: 'probe.two', payload: {} })).toThrow('killed before commit')
    expect(eventCount(b)).toBe(before)
  })
})

describe('A0 service seams: the clock, board.tasks, the taskRoot option, the org session filter', () => {
  it('the injected clock times posts and task events', () => {
    const b = open()
    b.clock.now = T0 + 12_345
    const root = post(b, 'clocked')
    expect(root.createdAt).toBe(new Date(T0 + 12_345).toISOString())
    b.clock.now = T0 + 99_000
    const [made] = b.board.tasks.transition(root.id, [created(root)])
    expect(made!.createdAt).toBe(new Date(T0 + 99_000).toISOString())
    expect(b.board.tasks).toBe(b.board.tasks)
  })

  it('taskRoot: prepare runs after the lock with the clock, emit lands the task events right after message.posted with its along', () => {
    const b = open()
    // A prerequisite that has completed: the new task needs it, so it is born ready.
    const done = post(b, 'prerequisite')
    b.board.tasks.transition(done.id, [
      created(done),
      ev(done, 'task.claimed', { epoch: 1, until: new Date(T0 + 60_000).toISOString(), token: HASH_A, by: AUTHOR }),
      ev(done, 'task.completed', { epoch: 1, result: null, by: AUTHOR }),
    ])
    b.clock.now = T0 + 5
    const opt = rootOption({ ready: true, needs: [done.id] })
    const head = b.store.getHeadIndex()
    const out = b.board.tasks.host.postRoot(alice, { channel: 'work', text: 'a root that is a task' }, opt)
    expect(out.replayed).toBe(false)
    const events = b.store.getEvents({ after: head }).events
    const types = events.map((e) => e.type).filter((t) => t !== 'actor.seen')
    expect(types).toEqual(['message.posted', 'task.created', 'task.ready'])
    const posted = events.find((e) => e.type === 'message.posted')!
    expect(posted.payload.along).toBe(2)
    expect(events.at(-1)!.index).toBe(posted.index + 2)
    expect(opt.calls).toEqual([`prepare@${T0 + 5}`, `emit@${posted.index}`])
    // The answer and the root show the task as the writes left it.
    expect(out.message.task).toMatchObject({ state: 'ready', owner: AUTHOR.principal, needs: [String(done.id)] })
    expect(out.message.labels['board.task']).toBe('ready')
    expect(out.message.version).toBe(posted.index + 2)
    expect(out.message.revision).toBe(posted.index)
    expect(out.root.id).toBe(posted.index)
    expect(loadRow(b.store.db, posted.index)!.state).toBe('ready')
    // `along` never reaches a reader of the feed.
    expect(message_(b, posted.index).task!.state).toBe('ready')
  })

  it('taskRoot: a prepare that refuses posts nothing at all', () => {
    const b = open()
    b.board.postMessage(alice, { channel: 'work', text: 'warm the actor' })
    const before = eventCount(b)
    const messages = b.store.db.prepare('SELECT COUNT(*) AS c FROM board_messages').get()
    const opt = rootOption({
      prepare: () => {
        throw conflict('the task would wait for #1: nothing was made', 'task_waiting')
      },
    })
    expect(() => b.board.tasks.host.postRoot(alice, { channel: 'work', text: 'never posted' }, opt)).toThrow(
      'the task would wait for #1: nothing was made',
    )
    expect(eventCount(b)).toBe(before)
    expect(b.store.db.prepare('SELECT COUNT(*) AS c FROM board_messages').get()).toEqual(messages)
  })

  it('taskRoot: emit must carry the events prepare announced, or nothing lands', () => {
    const b = open()
    const before = eventCount(b)
    const opt = rootOption({ prepare: () => ({ along: 2 }) })
    expect(() => b.board.tasks.host.postRoot(alice, { channel: 'work', text: 'short' }, opt)).toThrow(
      "a root's post carries the 2 events it said, not 1",
    )
    expect(eventCount(b)).toBe(before)
  })

  it('taskRoot: a post sent again with its id calls replay instead of prepare and emit, and writes nothing', () => {
    const b = open()
    const first = b.board.tasks.host.postRoot(alice, { channel: 'work', text: 'once', id: 'client-1' }, rootOption())
    const before = eventCount(b)
    const again = rootOption()
    const out = b.board.tasks.host.postRoot(alice, { channel: 'work', text: 'once', id: 'client-1' }, again)
    expect(out.replayed).toBe(true)
    expect(again.calls).toEqual(['replay'])
    expect(again.landed[0]!.id).toBe(first.root.id)
    expect(again.landed[0]!.task!.state).toBe('ready')
    expect(out.message.id).toBe(first.message.id)
    expect(eventCount(b)).toBe(before)
    // The option may refuse the replay (a plain post's id reused for a task): the refusal flows back.
    const plain = b.board.postMessage(alice, { channel: 'work', text: 'plain', id: 'client-2' })
    const refusing = rootOption({
      replay: (landed) => {
        if (!landed.task) throw conflict('that id was already used for a different write', 'duplicate_id')
      },
    })
    expect(() => b.board.tasks.host.postRoot(alice, { channel: 'work', text: 'plain', id: 'client-2' }, refusing)).toThrow(
      'that id was already used for a different write',
    )
    expect(plain.message.task).toBeUndefined()
  })

  it('taskRoot: an eventId names the root post and its thread (batch roots)', () => {
    const b = open()
    const id = '01234567-89ab-8cde-8f01-23456789abcd'
    const out = b.board.tasks.host.postRoot(alice, { channel: 'work', text: 'batch root' }, rootOption({ eventId: id }))
    expect(out.root.eventId).toBe(id)
    expect(out.root.thread).toBe(id)
    const posted = b.store.db.prepare("SELECT event_id FROM board_events WHERE type = 'message.posted' AND log_index = ?").get(out.root.id)
    expect(posted).toEqual({ event_id: id })
  })

  it('the org session stays out of the feed unless a reader of every channel asks with all=true&include=org', async () => {
    const b = open()
    b.board.postMessage(alice, { channel: 'dev', text: 'board event' })
    b.store.appendEvent({ sessionId: 'org', type: 'org.probe', payload: { note: 'org only' } })
    const plain = await b.board.getEvents(alice, { all: true, last: 100 })
    expect(plain.events.map((e) => e.type)).not.toContain('org.probe')
    const notAll = await b.board.getEvents(alice, { include: 'org', last: 100 })
    expect(notAll.events.map((e) => e.type)).not.toContain('org.probe')
    const withOrg = await b.board.getEvents(alice, { all: true, include: 'org', last: 100 })
    expect(withOrg.events.map((e) => e.type)).toContain('org.probe')
    const narrow = { ...alice, canHeader: 'dev=read' }
    const narrowed = await b.board.getEvents(narrow, { all: true, include: 'org', last: 100 })
    expect(narrowed.events.map((e) => e.type)).not.toContain('org.probe')
  })

  it('task search reads live state from board_tasks: a claim, which leaves fts_tasks alone, still shows', () => {
    const b = open()
    const root = post(b, 'searchable widget')
    b.board.tasks.transition(root.id, [created(root)])
    const until = new Date(T0 + 60_000).toISOString()
    b.board.tasks.transition(root.id, [ev(root, 'task.claimed', { epoch: 1, until, token: HASH_A, by: AUTHOR })])
    expect(b.store.db.prepare('SELECT state FROM fts_tasks WHERE task_id = ?').get(String(root.id))).toEqual({ state: 'ready' })
    const hits = b.store.ftsSearch({ query: 'widget', scope: 'tasks' })
    expect(hits).toHaveLength(1)
    expect(hits[0]!.metadata).toEqual({ state: 'claimed' })
    // A terminal transition rewrites the search row with its state and result.
    b.board.tasks.transition(root.id, [ev(root, 'task.completed', { epoch: 1, result: 'widget shipped', by: AUTHOR })])
    expect(b.store.db.prepare('SELECT state, result FROM fts_tasks WHERE task_id = ?').get(String(root.id))).toEqual({
      state: 'completed',
      result: 'widget shipped',
    })
  })
})
