import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { randomUUID, createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { acquireLock } from './lock.js';
import { storagePolicy } from './storage.js';
import { archiveRecord } from './history.js';
import { ensureMemory } from './memory.js';
import { GROUP_SCHEMA } from './groups/schema.js';
import type { Inbound, NoticeThread, Outbound, Run, Session } from './types.js';

function payloadHash(content: string, file?: string | null): string {
  const hash = createHash('sha256').update(content).update('\0');
  if (file)
    hash
      .update('file:')
      .update(path.basename(file).replace(/^[0-9a-f-]{36}-/, ''))
      .update('\0')
      .update(fs.readFileSync(file));
  else hash.update('text:');
  return hash.digest('hex');
}

export class Store {
  readonly db: DatabaseSync;
  private transactionDepth = 0;
  private commitCallbacks: Array<() => void> = [];
  constructor(readonly home: string) {
    const storage = storagePolicy(home);
    // Rollback-journal snapshots hold a shared read lock during the file copy.
    // A multi-GB copy can exceed five seconds; let writers wait for that lock.
    const busyTimeout = storage.journalMode === 'DELETE' ? 60000 : 5000;
    fs.mkdirSync(home, { recursive: true, mode: 0o700 });
    fs.mkdirSync(storage.directory, { recursive: true, mode: 0o700 });
    const filename = path.join(storage.directory, 'clawstrum.db');
    this.db = new DatabaseSync(filename);
    // Schema reads also contend with writers in rollback-journal mode.
    this.db.exec(`PRAGMA busy_timeout=${busyTimeout}`);
    // Prefix lookups like `key LIKE 'worker-steer:x:%'` can only use the metadata primary-key index when
    // LIKE is case-sensitive. Without this every such call scans the whole metadata table (266k rows on NFS in
    // one deployment), which starved the daemon's event loop. All LIKE patterns in this codebase match machine IDs.
    this.db.exec('PRAGMA case_sensitive_like=ON');
    const hasVersion = this.get("SELECT name FROM sqlite_master WHERE name='schema_version'");
    const versions = hasVersion
      ? this.all<{ version: number }>('SELECT version FROM schema_version')
      : [];
    if (
      (hasVersion &&
        (versions.length !== 1 || ![1, 2, 3, 4, 5, 6].includes(versions[0]!.version))) ||
      (!hasVersion &&
        this.get("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'"))
    ) {
      this.db.close();
      throw new Error(
        'Unsupported database version; use a compatible Clawstrum or restore a backup',
      );
    }
    let releaseMigration: (() => void) | undefined;
    try {
      // A read-only operator command must not migrate underneath a live older daemon.
      if (versions[0] && versions[0].version < 6) {
        try {
          releaseMigration = acquireLock(home);
        } catch (error) {
          throw new Error(
            `Database schema ${versions[0].version} needs upgrade to 6. Stop the running daemon and deploy one matching build before upgrading; do not rebuild its worker files in place. ${String(error)}`,
            { cause: error },
          );
        }
      }
      fs.chmodSync(filename, 0o600);
      this.db.exec(
        `PRAGMA busy_timeout=${busyTimeout}; PRAGMA journal_mode=${storage.journalMode}; PRAGMA foreign_keys=ON; PRAGMA synchronous=FULL;`,
      );
      this.transaction(() => {
        const lockedVersions = this.get(
          "SELECT name FROM sqlite_master WHERE name='schema_version'",
        )
          ? this.all<{ version: number }>('SELECT version FROM schema_version')
          : [];
        if (
          lockedVersions.length &&
          (lockedVersions.length !== 1 || ![1, 2, 3, 4, 5, 6].includes(lockedVersions[0]!.version))
        )
          throw new Error('Unsupported database version');
        if (!lockedVersions.length)
          this.db.exec(`
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
    `);
        if (!lockedVersions.length || lockedVersions[0]!.version === 1) {
          this.db.exec(`
        ALTER TABLE inbound ADD COLUMN batch_id TEXT;
        ALTER TABLE inbound ADD COLUMN interruptions INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE runs ADD COLUMN logical_id TEXT NOT NULL DEFAULT '';
        ALTER TABLE runs ADD COLUMN config_json TEXT;
        ALTER TABLE outbox ADD COLUMN payload_hash TEXT;
        CREATE TABLE account_quotas (account_id TEXT NOT NULL, bucket TEXT NOT NULL,
          cooldown_until INTEGER NOT NULL DEFAULT 0, usage_json TEXT NOT NULL, updated_at INTEGER NOT NULL,
          PRIMARY KEY(account_id,bucket));
        CREATE TABLE metadata (key TEXT PRIMARY KEY, value TEXT NOT NULL);
        CREATE TABLE discord_cursors (channel_id TEXT PRIMARY KEY, message_id TEXT NOT NULL);
        CREATE INDEX task_runs_latest ON task_runs(task_id,scheduled_at DESC);
        CREATE INDEX outbox_run ON outbox(run_id);
        CREATE INDEX inbound_session ON inbound(session_id,created_at,id);
        UPDATE inbound SET attempts=0;
        UPDATE schema_version SET version=2;
      `);
          for (const session of this.all<Session>('SELECT * FROM sessions')) {
            const cursor = this.get<{ id: string }>(
              "SELECT id FROM inbound WHERE session_id=? AND kind='user' ORDER BY created_at DESC,id DESC LIMIT 1",
              session.id,
            )?.id;
            if (cursor && /^\d+$/.test(cursor))
              this.exec(
                'INSERT INTO discord_cursors(channel_id,message_id) VALUES(?,?)',
                session.channel_id,
                cursor,
              );
          }
          for (const run of this.all<Run>('SELECT * FROM runs ORDER BY started_at')) {
            const ids = JSON.parse(run.message_ids) as string[];
            const logical = `${run.session_id}:${ids[0]}`;
            this.exec('UPDATE runs SET logical_id=? WHERE id=?', logical, run.id);
            if (run.status === 'running' || run.status === 'interrupted')
              for (const id of ids)
                this.exec('UPDATE inbound SET batch_id=? WHERE id=?', logical, id);
          }
        }
        if (!lockedVersions.length || lockedVersions[0]!.version < 3) {
          this.db.exec(`
            ALTER TABLE outbox ADD COLUMN origin TEXT NOT NULL DEFAULT 'agent';
            UPDATE outbox SET origin='notice' WHERE run_id IS NULL;
            CREATE TABLE citations (key TEXT PRIMARY KEY, metadata_json TEXT NOT NULL, verified_at INTEGER NOT NULL);
            CREATE TABLE research_notes (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
              dedupe_key TEXT NOT NULL UNIQUE, kind TEXT NOT NULL, title TEXT NOT NULL, body TEXT NOT NULL,
              evidence_json TEXT NOT NULL, created_at INTEGER NOT NULL);
            CREATE TABLE delegations (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
              parent_run TEXT, dedupe_key TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL, config_json TEXT NOT NULL,
              status TEXT NOT NULL DEFAULT 'queued', account_id TEXT, result_path TEXT, summary TEXT, usage_json TEXT,
              error TEXT, created_at INTEGER NOT NULL, started_at INTEGER, ended_at INTEGER);
            CREATE INDEX delegations_pending ON delegations(status,created_at);
            CREATE TABLE cluster_jobs (id TEXT PRIMARY KEY, session_id TEXT NOT NULL REFERENCES sessions(id),
              dedupe_key TEXT NOT NULL UNIQUE, spec_json TEXT NOT NULL, script_path TEXT NOT NULL, script_hash TEXT NOT NULL,
              config_json TEXT NOT NULL, preflight_json TEXT NOT NULL, status TEXT NOT NULL,
              job_id TEXT, cluster TEXT, observation_json TEXT, error TEXT, checks INTEGER NOT NULL DEFAULT 0,
              next_check INTEGER, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
            CREATE INDEX cluster_jobs_due ON cluster_jobs(status,next_check);
            UPDATE schema_version SET version=3;
          `);
        }
        if (!lockedVersions.length || lockedVersions[0]!.version < 4)
          this.db.exec(`
          CREATE TABLE history_records (
            seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT NOT NULL UNIQUE,
            session_id TEXT REFERENCES sessions(id), kind TEXT NOT NULL, source TEXT NOT NULL,
            content TEXT NOT NULL, bytes INTEGER NOT NULL, created_at INTEGER NOT NULL
          );
          CREATE INDEX history_scope ON history_records(session_id,seq);
          CREATE TABLE history_usage (logical_id TEXT PRIMARY KEY, bytes INTEGER NOT NULL);
          CREATE TABLE history_supersessions (previous_id TEXT PRIMARY KEY REFERENCES history_records(id), replacement_id TEXT NOT NULL REFERENCES history_records(id));
          UPDATE schema_version SET version=4;
          INSERT OR IGNORE INTO metadata(key,value) SELECT 'memory-layout-required','true' WHERE EXISTS(SELECT 1 FROM sessions);
        `);
        if (!lockedVersions.length || lockedVersions[0]!.version < 5) this.db.exec(GROUP_SCHEMA);
        // Maintenance runs on the daemon's event loop. The separate group/session indexes
        // let SQLite scan every channel's raw records for group_id=NULL once per channel.
        // Cover both scopes and scheduling fields without reading large transcript rows.
        // This additive index also upgrades existing schema-5 stores without a data migration.
        this.db.exec(`CREATE INDEX IF NOT EXISTS history_maintenance
          ON history_records(session_id,group_id,seq,bytes,kind,created_at)`);
        // The Discord loop polls pendingOutbox several times a second. Without this index each
        // poll scanned the whole outbox and, per pending row, scanned it again; on NFS that
        // starved the event loop until deliveries timed out.
        this.db.exec(
          'CREATE INDEX IF NOT EXISTS outbox_pending ON outbox(status,session_id,created_at)',
        );
        // Subagent file holds and changed-file records (research/file-holds.ts). Additive like the
        // indexes above: an older daemon ignores the tables, so no version bump or restart order.
        this.db.exec(`
          CREATE TABLE IF NOT EXISTS worker_file_holds (path TEXT PRIMARY KEY,
            delegation_id TEXT NOT NULL, acquired_at INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS worker_file_holds_owner ON worker_file_holds(delegation_id);
          CREATE TABLE IF NOT EXISTS worker_files (delegation_id TEXT NOT NULL, path TEXT NOT NULL,
            source TEXT NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
            PRIMARY KEY(delegation_id,path));
          CREATE INDEX IF NOT EXISTS worker_files_path ON worker_files(path);
          CREATE TABLE IF NOT EXISTS work_alone (session_id TEXT PRIMARY KEY REFERENCES sessions(id),
            active INTEGER NOT NULL DEFAULT 0, since INTEGER, ask TEXT, report TEXT, off_at INTEGER,
            off_reason TEXT, updated_at INTEGER NOT NULL);
        `);
        if (!lockedVersions.length || lockedVersions[0]!.version < 6)
          this.db.exec(`
          ALTER TABLE sessions ADD COLUMN active_model TEXT;
          UPDATE schema_version SET version=6;
        `);
      });
    } catch (error) {
      this.db.close();
      throw error;
    } finally {
      releaseMigration?.();
    }
  }

  /** Optional daemon-only aggregate observer; never receives query text or parameters. */
  timing?: (operation: string, milliseconds: number) => void;
  private timed<T>(operation: string, fn: () => T): T {
    if (!this.timing) return fn();
    const started = performance.now();
    try {
      return fn();
    } finally {
      this.timing(operation, performance.now() - started);
    }
  }
  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.timed('db.get', () => this.db.prepare(sql).get(...params) as T | undefined);
  }
  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.timed('db.all', () => this.db.prepare(sql).all(...params) as T[]);
  }
  exec(sql: string, ...params: SQLInputValue[]) {
    return this.timed('db.run', () => this.db.prepare(sql).run(...params));
  }
  transaction<T>(fn: () => T): T {
    return this.timed('db.transaction', () => this.transact(fn));
  }
  private transact<T>(fn: () => T): T {
    const savepoint = `nested_${this.transactionDepth}`;
    const callbacks = this.commitCallbacks.length;
    this.db.exec(this.transactionDepth ? `SAVEPOINT ${savepoint}` : 'BEGIN IMMEDIATE');
    this.transactionDepth++;
    let value: T;
    try {
      value = fn();
      this.db.exec(this.transactionDepth > 1 ? `RELEASE ${savepoint}` : 'COMMIT');
    } catch (e) {
      this.commitCallbacks.splice(callbacks);
      this.db.exec(
        this.transactionDepth > 1 ? `ROLLBACK TO ${savepoint}; RELEASE ${savepoint}` : 'ROLLBACK',
      );
      throw e;
    } finally {
      this.transactionDepth--;
    }
    if (!this.transactionDepth) {
      const work = this.commitCallbacks.splice(0);
      for (const callback of work) callback();
    }
    return value;
  }
  /** File projections follow the outer database commit, never a rolled-back savepoint. */
  afterCommit(callback: () => void): void {
    if (this.transactionDepth) this.commitCallbacks.push(callback);
    else callback();
  }
  close(): void {
    this.db.close();
  }
  session(id: string): Session {
    const s = this.get<Session>('SELECT * FROM sessions WHERE id=?', id);
    if (!s) throw new Error(`Unknown session: ${id}`);
    return s;
  }
  /** A Discord thread keeps its own conversation but reads its parent channel's workspace. */
  parentWorkspace(session: Session): string | undefined {
    const parent = this.get<{ workspace: string }>(
      'SELECT s.workspace FROM group_channels c JOIN sessions s ON s.channel_id=c.parent_id WHERE c.channel_id=?',
      session.channel_id,
    )?.workspace;
    return parent && parent !== session.workspace ? parent : undefined;
  }
  /** Discord parent channel of a thread, if one was recorded. */
  parentChannelId(session: Session): string | undefined {
    return (
      this.get<{ parent_id: string | null }>(
        'SELECT parent_id FROM group_channels WHERE channel_id=?',
        session.channel_id,
      )?.parent_id ?? undefined
    );
  }
  ensureSession(channel: string): Session {
    const existing = this.get<Session>('SELECT * FROM sessions WHERE channel_id=?', channel);
    if (existing) return existing;
    const id = randomUUID();
    const configuredRoot = this.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      'channels-root',
    )?.value;
    const workspace = path.join(configuredRoot ?? path.join(this.home, 'channels'), channel);
    fs.mkdirSync(workspace, { recursive: true, mode: 0o700 });
    this.exec(
      'INSERT INTO sessions(id, channel_id, workspace, created_at) VALUES(?,?,?,?)',
      id,
      channel,
      workspace,
      Date.now(),
    );
    ensureMemory(this, id);
    return this.session(id);
  }
  enqueue(input: {
    id: string;
    sessionId: string;
    author: string;
    content: string;
    attachments?: unknown;
    kind?: 'user' | 'task';
    at?: number;
  }): boolean {
    return this.transaction(() => {
      const now = input.at ?? Date.now();
      const change = this.exec(
        `INSERT OR IGNORE INTO inbound(id,session_id,author,content,attachments,kind,available_at,created_at)
      VALUES(?,?,?,?,?,?,?,?)`,
        input.id,
        input.sessionId,
        input.author,
        input.content,
        JSON.stringify(input.attachments ?? []),
        input.kind ?? 'user',
        now,
        now,
      );
      if (change.changes > 0)
        archiveRecord(this, {
          id: `inbound:${input.id}`,
          sessionId: input.sessionId,
          kind: input.kind ?? 'user',
          content: {
            author: input.author,
            text: input.content,
            attachments: input.attachments ?? [],
          },
          counted: true,
          at: now,
        });
      return change.changes > 0;
    });
  }
  claim(sessionId: string, now = Date.now()): { run: Run; messages: Inbound[] } | undefined {
    return this.transaction(() => {
      if (this.get('SELECT id FROM runs WHERE session_id=? AND status=?', sessionId, 'running'))
        return;
      const first = this.get<Inbound>(
        `SELECT * FROM inbound WHERE session_id=? AND status='queued' ORDER BY (kind='user') DESC,created_at,id LIMIT 1`,
        sessionId,
      );
      if (!first || first.available_at > now) return;
      // Scheduled prompts have their own turn; never mix them into a human burst.
      const rows = this.all<Inbound>(
        `SELECT * FROM inbound WHERE session_id=? AND status='queued' ORDER BY (kind='user') DESC,created_at,id LIMIT 20`,
        sessionId,
      );
      const messages: Inbound[] = [];
      for (const m of rows) {
        if (
          m.available_at > now ||
          m.kind !== first.kind ||
          m.batch_id !== first.batch_id ||
          (m.kind === 'task' && messages.length)
        )
          break;
        messages.push(m);
      }
      const id = randomUUID();
      const logical = first.batch_id ?? `${sessionId}:${first.id}`;
      for (const m of messages)
        this.exec("UPDATE inbound SET status='running',batch_id=? WHERE id=?", logical, m.id);
      this.exec(
        'INSERT INTO runs(id,session_id,message_ids,status,started_at,logical_id) VALUES(?,?,?,?,?,?)',
        id,
        sessionId,
        JSON.stringify(messages.map((m) => m.id)),
        'running',
        now,
        logical,
      );
      return {
        run: this.get<Run>('SELECT * FROM runs WHERE id=?', id)!,
        messages: messages.map((m) => ({ ...m, batch_id: logical })),
      };
    });
  }
  event(sessionId: string, runId: string | null, type: string, content: unknown): void {
    this.transaction(() => {
      const at = Date.now();
      const result = this.exec(
        'INSERT INTO events(session_id,run_id,type,content,created_at) VALUES(?,?,?,?,?)',
        sessionId,
        runId,
        type,
        typeof content === 'string' ? content : JSON.stringify(content),
        at,
      );
      if (['assistant', 'partial', 'activity', 'interrupted', 'handoff'].includes(type))
        archiveRecord(this, {
          id: `event:${result.lastInsertRowid}`,
          sessionId,
          kind: type,
          source: runId ?? '',
          content,
          at,
        });
    });
  }
  outbox(
    sessionId: string,
    content: string,
    options: {
      runId?: string;
      file?: string;
      key?: string;
      final?: boolean;
      origin?: 'agent' | 'notice' | 'worker' | 'provider';
      noticeThread?: NoticeThread;
    } = {},
  ): string {
    if (!content.trim() && !options.file) throw new Error('A message needs text or a file');
    if (options.noticeThread && (options.runId || (options.origin && options.origin !== 'notice')))
      throw new Error('Only harness notices can request a notice thread');
    const initialRun = options.runId
      ? this.get<Run>('SELECT * FROM runs WHERE id=?', options.runId)
      : undefined;
    const key =
      options.key ??
      (options.final && initialRun ? `${this.replyScope(initialRun.logical_id)}:final` : null);
    // Spools are immutable. Hash file bytes before acquiring the SQLite write lock.
    const digest = payloadHash(content, options.file);
    const legacy = key
      ? this.get<{ content: string; file_path: string | null; payload_hash: string | null }>(
          'SELECT content,file_path,payload_hash FROM outbox WHERE dedupe_key=?',
          key,
        )
      : undefined;
    const legacyHash =
      legacy && !legacy.payload_hash ? payloadHash(legacy.content, legacy.file_path) : undefined;
    return this.transaction(() => {
      const run = options.runId
        ? this.get<Run>('SELECT * FROM runs WHERE id=?', options.runId)
        : undefined;
      if (options.runId && (!run || run.session_id !== sessionId || run.status !== 'running'))
        throw new Error('Output belongs to an inactive or mismatched run');
      const existing = key
        ? this.get<{
            id: string;
            session_id: string;
            content: string;
            file_path: string | null;
            payload_hash: string | null;
            status: string;
          }>('SELECT * FROM outbox WHERE dedupe_key=?', key)
        : undefined;
      if (existing) {
        const oldHash = existing.payload_hash ?? legacyHash;
        if (existing.session_id !== sessionId || oldHash !== digest)
          throw new Error(
            'Output key conflict: this key already belongs to different content. Use a new key for a new message.',
          );
        if (existing.status === 'failed')
          throw new Error(
            'Previous delivery failed. The operator can run clawstrum retry-delivery SESSION; do not report this as newly queued.',
          );
        if (JSON.stringify(this.noticeThread(existing.id)) !== JSON.stringify(options.noticeThread))
          throw new Error('Output key conflict: this notice already has a different destination');
      }
      const id = existing?.id ?? randomUUID();
      const now = Date.now();
      if (!existing)
        this.exec(
          'INSERT INTO outbox(id,dedupe_key,session_id,run_id,content,file_path,payload_hash,available_at,created_at,origin) VALUES(?,?,?,?,?,?,?,?,?,?)',
          id,
          key,
          sessionId,
          options.runId ?? null,
          content,
          options.file ?? null,
          digest,
          now,
          now,
          options.origin ?? (options.runId ? 'agent' : 'notice'),
        );
      if (options.final && run) this.exec('UPDATE runs SET final_sent=1 WHERE id=?', run.id);
      if (!existing && options.noticeThread)
        this.exec(
          'INSERT INTO metadata(key,value) VALUES(?,?)',
          `outbox-thread:${id}`,
          JSON.stringify(options.noticeThread),
        );
      if (!existing && run) {
        const latest = (JSON.parse(run.message_ids) as string[]).at(-1);
        const route = latest
          ? this.get<{ value: string }>(
              'SELECT value FROM metadata WHERE key=?',
              `group-input:${latest}`,
            )
          : undefined;
        if (route)
          this.exec(
            'INSERT INTO metadata(key,value) VALUES(?,?)',
            `group-output:${id}`,
            route.value,
          );
      }
      return id;
    });
  }
  retry(
    run: Run,
    maxAttempts: number,
    error: string,
    now = Date.now(),
    slowRetryMs = 0,
  ): { queued: number; failed: number } {
    return this.transaction(() => {
      let queued = 0,
        failed = 0;
      for (const id of JSON.parse(run.message_ids) as string[]) {
        const m = this.get<Inbound>('SELECT * FROM inbound WHERE id=?', id)!;
        if (m.status !== 'running') continue;
        const attempts = m.attempts + 1;
        const slow = attempts >= maxAttempts && slowRetryMs > 0;
        const status = attempts < maxAttempts || slow ? 'queued' : 'failed';
        status === 'queued' ? queued++ : failed++;
        this.exec(
          'UPDATE inbound SET attempts=?,status=?,available_at=? WHERE id=?',
          attempts,
          status,
          now + (slow ? slowRetryMs : Math.min(60000, 5000 * 2 ** Math.min(attempts - 1, 4))),
          id,
        );
      }
      this.exec(
        'UPDATE runs SET status=?,error=?,ended_at=? WHERE id=?',
        queued ? 'interrupted' : 'failed',
        error,
        now,
        run.id,
      );
      this.setUnstarted(run.id, []);
      return { queued, failed };
    });
  }

  hasFinal(runId: string): boolean {
    return !!this.get<{ final_sent: number }>('SELECT final_sent FROM runs WHERE id=?', runId)
      ?.final_sent;
  }
  hasOutput(logicalId: string): boolean {
    return !!this.findOutput(logicalId);
  }
  /** Only suppress equivalent text already delivered in this answer. Length and timing alone
   * cannot establish that a result is a recap: it may contain the user's actual answer. */
  recentDuplicate(logicalId: string, since: number, reply: string): boolean {
    const normalize = (text: string) => {
      const normalized = text.replace(/\r\n?/g, '\n').trim();
      return /`|^ {4}\S/m.test(normalized) ? normalized : normalized.replace(/\s+/g, ' ');
    };
    const target = normalize(reply);
    return this.all<{ content: string }>(
      `SELECT o.content FROM outbox o JOIN runs r ON r.id=o.run_id WHERE r.logical_id=? AND o.status='sent'
       AND o.rowid>? AND o.file_path IS NULL AND o.created_at>=? AND o.origin='agent'
       ORDER BY o.rowid DESC LIMIT 20`,
      logicalId,
      this.replyGeneration(logicalId).afterRow,
      since,
    ).some((row) => normalize(row.content) === target);
  }
  private replyGeneration(logicalId: string): { scope: string; afterRow: number } {
    const row = this.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      `reply-generation:${logicalId}`,
    );
    return row ? JSON.parse(row.value) : { scope: logicalId, afterRow: 0 };
  }
  replyScope(logicalId: string): string {
    return this.replyGeneration(logicalId).scope;
  }
  /** Start a new answer within a provider kept alive by background tasks. Previous
   * output stays historical and cannot satisfy or deduplicate the new answer. */
  reopenReply(run: Run, inputId: string, preserveInputs: ReadonlySet<string> = new Set()): void {
    const afterRow = this.get<{ n: number }>('SELECT COALESCE(MAX(rowid),0) n FROM outbox')!.n;
    this.exec(
      'INSERT OR REPLACE INTO metadata(key,value) VALUES(?,?)',
      `reply-generation:${run.logical_id}`,
      JSON.stringify({ scope: `${run.logical_id}:input:${inputId}`, afterRow }),
    );
    // Earlier inputs already received their final answer. Do not replay them if
    // this new answer later encounters a provider error or daemon restart.
    for (const id of JSON.parse(run.message_ids) as string[])
      if (!preserveInputs.has(id))
        this.exec("UPDATE inbound SET status='done' WHERE id=? AND status='running'", id);
    this.exec('UPDATE runs SET final_sent=0 WHERE id=?', run.id);
  }
  findOutput(logicalId: string, content?: string): { id: string } | undefined {
    return this.get(
      `SELECT o.id FROM outbox o JOIN runs r ON r.id=o.run_id WHERE r.logical_id=? AND o.status!='failed'
       AND o.rowid>? ${content === undefined ? '' : 'AND o.content=? AND o.file_path IS NULL'} LIMIT 1`,
      logicalId,
      this.replyGeneration(logicalId).afterRow,
      ...(content === undefined ? [] : [content]),
    );
  }
  /** Repeated operator notices remain historical after delivery failure; never acknowledge them as newly queued. */
  notice(
    sessionId: string,
    content: string,
    key: string,
    options: { thread?: boolean; messageId?: string; sourceChannelId?: string } = {},
  ): void {
    this.transaction(() => {
      if (!this.get('SELECT id FROM outbox WHERE dedupe_key=?', key)) {
        const request =
          options.thread && !options.messageId
            ? this.get<{ value: string }>(
                'SELECT value FROM metadata WHERE key=?',
                `discord-request:${sessionId}`,
              )
            : undefined;
        const messageId =
          options.messageId ?? (request ? JSON.parse(request.value).messageId : undefined);
        const id = this.outbox(sessionId, content, {
          key,
          ...(messageId
            ? {
                noticeThread: {
                  messageId,
                  fallback: 'channel' as const,
                },
              }
            : {}),
        });
        if (options.sourceChannelId)
          this.exec(
            'INSERT INTO metadata(key,value) VALUES(?,?)',
            `notice-source:${id}`,
            JSON.stringify({ channelId: options.sourceChannelId }),
          );
      }
    });
  }

  noticeThread(id: string): NoticeThread | undefined {
    const row = this.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      `outbox-thread:${id}`,
    );
    return row ? (JSON.parse(row.value) as NoticeThread) : undefined;
  }

  /** Backfill and out-of-order gateway delivery must not move the notice anchor backwards. */
  discordRequest(sessionId: string, messageId: string, at: number): void {
    const key = `discord-request:${sessionId}`;
    this.exec(
      `INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value
      WHERE json_extract(metadata.value,'$.at') < json_extract(excluded.value,'$.at')
      OR (json_extract(metadata.value,'$.at') = json_extract(excluded.value,'$.at')
        AND CAST(json_extract(metadata.value,'$.messageId') AS INTEGER) < CAST(json_extract(excluded.value,'$.messageId') AS INTEGER))`,
      key,
      JSON.stringify({ messageId, at }),
    );
  }

  /** Steered input accepted by the provider transport but not yet started by the model. A
   * final reply sent in the meantime answers earlier input, not these. */
  unstarted(runId: string): string[] {
    const row = this.get<{ value: string }>(
      'SELECT value FROM metadata WHERE key=?',
      `unstarted:${runId}`,
    );
    return row ? (JSON.parse(row.value) as string[]) : [];
  }
  setUnstarted(runId: string, ids: Iterable<string>): void {
    const list = [...ids];
    if (!list.length) this.exec('DELETE FROM metadata WHERE key=?', `unstarted:${runId}`);
    else
      this.exec(
        'INSERT INTO metadata(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value',
        `unstarted:${runId}`,
        JSON.stringify(list),
      );
  }
  /** Return unstarted steered input to the queue before a run is closed as answered. */
  requeueUnstarted(run: Run, now = Date.now()): string[] {
    return this.transaction(() => {
      const ids = this.unstarted(run.id);
      for (const id of ids)
        this.exec(
          "UPDATE inbound SET status='queued',batch_id=NULL,available_at=? WHERE id=? AND status='running'",
          now,
          id,
        );
      this.setUnstarted(run.id, []);
      return ids;
    });
  }
  finish(
    run: Run,
    status: 'done' | 'failed' | 'cancelled' | 'queued',
    error?: string,
    availableAt = Date.now(),
  ): void {
    this.transaction(() => {
      for (const id of JSON.parse(run.message_ids) as string[])
        this.exec(
          "UPDATE inbound SET status=?,available_at=? WHERE id=? AND status='running'",
          status,
          availableAt,
          id,
        );
      this.exec(
        'UPDATE runs SET status=?,error=?,ended_at=? WHERE id=?',
        status === 'queued' ? 'interrupted' : status,
        error ?? null,
        Date.now(),
        run.id,
      );
      this.setUnstarted(run.id, []);
    });
  }
  recover(maxAttempts = 3): number {
    return this.transaction(() => {
      const runs = this.all<Run>("SELECT * FROM runs WHERE status='running'");
      for (const run of runs) {
        const unstarted = new Set(this.unstarted(run.id));
        this.setUnstarted(run.id, []);
        if (run.final_sent) {
          // A final reply is already in the durable outbox. Recover its delivery, not its model work.
          // Input accepted before that final but never started was not answered by it.
          for (const id of JSON.parse(run.message_ids) as string[])
            if (unstarted.has(id))
              this.exec(
                "UPDATE inbound SET status='queued',batch_id=NULL,available_at=? WHERE id=? AND status='running'",
                Date.now(),
                id,
              );
            else this.exec("UPDATE inbound SET status='done' WHERE id=?", id);
          this.exec("UPDATE runs SET status='done', ended_at=? WHERE id=?", Date.now(), run.id);
          continue;
        }
        const ids = (JSON.parse(run.message_ids) as string[]).filter(
          (id) =>
            this.get<{ status: string }>('SELECT status FROM inbound WHERE id=?', id)?.status ===
            'running',
        );
        for (const id of ids)
          this.exec('UPDATE inbound SET interruptions=interruptions+1 WHERE id=?', id);
        const exhausted = ids.some(
          (id) =>
            (this.get<{ interruptions: number }>('SELECT interruptions FROM inbound WHERE id=?', id)
              ?.interruptions ?? 0) >= maxAttempts,
        );
        if (exhausted) {
          for (const id of ids) this.exec("UPDATE inbound SET status='failed' WHERE id=?", id);
          this.exec(
            "UPDATE runs SET status='failed', error=?, ended_at=? WHERE id=?",
            'Service repeatedly stopped before completing this input',
            Date.now(),
            run.id,
          );
          this.outbox(
            run.session_id,
            'Repeated service interruptions stopped this turn. Work is saved. Inspect status, then resume after fixing the cause.',
            { key: `recovery:${run.id}` },
          );
          continue;
        }
        this.event(
          run.session_id,
          run.id,
          'interrupted',
          'Service stopped during this attempt. Inspect the workspace and tool events before repeating external actions.',
        );
        this.exec(
          "UPDATE runs SET status='interrupted', ended_at=? WHERE id=?",
          Date.now(),
          run.id,
        );
      }
      const count = this.exec("UPDATE inbound SET status='queued' WHERE status='running'").changes;
      return Number(count);
    });
  }
  pendingOutbox(now = Date.now()): Outbound[] {
    return this.all<Outbound>(
      `SELECT o.* FROM outbox o LEFT JOIN metadata ot ON ot.key='outbox-thread:'||o.id
      WHERE o.status='pending' AND o.available_at<=?
      AND NOT EXISTS(SELECT 1 FROM outbox p LEFT JOIN metadata pt ON pt.key='outbox-thread:'||p.id
      WHERE p.session_id=o.session_id AND p.status='pending'
      AND COALESCE(json_extract(pt.value,'$.messageId'),'')=COALESCE(json_extract(ot.value,'$.messageId'),'')
      AND (p.created_at<o.created_at OR (p.created_at=o.created_at AND p.rowid<o.rowid)))
      ORDER BY o.created_at LIMIT 20`,
      now,
    );
  }
}
