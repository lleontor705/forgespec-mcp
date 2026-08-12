import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, migrateDatabase } from "../src/database/migrations.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-performance-"));
const databasePath = path.join(directory, "benchmark.db");
let database: Database.Database;

// Windows runners can need a larger hook budget for this 200k-row fixture.
beforeAll(() => {
  migrateDatabase(databasePath);
  database = new Database(databasePath);
  database.pragma("foreign_keys = ON");

  if (
    database.pragma("user_version", { simple: true }) !== LATEST_SCHEMA_VERSION
    || !database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'direct_task_versions'").get()
  ) {
    return;
  }

  const insertFixture = database.transaction(() => {
    database.prepare("INSERT INTO boards (id, project, name) VALUES (?, ?, ?)").run("benchmark-board", "benchmark", "Benchmark");
    database.prepare(
      "INSERT INTO direct_boards (board_id, change_name, schema_version, revision, metadata_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, ?, ?, ?, ?)"
    ).run("benchmark-board", "benchmark", "1.0.0", 20_000, "{}", 1, 1);

    const insertTask = database.prepare(
      "INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'ready')"
    );
    const insertDirectTask = database.prepare(
      "INSERT INTO direct_tasks (task_id, board_id, revision, status, metadata_json, created_at_ms, updated_at_ms) VALUES (?, ?, ?, 'ready', ?, ?, ?)"
    );
    const insertVersion = database.prepare(
      `INSERT INTO direct_task_versions
       (board_id, task_id, board_revision, task_revision, status, metadata_json, created_at_ms, updated_at_ms, is_deleted)
       VALUES (?, ?, ?, ?, 'ready', ?, ?, ?, 0)`
    );

    for (let taskNumber = 0; taskNumber < 10_000; taskNumber += 1) {
      const taskId = `benchmark-task-${taskNumber}`;
      insertTask.run(taskId, "benchmark-board", taskId);
      insertDirectTask.run(taskId, "benchmark-board", 20, "{}", 1, 1);
      for (let version = 1; version <= 20; version += 1) {
        insertVersion.run("benchmark-board", taskId, version, version, "{}", version, version);
      }
    }
  });
  insertFixture();
}, 30_000);

afterAll(() => {
  database?.close();
  fs.rmSync(directory, { recursive: true, force: true });
});

describe("historical task query performance contract", () => {
  it("gives only the heavy fixture hook a 30-second preparation budget", () => {
    const source = fs.readFileSync(new URL(import.meta.url), "utf8");
    expect(source).toMatch(/beforeAll\([\s\S]*?\},\s*30_000\);/);
  });

  it("qualifies the latest schema and the snapshot selection indexes", () => {
    expect(database.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);

    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'direct_task_versions'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("direct_task_versions");

    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'direct_task_versions'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_task_versions_board_snapshot",
        "idx_task_versions_board_task_snapshot",
        "idx_task_versions_task_history",
      ])
    );
  });

  it("uses the historical index for 10,000 tasks with 20 versions each", () => {
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT v.task_id, v.status, v.metadata_json
         FROM direct_task_versions v
         WHERE v.board_id = ? AND v.board_revision <= ? AND v.task_id > ?
           AND v.is_deleted = 0
           AND NOT EXISTS (
             SELECT 1
             FROM direct_task_versions newer
             WHERE newer.board_id = v.board_id
               AND newer.task_id = v.task_id
               AND newer.board_revision <= ?
               AND newer.board_revision > v.board_revision
           )
         ORDER BY v.task_id
         LIMIT 100`
      )
      .all("benchmark-board", 20_000, "", 20_000) as Array<{ detail: string }>;

    expect(plan.map((step) => step.detail).join(" ")).toMatch(/idx_task_versions_board_task_snapshot/);
  });

  it("keeps 30 warmed pages of 100 below the latency budget", () => {
    const pageQuery = database.prepare(
      `SELECT v.task_id, v.status, v.metadata_json
       FROM direct_task_versions v
       WHERE v.board_id = ? AND v.board_revision <= ? AND v.task_id > ?
         AND v.is_deleted = 0
         AND NOT EXISTS (
           SELECT 1
           FROM direct_task_versions newer
           WHERE newer.board_id = v.board_id
             AND newer.task_id = v.task_id
             AND newer.board_revision <= ?
             AND newer.board_revision > v.board_revision
         )
       ORDER BY v.task_id
       LIMIT 100`
    );
    const elapsed: number[] = [];
    let lastTaskId = "";

    for (let page = 0; page < 30; page += 1) {
      const started = performance.now();
      const rows = pageQuery.all("benchmark-board", 20_000, lastTaskId, 20_000) as Array<{ task_id: string }>;
      lastTaskId = rows.at(-1)?.task_id ?? lastTaskId;
      elapsed.push(performance.now() - started);
    }

    const sorted = [...elapsed].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    expect(median).toBeLessThan(250);
    expect(p95).toBeLessThan(500);
  });
});
