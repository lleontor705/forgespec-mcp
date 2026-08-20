import type Database from "better-sqlite3";
import { createHash } from "node:crypto";

import { canonicalJson } from "../../core/canonical-json.js";
import { SCHEMA_CORE_TABLES, createFreshCoreStore } from "./schema-core.js";

export const SCHEMA_GOVERNANCE_TABLES = [
  "v2_schema_lease_scopes",
  "v2_schema_leases",
  "v2_schema_authority",
  "v2_schema_authority_revocations",
  "v2_schema_approvals",
  "v2_schema_audit_events",
  "v2_schema_idempotency",
  "v2_schema_evidence",
] as const;

const FORBIDDEN_PAYLOAD_KEYS = ["secret", "token", "password", "api_key"] as const;

export interface AuditEventPayload {
  [key: string]: unknown;
}

export interface InsertAuditEventInput {
  event_id: string;
  task_id: string;
  attempt_id: string;
  actor: string;
  tool: string;
  event_type: string;
  resource_type: string;
  resource_id: string;
  event_ordinal: number;
  prev_hash: string | null;
  event_hash: string;
  payload_json: AuditEventPayload | unknown[];
  created_at: number;
}

export interface InsertIdempotencyRecordInput {
  actor: string;
  tool: string;
  scope: string;
  idempotency_key: string;
  key_hash?: string;
  request_digest: string;
  response_json: string;
  result_code: string;
  resulting_revision: number;
  created_at: number;
}

function normalizeActorValue(value: unknown): string | null {
  if (typeof value !== "string") {
    return null;
  }

  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

function canonicalizeActorsForGranting(actors: string): string {
  const parsed = JSON.parse(actors);
  if (!Array.isArray(parsed)) {
    throw new Error("allowed_actors_json must be an array");
  }

  const normalizedActors = new Set<string>();
  for (const rawActor of parsed) {
    const normalized = normalizeActorValue(rawActor);
    if (normalized === null) {
      continue;
    }

    normalizedActors.add(normalized);
  }

  const orderedActors = Array.from(normalizedActors).sort();
  return canonicalJson(orderedActors);
}

export function canonicalizeActorsJson(value: string): string | null {
  try {
    return canonicalizeActorsForGranting(value);
  } catch {
    return null;
  }
}

export interface AuditEventDigestInput
  extends Omit<InsertAuditEventInput, "event_id" | "event_hash" | "created_at"> {}

export function canonicalAuditEventDigest(input: AuditEventDigestInput): string {
  const normalizedPrevHash = input.prev_hash === null ? null : ensureCanonicalSha256(input.prev_hash);

  return canonicalHash(
    canonicalJson({
      task_id: input.task_id,
      attempt_id: input.attempt_id,
      actor: input.actor,
      tool: input.tool,
      event_type: input.event_type,
      resource_type: input.resource_type,
      resource_id: input.resource_id,
      event_ordinal: input.event_ordinal,
      prev_hash: normalizedPrevHash,
      payload_json: input.payload_json,
    }),
  );
}

function isForbiddenPayloadKey(key: string): boolean {
  return FORBIDDEN_PAYLOAD_KEYS.includes(key.toLowerCase() as (typeof FORBIDDEN_PAYLOAD_KEYS)[number]);
}

export function findForbiddenPayloadKeyPath(
  payload: unknown,
  path = "root",
): string | null {
  if (payload === null || payload === undefined) {
    return null;
  }

  if (Array.isArray(payload)) {
    for (let index = 0; index < payload.length; index += 1) {
      const nested = findForbiddenPayloadKeyPath(payload[index], `${path}[${index}]`);
      if (nested !== null) {
        return nested;
      }
    }
    return null;
  }

  if (typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const nextPath = `${path}.${key}`;
      if (isForbiddenPayloadKey(key)) {
        return nextPath;
      }

      const nested = findForbiddenPayloadKeyPath(value, nextPath);
      if (nested !== null) {
        return nested;
      }
    }
  }

  return null;
}

function ensureCanonicalHex64(value: string): string {
  if (!/^[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid lowercase hex64 value");
  }
  return value;
}

function ensureCanonicalSha256(value: string): string {
  if (!/^(sha256:)?[0-9a-f]{64}$/.test(value)) {
    throw new Error("invalid sha256 digest format");
  }

  if (!value.startsWith("sha256:")) {
    return `sha256:${value}`;
  }

  return value;
}

function ensureRawSha256(value: string): string {
  const normalized = ensureCanonicalSha256(value);
  if (normalized.length !== 71) {
    throw new Error("invalid sha256 digest format");
  }

  return normalized;
}

export function assertAuditPayloadSafe(payload: unknown): void {
  const forbiddenPath = findForbiddenPayloadKeyPath(payload);
  if (forbiddenPath !== null) {
    throw new Error(`forbidden payload key at ${forbiddenPath}`);
  }
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function insertAuditEvent(database: Database.Database, input: InsertAuditEventInput): void {
  assertAuditPayloadSafe(input.payload_json);

  const normalizedEventHash = ensureCanonicalSha256(input.event_hash);
  const normalizedPrevHash = input.prev_hash === null ? null : ensureCanonicalSha256(input.prev_hash);

  const canonicalEventHash = canonicalAuditEventDigest({
    ...input,
    prev_hash: normalizedPrevHash,
    payload_json: input.payload_json,
  });
  if (normalizedEventHash !== canonicalEventHash) {
    throw new Error("event_hash does not match canonical audit payload");
  }

  const tailEvent = database
    .prepare(
      `SELECT event_ordinal AS event_ordinal, event_hash
         FROM v2_schema_audit_events
        WHERE resource_type = ? AND resource_id = ?
        ORDER BY event_ordinal DESC, created_at DESC
        LIMIT 1`,
    )
    .get(input.resource_type, input.resource_id) as { event_ordinal: number; event_hash: string } | undefined;

  if (input.event_ordinal === 1) {
    if (tailEvent !== undefined) {
      throw new Error("first audit event for a resource must have event_ordinal 1");
    }
    if (normalizedPrevHash !== null) {
      throw new Error("first audit event for a resource must not define prev_hash");
    }
  } else {
    if (tailEvent === undefined || input.event_ordinal !== tailEvent.event_ordinal + 1) {
      throw new Error("event_ordinal must append to the previous resource event");
    }
    if (normalizedPrevHash !== tailEvent.event_hash) {
      throw new Error("audit event prev_hash mismatch for resource chain");
    }
  }

  database
    .prepare(
      `INSERT INTO v2_schema_audit_events
         (event_id, task_id, attempt_id, actor, tool, event_type, resource_type, resource_id, event_ordinal, prev_hash, event_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.event_id,
      input.task_id,
      input.attempt_id,
      input.actor,
      input.tool,
      input.event_type,
      input.resource_type,
      input.resource_id,
      input.event_ordinal,
      normalizedPrevHash,
      normalizedEventHash,
      JSON.stringify(input.payload_json),
      input.created_at,
    );
}

export function insertGovernanceIdempotencyRecord(database: Database.Database, input: InsertIdempotencyRecordInput): void {
  const canonicalKeyHash = canonicalHash(input.idempotency_key);
  if (input.key_hash !== undefined && input.key_hash !== canonicalKeyHash) {
    throw new Error("idempotency key hash mismatch");
  }

  database
    .prepare(
      `INSERT INTO v2_schema_idempotency
         (actor, tool, scope, key_hash, request_digest, response_json, result_code, resulting_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
   )
     .run(
       input.actor,
       input.tool,
       input.scope,
       canonicalKeyHash,
       input.request_digest,
       input.response_json,
       input.result_code,
      input.resulting_revision,
      input.created_at,
    );
  }
export const SCHEMA_GOVERNANCE_SQL = `
  CREATE TABLE IF NOT EXISTS v2_schema_leases (
    lease_id TEXT PRIMARY KEY,
    attempt_id TEXT NOT NULL REFERENCES fs_attempts(id) ON DELETE RESTRICT,
    holder TEXT NOT NULL,
    path_pattern TEXT NOT NULL,
    token_hash TEXT NOT NULL CHECK (length(token_hash) = 64 AND token_hash NOT GLOB '*[^0-9a-f]*'),
    state TEXT NOT NULL CHECK (state IN ('active', 'renewed', 'released', 'expired', 'revoked')),
    revision INTEGER NOT NULL CHECK (revision >= 1),
    issued_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    CHECK (issued_at <= expires_at),
    CHECK (created_at <= issued_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS v2_schema_lease_scopes (
    lease_id TEXT NOT NULL REFERENCES v2_schema_leases(lease_id) ON DELETE RESTRICT,
    normalized_scope TEXT NOT NULL,
    base_path TEXT NOT NULL,
    scope_kind TEXT NOT NULL CHECK (scope_kind IN ('exact', 'tree', 'children')),
    PRIMARY KEY (lease_id, normalized_scope)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS v2_schema_authority (
    authority_id TEXT PRIMARY KEY,
    parent_authority_id TEXT REFERENCES v2_schema_authority(authority_id) ON DELETE RESTRICT,
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

  CREATE TABLE IF NOT EXISTS v2_schema_authority_revocations (
    revocation_id TEXT PRIMARY KEY,
    authority_id TEXT NOT NULL REFERENCES v2_schema_authority(authority_id) ON DELETE RESTRICT,
    actor TEXT NOT NULL,
    reason TEXT NOT NULL,
    revoked_at INTEGER NOT NULL,
    event_id TEXT,
    UNIQUE (authority_id),
    CHECK (length(reason) <= 1024)
  ) STRICT;

CREATE TABLE IF NOT EXISTS v2_schema_approvals (
    approval_id TEXT PRIMARY KEY,
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
    provenance_mode TEXT NOT NULL CHECK (provenance_mode = 'direct-v1'),
    provenance_ref_provider TEXT NOT NULL,
    provenance_ref_kind TEXT NOT NULL,
    provenance_ref_external_id TEXT NOT NULL,
    provenance_ref_digest TEXT NOT NULL CHECK (
      length(provenance_ref_digest) = 71
      AND substr(provenance_ref_digest, 1, 7) = 'sha256:'
      AND substr(provenance_ref_digest, 8) GLOB '[0-9a-f]*'
      AND substr(provenance_ref_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    CHECK (
      status = decision
      AND actor = provenance_asserted_actor
    ),
    UNIQUE (attempt_id, task_id, gate_id)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS v2_schema_audit_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    attempt_id TEXT NOT NULL,
    actor TEXT NOT NULL,
    tool TEXT NOT NULL,
    event_type TEXT NOT NULL,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    event_ordinal INTEGER NOT NULL CHECK (event_ordinal >= 1),
    prev_hash TEXT CHECK (
      prev_hash IS NULL
      OR (
        length(prev_hash) = 71
        AND substr(prev_hash, 1, 7) = 'sha256:'
        AND substr(prev_hash, 8) GLOB '[0-9a-f]*'
        AND substr(prev_hash, 8) NOT GLOB '*[^0-9a-f]*'
      )
    ),
    event_hash TEXT NOT NULL CHECK (
      length(event_hash) = 71
      AND substr(event_hash, 1, 7) = 'sha256:'
      AND substr(event_hash, 8) GLOB '[0-9a-f]*'
      AND substr(event_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    payload_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(payload_json)),
    created_at INTEGER NOT NULL,
    UNIQUE (resource_type, resource_id, event_ordinal),
    UNIQUE (event_hash)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS v2_schema_evidence (
    evidence_id TEXT PRIMARY KEY,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    provider TEXT NOT NULL,
    kind TEXT NOT NULL,
    external_id TEXT NOT NULL,
    digest TEXT NOT NULL CHECK (
      length(digest) = 71
      AND substr(digest, 1, 7) = 'sha256:'
      AND substr(digest, 8) GLOB '[0-9a-f]*'
      AND substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    actor TEXT NOT NULL,
    recorded_at INTEGER NOT NULL,
    CHECK (length(external_id) > 0),
    UNIQUE (provider, kind, external_id)
  ) STRICT;

CREATE TABLE IF NOT EXISTS v2_schema_idempotency (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    actor TEXT NOT NULL,
    tool TEXT NOT NULL,
    scope TEXT NOT NULL,
    key_hash TEXT NOT NULL CHECK (
      length(key_hash) = 71
      AND substr(key_hash, 1, 7) = 'sha256:'
      AND substr(key_hash, 8) GLOB '[0-9a-f]*'
      AND substr(key_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    request_digest TEXT NOT NULL CHECK (
      length(request_digest) = 71
      AND substr(request_digest, 1, 7) = 'sha256:'
      AND substr(request_digest, 8) GLOB '[0-9a-f]*'
      AND substr(request_digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    response_json TEXT NOT NULL CHECK (json_valid(response_json)),
    result_code TEXT NOT NULL CHECK (result_code IN ('ok', 'error')),
    resulting_revision INTEGER NOT NULL CHECK (resulting_revision >= 1),
    created_at INTEGER NOT NULL,
    attempt_id TEXT,
    resource_type TEXT,
    resource_id TEXT,
    UNIQUE (actor, tool, key_hash)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_v2_schema_leases_attempt ON v2_schema_leases(attempt_id, state, revision);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_leases_state ON v2_schema_leases(state, revision, expires_at);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_lease_scopes_lease ON v2_schema_lease_scopes(lease_id, scope_kind, normalized_scope);

  CREATE INDEX IF NOT EXISTS idx_v2_schema_authority_resource ON v2_schema_authority(resource_kind, resource_id, operation);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_authority_status ON v2_schema_authority(status, revision);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_authority_parent ON v2_schema_authority(parent_authority_id);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_authority_actor ON v2_schema_authority(actor, grantee_actor, operation, status);

  CREATE INDEX IF NOT EXISTS idx_v2_schema_authority_revocations_authority ON v2_schema_authority_revocations(authority_id);

  CREATE INDEX IF NOT EXISTS idx_v2_schema_approvals_task_gate ON v2_schema_approvals(task_id, gate_id, status);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_audit_events_task_attempt ON v2_schema_audit_events(task_id, attempt_id, event_ordinal);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_audit_events_resource ON v2_schema_audit_events(resource_type, resource_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_audit_events_actor_tool ON v2_schema_audit_events(actor, tool, event_type);
CREATE INDEX IF NOT EXISTS idx_v2_schema_idempotency_subject ON v2_schema_idempotency(actor, tool, request_digest);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_idempotency_key_hash ON v2_schema_idempotency(actor, tool, key_hash);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_idempotency_resulting_revision ON v2_schema_idempotency(resulting_revision);
  CREATE INDEX IF NOT EXISTS idx_v2_schema_evidence_resource ON v2_schema_evidence(resource_type, resource_id, digest);

  CREATE TRIGGER IF NOT EXISTS v2_schema_authority_parent_lineage
    BEFORE INSERT ON v2_schema_authority
    WHEN NEW.parent_authority_id IS NOT NULL
      AND NEW.lineage_kind = 'delegated'
      AND NOT EXISTS (
        SELECT 1
          FROM v2_schema_authority AS parent
         WHERE parent.authority_id = NEW.parent_authority_id
           AND parent.resource_kind = NEW.resource_kind
           AND parent.resource_id = NEW.resource_id
           AND parent.operation = NEW.operation
           AND parent.status = 'active'
           AND parent.expires_at >= NEW.granted_at
      )
    BEGIN
      SELECT RAISE(ABORT, 'invalid authority parent lineage');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_authority_delegation_blocked_by_revocation
    BEFORE INSERT ON v2_schema_authority
    WHEN NEW.lineage_kind = 'delegated'
      AND EXISTS (
        SELECT 1
          FROM v2_schema_authority_revocations
         WHERE authority_id = NEW.parent_authority_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'parent authority has been revoked');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_authority_children_expiry_bound
    BEFORE INSERT ON v2_schema_authority
    WHEN NEW.lineage_kind = 'delegated'
      AND EXISTS (
        WITH RECURSIVE ancestor_chain(authority_id, parent_authority_id, expires_at) AS (
          SELECT authority_id, parent_authority_id, expires_at
            FROM v2_schema_authority
           WHERE authority_id = NEW.parent_authority_id
          UNION ALL
          SELECT parent.authority_id, parent.parent_authority_id, parent.expires_at
            FROM v2_schema_authority AS parent
            JOIN ancestor_chain
              ON parent.authority_id = ancestor_chain.parent_authority_id
        )
        SELECT 1
          FROM ancestor_chain
         WHERE expires_at < NEW.expires_at
      )
    BEGIN
      SELECT RAISE(ABORT, 'child authority expiry cannot exceed parent');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_authority_parent_status_active
    BEFORE INSERT ON v2_schema_authority
    WHEN NEW.lineage_kind = 'delegated'
      AND NEW.parent_authority_id IS NOT NULL
      AND EXISTS (
        WITH RECURSIVE ancestor_chain(authority_id, parent_authority_id, status) AS (
          SELECT authority_id, parent_authority_id, status
            FROM v2_schema_authority
           WHERE authority_id = NEW.parent_authority_id
          UNION ALL
          SELECT parent.authority_id, parent.parent_authority_id, parent.status
            FROM v2_schema_authority AS parent
            JOIN ancestor_chain
              ON parent.authority_id = ancestor_chain.parent_authority_id
        )
        SELECT 1
          FROM ancestor_chain
         WHERE status <> 'active'
      )
    BEGIN
      SELECT RAISE(ABORT, 'parent authority in chain is not active');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_authority_parent_not_revoked_ancestor
    BEFORE INSERT ON v2_schema_authority
    WHEN NEW.lineage_kind = 'delegated'
      AND NEW.parent_authority_id IS NOT NULL
      AND EXISTS (
        WITH RECURSIVE ancestor_chain(authority_id, parent_authority_id) AS (
          SELECT authority_id, parent_authority_id
            FROM v2_schema_authority
           WHERE authority_id = NEW.parent_authority_id
          UNION ALL
          SELECT parent.authority_id, parent.parent_authority_id
            FROM v2_schema_authority AS parent
            JOIN ancestor_chain
              ON parent.authority_id = ancestor_chain.parent_authority_id
        )
        SELECT 1
          FROM ancestor_chain
          JOIN v2_schema_authority_revocations
            ON v2_schema_authority_revocations.authority_id = ancestor_chain.authority_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'parent authority has been revoked');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_authority_update
    BEFORE UPDATE ON v2_schema_authority
    BEGIN
      SELECT RAISE(ABORT, 'authority grants are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_authority_delete
    BEFORE DELETE ON v2_schema_authority
    BEGIN
      SELECT RAISE(ABORT, 'authority grants are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_authority_revocations_update
    BEFORE UPDATE ON v2_schema_authority_revocations
    BEGIN
      SELECT RAISE(ABORT, 'authority revocations are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_authority_revocations_delete
    BEFORE DELETE ON v2_schema_authority_revocations
    BEGIN
      SELECT RAISE(ABORT, 'authority revocations are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_approvals_update
    BEFORE UPDATE ON v2_schema_approvals
    BEGIN
      SELECT RAISE(ABORT, 'approvals are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_approvals_delete
    BEFORE DELETE ON v2_schema_approvals
    BEGIN
      SELECT RAISE(ABORT, 'approvals are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_approvals_actor_and_scope_guard
    BEFORE INSERT ON v2_schema_approvals
    WHEN NOT EXISTS (
      SELECT 1
        FROM fs_attempts AS a
        JOIN fs_tasks AS t
          ON t.board_id = a.board_id
         AND t.id = a.task_id
        JOIN fs_gates AS g
          ON g.board_id = a.board_id
         AND g.id = NEW.gate_id
       WHERE a.id = NEW.attempt_id
         AND t.id = NEW.task_id
         AND EXISTS (
           SELECT 1
             FROM json_each(v2_schema_normalize_actor_set(g.allowed_actors_json))
            WHERE lower(value) = lower(NEW.actor)
         )
         AND g.allowed_actors_json = v2_schema_normalize_actor_set(g.allowed_actors_json)
    )
    BEGIN
      SELECT RAISE(ABORT, 'approval actor, task, and gate must align with attempt scope and gate allowlist');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_audit_events_payload_guard
    BEFORE INSERT ON v2_schema_audit_events
    WHEN EXISTS (
      SELECT 1
        FROM json_tree(NEW.payload_json)
       WHERE key IS NOT NULL
         AND lower(key) IN ('secret', 'token', 'password', 'api_key')
    )
    BEGIN
      SELECT RAISE(ABORT, 'v2_schema_audit_events payload contains forbidden secret fields');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_audit_events_chain_insert_first
    BEFORE INSERT ON v2_schema_audit_events
    WHEN NEW.event_ordinal = 1
      AND EXISTS (
        SELECT 1
          FROM v2_schema_audit_events
         WHERE resource_type = NEW.resource_type
           AND resource_id = NEW.resource_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'event_ordinal 1 requires no prior resource events');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_audit_events_chain_insert_first_prev
    BEFORE INSERT ON v2_schema_audit_events
    WHEN NEW.event_ordinal = 1
      AND NEW.prev_hash IS NOT NULL
    BEGIN
      SELECT RAISE(ABORT, 'first audit event for a resource must not define prev_hash');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_audit_events_chain_insert_first_must_ordinal
    BEFORE INSERT ON v2_schema_audit_events
    WHEN NEW.event_ordinal <> 1
      AND NOT EXISTS (
        SELECT 1
          FROM v2_schema_audit_events
         WHERE resource_type = NEW.resource_type
           AND resource_id = NEW.resource_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'first audit event for a resource must have event_ordinal 1');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_audit_events_chain_append_guard
    BEFORE INSERT ON v2_schema_audit_events
    WHEN EXISTS (
      SELECT 1
      FROM v2_schema_audit_events
      WHERE resource_type = NEW.resource_type
        AND resource_id = NEW.resource_id
    )
      AND NEW.event_ordinal <> (
        SELECT COALESCE(MAX(event_ordinal), 0) + 1
        FROM v2_schema_audit_events
        WHERE resource_type = NEW.resource_type
          AND resource_id = NEW.resource_id
      )
    BEGIN
      SELECT RAISE(ABORT, 'event_ordinal must append to the previous resource event');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_audit_events_chain_append_prev_hash
    BEFORE INSERT ON v2_schema_audit_events
    WHEN EXISTS (
      SELECT 1
      FROM v2_schema_audit_events
      WHERE resource_type = NEW.resource_type
        AND resource_id = NEW.resource_id
    )
      AND (
        NEW.prev_hash IS NULL
        OR NEW.prev_hash <> (
          SELECT event_hash
          FROM v2_schema_audit_events
          WHERE resource_type = NEW.resource_type
            AND resource_id = NEW.resource_id
          ORDER BY event_ordinal DESC
          LIMIT 1
        )
       )
    BEGIN
      SELECT RAISE(ABORT, 'audit event prev_hash mismatch for resource chain');
    END;

  CREATE TRIGGER IF NOT EXISTS v2_schema_audit_events_hash_guard
    BEFORE INSERT ON v2_schema_audit_events
    WHEN NEW.event_hash IS NOT NULL
      AND NEW.event_hash <> v2_schema_canonical_audit_event_hash(
        NEW.task_id,
        NEW.attempt_id,
        NEW.actor,
        NEW.tool,
        NEW.event_type,
        NEW.resource_type,
        NEW.resource_id,
        NEW.event_ordinal,
        NEW.prev_hash,
        NEW.payload_json
      )
    BEGIN
      SELECT RAISE(ABORT, 'event_hash does not match canonical audit payload');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_audit_events_update
    BEFORE UPDATE ON v2_schema_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_audit_events_delete
    BEFORE DELETE ON v2_schema_audit_events
    BEGIN
      SELECT RAISE(ABORT, 'audit events are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_evidence_update
    BEFORE UPDATE ON v2_schema_evidence
    BEGIN
      SELECT RAISE(ABORT, 'evidence is immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_evidence_delete
    BEFORE DELETE ON v2_schema_evidence
    BEGIN
      SELECT RAISE(ABORT, 'evidence is immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_idempotency_update
    BEFORE UPDATE ON v2_schema_idempotency
    BEGIN
      SELECT RAISE(ABORT, 'idempotency records are immutable');
    END;

  CREATE TRIGGER IF NOT EXISTS immutable_v2_schema_idempotency_delete
    BEFORE DELETE ON v2_schema_idempotency
    BEGIN
      SELECT RAISE(ABORT, 'idempotency records are immutable');
    END;
`;

export function canonicalHash(value: string): string {
  return ensureRawSha256(sha256(value));
}

function auditEventHashFromArgs(
  taskId: string,
  attemptId: string,
  actor: string,
  tool: string,
  eventType: string,
  resourceType: string,
  resourceId: string,
  eventOrdinal: number,
  prevHash: string | null,
  payloadJson: string,
): string {
  return canonicalAuditEventDigest({
    task_id: taskId,
    attempt_id: attemptId,
    actor,
    tool,
    event_type: eventType,
    resource_type: resourceType,
    resource_id: resourceId,
    event_ordinal: eventOrdinal,
    prev_hash: prevHash === null ? null : ensureCanonicalSha256(prevHash),
    payload_json: JSON.parse(payloadJson),
  });
}

export function createFreshGovernanceStore(database: Database.Database): void {
  createFreshCoreStore(database);

  database.function("v2_schema_canonical_audit_event_hash", { deterministic: true }, (
    taskId: string,
    attemptId: string,
    actor: string,
    tool: string,
    eventType: string,
    resourceType: string,
    resourceId: string,
    eventOrdinal: number,
    prevHash: string | null,
    payloadJson: string,
  ): string | null => {
    try {
      return auditEventHashFromArgs(
        taskId,
        attemptId,
        actor,
        tool,
        eventType,
        resourceType,
        resourceId,
        Number(eventOrdinal),
        prevHash,
        payloadJson,
      );
    } catch {
      return "";
    }
  });

  database.function("v2_schema_normalize_actor_set", { deterministic: true }, (actorsJson: string): string | null => {
    return canonicalizeActorsJson(actorsJson);
  });

  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(SCHEMA_GOVERNANCE_SQL);

    const expectedTableCount = SCHEMA_CORE_TABLES.length + SCHEMA_GOVERNANCE_TABLES.length;
    const createdTables = database
      .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND (name LIKE 'fs_%' OR name LIKE 'v2_schema_%')")
      .get() as { count: number };
    if (createdTables.count !== expectedTableCount) {
      throw new Error(
        `Expected exactly ${expectedTableCount} known governance and core tables, got ${createdTables.count}`,
      );
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
