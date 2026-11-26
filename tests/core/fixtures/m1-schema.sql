      CREATE TABLE IF NOT EXISTS board_events (
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
