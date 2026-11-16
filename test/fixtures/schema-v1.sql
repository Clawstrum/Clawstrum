      CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY);
      INSERT OR IGNORE INTO schema_version VALUES (1);
      CREATE TABLE IF NOT EXISTS sessions (
        id TEXT PRIMARY KEY, channel_id TEXT NOT NULL UNIQUE, workspace TEXT NOT NULL,
        preferred_account TEXT, active_account TEXT, remote_id TEXT, fingerprint TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS inbound (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), author TEXT NOT NULL,
        content TEXT NOT NULL, attachments TEXT NOT NULL DEFAULT '[]', kind TEXT NOT NULL DEFAULT 'user',
        status TEXT NOT NULL DEFAULT 'queued', attempts INTEGER NOT NULL DEFAULT 0,
        available_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS inbound_pending ON inbound(status, available_at, session_id);
      CREATE TABLE IF NOT EXISTS runs (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), message_ids TEXT NOT NULL,
        status TEXT NOT NULL, account_id TEXT, error TEXT, final_sent INTEGER NOT NULL DEFAULT 0,
        started_at INTEGER NOT NULL, ended_at INTEGER
      );
      CREATE TABLE IF NOT EXISTS events (
        seq INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        run_id TEXT, type TEXT NOT NULL, content TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS events_session ON events(session_id, seq);
      CREATE TABLE IF NOT EXISTS outbox (
        id TEXT PRIMARY KEY, dedupe_key TEXT UNIQUE, session_id TEXT NOT NULL REFERENCES sessions(id), run_id TEXT,
        content TEXT NOT NULL, file_path TEXT, status TEXT NOT NULL DEFAULT 'pending', remote_id TEXT,
        attempts INTEGER NOT NULL DEFAULT 0, available_at INTEGER NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS accounts (
        id TEXT PRIMARY KEY, cooldown_until INTEGER NOT NULL DEFAULT 0, disabled INTEGER NOT NULL DEFAULT 0,
        reason TEXT, usage_json TEXT, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS controls (
        id INTEGER PRIMARY KEY AUTOINCREMENT, session_id TEXT NOT NULL REFERENCES sessions(id),
        command TEXT NOT NULL, argument TEXT, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS command_receipts (message_id TEXT PRIMARY KEY);
      CREATE TABLE IF NOT EXISTS tasks (
        id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id), prompt TEXT NOT NULL,
        kind TEXT NOT NULL, schedule TEXT NOT NULL, timezone TEXT NOT NULL, next_run INTEGER,
        status TEXT NOT NULL DEFAULT 'active', created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS task_runs (
        task_id TEXT NOT NULL REFERENCES tasks(id), scheduled_at INTEGER NOT NULL, message_id TEXT NOT NULL,
        PRIMARY KEY(task_id, scheduled_at)
      );
