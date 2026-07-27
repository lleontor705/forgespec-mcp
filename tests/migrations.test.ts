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
    expect(database.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get()).toEqual({ count: 2 });
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
