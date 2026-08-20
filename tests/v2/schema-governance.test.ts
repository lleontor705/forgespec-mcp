import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";

import {
  SCHEMA_GOVERNANCE_TABLES,
  assertAuditPayloadSafe,
  canonicalHash,
  canonicalAuditEventDigest,
  createFreshGovernanceStore,
  insertAuditEvent,
  InsertAuditEventInput,
  insertGovernanceIdempotencyRecord,
  InsertIdempotencyRecordInput,
} from "../../src/v2/storage/schema-governance";
import { SCHEMA_CORE_TABLES } from "../../src/v2/storage/schema-core";

function openMemoryStore(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  createFreshGovernanceStore(database);
  return database;
}

function tableExists(database: Database.Database, tableName: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) !== undefined;
}

function tableSql(database: Database.Database, tableName: string): string {
  return (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as {
    sql: string;
  } | undefined)?.sql ?? "";
}

function createScopedAttempt(database: Database.Database): string {
  const now = 1_700_000_000;
  const attemptId = "attempt-1";
  const tokenHash = "sha256:" + "b".repeat(64);

  database.prepare(
    `INSERT INTO fs_boards (id, project, name, revision, metadata_json, created_at, updated_at)
     VALUES (?, ?, ?, 1, '{}', ?, ?)`,
  ).run("board-1", "test-project", "Governance test", now, now);

  database.prepare(
    `INSERT INTO fs_tasks
     (board_id, id, title, description, priority, status, acceptance_criteria, revision, created_at, updated_at, recovery_pending)
     VALUES (?, ?, 'Task', '', 'p2', 'ready', '', 1, ?, ?, 0)`,
  ).run("board-1", "task-1", now, now);

  database.prepare(
    `INSERT INTO fs_attempts
     (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at)
     VALUES (?, 'board-1', 'task-1', 1, 'attempt-actor', ?, 'active', ?, ?)`,
  ).run(attemptId, tokenHash, now, now + 1_000_000);

  const insertGate = database.prepare(
    `INSERT INTO fs_gates (board_id, id, name, required_for_json, allowed_actors_json, created_at, updated_at)
       VALUES (?, ?, ?, '["ready"]', '["reviewer"]', ?, ?)`,
  );

  for (let index = 1; index <= 5; index += 1) {
    insertGate.run("board-1", `gate-${index}`, `Gate ${index}`, now, now);
  }

  return attemptId;
}

function writeAuditEvent(database: Database.Database, input: Omit<InsertAuditEventInput, "payload_json" | "created_at"> & { payload?: unknown; created_at?: number }): void {
  insertAuditEvent(database, {
    ...input,
    payload_json: input.payload ?? {},
    created_at: input.created_at ?? 1_700_000_000,
  });
}

function writeIdempotencyRecord(
  database: Database.Database,
  input: Omit<InsertIdempotencyRecordInput, "key_hash"> & { key_hash?: string },
): void {
  const canonicalKeyHash = canonicalHash(input.idempotency_key);
  insertGovernanceIdempotencyRecord(database, {
    ...input,
    key_hash: input.key_hash ?? canonicalKeyHash,
  });
}

    describe("forge-spec v2 schema-governance", () => {
  it("creates strict governance tables and bootstraps core meta 2.0", () => {
    const database = openMemoryStore();
    try {
      for (const tableName of SCHEMA_GOVERNANCE_TABLES) {
        expect(tableExists(database, tableName)).toBe(true);
        expect(tableSql(database, tableName).toUpperCase()).toContain("STRICT");
      }

      expect(tableExists(database, "fs_boards")).toBe(true);
      expect(tableExists(database, "fs_tasks")).toBe(true);

      expect(database.prepare("SELECT schema_version FROM fs_schema_meta WHERE key = 'core'").get()?.schema_version).toBe("2.0.0");

      const expectedCount = SCHEMA_CORE_TABLES.length + SCHEMA_GOVERNANCE_TABLES.length;
      const actualCount = database
        .prepare(
          "SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND (name LIKE 'fs_%' OR name LIKE 'v2_schema_%')",
        )
        .get().count;
      expect(actualCount).toBe(expectedCount);

      const leaseSql = tableSql(database, "v2_schema_leases");
      expect(leaseSql).toContain("attempt_id TEXT NOT NULL REFERENCES fs_attempts(id) ON DELETE RESTRICT");

      const idempotencySql = tableSql(database, "v2_schema_idempotency");
      expect(idempotencySql).not.toContain("idempotency_key");
      expect(idempotencySql).toContain("key_hash TEXT NOT NULL");
      expect(idempotencySql).toContain("UNIQUE (actor, tool, key_hash)");
      expect(idempotencySql).not.toContain("UNIQUE (actor, tool, request_digest)");

      const idempotencyColumns = database
        .prepare("PRAGMA table_info(v2_schema_idempotency)")
        .all()
        .map((row) => row.name);
      expect(idempotencyColumns).not.toContain("idempotency_key");

      const auditSql = tableSql(database, "v2_schema_audit_events");
      expect(auditSql).toContain("prev_hash");
      expect(auditSql).toContain("event_hash");

      const approvalSql = tableSql(database, "v2_schema_approvals");
      expect(approvalSql).toContain("attempt_id TEXT NOT NULL REFERENCES fs_attempts(id) ON DELETE RESTRICT");
      expect(approvalSql).toContain("status TEXT NOT NULL CHECK (status IN ('allow', 'deny'))");
      expect(approvalSql).toContain("decision TEXT NOT NULL CHECK (decision IN ('allow', 'deny'))");
      expect(approvalSql).toContain("substr(provenance_ref_digest, 1, 7) = 'sha256:'");

      const evidenceSql = tableSql(database, "v2_schema_evidence");
      expect(evidenceSql).toContain("length(digest) = 71");

    } finally {
      database.close();
    }
  });

  it("enforces governance constraints and adversarial immutability guarantees", () => {
    const database = openMemoryStore();
    const attemptId = createScopedAttempt(database);
    const now = 1_700_000_000;
    const hash64 = "a".repeat(64);

    const insertLease = database.prepare(
      `INSERT INTO v2_schema_leases
       (lease_id, attempt_id, holder, path_pattern, token_hash, state, revision, issued_at, expires_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertAuthority = database.prepare(
      `INSERT INTO v2_schema_authority
       (authority_id, parent_authority_id, resource_kind, resource_id, actor, grantee_actor, operation, granted_by_actor, lineage_kind, status, token_hash, revision, granted_at, expires_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertApproval = database.prepare(
      `INSERT INTO v2_schema_approvals
       (approval_id, attempt_id, task_id, gate_id, actor, status, decision, decided_at, revision,
        provenance_asserted_actor, provenance_boundary, provenance_mode, provenance_ref_provider, provenance_ref_kind, provenance_ref_external_id, provenance_ref_digest)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertAudit = database.prepare(
      `INSERT INTO v2_schema_audit_events
       (event_id, task_id, attempt_id, actor, tool, event_type, resource_type, resource_id, event_ordinal, prev_hash, event_hash, payload_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertEvidence = database.prepare(
      `INSERT INTO v2_schema_evidence
       (evidence_id, resource_type, resource_id, provider, kind, external_id, digest, actor, recorded_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    const insertIdempotency = database.prepare(
      `INSERT INTO v2_schema_idempotency
       (actor, tool, scope, key_hash, request_digest, response_json, result_code, resulting_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );

    try {
      expect(() => insertLease.run("lease-1", attemptId, "agent", "src/v2/storage/schema-governance.ts", hash64, "active", 1, now, now + 1_000, now)).not.toThrow();

      expect(() =>
        insertLease.run(
          "lease-phantom",
          "attempt-missing",
          "agent",
          "src/v2/storage/schema-governance.ts",
          hash64,
          "active",
          1,
          now,
          now + 1_000,
          now,
        ),
      ).toThrow();

      expect(() => {
        insertAuthority.run(
          "parent-root",
          null,
          "board",
          "board-1",
          "actor-a",
          "actor-b",
          "read_board",
          "actor-a",
          "owner_root",
          "active",
          hash64,
          1,
          now,
          now + 1_000,
        );
        insertAuthority.run(
          "child-good",
          "parent-root",
          "board",
          "board-1",
          "actor-a",
          "actor-c",
          "read_board",
          "actor-b",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 500,
        );
      }).not.toThrow();

      expect(() => {
        insertAuthority.run(
          "child-expanded",
          "parent-root",
          "board",
          "board-1",
          "actor-a",
          "actor-d",
          "read_board",
          "actor-b",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 1_500,
        );
      }).toThrow();

      expect(() => {
        database
          .prepare(
            `INSERT INTO v2_schema_authority_revocations
             (revocation_id, authority_id, actor, reason, revoked_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run("revoke-parent", "parent-root", "actor-a", "revoke parent", now);
        insertAuthority.run(
          "child-revoked",
          "parent-root",
          "board",
          "board-1",
          "actor-a",
          "actor-e",
          "read_board",
          "actor-b",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 500,
        );
      }).toThrow();

      expect(() => {
        insertAuthority.run(
          "parent-expired",
          null,
          "board",
          "board-1",
          "actor-a",
          "actor-f",
          "read_board",
          "actor-a",
          "owner_root",
          "expired",
          hash64,
          1,
          now,
          now + 1_000,
        );
        insertAuthority.run(
          "child-expired-parent",
          "parent-expired",
          "board",
          "board-1",
          "actor-a",
          "actor-g",
          "read_board",
          "actor-f",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 500,
        );
      }).toThrow();

      expect(() => {
        insertAuthority.run(
          "parent-early-expiry",
          null,
          "board",
          "board-2",
          "actor-a",
          "actor-h",
          "read_board",
          "actor-a",
          "owner_root",
          "active",
          hash64,
          1,
          now,
          now + 50,
        );
        insertAuthority.run(
          "child-granted-too-late",
          "parent-early-expiry",
          "board",
          "board-2",
          "actor-a",
          "actor-i",
          "read_board",
          "actor-h",
          "delegated",
          "active",
          hash64,
          1,
          now + 100,
          now + 40,
        );
      }).toThrow();

      expect(() => {
        insertAuthority.run(
          "parent-early-expiry-2",
          null,
          "board",
          "board-3",
          "actor-a",
          "actor-h2",
          "read_board",
          "actor-a",
          "owner_root",
          "active",
          hash64,
          1,
          now,
          now + 500,
        );
        insertAuthority.run(
          "child-2",
          "parent-early-expiry-2",
          "board",
          "board-3",
          "actor-a",
          "actor-j",
          "read_board",
          "actor-h2",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 100,
        );
        database
          .prepare(
            `INSERT INTO v2_schema_authority_revocations
             (revocation_id, authority_id, actor, reason, revoked_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run("revoke-root-ancestor", "parent-early-expiry-2", "actor-a", "revoke ancestor", now);
        insertAuthority.run(
          "child-3",
          "child-2",
          "board",
          "board-3",
          "actor-a",
          "actor-k",
          "read_board",
          "actor-j",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 50,
        );
      }).toThrow();

      expect(() => {
        insertAuthority.run(
          "parent-chain-2",
          null,
          "board",
          "board-4",
          "actor-a",
          "actor-l",
          "read_board",
          "actor-a",
          "owner_root",
          "active",
          hash64,
          1,
          now,
          now + 150,
        );
        insertAuthority.run(
          "child-chain-2",
          "parent-chain-2",
          "board",
          "board-4",
          "actor-a",
          "actor-m",
          "read_board",
          "actor-l",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 100,
        );
        insertAuthority.run(
          "grandchild-chain-2",
          "child-chain-2",
          "board",
          "board-4",
          "actor-a",
          "actor-n",
          "read_board",
          "actor-m",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 50,
        );
        insertAuthority.run(
          "grandgrandchild-chain-2",
          "grandchild-chain-2",
          "board",
          "board-4",
          "actor-a",
          "actor-o",
          "read_board",
          "actor-n",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 20,
        );
        database
          .prepare(
            `INSERT INTO v2_schema_authority_revocations
             (revocation_id, authority_id, actor, reason, revoked_at)
             VALUES (?, ?, ?, ?, ?)`,
          )
          .run("revoke-child-chain-2", "child-chain-2", "actor-a", "revoke child", now);
        insertAuthority.run(
          "grandgrandchild-chain-2-fail",
          "grandchild-chain-2",
          "board",
          "board-4",
          "actor-a",
          "actor-p",
          "read_board",
          "actor-n",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 10,
        );
      }).toThrow();

      expect(() =>
        insertAuthority.run(
          "auth-orphan",
          "missing-parent",
          "board",
          "board-1",
          "actor-a",
          "actor-z",
          "read_board",
          "actor-b",
          "delegated",
          "active",
          hash64,
          1,
          now,
          now + 1_000,
        ),
      ).toThrow();

      expect(() =>
        insertApproval.run(
          "approval-1",
          attemptId,
          "task-1",
          "gate-1",
          "reviewer",
          "allow",
          "allow",
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-1",
          `sha256:${hash64}`,
        ),
      ).not.toThrow();

      expect(() =>
        insertApproval.run(
          "approval-1b",
          attemptId,
          "task-1",
          "gate-1",
          "reviewer",
          "allow",
          "allow",
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-1b",
          `sha256:${hash64}`,
        ),
      ).toThrow();

      expect(() =>
        insertApproval.run(
          "approval-bad-actor",
          attemptId,
          "task-1",
          "gate-1",
          "intruder",
          "allow",
          "allow",
          now,
          1,
          "intruder",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-bad-actor",
          `sha256:${hash64}`,
        ),
      ).toThrow();

      expect(() =>
        insertApproval.run(
          "approval-bad-gate",
          attemptId,
          "task-1",
          "gate-missing",
          "reviewer",
          "allow",
          "allow",
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-bad-gate",
          `sha256:${hash64}`,
        ),
      ).toThrow();

      expect(() =>
        insertApproval.run(
          "approval-bad-task",
          attemptId,
          "task-2",
          "gate-1",
          "reviewer",
          "allow",
          "allow",
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-bad-task",
          `sha256:${hash64}`,
        ),
      ).toThrow();

      expect(() => {
        insertApproval.run(
          "approval-2",
          attemptId,
          "task-1",
          "gate-2",
          "reviewer",
          "deny",
          "allow",
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-2",
          `sha256:${hash64}`,
        );
      }).toThrow();

      expect(() =>
        insertApproval.run(
          "approval-3",
          attemptId,
          "task-1",
          "gate-1",
          "reviewer",
          "allow",
          "allow",
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-3",
          `sha256:${hash64}`,
        ),
      ).toThrow();

      expect(() => {
        insertApproval.run(
          "approval-null",
          attemptId,
          "task-1",
          "gate-4",
          "reviewer",
          "allow",
          null as unknown as string,
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-4",
          `sha256:${hash64}`,
        );
      }).toThrow();

      expect(() =>
        insertApproval.run(
          "approval-pending",
          attemptId,
          "task-1",
          "gate-5",
          "reviewer",
          "pending" as "allow",
          "deny",
          now,
          1,
          "reviewer",
          "local-trusted-client",
          "direct-v1",
          "forgespec",
          "approval",
          "ref-5",
          `sha256:${hash64}`,
        ),
      ).toThrow();

      expect(() => {
        database
          .prepare("UPDATE v2_schema_approvals SET status = 'allow', decision = 'allow' WHERE approval_id = 'approval-1'")
          .run();
      }).toThrow();

      expect(() => {
        database.prepare("DELETE FROM v2_schema_approvals WHERE approval_id = ?").run("approval-1");
      }).toThrow();

      const firstHash = canonicalAuditEventDigest({
        task_id: "task-2",
        attempt_id: attemptId,
        actor: "actor",
        tool: "insert",
        event_type: "created",
        resource_type: "task",
        resource_id: "task-2",
        event_ordinal: 1,
        prev_hash: null,
        payload_json: { nested: { safe: true } },
      });
      const secondHash = canonicalAuditEventDigest({
        task_id: "task-2",
        attempt_id: attemptId,
        actor: "actor",
        tool: "insert",
        event_type: "updated",
        resource_type: "task",
        resource_id: "task-2",
        event_ordinal: 2,
        prev_hash: firstHash,
        payload_json: { safe: true },
      });
      const sqlAuditHash = canonicalAuditEventDigest({
        task_id: "task-3",
        attempt_id: attemptId,
        actor: "actor",
        tool: "insert",
        event_type: "created",
        resource_type: "task",
        resource_id: "task-3",
        event_ordinal: 1,
        prev_hash: null,
        payload_json: { safe: true },
      });
      const task4FirstHash = canonicalAuditEventDigest({
        task_id: "task-3",
        attempt_id: attemptId,
        actor: "actor",
        tool: "insert",
        event_type: "updated",
        resource_type: "task",
        resource_id: "task-4",
        event_ordinal: 1,
        prev_hash: null,
        payload_json: { safe: true },
      });
      const task5FirstHash = canonicalAuditEventDigest({
        task_id: "task-5",
        attempt_id: attemptId,
        actor: "actor",
        tool: "insert",
        event_type: "created",
        resource_type: "task",
        resource_id: "task-5",
        event_ordinal: 1,
        prev_hash: null,
        payload_json: { safe: true },
      });

      expect(() =>
        writeAuditEvent(database, {
          event_id: "event-2",
          task_id: "task-2",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "created",
          resource_type: "task",
          resource_id: "task-2",
          event_ordinal: 2,
          prev_hash: null,
          event_hash: firstHash,
        }),
      ).toThrow();

      expect(() =>
        writeAuditEvent(database, {
          event_id: "event-1",
          task_id: "task-2",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "created",
          resource_type: "task",
          resource_id: "task-2",
          event_ordinal: 1,
          prev_hash: "deadbeef" + "a".repeat(56),
          event_hash: firstHash,
        }),
      ).toThrow();

      expect(() =>
        writeAuditEvent(database, {
          event_id: "event-1",
          task_id: "task-2",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "created",
          resource_type: "task",
          resource_id: "task-2",
          event_ordinal: 1,
          prev_hash: null,
          event_hash: firstHash,
          payload: { nested: { safe: true } },
        }),
      ).not.toThrow();

      expect(() =>
        writeAuditEvent(database, {
          event_id: "event-3",
          task_id: "task-2",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "updated",
          resource_type: "task",
          resource_id: "task-2",
          event_ordinal: 2,
          prev_hash: "bad".repeat(16),
          event_hash: secondHash,
          payload: { safe: true },
        }),
      ).toThrow();

      expect(() =>
        writeAuditEvent(database, {
          event_id: "event-3",
          task_id: "task-2",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "updated",
          resource_type: "task",
          resource_id: "task-2",
          event_ordinal: 2,
          prev_hash: firstHash,
          event_hash: secondHash,
          payload: { safe: true },
        }),
      ).not.toThrow();

      expect(() => {
        writeAuditEvent(database, {
          event_id: "event-sensitive",
          task_id: "task-2",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "updated",
          resource_type: "task",
          resource_id: "task-2",
          event_ordinal: 3,
          prev_hash: secondHash,
           event_hash: canonicalHash("audit-chain-3"),
          payload: { nested: { tOkEn: "x" } },
        });
      }).toThrow();

      expect(() => assertAuditPayloadSafe({ profile: { api_key: "top-secret" } })).toThrow();
      expect(() => assertAuditPayloadSafe({ meta: { Nested: { SeCrEt: 1 } } })).toThrow();
      expect(() => assertAuditPayloadSafe({ safe: "ok" })).not.toThrow();

      expect(() =>
        writeAuditEvent(database, {
          event_id: "event-from-sql",
          task_id: "task-3",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "created",
          resource_type: "task",
          resource_id: "task-3",
          event_ordinal: 1,
          prev_hash: null,
           event_hash: sqlAuditHash,
          payload: { safe: true },
        }),
      ).not.toThrow();

      expect(() =>
        insertAudit.run(
          "event-sql-bad",
          "task-5",
          attemptId,
          "actor",
          "insert",
          "created",
          "task",
          "task-5",
          1,
          null,
          canonicalHash("sql-audit-bad"),
          JSON.stringify({ safe: true }),
          now,
        ),
      ).toThrow();

      expect(() =>
        insertAudit.run(
          "event-sql-good",
          "task-5",
          attemptId,
          "actor",
          "insert",
          "created",
          "task",
          "task-5",
          1,
          null,
          task5FirstHash,
          JSON.stringify({ safe: true }),
          now,
        ),
      ).not.toThrow();

      expect(() => {
        insertAuditEvent(database, {
          event_id: "event-direct-secret",
          task_id: "task-3",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "created",
          resource_type: "task",
          resource_id: "task-3",
          event_ordinal: 2,
           prev_hash: sqlAuditHash,
           event_hash: canonicalHash("sql-audit-bad"),
          payload_json: { secret: "blocked" },
          created_at: now,
        });
      }).toThrow();

      expect(() =>
        writeAuditEvent(database, {
          event_id: "event-dup",
          task_id: "task-3",
          attempt_id: attemptId,
          actor: "actor",
          tool: "insert",
          event_type: "updated",
          resource_type: "task",
          resource_id: "task-3",
          event_ordinal: 3,
           prev_hash: sqlAuditHash,
           event_hash: canonicalHash("sql-audit-bad"),
          payload: { safe: true },
          created_at: now,
        }),
      ).toThrow();

        writeAuditEvent(database, {
        event_id: "event-delete",
        task_id: "task-3",
        attempt_id: attemptId,
        actor: "actor",
        tool: "insert",
        event_type: "updated",
        resource_type: "task",
        resource_id: "task-4",
        event_ordinal: 1,
        prev_hash: null,
         event_hash: task4FirstHash,
        payload: { safe: true },
        created_at: now,
      });
      expect(() => {
        database.prepare("UPDATE v2_schema_audit_events SET actor = 'x' WHERE event_id = 'event-delete'").run();
      }).toThrow();
      expect(() => {
        database.prepare("DELETE FROM v2_schema_audit_events WHERE event_id = 'event-delete'").run();
      }).toThrow();

      const key = "idem-1";
      const keyHash = canonicalHash(key);
      const requestDigest = canonicalHash("request");
      expect(() => insertIdempotency.run("agent", "insert", "scope", keyHash, requestDigest, "{}", "ok", 1, now)).not.toThrow();
      expect(() => insertIdempotency.run("agent", "insert", "scope", keyHash, requestDigest, "{}", "ok", 1, now + 1)).toThrow();

      expect(() =>
        writeIdempotencyRecord(database, {
          actor: "agent",
          tool: "insert",
          scope: "scope",
          idempotency_key: "idem-2",
          request_digest: requestDigest,
          response_json: "{}",
          result_code: "ok",
          resulting_revision: 1,
          created_at: now + 2,
        }),
      ).not.toThrow();

      expect(() =>
        writeIdempotencyRecord(database, {
          actor: "agent",
          tool: "insert",
          scope: "scope",
          idempotency_key: "idem-2",
          key_hash: canonicalHash("different-hash-for-key"),
          request_digest: requestDigest,
          response_json: "{}",
          result_code: "ok",
          resulting_revision: 1,
          created_at: now + 3,
        }),
      ).toThrow();

      expect(() =>
        writeIdempotencyRecord(database, {
          actor: "agent",
          tool: "insert",
          scope: "scope",
          idempotency_key: "idem-3",
          request_digest: requestDigest,
          response_json: "{}",
          result_code: "ok",
          resulting_revision: 1,
          created_at: now + 4,
        }),
      ).not.toThrow();

      expect(() =>
        insertIdempotency.run(
          "agent",
          "insert",
          "scope",
          "sha256:zz" + "0".repeat(62),
          requestDigest,
          "{}",
          "ok",
          1,
          now + 2,
        ),
      ).toThrow();

      expect(() =>
        insertEvidence.run(
          "evidence-ok",
          "task",
          "task-1",
          "forgespec",
          "task-result",
          "run-1",
          `sha256:${hash64}`,
          "actor",
          now,
        ),
      ).not.toThrow();

      expect(() =>
        insertEvidence.run(
          "evidence-bad",
          "task",
          "task-1",
          "forgespec",
          "task-result",
          "run-2",
          hash64,
          "actor",
          now,
        ),
      ).toThrow();

      expect(() => {
        insertLease.run("lease-2", attemptId, "agent", "src/v2/storage/schema-governance.ts", hash64, "active", 1, now + 1, now + 2_000, now + 1);
      }).not.toThrow();

      expect(() =>
        database.prepare("UPDATE v2_schema_idempotency SET result_code = 'error' WHERE id = 1").run(),
      ).toThrow();
    } finally {
      database.close();
    }
  });
});
