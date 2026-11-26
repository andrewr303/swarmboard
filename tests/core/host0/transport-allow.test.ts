// HOST-0 stage 3, the transport allow-list (HOST0_DESIGN 3.9, SEC-2): HT-76. TypeScript `private` is erased at
// run time, so the list of members a transport may bind to is an allow-list, checked here by reflection and by a
// source scan. A new public verb fails this test until someone routes it or lists it as never-routable.
import * as fs from 'node:fs'
import { join, resolve } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { BoardService, SqliteUnifiedStore } from '../../../src/core/index.ts'
import { TRANSPORT_ALLOW } from '../../../src/core/internal.ts'

const SRC = resolve(import.meta.dirname, '..', '..', '..', 'src', 'core')
const NEVER_BOARD = ['store', 'runDueSchedules', 'importAttachment', 'resolveAccess', 'boardInfo']
const NEVER_TASKS = ['host', 'transition', 'commitRootEventsInTx', 'rootHooks', 'use', 'reserveHoldPrefix', 'expireDueClaims', 'nextLeaseDueMs', 'rebuildIndex', 'capabilities']

const stores: SqliteUnifiedStore[] = []
afterEach(() => {
  for (const s of stores.splice(0)) s.close()
})

function members(obj: object): Map<string, unknown> {
  const out = new Map<string, unknown>()
  for (let o: object | null = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
    for (const k of Object.getOwnPropertyNames(o)) {
      if (k === 'constructor' || out.has(k)) continue
      const d = Object.getOwnPropertyDescriptor(o, k)!
      out.set(k, d.get ? '<getter>' : d.value)
    }
  }
  return out
}
const firstParam = (f: Function): string | null => /^[^(]*\(\s*([A-Za-z_$][\w$]*)/.exec(Function.prototype.toString.call(f))?.[1] ?? null

function excluded(file: string): Set<string> {
  const src = fs.readFileSync(file, 'utf8')
  const out = new Set<string>()
  for (const m of src.matchAll(/^\s*(?:private|protected)\s+(?:readonly\s+|async\s+|static\s+)*([A-Za-z_$][\w$]*)/gm)) out.add(m[1]!)
  for (const m of src.matchAll(/@internal[\s\S]*?\*\/\s*\n\s*(?:(?:public|readonly|async|get|set)\s+)*([A-Za-z_$][\w$]*)/g)) out.add(m[1]!)
  return out
}

function generate(obj: object, ex: Set<string>, never: string[]): { allowed: string[]; callerFirst: string[] } {
  const allowed: string[] = []
  const callerFirst: string[] = []
  for (const [k, v] of members(obj)) {
    if (typeof v !== 'function' || firstParam(v) !== 'caller') continue
    callerFirst.push(k)
    if (!ex.has(k) && !never.includes(k)) allowed.push(k)
  }
  return { allowed: allowed.sort(), callerFirst }
}

const isSorted = (xs: readonly string[]): boolean => xs.every((x, i) => i === 0 || xs[i - 1]! < x)

describe('C6 the transport allow-list', () => {
  it('HT-76 TRANSPORT_ALLOW is frozen, sorted, caller-first, public and complete', () => {
    const store = new SqliteUnifiedStore({ path: ':memory:' })
    stores.push(store)
    const board = new BoardService(store)
    const tasks = board.tasks

    expect(Object.isFrozen(TRANSPORT_ALLOW)).toBe(true)
    expect(Object.isFrozen(TRANSPORT_ALLOW.board)).toBe(true)
    expect(Object.isFrozen(TRANSPORT_ALLOW.tasks)).toBe(true)
    expect(isSorted(TRANSPORT_ALLOW.board)).toBe(true)
    expect(isSorted(TRANSPORT_ALLOW.tasks)).toBe(true)

    const bMembers = members(board)
    const tMembers = members(tasks)
    for (const name of TRANSPORT_ALLOW.board) {
      const f = bMembers.get(name)
      expect(typeof f, `board.${name}`).toBe('function')
      expect(firstParam(f as Function), `board.${name}`).toBe('caller')
    }
    for (const name of TRANSPORT_ALLOW.tasks) {
      const f = tMembers.get(name)
      expect(typeof f, `tasks.${name}`).toBe('function')
      expect(firstParam(f as Function), `tasks.${name}`).toBe('caller')
    }

    // Reflective sweep: nothing that is not a caller-first function is listed.
    for (const [name, v] of bMembers) {
      if (typeof v !== 'function' || firstParam(v) !== 'caller') expect(TRANSPORT_ALLOW.board, `board.${name}`).not.toContain(name)
    }
    for (const [name, v] of tMembers) {
      if (typeof v !== 'function' || firstParam(v) !== 'caller') expect(TRANSPORT_ALLOW.tasks, `tasks.${name}`).not.toContain(name)
    }
    for (const name of ['tx', 'fireScheduleInTx', 'seedDefaults', 'saveMessageInTx', 'taskHost', 'ensureChannelInTx', 'options', 'nowMs', 'boardInfo']) {
      expect(TRANSPORT_ALLOW.board).not.toContain(name)
    }
    for (const name of ['hooks', 'hub', 'capabilities']) expect(TRANSPORT_ALLOW.tasks).not.toContain(name)

    // Static sweep: private, protected and @internal members.
    const bEx = excluded(join(SRC, 'board-service.ts'))
    const tEx = excluded(join(SRC, 'tasks', 'task-service.ts'))
    for (const name of bEx) expect(TRANSPORT_ALLOW.board, `board.${name}`).not.toContain(name)
    for (const name of tEx) expect(TRANSPORT_ALLOW.tasks, `tasks.${name}`).not.toContain(name)
    for (const name of ['postMessageAs', 'upsertActorInTx', 'requireAdmitted', 'postRootAs']) {
      expect(bEx.has(name), name).toBe(true)
      expect(TRANSPORT_ALLOW.board).not.toContain(name)
    }

    // Never-routable names stay callable in process.
    for (const name of NEVER_BOARD) {
      expect(TRANSPORT_ALLOW.board).not.toContain(name)
      expect(name in board, `board.${name}`).toBe(true)
    }
    for (const name of NEVER_TASKS) {
      expect(TRANSPORT_ALLOW.tasks).not.toContain(name)
      expect(name in tasks, `tasks.${name}`).toBe(true)
    }

    // Completeness: the list is exactly what the two sweeps leave. On failure the names are printed.
    const wantBoard = generate(board, bEx, NEVER_BOARD).allowed
    const wantTasks = generate(tasks, tEx, NEVER_TASKS).allowed
    const delta = (have: readonly string[], want: string[]): { missing: string[]; extra: string[] } => ({
      missing: want.filter((n) => !have.includes(n)),
      extra: have.filter((n) => !want.includes(n)),
    })
    expect(delta(TRANSPORT_ALLOW.board, wantBoard)).toEqual({ missing: [], extra: [] })
    expect(delta(TRANSPORT_ALLOW.tasks, wantTasks)).toEqual({ missing: [], extra: [] })
    expect(TRANSPORT_ALLOW.board).toHaveLength(68)
    expect(TRANSPORT_ALLOW.tasks).toHaveLength(17)
  })
})
