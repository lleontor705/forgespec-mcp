import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  migrateDatabase,
  restoreDatabaseBackup,
} from "../src/database/migrations.js";
import {
  DIRECT_AUTHORITY_LINEAGE_SCHEMA_SQL,
  DIRECT_AUTHORITY_PERSISTENCE_SCHEMA_SQL,
  DIRECT_TASK_HISTORY_SCHEMA_SQL,
} from "../src/database/schema.js";
import {
  createV2Database,
  removeTestDatabases,
  seedDirectBoard,
  seedDirectTask,
  seedTaskCreatedEvent,
} from "./helpers/database.js";

const fixturePath = path.resolve("tests/fixtures/forgespec-1.2.2.db");
const temporaryDirectories: string[] = [];

function copyFixture(): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-migration-"));
  temporaryDirectories.push(directory);
  const databasePath = path.join(directory, "forgespec.db");
  fs.copyFileSync(fixturePath, databasePath);
  return databasePath;
}

function open(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  return database;
}

function advanceToSchemaV4(database: Database.Database): void {
  database.exec("PRAGMA foreign_keys = OFF");
  for (const table of [...authorityTables].reverse()) database.exec(`DROP TABLE IF EXISTS ${table}`);
  database.prepare("DELETE FROM schema_migrations WHERE version >= 3").run();
  database.exec(DIRECT_TASK_HISTORY_SCHEMA_SQL);
  database.exec(DIRECT_AUTHORITY_PERSISTENCE_SCHEMA_SQL);
  const insert = database.prepare(
    "INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)"
  );
  insert.run(3, "direct-v1-p1-task-history", digestSql(DIRECT_TASK_HISTORY_SCHEMA_SQL), 3000);
  insert.run(4, "direct-v1-additive-authority-persistence", digestSql(DIRECT_AUTHORITY_PERSISTENCE_SCHEMA_SQL), 4000);
  database.pragma("user_version = 4");
  database.exec("PRAGMA foreign_keys = ON");
}

function digestSql(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

function advanceToSchemaV5(database: Database.Database): void {
  advanceToSchemaV4(database);
  database.exec(DIRECT_AUTHORITY_LINEAGE_SCHEMA_SQL);
  database
    .prepare("INSERT INTO schema_migrations (version, name, checksum, applied_at_ms) VALUES (?, ?, ?, ?)")
    .run(5, "direct-v1-grant-ancestry-storage-hardening", digestSql(DIRECT_AUTHORITY_LINEAGE_SCHEMA_SQL), 5000);
  database.pragma("user_version = 5");
}

const authorityTables = [
  "task_approval_provenance",
  "task_authority_grants",
  "task_authority_handoff_refs",
  "task_authority_handoffs",
  "task_authority_idempotency",
  "task_authority_revocations",
] as const;

function seedAuthorityRows(database: Database.Database): void {
  seedDirectBoard(database, "board-authority", 8);
  seedDirectTask(database, "task-authority", "board-authority", 1);
  for (const [ordinal, eventId] of ["event-handoff", "event-grant", "event-revoke", "event-approval"].entries()) {
    database
      .prepare(
        `INSERT INTO authority_events
           (event_id, resource_type, resource_id, board_id, board_revision, resource_revision,
            event_ordinal, event_type, actor, outcome, details_json, created_at_ms)
         VALUES (?, 'board', 'board-authority', 'board-authority', ?, 1, 0, ?, 'alice', 'success', '{}', ?)`
      )
      .run(eventId, ordinal + 1, eventId.replace("event-", "authority_"), 2000 + ordinal);
  }
  database
    .prepare(
      `INSERT INTO task_authority_handoffs
         (handoff_id, board_id, from_actor, to_actor, resource_kind, resource_id,
          expires_at_ms, created_at_ms, created_event_id)
       VALUES ('handoff-1', 'board-authority', 'alice', 'bob', 'task', 'task-authority',
               9000, 2000, 'event-handoff')`
    )
    .run();
  database
    .prepare(
      `INSERT INTO task_authority_handoff_refs
         (handoff_id, ordinal, provider, kind, external_id, digest)
       VALUES ('handoff-1', 0, 'forgespec', 'task', 'task-authority', ?)`
    )
    .run(`sha256:${"1".repeat(64)}`);
  database
    .prepare(
      `INSERT INTO task_authority_grants
         (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation,
          granted_by_actor, expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id)
       VALUES ('grant-1', 'board-authority', 'task', 'task-authority', 'bob', 'update',
               'alice', 9000, 'handoff', 'handoff-1', 2001, 'event-grant')`
    )
    .run();
  database
    .prepare(
      `INSERT INTO task_authority_revocations
         (revoke_id, grant_id, board_id, revoked_by_actor, reason, created_at_ms, created_event_id)
       VALUES ('revoke-1', 'grant-1', 'board-authority', 'alice', 'complete', 2002, 'event-revoke')`
    )
    .run();
  database
    .prepare(
      `INSERT INTO task_authority_idempotency
         (command_kind, board_id, idempotency_key, request_hash, result_kind, result_id,
          canonical_response_json, created_at_ms)
       VALUES ('handoff', 'board-authority', 'key-1', ?, 'handoff', 'handoff-1', '{"ok":true}', 2000)`
    )
    .run(`sha256:${"2".repeat(64)}`);
  database
    .prepare(
      `INSERT INTO task_approval_provenance
         (board_id, task_id, gate_id, decision_event_id, asserted_actor, boundary, mode,
          ref_provider, ref_kind, ref_external_id, ref_digest, created_at_ms)
       VALUES ('board-authority', 'task-authority', 'apply-approved', 'event-approval', 'alice',
               'local-trusted-client', 'direct-v1', 'forgespec', 'approval', 'approval-1', ?, 2003)`
    )
    .run(`sha256:${"3".repeat(64)}`);
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  removeTestDatabases();
});

describe("schema v6 delegated grant identity hardening", () => {
  it("migrates schema 5 additively without changing the applied schema-5 migration", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-v6-");
    advanceToSchemaV5(database);
    seedAuthorityRows(database);
    const schema5 = database.prepare("SELECT name, checksum FROM schema_migrations WHERE version = 5").get();
    database.close();

    expect(migrateDatabase(databasePath)).toMatchObject({ fromVersion: 5, toVersion: 6, appliedVersions: [6] });
    const migrated = open(databasePath);
    try {
      expect(migrated.prepare("SELECT name, checksum FROM schema_migrations WHERE version = 5").get()).toEqual(schema5);
      expect(migrated.pragma("user_version", { simple: true })).toBe(6);
    } finally {
      migrated.close();
    }

    expect(migrateDatabase(databasePath)).toMatchObject({ fromVersion: 6, toVersion: 6, appliedVersions: [] });
  });

  it("atomically rejects SQL operation and grantor mismatches without durable side effects", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-v6-negative-");
    database.close();
    migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      seedAuthorityRows(migrated);
      const before = {
        grants: migrated.prepare("SELECT COUNT(*) AS count FROM task_authority_grants").get(),
        events: migrated.prepare("SELECT COUNT(*) AS count FROM authority_events").get(),
        idempotency: migrated.prepare("SELECT COUNT(*) AS count FROM task_authority_idempotency").get(),
      };
      const insert = migrated.transaction(
        (grantId: string, operation: string, grantedByActor: string, eventId: string, keyHash: string) => {
          migrated
            .prepare(
              `INSERT INTO authority_events
                 (event_id, resource_type, resource_id, board_id, board_revision, resource_revision,
                  event_ordinal, event_type, actor, outcome, details_json, created_at_ms)
               VALUES (?, 'board', 'board-authority', 'board-authority', 9, 1, 0,
                       'authority_grant_created', ?, 'success', '{}', 3000)`
            )
            .run(eventId, grantedByActor);
          migrated
            .prepare(
              `INSERT INTO task_authority_grants
                 (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation, granted_by_actor,
                  expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id,
                  parent_grant_id, lineage_kind)
               VALUES (?, 'board-authority', 'task', 'task-authority', 'carol', ?, ?,
                       8000, 'grant', NULL, 3000, ?, 'grant-1', 'delegated')`
            )
            .run(grantId, operation, grantedByActor, eventId);
          migrated
            .prepare(
              `INSERT INTO task_authority_idempotency
                 (command_kind, board_id, idempotency_key, idempotency_key_hash, request_hash,
                  result_kind, result_id, canonical_response_json, created_at_ms)
               VALUES ('grant', 'board-authority', ?, ?, ?, 'grant', ?, '{}', 3000)`
            )
            .run(keyHash, keyHash, `sha256:${"9".repeat(64)}`, grantId);
        }
      );

      expect(() =>
        insert("grant-operation-mismatch", "read_task", "bob", "event-operation-mismatch", `sha256:${"7".repeat(64)}`)
      ).toThrow(/invalid parent grant lineage/);
      expect(() =>
        insert("grant-grantor-mismatch", "update", "mallory", "event-grantor-mismatch", `sha256:${"8".repeat(64)}`)
      ).toThrow(/invalid parent grant lineage/);
      expect({
        grants: migrated.prepare("SELECT COUNT(*) AS count FROM task_authority_grants").get(),
        events: migrated.prepare("SELECT COUNT(*) AS count FROM authority_events").get(),
        idempotency: migrated.prepare("SELECT COUNT(*) AS count FROM task_authority_idempotency").get(),
      }).toEqual(before);

      insert("grant-valid-chain", "update", "bob", "event-valid-chain", `sha256:${"a".repeat(64)}`);
      expect(migrated.prepare("SELECT operation, granted_by_actor FROM task_authority_grants WHERE grant_id = ?").get(
        "grant-valid-chain"
      )).toEqual({ operation: "update", granted_by_actor: "bob" });
    } finally {
      migrated.close();
    }
  });

  it("keeps delegated identity constraints active after restart and repeated initialization", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-v6-restart-");
    database.close();
    migrateDatabase(databasePath);
    const seeded = open(databasePath);
    seedAuthorityRows(seeded);
    seeded.close();

    expect(migrateDatabase(databasePath)).toMatchObject({ fromVersion: 6, toVersion: 6, appliedVersions: [] });
    const restarted = open(databasePath);
    try {
      expect(() =>
        restarted
          .prepare(
            `INSERT INTO task_authority_grants
               (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation, granted_by_actor,
                expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id,
                parent_grant_id, lineage_kind)
             VALUES ('grant-restart-mismatch', 'board-authority', 'task', 'task-authority', 'carol',
                     'read_task', 'bob', 8000, 'grant', NULL, 3000, 'event-approval', 'grant-1', 'delegated')`
          )
          .run()
      ).toThrow(/invalid parent grant lineage/);
    } finally {
      restarted.close();
    }
  });
});

describe("schema v5 grant ancestry and storage hardening", () => {
  it("migrates schema 4 additively without changing the applied schema-4 migration", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-v5-");
    advanceToSchemaV4(database);
    seedAuthorityRows(database);
    const schema4 = database
      .prepare("SELECT name, checksum FROM schema_migrations WHERE version = 4")
      .get();
    database.close();

    expect(migrateDatabase(databasePath)).toMatchObject({ fromVersion: 4, toVersion: 6, appliedVersions: [5, 6] });
    const migrated = open(databasePath);
    try {
      expect(migrated.prepare("SELECT name, checksum FROM schema_migrations WHERE version = 4").get()).toEqual(schema4);
      expect(migrated.pragma("user_version", { simple: true })).toBe(6);
      expect(
        migrated.prepare("SELECT name FROM pragma_table_info('task_authority_grants') WHERE name = 'parent_grant_id'").get()
      ).toEqual({ name: "parent_grant_id" });
      expect(
        migrated.prepare("SELECT name FROM pragma_table_info('task_authority_idempotency') WHERE name = 'idempotency_key_hash'").get()
      ).toEqual({ name: "idempotency_key_hash" });
      expect(migrated.prepare("SELECT parent_grant_id FROM task_authority_grants WHERE grant_id = 'grant-1'").get()).toEqual({
        parent_grant_id: null,
      });
      expect(migrated.prepare("SELECT lineage_kind FROM task_authority_grants WHERE grant_id = 'grant-1'").get()).toEqual({
        lineage_kind: "legacy_unknown",
      });
      expect(migrated.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = ?").get(
        "idx_task_authority_grants_parent"
      )).toEqual({ name: "idx_task_authority_grants_parent" });
    } finally {
      migrated.close();
    }

    expect(migrateDatabase(databasePath)).toMatchObject({ fromVersion: 6, toVersion: 6, appliedVersions: [] });
  });

  it("enforces parent grant foreign keys, resource ancestry, canonical digests, and hashed idempotency storage", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-v5-constraints-");
    database.close();
    migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      seedAuthorityRows(migrated);
      migrated
        .prepare(
          `INSERT INTO task_authority_grants
             (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation, granted_by_actor,
              expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id, parent_grant_id, lineage_kind)
           VALUES ('grant-child', 'board-authority', 'task', 'task-authority', 'carol', 'update', 'bob',
                   8000, 'grant', NULL, 2002, 'event-approval', 'grant-1', 'delegated')`
        )
        .run();
      expect(migrated.prepare("SELECT parent_grant_id FROM task_authority_grants WHERE grant_id = 'grant-child'").get()).toEqual({
        parent_grant_id: "grant-1",
      });
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO task_authority_grants
               (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation, granted_by_actor,
                expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id, parent_grant_id, lineage_kind)
             VALUES ('grant-missing', 'board-authority', 'task', 'task-authority', 'dave', 'update', 'bob',
                     8000, 'grant', NULL, 2002, 'event-handoff', 'grant-absent', 'delegated')`
          )
          .run()
      ).toThrow();

      const malformedDigest = `sha256:${"a".repeat(63)}z`;
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO task_authority_handoff_refs
               (handoff_id, ordinal, provider, kind, external_id, digest)
             VALUES ('handoff-1', 1, 'forgespec', 'task', 'bad-ref', ?)`
          )
          .run(malformedDigest)
      ).toThrow(/canonical sha256 digest/);
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM task_authority_handoff_refs").get()).toEqual({ count: 1 });

      const keyHash = `sha256:${"4".repeat(64)}`;
      migrated
        .prepare(
          `INSERT INTO task_authority_idempotency
             (command_kind, board_id, idempotency_key, idempotency_key_hash, request_hash,
              result_kind, result_id, canonical_response_json, created_at_ms)
           VALUES ('grant', 'board-authority', ?, ?, ?, 'grant', 'grant-child', '{}', 2004)`
        )
        .run(keyHash, keyHash, `sha256:${"5".repeat(64)}`);
      expect(
        migrated.prepare("SELECT idempotency_key, idempotency_key_hash FROM task_authority_idempotency WHERE command_kind = 'grant'").get()
      ).toEqual({ idempotency_key: keyHash, idempotency_key_hash: keyHash });
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO task_authority_idempotency
               (command_kind, board_id, idempotency_key, idempotency_key_hash, request_hash,
                result_kind, result_id, canonical_response_json, created_at_ms)
             VALUES ('revoke', 'board-authority', 'raw-secret-key', ?, ?, 'revoke', 'revoke-2', '{}', 2005)`
          )
          .run(keyHash, `sha256:${"6".repeat(64)}`)
      ).toThrow(/idempotency key hash/);
    } finally {
      migrated.close();
    }
  });

  it("fails closed after restart when persisted parent lineage is corrupt", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-v5-corrupt-");
    database.close();
    migrateDatabase(databasePath);
    const damaged = open(databasePath);
    try {
      seedAuthorityRows(damaged);
      damaged
        .prepare(
          `INSERT INTO task_authority_grants
             (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation, granted_by_actor,
              expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id, parent_grant_id, lineage_kind)
           VALUES ('grant-child', 'board-authority', 'task', 'task-authority', 'carol', 'update', 'bob',
                   8000, 'grant', NULL, 2002, 'event-approval', 'grant-1', 'delegated')`
        )
        .run();
      damaged.exec("DROP TRIGGER immutable_task_authority_grants_update");
      damaged
        .prepare(
          "UPDATE task_authority_grants SET parent_grant_id = 'grant-child', lineage_kind = 'delegated' WHERE grant_id = 'grant-1'"
        )
        .run();
    } finally {
      damaged.close();
    }

    expect(() => migrateDatabase(databasePath)).toThrow(/AUTH_STATE_UNAVAILABLE.*grant lineage/);
  });
});

describe("schema v4 additive authority persistence", () => {
  it("applies the ordered migration with six strict tables, lookup indexes, foreign keys, and immutable triggers", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-schema-");
    database.close();

    const result = migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      expect(result.toVersion).toBe(6);
      expect(result.appliedVersions).toEqual([3, 4, 5, 6]);
      expect(migrated.pragma("user_version", { simple: true })).toBe(6);
      expect(
        migrated
          .prepare(
            `SELECT name FROM sqlite_master
              WHERE type = 'table'
                AND (name LIKE 'task_authority_%' OR name = 'task_approval_provenance')
              ORDER BY name`
          )
          .all()
      ).toEqual(authorityTables.map((name) => ({ name })));
      expect(
        migrated
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_task_authority_%' ORDER BY name")
          .all()
      ).toEqual([
        { name: "idx_task_authority_grants_effective" },
        { name: "idx_task_authority_grants_parent" },
        { name: "idx_task_authority_handoffs_resource" },
        { name: "idx_task_authority_idempotency_key_hash" },
        { name: "idx_task_authority_revocations_board" },
      ]);
      for (const table of authorityTables) {
        expect(migrated.prepare(`PRAGMA foreign_key_list(${table})`).all().length).toBeGreaterThan(0);
        const triggerCount = migrated
          .prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?")
          .get(table) as { count: number };
        expect(triggerCount.count).toBeGreaterThanOrEqual(2);
      }
    } finally {
      migrated.close();
    }
  });

  it("preserves authority provenance, references, expiry, revocation, idempotency response, and event order across restart", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-restart-");
    database.close();
    migrateDatabase(databasePath);
    const seeded = open(databasePath);
    seedAuthorityRows(seeded);
    seeded.close();

    expect(migrateDatabase(databasePath)).toMatchObject({ fromVersion: 6, toVersion: 6, appliedVersions: [] });
    const restarted = open(databasePath);
    try {
      expect(restarted.prepare("SELECT asserted_actor, boundary, mode, ref_external_id FROM task_approval_provenance").get()).toEqual({
        asserted_actor: "alice",
        boundary: "local-trusted-client",
        mode: "direct-v1",
        ref_external_id: "approval-1",
      });
      expect(restarted.prepare("SELECT expires_at_ms, origin_kind, origin_id FROM task_authority_grants").get()).toEqual({
        expires_at_ms: 9000,
        origin_kind: "handoff",
        origin_id: "handoff-1",
      });
      expect(restarted.prepare("SELECT provider, external_id FROM task_authority_handoff_refs").get()).toEqual({
        provider: "forgespec",
        external_id: "task-authority",
      });
      expect(restarted.prepare("SELECT revoke_id, reason FROM task_authority_revocations").get()).toEqual({
        revoke_id: "revoke-1",
        reason: "complete",
      });
      expect(restarted.prepare("SELECT canonical_response_json FROM task_authority_idempotency").get()).toEqual({
        canonical_response_json: '{"ok":true}',
      });
      expect(
        restarted
          .prepare("SELECT event_id FROM authority_events WHERE event_id LIKE 'event-%' ORDER BY board_revision, event_ordinal")
          .all()
      ).toEqual([
        { event_id: "event-handoff" },
        { event_id: "event-grant" },
        { event_id: "event-revoke" },
        { event_id: "event-approval" },
      ]);
    } finally {
      restarted.close();
    }
  });

  it("rejects update and delete for every additive authority table", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-immutable-");
    database.close();
    migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      seedAuthorityRows(migrated);
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO task_authority_revocations
               (revoke_id, grant_id, board_id, revoked_by_actor, created_at_ms, created_event_id)
             VALUES ('revoke-duplicate', 'grant-1', 'board-authority', 'alice', 2004, 'event-approval')`
          )
          .run()
      ).toThrow();
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO task_authority_idempotency
               (command_kind, board_id, idempotency_key, request_hash, result_kind, result_id,
                canonical_response_json, created_at_ms)
             SELECT command_kind, board_id, idempotency_key, request_hash, result_kind, result_id,
                    canonical_response_json, created_at_ms
               FROM task_authority_idempotency`
          )
          .run()
      ).toThrow();
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO task_approval_provenance
               (board_id, task_id, gate_id, decision_event_id, asserted_actor, boundary, mode,
                ref_provider, ref_kind, ref_external_id, ref_digest, created_at_ms)
             SELECT board_id, task_id, 'other-gate', decision_event_id, asserted_actor, boundary, mode,
                    ref_provider, ref_kind, ref_external_id, ref_digest, created_at_ms
               FROM task_approval_provenance`
          )
          .run()
      ).toThrow();
      for (const table of authorityTables) {
        expect(() => migrated.prepare(`UPDATE ${table} SET rowid = rowid`).run()).toThrow(/immutable/);
        expect(() => migrated.prepare(`DELETE FROM ${table}`).run()).toThrow(/immutable/);
      }
    } finally {
      migrated.close();
    }
  });

  it("fails closed at startup when a required durable authority table is unavailable", () => {
    const { path: databasePath, database } = createV2Database("forgespec-authority-missing-");
    database.close();
    migrateDatabase(databasePath);
    const damaged = open(databasePath);
    damaged.exec("DROP TABLE task_authority_revocations");
    damaged.close();

    expect(() => migrateDatabase(databasePath)).toThrow(/AUTH_STATE_UNAVAILABLE.*task_authority_revocations/);
  });
});

describe("schema v3 migration and historical task contract", () => {
  it("migrates v2 to schema v3 with append-only history and required indexes", () => {
    const { path: databasePath, database } = createV2Database();
    seedDirectBoard(database, "board-v3", 7);
    seedDirectTask(database, "task-v3", "board-v3", 1, { owner: "alice" });
    seedTaskCreatedEvent(database, "event-task-v3", "task-v3", "board-v3", 1);
    database.close();

    const result = migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      const columns = migrated
        .prepare("PRAGMA table_info(direct_task_versions)")
        .all() as Array<{ name: string; notnull: number }>;
      const indexes = migrated
        .prepare(
          "SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'idx_task_versions_%' ORDER BY name"
        )
        .all() as Array<{ name: string }>;

      expect(result.toVersion).toBe(6);
      expect(migrated.pragma("user_version", { simple: true })).toBe(6);
      expect(columns.map(({ name }) => name)).toEqual([
        "version_id",
        "board_id",
        "task_id",
        "board_revision",
        "task_revision",
        "status",
        "current_attempt_id",
        "blocked_reason",
        "metadata_json",
        "created_at_ms",
        "updated_at_ms",
        "is_deleted",
      ]);
      expect(indexes.map(({ name }) => name)).toEqual([
        "idx_task_versions_board_snapshot",
        "idx_task_versions_board_task_snapshot",
        "idx_task_versions_task_history",
      ]);
      expect(
        migrated.prepare("SELECT task_id, board_revision, metadata_json, is_deleted FROM direct_task_versions").all()
      ).toEqual([
        { task_id: "task-v3", board_revision: 1, metadata_json: '{"owner":"alice"}', is_deleted: 0 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("backfills empty, terminal, and logically deleted task rows without inventing history", () => {
    const { path: databasePath, database } = createV2Database();
    seedDirectBoard(database, "board-cases", 9);
    seedDirectTask(database, "task-active", "board-cases", 2, { kind: "active" }, "backlog");
    seedDirectTask(database, "task-terminal", "board-cases", 3, { kind: "terminal" }, "succeeded");
    seedDirectTask(database, "task-deleted", "board-cases", 4, { kind: "deleted", is_deleted: true }, "deleted");
    seedTaskCreatedEvent(database, "event-active", "task-active", "board-cases", 2);
    seedTaskCreatedEvent(database, "event-terminal", "task-terminal", "board-cases", 3);
    seedTaskCreatedEvent(database, "event-deleted", "task-deleted", "board-cases", 4);
    database.close();

    migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM direct_task_versions").get()).toEqual({ count: 3 });
      expect(
        migrated
          .prepare("SELECT task_id, status, metadata_json, is_deleted FROM direct_task_versions ORDER BY task_id")
          .all()
      ).toEqual([
        { task_id: "task-active", status: "backlog", metadata_json: '{"kind":"active"}', is_deleted: 0 },
        { task_id: "task-deleted", status: "deleted", metadata_json: '{"kind":"deleted","is_deleted":true}', is_deleted: 1 },
        { task_id: "task-terminal", status: "succeeded", metadata_json: '{"kind":"terminal"}', is_deleted: 0 },
      ]);
    } finally {
      migrated.close();
    }
  });

  it("rolls back the entire migration when task-created history collides or points into the future", () => {
    const { path: databasePath, database } = createV2Database();
    seedDirectBoard(database, "board-invalid", 4);
    seedDirectTask(database, "task-invalid", "board-invalid", 1);
    seedTaskCreatedEvent(database, "event-invalid-1", "task-invalid", "board-invalid", 2, 0);
    seedTaskCreatedEvent(database, "event-invalid-2", "task-invalid", "board-invalid", 2, 1);
    database.close();

    expect(() => migrateDatabase(databasePath)).toThrow();
    const unchanged = open(databasePath);
    try {
      expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'direct_task_versions'").get()).toBeUndefined();
      expect(unchanged.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 5 });
    } finally {
      unchanged.close();
    }
  });

  it("keeps one historical version per visible change and suppresses no-op/retry duplicates", () => {
    const { path: databasePath, database } = createV2Database();
    seedDirectBoard(database, "board-history", 2);
    seedDirectTask(database, "task-history", "board-history", 1, { value: "before" });
    seedTaskCreatedEvent(database, "event-history", "task-history", "board-history", 1);
    database.close();

    migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      expect(() =>
        migrated
          .prepare(
            `INSERT INTO direct_task_versions
               (board_id, task_id, board_revision, task_revision, status, metadata_json,
                created_at_ms, updated_at_ms, is_deleted)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
          )
          .run("board-history", "task-history", 1, 1, "backlog", '{"value":"before"}', 1000, 1000, 0)
      ).toThrow();
      expect(migrated.prepare("SELECT COUNT(*) AS count FROM direct_task_versions").get()).toEqual({ count: 1 });
    } finally {
      migrated.close();
    }
  });

  it("keeps committed history after restart and never prunes versions needed by old snapshots", () => {
    const { path: databasePath, database } = createV2Database();
    seedDirectBoard(database, "board-retention", 2);
    seedDirectTask(database, "task-retention", "board-retention", 1, { value: "before" });
    seedTaskCreatedEvent(database, "event-retention", "task-retention", "board-retention", 1);
    database.close();

    migrateDatabase(databasePath);
    const migrated = open(databasePath);
    try {
      migrated
        .prepare(
          `INSERT INTO direct_task_versions
             (board_id, task_id, board_revision, task_revision, status, metadata_json,
              created_at_ms, updated_at_ms, is_deleted)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run("board-retention", "task-retention", 2, 2, "ready", '{"value":"after"}', 2000, 2000, 0);
    } finally {
      migrated.close();
    }

    migrateDatabase(databasePath);
    const restarted = open(databasePath);
    try {
      expect(restarted.prepare("SELECT COUNT(*) AS count FROM direct_task_versions").get()).toEqual({ count: 2 });
      expect(
        restarted
          .prepare("SELECT metadata_json FROM direct_task_versions WHERE task_id = ? ORDER BY board_revision")
          .all("task-retention")
      ).toEqual([{ metadata_json: '{"value":"before"}' }, { metadata_json: '{"value":"after"}' }]);
    } finally {
      restarted.close();
    }
  });

  it("rolls back v3 schema, projection, and history together when commit is interrupted", () => {
    const { path: databasePath, database } = createV2Database();
    seedDirectBoard(database, "board-atomic", 1);
    seedDirectTask(database, "task-atomic", "board-atomic", 1);
    seedTaskCreatedEvent(database, "event-atomic", "task-atomic", "board-atomic", 1);
    database.close();

    expect(() =>
      migrateDatabase(databasePath, {
        beforeCommit: ({ version }) => {
          if (version === 3) throw new Error("simulated v3 interruption");
        },
      })
    ).toThrow("simulated v3 interruption");

    const unchanged = open(databasePath);
    try {
      expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
      expect(unchanged.prepare("SELECT name FROM sqlite_master WHERE name = 'direct_task_versions'").get()).toBeUndefined();
      expect(unchanged.prepare("SELECT COUNT(*) AS count FROM direct_tasks").get()).toEqual({ count: 1 });
    } finally {
      unchanged.close();
    }
  });
});

describe("ForgeSpec 1.2.2 migration", () => {
  it("upgrades a real legacy database and preserves every legacy resource across restart", () => {
    const databasePath = copyFixture();

    const first = migrateDatabase(databasePath);
    const second = migrateDatabase(databasePath);
    const database = open(databasePath);

    expect(first).toMatchObject({ fromVersion: 0, toVersion: LATEST_SCHEMA_VERSION });
    expect(second).toMatchObject({
      fromVersion: LATEST_SCHEMA_VERSION,
      toVersion: LATEST_SCHEMA_VERSION,
      appliedVersions: [],
    });
    expect(database.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
    expect(database.prepare("SELECT id, data FROM contracts WHERE id = ?").get("sdd-legacy")).toEqual({
      id: "sdd-legacy",
      data: '{"legacy":true}',
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM boards").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM tasks").get()).toEqual({ count: 5 });
    expect(database.prepare("SELECT notes FROM tasks WHERE id = ?").get("task-legacy-a")).toEqual({
      notes: '[{"text":"kept","timestamp":"2026-01-01T00:00:00.000Z"}]',
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM file_reservations").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 6 });
    database.close();
  });

  it("rolls back an interrupted upgrade and can restart from the complete legacy state", () => {
    const databasePath = copyFixture();

    expect(() =>
      migrateDatabase(databasePath, {
        beforeCommit: ({ version }) => {
          if (version === LATEST_SCHEMA_VERSION) throw new Error("simulated interruption");
        },
      })
    ).toThrow("simulated interruption");

    const interrupted = open(databasePath);
    expect(interrupted.pragma("user_version", { simple: true })).toBe(0);
    expect(interrupted.prepare("SELECT name FROM sqlite_master WHERE name = 'schema_migrations'").get()).toBeUndefined();
    expect(interrupted.prepare("SELECT title FROM tasks WHERE id = ?").get("task-legacy-a")).toEqual({ title: "Root" });
    interrupted.close();

    expect(migrateDatabase(databasePath).toVersion).toBe(LATEST_SCHEMA_VERSION);
  });

  it("creates a verified backup that restores the pre-upgrade database", () => {
    const databasePath = copyFixture();
    const result = migrateDatabase(databasePath);

    expect(result.backupPath).toBeTruthy();
    expect(fs.existsSync(result.backupPath!)).toBe(true);
    restoreDatabaseBackup(databasePath, result.backupPath!);

    const restored = open(databasePath);
    expect(restored.pragma("quick_check", { simple: true })).toBe("ok");
    expect(restored.pragma("user_version", { simple: true })).toBe(0);
    expect(restored.prepare("SELECT executive_summary FROM contracts WHERE id = ?").get("sdd-legacy")).toEqual({
      executive_summary: "Legacy 1.2.2 contract survives migration.",
    });
    restored.close();
  });

  it("records malformed legacy dependencies without promoting them to direct authority", () => {
    const databasePath = copyFixture();
    migrateDatabase(databasePath);
    const database = open(databasePath);

    const categories = database
      .prepare("SELECT category FROM migration_findings ORDER BY category")
      .all() as Array<{ category: string }>;
    expect(categories.map(({ category }) => category)).toEqual([
      "cross_board_dependency",
      "cyclic_dependency",
      "cyclic_dependency",
      "duplicate_dependency",
      "missing_dependency",
      "self_dependency",
    ]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM direct_boards").get()).toEqual({ count: 0 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM task_dependencies").get()).toEqual({ count: 0 });
    database.close();
  });

  it("keeps legacy resources writable while direct-v1 shadow tables coexist", () => {
    const databasePath = copyFixture();
    migrateDatabase(databasePath);
    const database = open(databasePath);

    database.prepare("INSERT INTO boards (id, project, name) VALUES (?, ?, ?)").run(
      "board-after-upgrade",
      "legacy-project",
      "Still legacy"
    );
    expect(database.prepare("SELECT name FROM boards WHERE id = ?").get("board-after-upgrade")).toEqual({
      name: "Still legacy",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM direct_boards").get()).toEqual({ count: 0 });
    database.close();
  });
});

describe("startup migration preflight", () => {
  it("rejects an applied migration whose checksum no longer matches", () => {
    const { path: databasePath, database } = createV2Database("forgespec-checksum-");
    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2")
      .run("sha256:tampered");
    database.close();

    expect(() => migrateDatabase(databasePath)).toThrow(/MIGRATION_CHECKSUM_MISMATCH/);

    const unchanged = open(databasePath);
    try {
      expect(unchanged.pragma("user_version", { simple: true })).toBe(2);
      expect(unchanged.prepare("SELECT checksum FROM schema_migrations WHERE version = 2").get()).toEqual({
        checksum: "sha256:tampered",
      });
    } finally {
      unchanged.close();
    }
  });

  it("applies and records a pending migration atomically before startup traffic", () => {
    const { path: databasePath, database } = createV2Database("forgespec-pending-");
    database.close();

    const result = migrateDatabase(databasePath);

    expect(result.appliedVersions).toContain(3);
    const migrated = open(databasePath);
    try {
      expect(migrated.pragma("user_version", { simple: true })).toBe(6);
      expect(migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
        { version: 4 },
        { version: 5 },
        { version: 6 },
      ]);
    } finally {
      migrated.close();
    }
  });
});
