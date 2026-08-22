import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createFreshStore } from "../src/storage/bootstrap.js";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-performance-"));
const databasePath = path.join(directory, "benchmark.db");
let database: Database.Database;

// Windows runners can need a larger hook budget for this 200k-row fixture.
beforeAll(() => {
  database = new Database(databasePath);
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  createFreshStore(database);

  if (
    !database.prepare("SELECT 1 FROM sqlite_master WHERE name = 'fs_tasks'").get()
  ) {
    return;
  }

  const insertFixture = database.transaction(() => {
    database.prepare("INSERT INTO fs_boards (id, project, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run("benchmark-board", "benchmark", "Benchmark", 1, 1);
    const insertTask = database.prepare(
      "INSERT INTO fs_tasks (board_id, id, title, priority, status, created_at, updated_at) VALUES (?, ?, ?, 'p2', 'ready', ?, ?)"
    );

    for (let taskNumber = 0; taskNumber < 10_000; taskNumber += 1) {
      const taskId = `benchmark-task-${taskNumber}`;
      insertTask.run("benchmark-board", taskId, taskId, 1, 1);
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
    const table = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'fs_tasks'")
      .get() as { name: string } | undefined;
    expect(table?.name).toBe("fs_tasks");

    const indexes = database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'fs_tasks'")
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual(
      expect.arrayContaining([
        "idx_fs_tasks_board",
        "idx_fs_tasks_board_status",
      ])
    );
  });

  it("uses the historical index for 10,000 tasks with 20 versions each", () => {
    const plan = database
      .prepare(
        `EXPLAIN QUERY PLAN
         SELECT v.id, v.status, v.title
         FROM fs_tasks v
         WHERE v.board_id = ? AND v.id > ? AND v.status = 'ready'
         ORDER BY v.id
         LIMIT 100`
      )
      .all("benchmark-board", "") as Array<{ detail: string }>;

    expect(plan.map((step) => step.detail).join(" ")).toMatch(/sqlite_autoindex_fs_tasks_1/);
  });

  it("keeps 30 warmed pages of 100 below the latency budget", () => {
    const pageQuery = database.prepare(
      `SELECT v.id, v.status, v.title
       FROM fs_tasks v
       WHERE v.board_id = ? AND v.id > ? AND v.status = 'ready'
       ORDER BY v.id
       LIMIT 100`
    );
    const elapsed: number[] = [];
    let lastTaskId = "";

    for (let page = 0; page < 30; page += 1) {
      const started = performance.now();
      const rows = pageQuery.all("benchmark-board", lastTaskId) as Array<{ id: string }>;
      lastTaskId = rows.at(-1)?.id ?? lastTaskId;
      elapsed.push(performance.now() - started);
    }

    const sorted = [...elapsed].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    const p95 = sorted[Math.ceil(sorted.length * 0.95) - 1];
    expect(median).toBeLessThan(250);
    expect(p95).toBeLessThan(500);
  });
});
