export const CORE_TABLE_NAMES = [
  "fs_schema_meta",
  "fs_boards",
  "fs_tasks",
  "fs_task_dependencies",
  "fs_gates",
  "fs_gate_decisions",
  "fs_attempts",
  "fs_contracts",
] as const;

export const CORE_TABLE_NAME_SET: ReadonlySet<string> = new Set(CORE_TABLE_NAMES);

export const CORE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS fs_schema_meta (
    key TEXT PRIMARY KEY CHECK (key = 'core'),
    schema_version TEXT NOT NULL CHECK (schema_version = '2.0.0'),
    bootstrapped_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    bootstrap_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(bootstrap_metadata_json)),
    recovery_mode INTEGER NOT NULL DEFAULT 0 CHECK (recovery_mode IN (0, 1))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_boards (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_tasks (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
    status TEXT NOT NULL CHECK (status IN ('backlog', 'ready', 'in_progress', 'in_review', 'blocked', 'done')),
    spec_ref TEXT,
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    blocked_reason TEXT,
    notes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    recovery_pending INTEGER NOT NULL DEFAULT 0 CHECK (recovery_pending IN (0, 1)),
    PRIMARY KEY (board_id, id),
    FOREIGN KEY (board_id) REFERENCES fs_boards(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_task_dependencies (
    task_board_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    dependency_board_id TEXT NOT NULL,
    dependency_task_id TEXT NOT NULL,
    PRIMARY KEY (task_board_id, task_id, dependency_task_id),
    CHECK (task_id <> dependency_task_id),
    CHECK (task_board_id = dependency_board_id),
    FOREIGN KEY (task_board_id, task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE,
    FOREIGN KEY (dependency_board_id, dependency_task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_gates (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    required_for_json TEXT NOT NULL DEFAULT '["ready"]' CHECK (json_valid(required_for_json)),
    allowed_actors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_actors_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, id),
    FOREIGN KEY (board_id) REFERENCES fs_boards(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_gate_decisions (
    board_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    decision_no INTEGER NOT NULL DEFAULT 1 CHECK (decision_no >= 1),
    attempt_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'allow', 'deny')),
    actor TEXT,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, task_id, gate_id, decision_no),
    FOREIGN KEY (board_id, task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE,
    FOREIGN KEY (board_id, gate_id) REFERENCES fs_gates(board_id, id) ON DELETE CASCADE,
    CHECK (
      (status = 'pending' AND attempt_id IS NULL AND actor IS NULL)
      OR (status IN ('allow', 'deny') AND attempt_id IS NOT NULL AND actor IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_attempts (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    actor TEXT NOT NULL,
    token_hash TEXT NOT NULL CHECK (
      length(token_hash) = 71
      AND substr(token_hash, 1, 7) = 'sha256:'
      AND substr(token_hash, 8) GLOB '[0-9a-f]*'
      AND substr(token_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'expired', 'abandoned')),
    claimed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    closed_at INTEGER,
    reason TEXT,
    UNIQUE (board_id, task_id, attempt_no),
    FOREIGN KEY (board_id, task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE,
    CHECK (claimed_at <= expires_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_contracts (
    id TEXT NOT NULL,
    board_id TEXT NOT NULL,
    project TEXT NOT NULL,
    parent_contract_id TEXT,
    digest TEXT NOT NULL CHECK (
      length(digest) = 71
      AND substr(digest, 1, 7) = 'sha256:'
      AND substr(digest, 8) GLOB '[0-9a-f]*'
      AND substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    change_name TEXT NOT NULL,
    planning_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(planning_json)),
    phase TEXT NOT NULL CHECK (
      phase IN ('init', 'explore', 'proposal', 'spec', 'design', 'tasks', 'apply', 'verify')
    ),
    status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'blocked')),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    executive_summary TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    contract_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(contract_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (board_id) REFERENCES fs_boards(id) ON DELETE RESTRICT,
    FOREIGN KEY (parent_contract_id) REFERENCES fs_contracts(id) ON DELETE RESTRICT,
    CHECK (json_valid(contract_json)),
    UNIQUE (project, change_name, revision)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_fs_tasks_board ON fs_tasks(board_id);
  CREATE INDEX IF NOT EXISTS idx_fs_tasks_board_status ON fs_tasks(board_id, status);
  CREATE INDEX IF NOT EXISTS idx_fs_task_dependencies_task ON fs_task_dependencies(task_board_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_fs_gates_board ON fs_gates(board_id);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_parent ON fs_contracts(parent_contract_id);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_digests ON fs_contracts(digest);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_attempts_one_active
    ON fs_attempts(board_id, task_id) WHERE state = 'active';
  CREATE INDEX IF NOT EXISTS idx_fs_gate_decisions_board_status ON fs_gate_decisions(board_id, status);
  CREATE INDEX IF NOT EXISTS idx_fs_attempts_board_task ON fs_attempts(board_id, task_id, state);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_board_phase ON fs_contracts(board_id, phase, status);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_project_phase_status ON fs_contracts(project, phase, status, revision);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_gate_decisions_one_pending
    ON fs_gate_decisions(board_id, task_id, gate_id)
    WHERE status = 'pending';
`;
