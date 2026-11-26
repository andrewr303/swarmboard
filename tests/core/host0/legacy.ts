// Legacy board files for the HOST-0 stage 2 tests (HOST0_DESIGN 3.5): a file as the closed M1 build or the
// pre-ladder slice A build left it, made with a raw DatabaseSync from the frozen fixtures. It never writes a
// `core.*` key, so the ladder sees it as a legacy file (`effective = 0`).
import * as fs from 'node:fs'
import { DatabaseSync } from 'node:sqlite'

const fixture = (name: string): string => fs.readFileSync(new URL(`../fixtures/${name}`, import.meta.url), 'utf8')

/** The M1-closed DDL (snapshot 7-m1-closed-s1-w1, `initSchema` minus its final PRAGMA). */
export const M1_FIXTURE_SQL = fixture('m1-schema.sql')
/** The slice A task index block, as it stood in `initSchema`. */
export const TASKS_FIXTURE_SQL = fixture('tasks-schema.sql')
/** The seed rows a board opened by the M1 build carries (flags, built-in schemas, the three starting grants). */
export const SEED_FIXTURE_SQL = fixture('m1-seed.sql')

export type LegacyKind = 'm1' | 'sliceA'

/**
 * Builds a legacy board at `path`: WAL, the M1 DDL (plus the task DDL and `tasks_schema='1'` for
 * `'sliceA'`), `user_version = 1`, the M1 seed rows, and `events` `message.posted` rows in the log.
 */
export function makeLegacyFile(path: string, kind: LegacyKind, events = 0): void {
  const db = new DatabaseSync(path)
  try {
    db.exec('PRAGMA journal_mode = WAL')
    db.exec(M1_FIXTURE_SQL)
    if (kind === 'sliceA') db.exec(TASKS_FIXTURE_SQL)
    db.exec('PRAGMA user_version = 1')
    db.exec('BEGIN')
    db.exec(SEED_FIXTURE_SQL)
    const insert = db.prepare(
      `INSERT INTO board_events (event_id, session_id, type, channel, thread, payload_json, created_at)
       VALUES (?, 'board', 'message.posted', 'dev', ?, ?, '2026-11-22T00:00:00.000Z')`,
    )
    for (let i = 1; i <= events; i++) insert.run(`legacy-${i}`, `t-${i}`, JSON.stringify({ id: i, text: `legacy ${i}` }))
    if (kind === 'sliceA') db.exec("INSERT INTO board_meta (key, value) VALUES ('tasks_schema', '1')")
    db.exec('COMMIT')
  } finally {
    db.close()
  }
}
