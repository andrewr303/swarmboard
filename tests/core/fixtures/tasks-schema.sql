      -- M2 slice A: the task index (M2_DESIGN 2.6). Projections of the event log, kept by one writer.
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
