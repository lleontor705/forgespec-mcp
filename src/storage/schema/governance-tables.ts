export const GOVERNANCE_TABLE_NAMES = [
  "fs_leases",
  "fs_lease_scopes",
  "fs_authority",
  "fs_authority_revocations",
  "fs_approvals",
  "fs_audit_events",
  "fs_idempotency",
  "fs_evidence",
] as const;

export const GOVERNANCE_TABLE_NAME_SET: ReadonlySet<string> = new Set(GOVERNANCE_TABLE_NAMES);

export const GOVERNANCE_TABLES_SQL = `
  CREATE TABLE IF NOT EXISTS fs_leases (
    lease_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES fs_attempts(id) ON DELETE RESTRICT,
    holder TEXT NOT NULL,
    path_pattern TEXT NOT NULL,
    case_policy TEXT NOT NULL DEFAULT 'sensitive' CHECK (case_policy IN ('sensitive', 'insensitive')),
    token_hash TEXT NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK (state IN ('active', 'renewed', 'released', 'expired', 'revoked')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (issued_at <= expires_at),
    CHECK (created_at <= issued_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_lease_scopes (
    lease_id TEXT NOT NULL REFERENCES fs_leases(lease_id) ON DELETE RESTRICT,
    normalized_scope TEXT NOT NULL,
    base_path TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('exact', 'tree', 'children')),
    PRIMARY KEY (lease_id, normalized_scope)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_authority (
    authority_id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES fs_boards(id) ON DELETE RESTRICT,
    parent_authority_id TEXT REFERENCES fs_authority(authority_id) ON DELETE RESTRICT,
    resource_kind TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    grantee_actor TEXT NOT NULL,
    operation TEXT NOT NULL CHECK (operation IN ('read_board', 'read_task', 'add', 'update', 'approve', 'recover', 'grant', 'handoff', 'revoke')),
    granted_by_actor TEXT NOT NULL,
    lineage_kind TEXT NOT NULL CHECK (lineage_kind IN ('owner_root', 'delegated')),
    status TEXT NOT NULL CHECK (status IN ('active', 'revoked', 'expired')),
    token_hash TEXT NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    granted_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    revoked_at INTEGER,
    revoked_by_actor TEXT,
    revoked_reason TEXT,
    CHECK (granted_at <= expires_at),
    CHECK (revoked_at IS NULL OR revoked_at >= granted_at),
    CHECK (revoked_reason IS NULL OR revoked_at IS NOT NULL),
    CHECK (revoked_by_actor IS NULL OR revoked_at IS NOT NULL),
    CHECK ((lineage_kind = 'delegated' AND parent_authority_id IS NOT NULL) OR lineage_kind <> 'delegated'),
    CHECK (revoked_at IS NULL OR status = 'revoked')
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_authority_revocations (
    revocation_id TEXT PRIMARY KEY,
    authority_id TEXT NOT NULL REFERENCES fs_authority(authority_id) ON DELETE RESTRICT,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    revoked_at INTEGER NOT NULL,
    event_id TEXT,
    UNIQUE (authority_id),
    CHECK (length(reason) <= 1024)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_approvals (
    approval_id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES fs_boards(id) ON DELETE RESTRICT,
    attempt_id TEXT NOT NULL REFERENCES fs_attempts(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('allow', 'deny')),
    decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny')),
    decided_at INTEGER NOT NULL,
    revision INTEGER NOT NULL CHECK (revision >= 1),
    notes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes_json)),
    provenance_asserted_actor TEXT NOT NULL,
    provenance_boundary TEXT NOT NULL CHECK (provenance_boundary = 'local-trusted-client'),
    provenance_mode TEXT NOT NULL CHECK (provenance_mode = 'native'),
    provenance_ref_provider TEXT NOT NULL,
    provenance_ref_kind TEXT NOT NULL,
    provenance_ref_external_id TEXT NOT NULL,
    provenance_ref_digest TEXT NOT NULL CHECK (length(provenance_ref_digest) = 71 AND substr(provenance_ref_digest, 1, 7) = 'sha256:' AND substr(provenance_ref_digest, 8) GLOB '[0-9a-f]*' AND substr(provenance_ref_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    CHECK (status = decision AND actor = provenance_asserted_actor),
    FOREIGN KEY (board_id, task_id) REFERENCES fs_tasks(board_id, id) ON DELETE RESTRICT,
    FOREIGN KEY (board_id, gate_id) REFERENCES fs_gates(board_id, id) ON DELETE RESTRICT,
    CHECK (length(trim(provenance_ref_provider)) > 0),
    CHECK (length(trim(provenance_ref_kind)) > 0),
    CHECK (length(trim(provenance_ref_external_id)) > 0),
    UNIQUE (attempt_id, task_id, gate_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_audit_events (
    event_id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL REFERENCES fs_boards(id) ON DELETE RESTRICT,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    tool TEXT NOT NULL,
    event_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 1),
    prev_hash TEXT CHECK (prev_hash IS NULL OR (length(prev_hash) = 71 AND substr(prev_hash, 1, 7) = 'sha256:' AND substr(prev_hash, 8) GLOB '[0-9a-f]*' AND substr(prev_hash, 8) NOT GLOB '*[^0-9a-f]*')),
    event_hash TEXT NOT NULL CHECK (length(event_hash) = 71 AND substr(event_hash, 1, 7) = 'sha256:' AND substr(event_hash, 8) GLOB '[0-9a-f]*' AND substr(event_hash, 8) NOT GLOB '*[^0-9a-f]*'),
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at INTEGER NOT NULL,
    UNIQUE (board_id, resource_type, resource_id, event_ordinal),
    UNIQUE (event_hash)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_evidence (
    evidence_id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (length(digest) = 71 AND substr(digest, 1, 7) = 'sha256:' AND substr(digest, 8) GLOB '[0-9a-f]*' AND substr(digest, 8) NOT GLOB '*[^0-9a-f]*'),
    actor TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    CHECK (length(trim(provider)) > 0),
    CHECK (length(trim(kind)) > 0),
    CHECK (length(trim(external_id)) > 0),
    UNIQUE (provider, kind, external_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    tool TEXT NOT NULL,
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK (length(key_hash) = 71 AND substr(key_hash, 1, 7) = 'sha256:' AND substr(key_hash, 8) GLOB '[0-9a-f]*' AND substr(key_hash, 8) NOT GLOB '*[^0-9a-f]*'),
    request_digest TEXT NOT NULL CHECK (length(request_digest) = 71 AND substr(request_digest, 1, 7) = 'sha256:' AND substr(request_digest, 8) GLOB '[0-9a-f]*' AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    result_code TEXT NOT NULL CHECK (result_code IN ('ok', 'error')),
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 1),
    created_at INTEGER NOT NULL,
    attempt_id TEXT,
    resource_type TEXT,
    resource_id TEXT,
    UNIQUE (actor, tool, key_hash)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_fs_leases_attempt ON fs_leases(attempt_id, state, revision);
  CREATE INDEX IF NOT EXISTS idx_fs_leases_state ON fs_leases(state, revision, expires_at);
  CREATE INDEX IF NOT EXISTS idx_fs_lease_scopes_lease ON fs_lease_scopes(lease_id, scope_kind, normalized_scope);
  CREATE INDEX IF NOT EXISTS idx_fs_authority_resource ON fs_authority(board_id, resource_kind, resource_id, operation);
  CREATE INDEX IF NOT EXISTS idx_fs_authority_status ON fs_authority(status, revision);
  CREATE INDEX IF NOT EXISTS idx_fs_authority_parent ON fs_authority(parent_authority_id);
  CREATE INDEX IF NOT EXISTS idx_fs_authority_actor ON fs_authority(board_id, actor, grantee_actor, operation, status);
  CREATE INDEX IF NOT EXISTS idx_fs_authority_revocations_authority ON fs_authority_revocations(authority_id);
  CREATE INDEX IF NOT EXISTS idx_fs_approvals_task_gate ON fs_approvals(task_id, gate_id, status);
  CREATE INDEX IF NOT EXISTS idx_fs_audit_events_task_attempt ON fs_audit_events(task_id, attempt_id, event_ordinal);
  CREATE INDEX IF NOT EXISTS idx_fs_audit_events_resource ON fs_audit_events(resource_type, resource_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_fs_audit_events_actor_tool ON fs_audit_events(actor, tool, event_type);
  CREATE INDEX IF NOT EXISTS idx_fs_idempotency_subject ON fs_idempotency(actor, tool, request_digest);
  CREATE INDEX IF NOT EXISTS idx_fs_idempotency_key_hash ON fs_idempotency(actor, tool, key_hash);
  CREATE INDEX IF NOT EXISTS idx_fs_idempotency_resulting_revision ON fs_idempotency(resulting_revision);
  CREATE INDEX IF NOT EXISTS idx_fs_evidence_resource ON fs_evidence(resource_type, resource_id, digest);
`;
