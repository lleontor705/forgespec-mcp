export const SCHEMA_V2_SQL = `
  CREATE TABLE IF NOT EXISTS v2_boards (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    owner_actor TEXT NOT NULL,
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v2_boards_project ON v2_boards(project);

  CREATE TABLE IF NOT EXISTS v2_tasks (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES v2_boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
    status TEXT NOT NULL CHECK (status IN ('backlog', 'ready', 'in_progress', 'in_review', 'blocked', 'done')),
    spec_ref TEXT,
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    dependencies_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(dependencies_json)),
    revision INTEGER NOT NULL DEFAULT 1,
    assignee TEXT,
    current_attempt_id TEXT,
    blocked_reason TEXT,
    notes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v2_tasks_board ON v2_tasks(board_id);
  CREATE INDEX IF NOT EXISTS idx_v2_tasks_status ON v2_tasks(board_id, status);

  CREATE TABLE IF NOT EXISTS v2_task_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES v2_tasks(id) ON DELETE CASCADE,
    attempt_no INTEGER NOT NULL,
    actor TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'expired', 'abandoned')),
    claimed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    closed_at INTEGER,
    reason TEXT
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v2_attempts_task ON v2_task_attempts(task_id, state);

  CREATE TABLE IF NOT EXISTS v2_file_leases (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    path_pattern TEXT NOT NULL,
    holder TEXT NOT NULL,
    task_id TEXT REFERENCES v2_tasks(id) ON DELETE SET NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v2_file_leases_lookup ON v2_file_leases(project, holder);

  CREATE TABLE IF NOT EXISTS v2_spec_contracts (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    phase TEXT NOT NULL,
    change_name TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'blocked')),
    confidence REAL NOT NULL,
    executive_summary TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    contract_json TEXT NOT NULL CHECK (json_valid(contract_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v2_spec_contracts_lookup ON v2_spec_contracts(project, phase);

  CREATE TABLE IF NOT EXISTS v2_audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at INTEGER NOT NULL
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v2_audit_events ON v2_audit_events(entity_type, entity_id);
`;
