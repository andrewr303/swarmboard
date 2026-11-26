// The schema ladder (HOST0_DESIGN 3.5, C3), board identity (3.7, C5) and the downgrade guard (3.8).
//
// The ladder position is board_meta['core.schema_version'], never `PRAGMA user_version`: every M1 and
// pre-ladder slice A build rewrites `user_version = 1` on every open, so a version kept there could be
// rolled back silently. `user_version` stays 1 forever and only step 1 writes it.
//
// Steps are APPEND ONLY. A released step is never edited (its SQL is frozen, and tests pin it byte for
// byte against tests/core/fixtures); a schema change is a new step, appended with `SCHEMA_VERSION` raised
// by one. Each step declares the lowest ladder version that may write (`writeMin`) and read (`readMin`) a
// file at or past it; the file's floors are the maximum over the steps applied, so they never fall.
//
// Lockout recipe for a future step. To stop ladder builds below N from writing, the step declares
// `writeMin: N`. To also stop pre-ladder slice A builds (which read only `tasks_schema` and refuse writes
// when it is above 1), its `up()` sets `tasks_schema = '2'` and the same release raises
// `TASKS_SCHEMA_VERSION` to 2 (that release, not HOST-0, then updates AT-38's literals). The closed M1
// build reads no marker at all, so no step can stop it; its damage is detected and repaired by HOST-5
// `doctor` (a consistency scan, `rebuildIndex`, compensating `task.canceled` events).
//
// The M1.1 predicate (the contract for a hypothetical M1 point release; D5 says none is cut): after its
// schema setup, refuse writes when `core.schema_write_min` is present and either malformed (not a 1-9
// digit decimal) or above 1, or when it is absent and `tasks_schema` exists:
//
//   const LADDER_KNOWN = 1
//   const raw = get('core.schema_write_min')
//   const writeMin = raw !== undefined ? (/^\d{1,9}$/.test(raw) ? Number(raw) : NaN) : get('tasks_schema') !== undefined ? 2 : 1
//   if (!(writeMin <= LADDER_KNOWN)) refuse writes with 503 schema_too_new
//
// The same predicate with `LADDER_KNOWN = 2` is what a slice A point release would use, and what every
// ladder build already enforces with `LADDER_KNOWN = SCHEMA_VERSION`.
import type { DatabaseSync } from 'node:sqlite'
import { BoardError } from './errors.ts'
import {
  META_BOARD_ID,
  META_INSTANCE_FILE,
  META_INSTANCE_ID,
  META_READ_MIN,
  META_SCHEMA_VERSION,
  META_WRITE_MIN,
} from './meta-keys.ts'
import { rebuildTaskIndexInTx } from './tasks/rebuild.ts'

/** The ladder position this build knows. */
export const SCHEMA_VERSION = 5

/**
 * `'refuse-newer'` (the default) enforces the read and write floors and the legacy `tasks_schema` gate.
 * `'off'` enforces none of them (recovery tooling and tests only; transports and the resolver never pass
 * it). Neither ever migrates a file this build does not understand, and the replaced-file fence holds
 * under both.
 */
export type SchemaGate = 'refuse-newer' | 'off'

/** `core.board_id`: `b_` and 32 lowercase hex digits. */
export const BOARD_ID_PATTERN = /^b_[0-9a-f]{32}$/
/** `core.instance_id`: `i_` and 32 lowercase hex digits. */
export const INSTANCE_ID_PATTERN = /^i_[0-9a-f]{32}$/

export type SchemaStepContext = {
  /** The .wakeup sidecar's generation (0 when there is none). */
  readonly wakeupFileGeneration: () => number
  /** board_meta's wakeup generation (0 when there is none). */
  readonly wakeupDbGeneration: () => number
  /** The file's inode as a decimal string; '' for `:memory:` or a filesystem that reports inode 0. */
  readonly fileId: string
  /** `b_` or `i_` and randomUUID() without its hyphens (tests inject their own through the store's testHooks). */
  readonly newId: (prefix: 'b_' | 'i_') => string
}

export type SchemaStep = {
  readonly version: number
  readonly name: 'm1' | 'tasks' | 'identity' | 'fts_messages_rowid' | 'v2_launch'
  /** The lowest ladder version that may write a file at or past this step. */
  readonly writeMin: number
  /** The lowest ladder version that may read a file at or past this step. */
  readonly readMin: number
  /** The sqlite_master names this step creates: all present means its objects are done. */
  readonly objects: readonly string[]
  /** The board_meta keys this step writes: all present means its data is done. */
  readonly metaKeys: readonly string[]
  /** Idempotent. Runs inside the ladder's BEGIN IMMEDIATE. Appends no event and emits no wakeup. */
  up(db: DatabaseSync, ctx: SchemaStepContext): void
}

/**
 * @internal Frozen DDL of step 1: the M1 schema, byte-equal to tests/core/fixtures/m1-schema.sql (the
 * M1-closed `initSchema`, snapshot 7-m1-closed-s1-w1, minus its final `PRAGMA user_version = 1`).
 */
export const M1_SCHEMA_SQL = `      CREATE TABLE IF NOT EXISTS board_events (
        log_index INTEGER PRIMARY KEY AUTOINCREMENT,
        event_id TEXT NOT NULL UNIQUE,
        session_id TEXT NOT NULL DEFAULT 'board',
        type TEXT NOT NULL,
        channel TEXT,
        thread TEXT,
        payload_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_board_events_session ON board_events (session_id, log_index);
      CREATE INDEX IF NOT EXISTS idx_board_events_channel ON board_events (channel, log_index);
      CREATE INDEX IF NOT EXISTS idx_board_events_thread ON board_events (thread, log_index);

      CREATE TABLE IF NOT EXISTS board_channels (
        path TEXT PRIMARY KEY,
        last_index INTEGER NOT NULL DEFAULT 0,
        messages INTEGER NOT NULL DEFAULT 0,
        threads INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        metadata_json TEXT NOT NULL DEFAULT '{}'
      );

      CREATE TABLE IF NOT EXISTS board_messages (
        id INTEGER PRIMARY KEY,
        event_id TEXT NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        re INTEGER,
        reply_to INTEGER,
        thread TEXT NOT NULL,
        by_actor TEXT NOT NULL,
        by_principal TEXT NOT NULL,
        by_profile TEXT,
        from_key TEXT,
        no_sync INTEGER NOT NULL,
        text TEXT NOT NULL,
        text_lower TEXT NOT NULL,
        deleted INTEGER NOT NULL,
        created_at INTEGER NOT NULL,
        edited_at INTEGER,
        replies INTEGER NOT NULL DEFAULT 0,
        at INTEGER,
        version INTEGER NOT NULL,
        revision INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS board_messages_channel ON board_messages (channel, id);
      CREATE INDEX IF NOT EXISTS board_messages_re ON board_messages (re, id);
      CREATE INDEX IF NOT EXISTS board_messages_by_actor ON board_messages (by_actor, id);
      CREATE INDEX IF NOT EXISTS board_messages_by_principal ON board_messages (by_principal, id);
      CREATE INDEX IF NOT EXISTS board_threads_at ON board_messages (at) WHERE re IS NULL;
      CREATE INDEX IF NOT EXISTS board_threads_channel ON board_messages (channel, at) WHERE re IS NULL;

      CREATE TABLE IF NOT EXISTS board_versions (
        log_index INTEGER PRIMARY KEY,
        message_id INTEGER NOT NULL,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS board_versions_message ON board_versions (message_id, log_index);

      CREATE TABLE IF NOT EXISTS board_terms (
        message_id INTEGER NOT NULL,
        term TEXT NOT NULL,
        value TEXT NOT NULL,
        PRIMARY KEY (message_id, term, value)
      );
      CREATE INDEX IF NOT EXISTS board_terms_term ON board_terms (term, value, message_id);

      CREATE TABLE IF NOT EXISTS board_actors (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        handle TEXT NOT NULL,
        handle_lower TEXT NOT NULL,
        name TEXT NOT NULL,
        avatar TEXT,
        via_json TEXT,
        platform TEXT,
        host INTEGER NOT NULL DEFAULT 0,
        verified INTEGER NOT NULL DEFAULT 0,
        data TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS board_actors_handle ON board_actors (handle_lower);

      CREATE TABLE IF NOT EXISTS board_grants (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        principals_json TEXT NOT NULL,
        can_json TEXT NOT NULL,
        by_actor TEXT,
        updated_at TEXT
      );

      CREATE TABLE IF NOT EXISTS board_schemas (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        version INTEGER NOT NULL,
        description TEXT,
        schema_json TEXT NOT NULL,
        canonical_json TEXT NOT NULL,
        by_actor TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(name, version)
      );

      CREATE TABLE IF NOT EXISTS board_schedules (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL UNIQUE,
        channel TEXT NOT NULL,
        re INTEGER,
        by_actor TEXT NOT NULL,
        by_principal TEXT NOT NULL,
        next_at INTEGER,
        state TEXT NOT NULL,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_attachments (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_by TEXT,
        storage_key TEXT NOT NULL,
        data BLOB,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_upload_tickets (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        type TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_by TEXT NOT NULL,
        expires_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_watchers (
        owner TEXT PRIMARY KEY,
        principal_json TEXT NOT NULL,
        url TEXT,
        path TEXT,
        branch TEXT,
        watch_json TEXT NOT NULL,
        sync_json TEXT NOT NULL,
        hash TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_watcher_matches (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL,
        watcher TEXT NOT NULL,
        thread TEXT NOT NULL,
        event_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        lease TEXT,
        lease_until INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0,
        retry_at INTEGER,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_sync_threads (
        thread TEXT PRIMARY KEY,
        data TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_external_threads (
        external TEXT PRIMARY KEY,
        thread TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_copies (
        message_id INTEGER NOT NULL,
        target TEXT NOT NULL,
        data TEXT NOT NULL,
        PRIMARY KEY (message_id, target)
      );

      CREATE TABLE IF NOT EXISTS board_external_messages (
        key TEXT PRIMARY KEY,
        message_id INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_inbox (
        id TEXT PRIMARY KEY,
        owner TEXT NOT NULL DEFAULT '',
        retry_at INTEGER,
        sync_key TEXT NOT NULL,
        channel TEXT NOT NULL,
        thread TEXT NOT NULL,
        event_json TEXT NOT NULL,
        raw_json TEXT NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending',
        lease TEXT,
        lease_until INTEGER,
        attempt INTEGER NOT NULL DEFAULT 0,
        error TEXT,
        created_at INTEGER NOT NULL
      );

      CREATE TABLE IF NOT EXISTS board_meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      -- F14 FTS5 Virtual Tables
      CREATE VIRTUAL TABLE IF NOT EXISTS fts_messages USING fts5(
        message_id UNINDEXED,
        channel UNINDEXED,
        thread UNINDEXED,
        body,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_tasks USING fts5(
        task_id UNINDEXED,
        channel UNINDEXED,
        state UNINDEXED,
        body,
        result,
        tokenize='porter unicode61'
      );

      CREATE VIRTUAL TABLE IF NOT EXISTS fts_knowledge USING fts5(
        entry_id UNINDEXED,
        channel UNINDEXED,
        dept_id UNINDEXED,
        title,
        body,
        citations,
        tokenize='porter unicode61'
      );

      -- M2 Corporate Swarm Extension Tables
      CREATE TABLE IF NOT EXISTS org_nodes (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        name TEXT NOT NULL,
        slug TEXT NOT NULL,
        parent_id TEXT,
        dept_id TEXT,
        squad_id TEXT,
        reports_to TEXT,
        role TEXT,
        lineage TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        max_depth INTEGER NOT NULL DEFAULT 4,
        spawn_budget INTEGER NOT NULL DEFAULT 0,
        default_channel_prefix TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE(org_id, slug)
      );

      CREATE TABLE IF NOT EXISTS departments (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        division_id TEXT,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        head_agent_id TEXT,
        channel_namespace TEXT NOT NULL,
        isolation_mode TEXT NOT NULL DEFAULT 'captain_bridge',
        budget_policy_id TEXT,
        paused INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        UNIQUE(org_id, slug)
      );

      CREATE TABLE IF NOT EXISTS squads (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        dept_id TEXT NOT NULL,
        slug TEXT NOT NULL,
        name TEXT NOT NULL,
        captain_id TEXT,
        witness_id TEXT,
        refinery_id TEXT,
        channel_path TEXT NOT NULL,
        max_concurrent_workers INTEGER NOT NULL DEFAULT 8,
        created_at TEXT NOT NULL,
        UNIQUE(org_id, dept_id, slug)
      );

      CREATE TABLE IF NOT EXISTS agent_cards (
        id TEXT PRIMARY KEY,
        handle TEXT NOT NULL,
        display_name TEXT NOT NULL,
        org_id TEXT NOT NULL,
        dept_id TEXT,
        squad_id TEXT,
        reports_to TEXT,
        role TEXT NOT NULL,
        lineage TEXT NOT NULL,
        depth INTEGER NOT NULL DEFAULT 0,
        max_depth INTEGER NOT NULL DEFAULT 2,
        spawn_budget INTEGER NOT NULL DEFAULT 0,
        principal_kind TEXT NOT NULL,
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        model_family TEXT NOT NULL,
        correlation_group TEXT NOT NULL,
        harness TEXT NOT NULL,
        capabilities_json TEXT NOT NULL DEFAULT '[]',
        a2a_endpoint TEXT,
        status TEXT NOT NULL DEFAULT 'online',
        context_pct REAL,
        cost_usd REAL NOT NULL DEFAULT 0,
        last_heartbeat_at TEXT NOT NULL,
        registered_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_agent_cards_org_dept ON agent_cards (org_id, dept_id, role);

      CREATE TABLE IF NOT EXISTS communication_flows (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        source_selector_json TEXT NOT NULL,
        target_selector_json TEXT NOT NULL,
        mode TEXT NOT NULL,
        allowed_purposes_json TEXT NOT NULL,
        channel_pattern TEXT NOT NULL DEFAULT '*',
        require_contact_approval INTEGER NOT NULL DEFAULT 0,
        priority INTEGER NOT NULL DEFAULT 0,
        enabled INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS bridge_rfcs (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        thread_id TEXT NOT NULL,
        from_captain_id TEXT NOT NULL,
        to_captain_ids_json TEXT NOT NULL,
        title TEXT NOT NULL,
        interface_contract_json TEXT NOT NULL,
        contract_digest_sha256 TEXT NOT NULL,
        affected_paths_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'proposed',
        acks_json TEXT NOT NULL DEFAULT '[]',
        deadline TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS envelopes_v2 (
        id TEXT PRIMARY KEY,
        message_id TEXT,
        run_id TEXT NOT NULL,
        trace_id TEXT NOT NULL,
        purpose TEXT NOT NULL,
        summary TEXT NOT NULL,
        requested_action TEXT NOT NULL DEFAULT '',
        task_id TEXT NOT NULL DEFAULT '',
        attempt INTEGER NOT NULL DEFAULT 0,
        reply_to TEXT,
        progress_key TEXT NOT NULL DEFAULT '',
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        deadline TEXT,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        source_trust_level TEXT NOT NULL DEFAULT 'internal_agent',
        untrusted INTEGER NOT NULL DEFAULT 0,
        from_agent_id TEXT,
        to_agent_ids_json TEXT NOT NULL DEFAULT '[]',
        channel TEXT,
        thread_id TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS deliveries (
        message_id TEXT NOT NULL,
        recipient_id TEXT NOT NULL,
        state TEXT NOT NULL DEFAULT 'pending',
        priority TEXT NOT NULL DEFAULT 'normal',
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        lease_token_hash TEXT,
        lease_until TEXT,
        deadline TEXT,
        read_at TEXT,
        acked_at TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, recipient_id)
      );
      CREATE INDEX IF NOT EXISTS idx_deliveries_recipient ON deliveries (recipient_id, state, priority);

      CREATE TABLE IF NOT EXISTS escalations (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        dept_id TEXT,
        task_id TEXT,
        from_agent_id TEXT NOT NULL,
        target_agent_id TEXT NOT NULL,
        severity TEXT NOT NULL,
        category TEXT NOT NULL,
        summary TEXT NOT NULL,
        tried TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT 'open',
        stale_threshold_seconds INTEGER NOT NULL DEFAULT 900,
        reescalation_count INTEGER NOT NULL DEFAULT 0,
        max_reescalations INTEGER NOT NULL DEFAULT 3,
        route_trace_json TEXT NOT NULL,
        next_escalate_at TEXT,
        acked_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS reservations (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        pattern TEXT NOT NULL,
        is_glob INTEGER NOT NULL DEFAULT 0,
        exclusive INTEGER NOT NULL DEFAULT 1,
        agent_id TEXT NOT NULL,
        task_id TEXT NOT NULL DEFAULT '',
        dept_id TEXT,
        reason TEXT NOT NULL DEFAULT '',
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_reservations_workspace ON reservations (workspace, expires_at);

      CREATE TABLE IF NOT EXISTS build_slots (
        id TEXT PRIMARY KEY,
        workspace TEXT NOT NULL,
        slot_name TEXT NOT NULL,
        max_concurrency INTEGER NOT NULL DEFAULT 1,
        holder_agent_id TEXT NOT NULL,
        holder_task_id TEXT NOT NULL DEFAULT '',
        lease_token_hash TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        acquired_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_build_slots_ws ON build_slots (workspace, slot_name, expires_at);

      CREATE TABLE IF NOT EXISTS decisions (
        id TEXT PRIMARY KEY,
        org_id TEXT NOT NULL,
        dept_id TEXT,
        task_id TEXT,
        channel TEXT NOT NULL,
        requested_by_agent_id TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        gate_kind TEXT NOT NULL,
        options_json TEXT NOT NULL,
        artifacts_json TEXT NOT NULL DEFAULT '[]',
        continuation_policy TEXT NOT NULL DEFAULT 'resume_task',
        snapshot_digest_sha256 TEXT,
        status TEXT NOT NULL DEFAULT 'pending',
        chosen_option_id TEXT,
        resolved_by_principal TEXT,
        resolved_principal_kind TEXT,
        override_note TEXT,
        expires_at TEXT,
        resolved_at TEXT,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS budget_policies (
        id TEXT PRIMARY KEY,
        scope_type TEXT NOT NULL,
        scope_id TEXT NOT NULL,
        budget_cents INTEGER NOT NULL,
        spent_cents REAL NOT NULL DEFAULT 0,
        warn_percent REAL NOT NULL DEFAULT 80,
        hard_stop_enabled INTEGER NOT NULL DEFAULT 1,
        unpriced_usage_policy TEXT NOT NULL DEFAULT 'allow_warn',
        warn_triggered_at TEXT,
        hard_stopped_at TEXT,
        updated_at TEXT NOT NULL,
        UNIQUE(scope_type, scope_id)
      );

      CREATE TABLE IF NOT EXISTS wakeup_requests (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        scope_key TEXT NOT NULL,
        idempotency_key TEXT,
        coalesced_count INTEGER NOT NULL DEFAULT 1,
        cursor_from TEXT NOT NULL,
        cursor_to TEXT NOT NULL,
        summary TEXT NOT NULL,
        event_types_json TEXT NOT NULL DEFAULT '[]',
        status TEXT NOT NULL DEFAULT 'queued',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_wakeup_requests_agent ON wakeup_requests (agent_id, status, scope_key);

      CREATE TABLE IF NOT EXISTS knowledge_entries (
        id TEXT PRIMARY KEY,
        channel TEXT NOT NULL,
        dept_id TEXT,
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        citations_json TEXT NOT NULL DEFAULT '[]',
        git_commit_sha TEXT,
        promoted_by TEXT NOT NULL,
        valid INTEGER NOT NULL DEFAULT 1,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS tasks_ext (
        task_id INTEGER PRIMARY KEY,
        parent_task_id INTEGER,
        dept_id TEXT,
        priority INTEGER NOT NULL DEFAULT 0,
        defer_until TEXT,
        attempt INTEGER NOT NULL DEFAULT 0,
        lease_seconds INTEGER,
        completion_contract_sha256 TEXT,
        writes_paths_json TEXT NOT NULL DEFAULT '[]',
        reads_paths_json TEXT NOT NULL DEFAULT '[]',
        outcome_json TEXT,
        review_status TEXT NOT NULL DEFAULT 'none',
        review_policy TEXT NOT NULL DEFAULT 'none',
        conditional_needs_json TEXT NOT NULL DEFAULT '[]',
        request_depth INTEGER NOT NULL DEFAULT 0,
        goal_id TEXT,
        budget_policy_id TEXT
      );
`

/** @internal Frozen DDL of step 2: the slice A task index, byte-equal to tests/core/fixtures/tasks-schema.sql. */
export const TASKS_SCHEMA_SQL = `      -- M2 slice A: the task index (M2_DESIGN 2.6). Projections of the event log, kept by one writer.
      CREATE TABLE IF NOT EXISTS board_tasks (
        task_id          INTEGER PRIMARY KEY,
        channel          TEXT    NOT NULL,
        thread           TEXT    NOT NULL,
        state            TEXT    NOT NULL CHECK (state IN ('waiting','ready','claimed','blocked','completed','failed','canceled')),
        owner            TEXT    NOT NULL,
        by_actor         TEXT    NOT NULL,
        for_actor        TEXT,
        epoch            INTEGER NOT NULL DEFAULT 0,
        claim_actor      TEXT,
        claim_until_ms   INTEGER,
        claim_token_hash TEXT,
        blocked_kind     TEXT,
        blocked_reason   TEXT,
        result           TEXT,
        reason           TEXT,
        priority         INTEGER NOT NULL DEFAULT 0,
        claim_after_ms   INTEGER,
        expirations      INTEGER NOT NULL DEFAULT 0,
        root_deleted     INTEGER NOT NULL DEFAULT 0,
        created_index    INTEGER NOT NULL,
        updated_index    INTEGER NOT NULL
      );
      -- claim probe P1: ready tasks assigned to the caller
      CREATE INDEX IF NOT EXISTS board_tasks_mine ON board_tasks (for_actor, owner, priority DESC, task_id)
        WHERE state = 'ready';
      -- claim probe P2: unassigned ready pool, one probe per accepted owner
      CREATE INDEX IF NOT EXISTS board_tasks_pool ON board_tasks (owner, priority DESC, task_id)
        WHERE state = 'ready' AND for_actor IS NULL;
      -- lapsed probes, the sweep, nextLeaseDueMs, the lapse timer
      CREATE INDEX IF NOT EXISTS board_tasks_lease ON board_tasks (claim_until_ms, task_id)
        WHERE state = 'claimed';
      -- lists and owner queries
      CREATE INDEX IF NOT EXISTS board_tasks_state ON board_tasks (state, channel, task_id);
      CREATE INDEX IF NOT EXISTS board_tasks_owner ON board_tasks (owner, state, task_id);

      CREATE TABLE IF NOT EXISTS board_task_needs (
        task_id INTEGER NOT NULL,
        need_id INTEGER NOT NULL,
        pos     INTEGER NOT NULL,
        cond    TEXT    NOT NULL DEFAULT 'completed' CHECK (cond IN ('completed','failed')),
        PRIMARY KEY (task_id, need_id)
      ) WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS board_task_needs_need ON board_task_needs (need_id, task_id);
`

/**
 * @internal Frozen DDL of step 3: `core.board_id` is immutable. The triggers abort every insert (also
 * `ON CONFLICT DO NOTHING`, `OR IGNORE` and `OR REPLACE`), update and delete aimed at the row once it
 * exists, whatever the code path (raw SQL, an old build, a future helper).
 */
export const IDENTITY_SCHEMA_SQL = `CREATE TRIGGER IF NOT EXISTS board_meta_board_id_insert BEFORE INSERT ON board_meta
  WHEN NEW.key = 'core.board_id' AND EXISTS (SELECT 1 FROM board_meta WHERE key = 'core.board_id')
  BEGIN SELECT RAISE(ABORT, 'board_id is immutable'); END;
CREATE TRIGGER IF NOT EXISTS board_meta_board_id_update BEFORE UPDATE ON board_meta
  WHEN OLD.key = 'core.board_id' OR NEW.key = 'core.board_id'
  BEGIN SELECT RAISE(ABORT, 'board_id is immutable'); END;
CREATE TRIGGER IF NOT EXISTS board_meta_board_id_delete BEFORE DELETE ON board_meta
  WHEN OLD.key = 'core.board_id'
  BEGIN SELECT RAISE(ABORT, 'board_id is immutable'); END;
`

/**
 * @internal Frozen DDL of step 5: Swarmboard v2 launch tables & indexes (rich channel metadata,
 * private/DM member ACLs, thread root lookup index, @groups, real-time notifications & read
 * cursors, pins/announcements, agent presence, and HOST-8 auth tokens & audit log).
 */
export const V2_LAUNCH_SCHEMA_SQL = `-- 1. Rich channel metadata (normalized side-table; M1 board_channels stays untouched)
CREATE TABLE IF NOT EXISTS board_channel_meta (
  path        TEXT PRIMARY KEY,
  category    TEXT,
  parent      TEXT,
  topic       TEXT,
  kind        TEXT NOT NULL DEFAULT 'chat'
              CHECK (kind IN ('chat','forum','tasks','dm','announcements')),
  archived    INTEGER NOT NULL DEFAULT 0 CHECK (archived IN (0, 1)),
  sort_order  INTEGER NOT NULL DEFAULT 0,
  repo        TEXT,
  session_id  TEXT,
  is_private  INTEGER NOT NULL DEFAULT 0 CHECK (is_private IN (0, 1)),
  updated_at  TEXT NOT NULL,
  updated_by  TEXT
);
CREATE INDEX IF NOT EXISTS idx_channel_meta_parent
  ON board_channel_meta (parent, sort_order, path);
CREATE INDEX IF NOT EXISTS idx_channel_meta_kind
  ON board_channel_meta (kind, archived, sort_order, path);
CREATE INDEX IF NOT EXISTS idx_channel_meta_repo
  ON board_channel_meta (repo, path) WHERE repo IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_channel_meta_session
  ON board_channel_meta (session_id) WHERE session_id IS NOT NULL;

-- 1b. Private channel & DM membership ACL table (enforces privacy even under local seeded g1)
CREATE TABLE IF NOT EXISTS board_channel_members (
  channel   TEXT NOT NULL,
  actor_id  TEXT NOT NULL,
  role      TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','owner')),
  added_by  TEXT NOT NULL,
  added_at  TEXT NOT NULL,
  PRIMARY KEY (channel, actor_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_channel_members_actor
  ON board_channel_members (actor_id, channel);

-- 2. Thread root lookup index for O(log N) thr_... / thread-UUID resolution
CREATE INDEX IF NOT EXISTS idx_messages_thread_root
  ON board_messages (thread) WHERE re IS NULL;

-- 3. @group definitions and memberships
CREATE TABLE IF NOT EXISTS board_groups (
  handle      TEXT PRIMARY KEY,
  name        TEXT NOT NULL,
  description TEXT NOT NULL DEFAULT '',
  kind        TEXT NOT NULL DEFAULT 'team'
              CHECK (kind IN ('team','swarm','role','harness','system')),
  channel     TEXT,
  by_actor    TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS board_group_members (
  group_handle TEXT NOT NULL REFERENCES board_groups(handle) ON DELETE CASCADE,
  member_id    TEXT NOT NULL,
  role         TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member','lead')),
  added_by     TEXT NOT NULL,
  added_at     TEXT NOT NULL,
  PRIMARY KEY (group_handle, member_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS idx_group_members_member
  ON board_group_members (member_id, group_handle);

-- 4. Real-time notifications & per-channel read cursors
CREATE TABLE IF NOT EXISTS board_notifications (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  log_index    INTEGER NOT NULL,
  recipient    TEXT NOT NULL,
  reason       TEXT NOT NULL
               CHECK (reason IN ('mention','group_mention','dm','reply','pin','task_assigned','attention')),
  priority     TEXT NOT NULL DEFAULT 'normal' CHECK (priority IN ('normal','urgent')),
  source_group TEXT,
  channel      TEXT NOT NULL,
  thread       TEXT NOT NULL,
  root_id      INTEGER NOT NULL,
  message_id   INTEGER NOT NULL,
  by_actor     TEXT NOT NULL,
  excerpt      TEXT NOT NULL,
  created_at   TEXT NOT NULL,
  read_at      TEXT,
  acked_at     TEXT,
  UNIQUE (recipient, message_id, reason)
);
CREATE INDEX IF NOT EXISTS idx_notif_recipient_unread
  ON board_notifications (recipient, log_index) WHERE acked_at IS NULL;
CREATE INDEX IF NOT EXISTS idx_notif_recipient_all
  ON board_notifications (recipient, log_index DESC);
CREATE INDEX IF NOT EXISTS idx_notif_channel
  ON board_notifications (channel, log_index);
CREATE INDEX IF NOT EXISTS idx_notif_message
  ON board_notifications (message_id);

CREATE TABLE IF NOT EXISTS board_read_cursors (
  actor_id        TEXT NOT NULL,
  channel         TEXT NOT NULL,
  last_read_index INTEGER NOT NULL DEFAULT 0,
  updated_at      TEXT NOT NULL,
  PRIMARY KEY (actor_id, channel)
) WITHOUT ROWID;

-- 5. Pinned posts, sticky threads & announcements (root_id INTEGER + thread TEXT matches board_notifications)
CREATE TABLE IF NOT EXISTS board_pins (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  scope       TEXT NOT NULL CHECK (scope IN ('thread','channel','announcement')),
  channel     TEXT NOT NULL,
  root_id     INTEGER NOT NULL,
  thread      TEXT NOT NULL,
  message_id  INTEGER NOT NULL,
  pinned_by   TEXT NOT NULL,
  pinned_at   TEXT NOT NULL,
  note        TEXT,
  sort_order  INTEGER NOT NULL DEFAULT 0,
  UNIQUE (scope, channel, message_id)
);
CREATE INDEX IF NOT EXISTS idx_pins_channel_scope
  ON board_pins (channel, scope, sort_order, id DESC);
CREATE INDEX IF NOT EXISTS idx_pins_root
  ON board_pins (root_id, scope);
CREATE INDEX IF NOT EXISTS idx_pins_announcements
  ON board_pins (scope, sort_order, id DESC) WHERE scope = 'announcement';

-- 6. Agent presence ("Who is Online")
CREATE TABLE IF NOT EXISTS board_presence (
  agent       TEXT PRIMARY KEY,
  principal   TEXT NOT NULL,
  profile     TEXT,
  handle      TEXT NOT NULL,
  harness     TEXT,
  model       TEXT,
  status      TEXT NOT NULL DEFAULT 'active'
              CHECK (status IN ('active','busy','idle','offline')),
  channel     TEXT,
  task_id     TEXT,
  note        TEXT,
  updated_at  TEXT NOT NULL,
  expires_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_presence_expires
  ON board_presence (expires_at, status);
CREATE INDEX IF NOT EXISTS idx_presence_channel
  ON board_presence (channel, expires_at) WHERE channel IS NOT NULL;

-- 7. HOST-8 hashed tokens & auth audit log (created once in Step 5 so no Step 6 migration is needed)
CREATE TABLE IF NOT EXISTS auth_tokens (
  id                TEXT PRIMARY KEY,
  secret_hash       TEXT NOT NULL UNIQUE,
  principal_id      TEXT NOT NULL,
  profile           TEXT,
  assurance         TEXT NOT NULL
                    CHECK (assurance IN ('human_verified','agent_delegated','local_unverified')),
  cap_json          TEXT NOT NULL,
  can_header        TEXT,
  listener_scope    TEXT NOT NULL DEFAULT 'local' CHECK (listener_scope IN ('local','lan','remote')),
  delegation_depth  INTEGER NOT NULL DEFAULT 0 CHECK (delegation_depth BETWEEN 0 AND 4),
  issued_by         TEXT NOT NULL,
  note              TEXT,
  created_at        TEXT NOT NULL,
  expires_at        TEXT,
  revoked_at        TEXT,
  last_used_at      TEXT
);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_principal
  ON auth_tokens (principal_id, revoked_at);
CREATE INDEX IF NOT EXISTS idx_auth_tokens_expires
  ON auth_tokens (expires_at) WHERE revoked_at IS NULL;

CREATE TABLE IF NOT EXISTS auth_audit_log (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  ts           TEXT NOT NULL,
  listener     TEXT NOT NULL,
  outcome      TEXT NOT NULL CHECK (outcome IN ('allow','deny')),
  code         TEXT,
  principal_id TEXT,
  actor_id     TEXT,
  assurance    TEXT,
  token_id     TEXT,
  method       TEXT NOT NULL,
  path         TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_auth_audit_ts
  ON auth_audit_log (ts DESC);
`

/** The names a DDL text creates with `CREATE [VIRTUAL] TABLE|INDEX|TRIGGER IF NOT EXISTS <name>`, in order. */
function createdNames(sql: string): string[] {
  return [...sql.matchAll(/CREATE\s+(?:VIRTUAL\s+)?(?:TABLE|INDEX|TRIGGER)\s+IF\s+NOT\s+EXISTS\s+([A-Za-z0-9_]+)/g)].map((m) => m[1]!)
}

const metaValue = (db: DatabaseSync, key: string): string | undefined =>
  (db.prepare('SELECT value FROM board_meta WHERE key = ?').get(key) as { value?: string } | undefined)?.value

/** @internal The one board_meta upsert (the ladder, the identity, the wakeup generation, `casMeta`). Runs in the caller's transaction. */
export const upsertMeta = (db: DatabaseSync, key: string, value: string): void => {
  db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value)
}

/** Steps 1..SCHEMA_VERSION: index i holds version i + 1. @internal Append only. */
export const SCHEMA_STEPS: readonly SchemaStep[] = Object.freeze([
  {
    version: 1,
    name: 'm1',
    writeMin: 1,
    readMin: 1,
    objects: Object.freeze(createdNames(M1_SCHEMA_SQL)),
    metaKeys: Object.freeze([]),
    up(db: DatabaseSync): void {
      db.exec(M1_SCHEMA_SQL)
      // Columns added after board_inbox's first shape: a file made before them gets them here, since
      // CREATE TABLE IF NOT EXISTS leaves an existing table as it was (the M1 addMissingColumns, verbatim).
      const has = (table: string, column: string): boolean =>
        (db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>).some((c) => c.name === column)
      if (!has('board_inbox', 'owner')) db.exec("ALTER TABLE board_inbox ADD COLUMN owner TEXT NOT NULL DEFAULT ''")
      if (!has('board_inbox', 'retry_at')) db.exec('ALTER TABLE board_inbox ADD COLUMN retry_at INTEGER')
      db.exec('PRAGMA user_version = 1')
    },
  },
  {
    version: 2,
    name: 'tasks',
    // A writer must run the task root hooks, which only a slice A or later build has.
    writeMin: 2,
    readMin: 1,
    objects: Object.freeze(createdNames(TASKS_SCHEMA_SQL)),
    metaKeys: Object.freeze(['tasks_schema']),
    up(db: DatabaseSync): void {
      db.exec(TASKS_SCHEMA_SQL)
      // The slice A gate's first-open body, verbatim: a log another build wrote gets its task index
      // backfilled from the log, then the marker. `tasks_schema` stays '1' (the lockout lever, see above).
      if (metaValue(db, 'tasks_schema') === undefined) {
        const logged = db.prepare("SELECT 1 FROM board_events WHERE substr(type, 1, 5) = 'task.' LIMIT 1").get()
        const indexed = db.prepare('SELECT 1 FROM board_tasks LIMIT 1').get()
        if (logged && !indexed) rebuildTaskIndexInTx(db)
        db.prepare("INSERT INTO board_meta (key, value) VALUES ('tasks_schema', ?) ON CONFLICT(key) DO NOTHING").run('1')
      }
    },
  },
  {
    version: 3,
    name: 'identity',
    writeMin: 2,
    readMin: 1,
    objects: Object.freeze(createdNames(IDENTITY_SCHEMA_SQL)),
    metaKeys: Object.freeze([META_BOARD_ID, META_INSTANCE_ID, META_INSTANCE_FILE]),
    up(db: DatabaseSync, ctx: SchemaStepContext): void {
      db.exec(IDENTITY_SCHEMA_SQL)
      // The insert trigger fires even for ON CONFLICT DO NOTHING, so check first.
      if (metaValue(db, META_BOARD_ID) === undefined) {
        db.prepare('INSERT INTO board_meta (key, value) VALUES (?, ?)').run(META_BOARD_ID, ctx.newId('b_'))
      }
      // A lone survivor of the pair is not trusted: a new instance is the safe direction (CR-7).
      if (metaValue(db, META_INSTANCE_ID) === undefined || metaValue(db, META_INSTANCE_FILE) === undefined) {
        upsertMeta(db, META_INSTANCE_ID, ctx.newId('i_'))
        upsertMeta(db, META_INSTANCE_FILE, ctx.fileId)
      }
      // A new database under a kept .wakeup (the file is ahead): catch the database up silently, so a
      // later open does not take that for an in-place rewind, and no wakeup is emitted by opening.
      const fileGen = ctx.wakeupFileGeneration()
      if (fileGen > ctx.wakeupDbGeneration()) upsertMeta(db, 'wakeup_generation', String(fileGen))
    },
  },
  {
    version: 4,
    name: 'fts_messages_rowid',
    // Only v4+ builds maintain fts_messages.rowid = board_messages.id on writes; older builds may still read.
    writeMin: 4,
    readMin: 1,
    objects: Object.freeze(['fts_messages']),
    metaKeys: Object.freeze([]),
    up(db: DatabaseSync): void {
      // Rebuild fts_messages keyed by SQLite rowid = board_messages.id so edits/deletes use O(log N)
      // rowid lookups instead of scanning the UNINDEXED message_id column. Idempotent and a no-op on
      // fresh boards with no rows in either table.
      const hasFts = db.prepare('SELECT 1 FROM fts_messages LIMIT 1').get()
      const hasMsg = db.prepare('SELECT 1 FROM board_messages WHERE deleted = 0 LIMIT 1').get()
      if (!hasFts && !hasMsg) return
      db.exec('DELETE FROM fts_messages')
      const select = db.prepare('SELECT id, channel, thread, text FROM board_messages WHERE deleted = 0 ORDER BY id ASC')
      const insert = db.prepare(
        'INSERT INTO fts_messages (rowid, message_id, channel, thread, body) VALUES (?, ?, ?, ?, ?)',
      )
      for (const row of select.iterate() as Iterable<{ id: number; channel: string; thread: string; text: string }>) {
        if (row.text.trim() === '') continue
        insert.run(row.id, String(row.id), row.channel, row.thread, row.text)
      }
    },
  },
  {
    version: 5,
    name: 'v2_launch',
    // v5+ writers maintain notification/mention fanout, private channel ACLs, pins, groups, presence, and auth tables.
    writeMin: 5,
    readMin: 1,
    objects: Object.freeze(createdNames(V2_LAUNCH_SCHEMA_SQL)),
    metaKeys: Object.freeze([]),
    up(db: DatabaseSync): void {
      db.exec(V2_LAUNCH_SCHEMA_SQL)
    },
  },
] satisfies SchemaStep[])

export type SchemaState = {
  /** No board_meta table: a new (or foreign) file. */
  readonly fresh: boolean
  /** `core.schema_version` as stored ('' when absent). */
  readonly storedRaw: string
  /** Parsed `core.schema_version`: null when absent, NaN when malformed. */
  readonly stored: number | null
  /** The highest k <= stored with steps 1..k complete; 0 for a fresh or legacy file, and for a `newer` one. */
  readonly effective: number
  /** The version or a floor is above this build or malformed: never migrated, under either gate. */
  readonly newer: boolean
  /** Parsed floors: absent gives the legacy default (write 2 when `tasks_schema` exists, else 1; read 1), malformed NaN. */
  readonly writeMin: number
  readonly readMin: number
  /** The stored floor text, or the legacy default as a decimal when absent. */
  readonly writeMinRaw: string
  readonly readMinRaw: string
  /** Whether each floor is stored at all (a legacy file has neither). */
  readonly writeMinStored: boolean
  readonly readMinStored: boolean
  readonly tasksSchema: string | undefined
  /** Set when `core.board_id` and `core.instance_id` are both present; `fileId` is `core.instance_file` or ''. */
  readonly identity: { readonly boardId: string; readonly instanceId: string; readonly fileId: string } | null
}

const DECIMAL = /^\d{1,9}$/
/** @internal A stored ladder number (`core.schema_*`, `tasks_schema`): a 1-9 digit decimal, else NaN (malformed). */
export const parseDecimal = (raw: string): number => (DECIMAL.test(raw) ? Number(raw) : Number.NaN)

const STATE_KEYS = [META_SCHEMA_VERSION, META_WRITE_MIN, META_READ_MIN, META_BOARD_ID, META_INSTANCE_ID, META_INSTANCE_FILE, 'tasks_schema']

/** @internal Read-only: one sqlite_master read and one board_meta read. Takes no lock. */
export function readSchemaState(db: DatabaseSync): SchemaState {
  const names = new Set((db.prepare('SELECT name FROM sqlite_master').all() as Array<{ name: string }>).map((r) => r.name))
  if (!names.has('board_meta')) {
    return {
      fresh: true,
      storedRaw: '',
      stored: null,
      effective: 0,
      newer: false,
      writeMin: 1,
      readMin: 1,
      writeMinRaw: '1',
      readMinRaw: '1',
      writeMinStored: false,
      readMinStored: false,
      tasksSchema: undefined,
      identity: null,
    }
  }
  const meta = new Map(
    (
      db.prepare(`SELECT key, value FROM board_meta WHERE key IN (${STATE_KEYS.map(() => '?').join(', ')})`).all(...STATE_KEYS) as Array<{
        key: string
        value: string
      }>
    ).map((r) => [r.key, r.value]),
  )
  const storedText = meta.get(META_SCHEMA_VERSION)
  const tasksSchema = meta.get('tasks_schema')
  const writeText = meta.get(META_WRITE_MIN)
  const readText = meta.get(META_READ_MIN)
  const stored = storedText === undefined ? null : parseDecimal(storedText)
  const writeMinRaw = writeText ?? (tasksSchema !== undefined ? '2' : '1')
  const readMinRaw = readText ?? '1'
  const writeMin = parseDecimal(writeMinRaw)
  const readMin = parseDecimal(readMinRaw)
  const newer =
    (stored !== null && !(stored <= SCHEMA_VERSION)) || Number.isNaN(writeMin) || Number.isNaN(readMin)
  let effective = 0
  if (stored !== null && !newer) {
    for (const step of SCHEMA_STEPS) {
      if (step.version > stored) break
      if (!step.objects.every((name) => names.has(name)) || !step.metaKeys.every((key) => meta.has(key))) break
      effective = step.version
    }
  }
  const boardId = meta.get(META_BOARD_ID)
  const instanceId = meta.get(META_INSTANCE_ID)
  return {
    fresh: false,
    storedRaw: storedText ?? '',
    stored,
    effective,
    newer,
    writeMin,
    readMin,
    writeMinRaw,
    readMinRaw,
    writeMinStored: writeText !== undefined,
    readMinStored: readText !== undefined,
    tasksSchema,
    identity:
      boardId !== undefined && instanceId !== undefined
        ? { boardId, instanceId, fileId: meta.get(META_INSTANCE_FILE) ?? '' }
        : null,
  }
}

/** @internal The 503 for a file this build may not open ('read') or write ('write'). No retryAfter: waiting does not help. */
export function schemaTooNew(kind: 'read' | 'write', state: SchemaState): BoardError {
  const message =
    kind === 'write'
      ? `this board needs a newer Swarmboard to write it (schema ${state.storedRaw}, writable from ${state.writeMinRaw}; this build knows ${SCHEMA_VERSION})`
      : `this board needs a newer Swarmboard to open it (schema ${state.storedRaw}, readable from ${state.readMinRaw}; this build knows ${SCHEMA_VERSION})`
  return new BoardError(503, 'schema_too_new', message, {
    details: { schema: state.storedRaw, writeMin: state.writeMinRaw, readMin: state.readMinRaw, build: SCHEMA_VERSION },
  })
}
