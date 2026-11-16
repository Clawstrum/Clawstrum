export const GROUP_SCHEMA = `
CREATE TABLE groups (
 id TEXT PRIMARY KEY,name TEXT NOT NULL,purpose TEXT NOT NULL,
 revision INTEGER NOT NULL DEFAULT 1,reviewed_revision INTEGER NOT NULL DEFAULT 0,
 dirty_since INTEGER,next_review INTEGER NOT NULL DEFAULT 0,error TEXT,
 rendered_memory TEXT,rendered_revision INTEGER NOT NULL DEFAULT 0,
 created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE group_channels (
 channel_id TEXT PRIMARY KEY,session_id TEXT NOT NULL UNIQUE REFERENCES sessions(id),
 name TEXT NOT NULL,parent_id TEXT
);
CREATE TABLE group_memberships (
 group_id TEXT NOT NULL REFERENCES groups(id),channel_id TEXT NOT NULL,
 role TEXT NOT NULL DEFAULT '',enabled INTEGER NOT NULL DEFAULT 1,
 PRIMARY KEY(group_id,channel_id)
);
CREATE TABLE group_entries (
 id TEXT PRIMARY KEY,source_session TEXT REFERENCES sessions(id),source_message TEXT,
 origin_id TEXT NOT NULL,revision INTEGER NOT NULL DEFAULT 1,
 spec_json TEXT NOT NULL,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE group_audiences (
 group_id TEXT NOT NULL REFERENCES groups(id),entry_id TEXT NOT NULL REFERENCES group_entries(id),
 status TEXT NOT NULL DEFAULT 'active',replacement TEXT,
 PRIMARY KEY(group_id,entry_id)
);
CREATE TABLE group_issues (
 id TEXT PRIMARY KEY,group_id TEXT NOT NULL REFERENCES groups(id),dedupe_key TEXT NOT NULL UNIQUE,
 revision INTEGER NOT NULL DEFAULT 1,status TEXT NOT NULL DEFAULT 'open',
 message TEXT NOT NULL,entries_json TEXT NOT NULL,evidence_json TEXT NOT NULL,
 channels_json TEXT NOT NULL,resolution TEXT,created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL
);
CREATE TABLE group_review_jobs (group_id TEXT PRIMARY KEY REFERENCES groups(id),state_json TEXT NOT NULL);
CREATE TABLE group_receipts (key TEXT PRIMARY KEY,hash TEXT NOT NULL,result_json TEXT NOT NULL);
CREATE TABLE group_review_routes (
 issue_id TEXT NOT NULL REFERENCES group_issues(id),channel_id TEXT NOT NULL,thread_id TEXT,
 PRIMARY KEY(issue_id,channel_id)
);
ALTER TABLE history_records ADD COLUMN group_id TEXT REFERENCES groups(id);
CREATE INDEX history_group ON history_records(group_id,seq);
UPDATE schema_version SET version=5;
`;
