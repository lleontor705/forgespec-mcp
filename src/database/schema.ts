export const LEGACY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS contracts (
    id TEXT PRIMARY KEY,
    phase TEXT NOT NULL,
    change_name TEXT NOT NULL,
    project TEXT NOT NULL,
    status TEXT NOT NULL,
    confidence REAL NOT NULL,
    executive_summary TEXT NOT NULL,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS boards (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES boards(id) ON DELETE CASCADE,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'backlog',
    priority TEXT NOT NULL DEFAULT 'p2',
    assignee TEXT,
    spec_ref TEXT,
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    dependencies TEXT NOT NULL DEFAULT '[]',
    notes TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now')),
    claimed_at TEXT,
    completed_at TEXT
  );

  CREATE TABLE IF NOT EXISTS file_reservations (
    id TEXT PRIMARY KEY,
    pattern TEXT NOT NULL,
    agent TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    timestamp TEXT DEFAULT (datetime('now')),
    action TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT NOT NULL,
    agent_name TEXT,
    details TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_tasks_board ON tasks(board_id);
  CREATE INDEX IF NOT EXISTS idx_tasks_status ON tasks(status);
  CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project);
  CREATE INDEX IF NOT EXISTS idx_reservations_agent ON file_reservations(agent);
`;

export const MIGRATION_CONTROL_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE,
    checksum TEXT NOT NULL,
    applied_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS migration_findings (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    migration_version INTEGER NOT NULL,
    board_id TEXT,
    task_id TEXT,
    category TEXT NOT NULL,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    created_at_ms INTEGER NOT NULL
  ) STRICT;
`;

export const DIRECT_CORE_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS direct_boards (
    board_id TEXT PRIMARY KEY REFERENCES boards(id) ON DELETE RESTRICT,
    change_name TEXT,
    schema_version TEXT NOT NULL CHECK (schema_version = '1.0.0'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS direct_tasks (
    task_id TEXT PRIMARY KEY REFERENCES tasks(id) ON DELETE RESTRICT,
    board_id TEXT NOT NULL REFERENCES direct_boards(board_id) ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    status TEXT NOT NULL,
    current_attempt_id TEXT,
    blocked_reason TEXT,
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS task_dependencies (
    board_id TEXT NOT NULL REFERENCES direct_boards(board_id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    dependency_task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    created_revision INTEGER NOT NULL CHECK (created_revision >= 1),
    PRIMARY KEY (task_id, dependency_task_id),
    CHECK (task_id <> dependency_task_id)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_direct_boards_change ON direct_boards(board_id, change_name);
  CREATE INDEX IF NOT EXISTS idx_direct_tasks_board_status ON direct_tasks(board_id, status, updated_at_ms, task_id);
  CREATE INDEX IF NOT EXISTS idx_task_dependencies_reverse ON task_dependencies(dependency_task_id, task_id);

  CREATE TABLE IF NOT EXISTS server_clock_state (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    last_observed_ms INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS task_attempts (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    attempt_no INTEGER NOT NULL CHECK (attempt_no >= 1),
    actor TEXT NOT NULL,
    token_hash TEXT NOT NULL CHECK (token_hash GLOB 'sha256:[0-9a-f]*' AND length(token_hash) = 71),
    state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'expired', 'abandoned')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    claimed_at_ms INTEGER NOT NULL,
    expires_at_ms INTEGER NOT NULL,
    closed_at_ms INTEGER,
    reason TEXT,
    UNIQUE (task_id, attempt_no)
  ) STRICT;

  CREATE UNIQUE INDEX IF NOT EXISTS idx_task_attempts_one_active
    ON task_attempts(task_id) WHERE state = 'active';
  CREATE INDEX IF NOT EXISTS idx_task_attempts_expiry
    ON task_attempts(state, expires_at_ms, task_id);

  CREATE TABLE IF NOT EXISTS evidence_objects (
    id TEXT PRIMARY KEY,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (digest GLOB 'sha256:[0-9a-f]*' AND length(digest) = 71),
    UNIQUE (provider, kind, external_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS task_evidence_links (
    task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL DEFAULT '',
    evidence_id TEXT NOT NULL REFERENCES evidence_objects(id) ON DELETE RESTRICT,
    attached_revision INTEGER NOT NULL CHECK (attached_revision >= 1),
    PRIMARY KEY (task_id, attempt_id, evidence_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS approval_gates (
    task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    gate_id TEXT NOT NULL,
    policy_json TEXT NOT NULL CHECK (json_valid(policy_json)),
    declared_revision INTEGER NOT NULL CHECK (declared_revision >= 1),
    PRIMARY KEY (task_id, gate_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS approval_decisions (
    id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    gate_id TEXT NOT NULL,
    decision_no INTEGER NOT NULL CHECK (decision_no >= 1),
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    actor TEXT NOT NULL,
    reason TEXT,
    board_revision INTEGER NOT NULL CHECK (board_revision >= 1),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (task_id, gate_id, decision_no),
    FOREIGN KEY (task_id, gate_id) REFERENCES approval_gates(task_id, gate_id) ON DELETE RESTRICT
  ) STRICT;

  CREATE TABLE IF NOT EXISTS approval_decision_evidence (
    decision_id TEXT NOT NULL REFERENCES approval_decisions(id) ON DELETE RESTRICT,
    evidence_id TEXT NOT NULL REFERENCES evidence_objects(id) ON DELETE RESTRICT,
    PRIMARY KEY (decision_id, evidence_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS contract_revisions (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    change_name TEXT NOT NULL,
    phase TEXT NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    parent_contract_id TEXT REFERENCES contract_revisions(id) ON DELETE RESTRICT,
    contract_json TEXT NOT NULL CHECK (json_valid(contract_json)),
    digest TEXT NOT NULL CHECK (digest GLOB 'sha256:[0-9a-f]*' AND length(digest) = 71),
    actor TEXT NOT NULL,
    created_at_ms INTEGER NOT NULL,
    UNIQUE (project, change_name, revision),
    UNIQUE (project, change_name, digest)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS contract_streams (
    project TEXT NOT NULL,
    change_name TEXT NOT NULL,
    head_revision INTEGER NOT NULL CHECK (head_revision >= 1),
    head_contract_id TEXT NOT NULL REFERENCES contract_revisions(id) ON DELETE RESTRICT,
    PRIMARY KEY (project, change_name)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS idempotency_records (
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK (key_hash GLOB 'sha256:[0-9a-f]*' AND length(key_hash) = 71),
    request_digest TEXT NOT NULL CHECK (request_digest GLOB 'sha256:[0-9a-f]*' AND length(request_digest) = 71),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    resource_type TEXT,
    resource_id TEXT,
    resulting_revision INTEGER,
    created_at_ms INTEGER NOT NULL,
    PRIMARY KEY (scope, key_hash)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS authority_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_id TEXT NOT NULL UNIQUE,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    board_id TEXT,
    board_revision INTEGER,
    resource_revision INTEGER NOT NULL CHECK (resource_revision >= 1),
    event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 0),
    event_type TEXT NOT NULL,
    actor TEXT NOT NULL,
    attempt_id TEXT,
    outcome TEXT NOT NULL,
    correlation_hash TEXT,
    details_json TEXT NOT NULL CHECK (json_valid(details_json)),
    created_at_ms INTEGER NOT NULL,
    UNIQUE (board_id, board_revision, event_ordinal)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS file_leases (
    id TEXT PRIMARY KEY,
    workspace_id TEXT NOT NULL,
    case_policy TEXT NOT NULL CHECK (case_policy IN ('sensitive', 'insensitive')),
    actor TEXT NOT NULL,
    task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL REFERENCES task_attempts(id) ON DELETE RESTRICT,
    token_hash TEXT NOT NULL CHECK (token_hash GLOB 'sha256:[0-9a-f]*' AND length(token_hash) = 71),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    state TEXT NOT NULL CHECK (state IN ('active', 'released', 'expired')),
    expires_at_ms INTEGER NOT NULL,
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    released_at_ms INTEGER
  ) STRICT;

  CREATE TABLE IF NOT EXISTS file_lease_scopes (
    lease_id TEXT NOT NULL REFERENCES file_leases(id) ON DELETE RESTRICT,
    normalized_scope TEXT NOT NULL,
    base_path TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('exact', 'children', 'tree')),
    PRIMARY KEY (lease_id, normalized_scope)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_contract_revision_history
    ON contract_revisions(project, change_name, revision);
  CREATE INDEX IF NOT EXISTS idx_idempotency_resource
    ON idempotency_records(resource_type, resource_id);
  CREATE INDEX IF NOT EXISTS idx_authority_events_resource
    ON authority_events(resource_type, resource_id, resource_revision, id);
  CREATE INDEX IF NOT EXISTS idx_file_leases_active
    ON file_leases(workspace_id, expires_at_ms, id) WHERE state = 'active';
  CREATE INDEX IF NOT EXISTS idx_file_lease_scopes_base
    ON file_lease_scopes(base_path, scope_kind, lease_id);

  CREATE TRIGGER IF NOT EXISTS immutable_contract_revisions_update
    BEFORE UPDATE ON contract_revisions BEGIN SELECT RAISE(ABORT, 'contract revisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_contract_revisions_delete
    BEFORE DELETE ON contract_revisions BEGIN SELECT RAISE(ABORT, 'contract revisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_authority_events_update
    BEFORE UPDATE ON authority_events BEGIN SELECT RAISE(ABORT, 'authority events are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_authority_events_delete
    BEFORE DELETE ON authority_events BEGIN SELECT RAISE(ABORT, 'authority events are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_idempotency_records_update
    BEFORE UPDATE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_idempotency_records_delete
    BEFORE DELETE ON idempotency_records BEGIN SELECT RAISE(ABORT, 'idempotency records are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_task_attempt_identity
    BEFORE UPDATE ON task_attempts
    WHEN NEW.id <> OLD.id OR NEW.task_id <> OLD.task_id OR NEW.attempt_no <> OLD.attempt_no
      OR NEW.actor <> OLD.actor OR NEW.token_hash <> OLD.token_hash OR NEW.claimed_at_ms <> OLD.claimed_at_ms
    BEGIN SELECT RAISE(ABORT, 'task attempt identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_task_attempts_delete
    BEFORE DELETE ON task_attempts BEGIN SELECT RAISE(ABORT, 'task attempts are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_evidence_objects_update
    BEFORE UPDATE ON evidence_objects BEGIN SELECT RAISE(ABORT, 'evidence objects are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_evidence_objects_delete
    BEFORE DELETE ON evidence_objects BEGIN SELECT RAISE(ABORT, 'evidence objects are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_task_evidence_links_update
    BEFORE UPDATE ON task_evidence_links BEGIN SELECT RAISE(ABORT, 'evidence links are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_task_evidence_links_delete
    BEFORE DELETE ON task_evidence_links BEGIN SELECT RAISE(ABORT, 'evidence links are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_approval_gates_update
    BEFORE UPDATE ON approval_gates BEGIN SELECT RAISE(ABORT, 'approval gates are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_approval_gates_delete
    BEFORE DELETE ON approval_gates BEGIN SELECT RAISE(ABORT, 'approval gates are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_approval_decisions_update
    BEFORE UPDATE ON approval_decisions BEGIN SELECT RAISE(ABORT, 'approval decisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_approval_decisions_delete
    BEFORE DELETE ON approval_decisions BEGIN SELECT RAISE(ABORT, 'approval decisions are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_approval_decision_evidence_update
    BEFORE UPDATE ON approval_decision_evidence BEGIN SELECT RAISE(ABORT, 'approval decision evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_approval_decision_evidence_delete
    BEFORE DELETE ON approval_decision_evidence BEGIN SELECT RAISE(ABORT, 'approval decision evidence is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_file_lease_identity
    BEFORE UPDATE ON file_leases
    WHEN NEW.id <> OLD.id OR NEW.workspace_id <> OLD.workspace_id OR NEW.case_policy <> OLD.case_policy
      OR NEW.actor <> OLD.actor OR NEW.task_id <> OLD.task_id OR NEW.attempt_id <> OLD.attempt_id
      OR NEW.token_hash <> OLD.token_hash OR NEW.created_at_ms <> OLD.created_at_ms
    BEGIN SELECT RAISE(ABORT, 'file lease identity is immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_file_leases_delete
    BEFORE DELETE ON file_leases BEGIN SELECT RAISE(ABORT, 'file leases are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_file_lease_scopes_update
    BEFORE UPDATE ON file_lease_scopes BEGIN SELECT RAISE(ABORT, 'file lease scopes are immutable'); END;
  CREATE TRIGGER IF NOT EXISTS immutable_file_lease_scopes_delete
    BEFORE DELETE ON file_lease_scopes BEGIN SELECT RAISE(ABORT, 'file lease scopes are immutable'); END;
`;

export const DIRECT_TASK_HISTORY_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS direct_task_versions (
    version_id TEXT PRIMARY KEY DEFAULT ('task-version:' || lower(hex(randomblob(16)))),
    board_id TEXT NOT NULL REFERENCES direct_boards(board_id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL REFERENCES direct_tasks(task_id) ON DELETE RESTRICT,
    board_revision INTEGER NOT NULL CHECK (board_revision >= 1),
    task_revision INTEGER NOT NULL CHECK (task_revision >= 1),
    status TEXT NOT NULL,
    current_attempt_id TEXT,
    blocked_reason TEXT,
    metadata_json TEXT NOT NULL CHECK (json_valid(metadata_json)),
    created_at_ms INTEGER NOT NULL,
    updated_at_ms INTEGER NOT NULL,
    is_deleted INTEGER NOT NULL DEFAULT 0 CHECK (is_deleted IN (0, 1)),
    UNIQUE (task_id, board_revision),
    UNIQUE (task_id, task_revision)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_task_versions_board_snapshot
    ON direct_task_versions(board_id, board_revision DESC, task_id);
  CREATE INDEX IF NOT EXISTS idx_task_versions_board_task_snapshot
    ON direct_task_versions(board_id, task_id, board_revision DESC, version_id DESC);
  CREATE INDEX IF NOT EXISTS idx_task_versions_task_history
    ON direct_task_versions(task_id, board_revision, task_revision);
`;
