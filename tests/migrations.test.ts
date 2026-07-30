import Database from "better-sqlite3";
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

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
  removeTestDatabases();
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

      expect(result.toVersion).toBe(3);
      expect(migrated.pragma("user_version", { simple: true })).toBe(3);
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
      expect(unchanged.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 2 });
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
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 3 });
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
      expect(migrated.pragma("user_version", { simple: true })).toBe(3);
      expect(migrated.prepare("SELECT version FROM schema_migrations ORDER BY version").all()).toEqual([
        { version: 1 },
        { version: 2 },
        { version: 3 },
      ]);
    } finally {
      migrated.close();
    }
  });
});
