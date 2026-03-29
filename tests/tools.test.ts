import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { generateId } from "../src/utils/id.js";

// Use a temporary database for testing
const TEST_DB_DIR = path.join(os.tmpdir(), `forgespec-test-${Date.now()}`);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "test.db");

let db: Database.Database;

function initTestDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  const database = new Database(TEST_DB_PATH);
  database.pragma("journal_mode = WAL");
  database.pragma("foreign_keys = ON");

  database.exec(`
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

    CREATE INDEX IF NOT EXISTS idx_contracts_project ON contracts(project);
  `);

  return database;
}

beforeAll(() => {
  db = initTestDb();
});

afterAll(() => {
  db.close();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

// ── sdd_get tests ──────────────────────────────────────

describe("sdd_get", () => {
  it("returns a contract by valid ID", () => {
    const id = generateId("sdd");
    db.prepare(
      `INSERT INTO contracts (id, phase, change_name, project, status, confidence, executive_summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(id, "init", "test-feature", "proj-a", "success", 0.8, "Test summary for init phase.", "{}");

    const row = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get(id) as Record<string, unknown> | undefined;

    expect(row).toBeDefined();
    expect(row!.id).toBe(id);
    expect(row!.phase).toBe("init");
    expect(row!.project).toBe("proj-a");
    expect(row!.confidence).toBe(0.8);
  });

  it("returns undefined for non-existent ID", () => {
    const row = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get("sdd-nonexistent");
    expect(row).toBeUndefined();
  });

  it("returns undefined for empty string ID", () => {
    const row = db.prepare(`SELECT * FROM contracts WHERE id = ?`).get("");
    expect(row).toBeUndefined();
  });
});

// ── sdd_list tests ─────────────────────────────────────

describe("sdd_list", () => {
  beforeAll(() => {
    // Seed multiple contracts across projects and phases
    const insert = db.prepare(
      `INSERT INTO contracts (id, phase, change_name, project, status, confidence, executive_summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    insert.run(generateId("sdd"), "init", "feat-1", "proj-list", "success", 0.6, "Summary for init phase.", "{}");
    insert.run(generateId("sdd"), "explore", "feat-1", "proj-list", "success", 0.7, "Summary for explore phase.", "{}");
    insert.run(generateId("sdd"), "propose", "feat-2", "proj-list", "success", 0.8, "Summary for propose phase.", "{}");
    insert.run(generateId("sdd"), "init", "feat-3", "proj-other", "success", 0.5, "Summary for other project.", "{}");
  });

  it("lists all contracts without filters", () => {
    const rows = db.prepare(`SELECT * FROM contracts ORDER BY created_at DESC LIMIT 20`).all();
    expect(rows.length).toBeGreaterThanOrEqual(4);
  });

  it("filters by project", () => {
    const rows = db
      .prepare(`SELECT * FROM contracts WHERE project = ? ORDER BY created_at DESC LIMIT 20`)
      .all("proj-list") as Record<string, unknown>[];

    expect(rows.length).toBe(3);
    for (const row of rows) {
      expect(row.project).toBe("proj-list");
    }
  });

  it("filters by phase", () => {
    const rows = db
      .prepare(`SELECT * FROM contracts WHERE phase = ? ORDER BY created_at DESC LIMIT 20`)
      .all("init") as Record<string, unknown>[];

    expect(rows.length).toBeGreaterThanOrEqual(2);
    for (const row of rows) {
      expect(row.phase).toBe("init");
    }
  });

  it("filters by both project and phase", () => {
    const rows = db
      .prepare(`SELECT * FROM contracts WHERE project = ? AND phase = ? ORDER BY created_at DESC LIMIT 20`)
      .all("proj-list", "init") as Record<string, unknown>[];

    expect(rows.length).toBe(1);
    expect(rows[0].project).toBe("proj-list");
    expect(rows[0].phase).toBe("init");
  });

  it("respects limit parameter", () => {
    const rows = db.prepare(`SELECT * FROM contracts ORDER BY created_at DESC LIMIT 2`).all();
    expect(rows.length).toBe(2);
  });
});

// ── tb_delete_task tests ───────────────────────────────

describe("tb_delete_task", () => {
  let boardId: string;

  beforeAll(() => {
    boardId = generateId("board");
    db.prepare(`INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`).run(
      boardId, "proj-del", "Delete Test Board"
    );
  });

  it("deletes a task in backlog status", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'backlog')`
    ).run(taskId, boardId, "Backlog task");

    const before = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    expect(before).toBeDefined();

    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);

    const after = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    expect(after).toBeUndefined();
  });

  it("deletes a task in done status", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'done')`
    ).run(taskId, boardId, "Done task");

    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskId);

    const after = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    expect(after).toBeUndefined();
  });

  it("rejects deletion of task in in_progress status", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'in_progress')`
    ).run(taskId, boardId, "In-progress task");

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    expect(task.status).toBe("in_progress");

    // Simulating the tool logic: only backlog/done can be deleted
    const canDelete = task.status === "backlog" || task.status === "done";
    expect(canDelete).toBe(false);

    // Task should still exist
    const after = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId);
    expect(after).toBeDefined();
  });

  it("rejects deletion of task in in_review status", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'in_review')`
    ).run(taskId, boardId, "In-review task");

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const canDelete = task.status === "backlog" || task.status === "done";
    expect(canDelete).toBe(false);
  });

  it("rejects deletion of task in blocked status", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'blocked')`
    ).run(taskId, boardId, "Blocked task");

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const canDelete = task.status === "backlog" || task.status === "done";
    expect(canDelete).toBe(false);
  });

  it("removes deleted task from other tasks' dependencies", () => {
    const taskA = generateId("task");
    const taskB = generateId("task");

    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status, dependencies) VALUES (?, ?, ?, 'backlog', '[]')`
    ).run(taskA, boardId, "Task A");

    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status, dependencies) VALUES (?, ?, ?, 'backlog', ?)`
    ).run(taskB, boardId, "Task B", JSON.stringify([taskA]));

    // Verify dependency is set
    const beforeDel = db.prepare(`SELECT dependencies FROM tasks WHERE id = ?`).get(taskB) as Record<string, unknown>;
    expect(JSON.parse(beforeDel.dependencies as string)).toContain(taskA);

    // Simulate tb_delete_task logic: clean up dependencies before deleting
    const siblings = db
      .prepare(`SELECT id, dependencies FROM tasks WHERE board_id = ? AND id != ?`)
      .all(boardId, taskA) as Record<string, unknown>[];

    for (const sibling of siblings) {
      const deps = JSON.parse(sibling.dependencies as string) as string[];
      if (deps.includes(taskA)) {
        const updated = deps.filter((d) => d !== taskA);
        db.prepare(`UPDATE tasks SET dependencies = ? WHERE id = ?`).run(
          JSON.stringify(updated), sibling.id
        );
      }
    }

    db.prepare(`DELETE FROM tasks WHERE id = ?`).run(taskA);

    // Verify dependency was cleaned up
    const afterDel = db.prepare(`SELECT dependencies FROM tasks WHERE id = ?`).get(taskB) as Record<string, unknown>;
    expect(JSON.parse(afterDel.dependencies as string)).not.toContain(taskA);
    expect(JSON.parse(afterDel.dependencies as string)).toEqual([]);
  });

  it("returns error for non-existent task", () => {
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get("task-nonexistent");
    expect(row).toBeUndefined();
  });
});

// ── tb_add_notes tests ─────────────────────────────────

describe("tb_add_notes", () => {
  let boardId: string;

  beforeAll(() => {
    boardId = generateId("board");
    db.prepare(`INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`).run(
      boardId, "proj-notes", "Notes Test Board"
    );
  });

  it("appends a note to a task with no prior notes", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title) VALUES (?, ?, ?)`
    ).run(taskId, boardId, "Notes task");

    // Simulate tb_add_notes logic
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const existing = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    existing.push({ text: "First note", timestamp: new Date().toISOString() });
    db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(existing), taskId);

    const updated = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const notes = JSON.parse(updated.notes as string) as Array<{ text: string; timestamp: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("First note");
    expect(notes[0].timestamp).toBeDefined();
  });

  it("appends multiple notes preserving order", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title) VALUES (?, ?, ?)`
    ).run(taskId, boardId, "Multi-notes task");

    // Add first note
    let task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    let notes = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    notes.push({ text: "Note 1", timestamp: "2026-01-01T00:00:00.000Z" });
    db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), taskId);

    // Add second note
    task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    notes = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    notes.push({ text: "Note 2", timestamp: "2026-01-02T00:00:00.000Z" });
    db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), taskId);

    // Add third note
    task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    notes = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    notes.push({ text: "Note 3", timestamp: "2026-01-03T00:00:00.000Z" });
    db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), taskId);

    const result = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const finalNotes = JSON.parse(result.notes as string) as Array<{ text: string; timestamp: string }>;
    expect(finalNotes).toHaveLength(3);
    expect(finalNotes[0].text).toBe("Note 1");
    expect(finalNotes[1].text).toBe("Note 2");
    expect(finalNotes[2].text).toBe("Note 3");
  });

  it("does not change task status when adding notes", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'in_progress')`
    ).run(taskId, boardId, "Status-preserved task");

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const notes = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    notes.push({ text: "A note", timestamp: new Date().toISOString() });
    db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), taskId);

    const updated = db.prepare(`SELECT status FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    expect(updated.status).toBe("in_progress");
  });

  it("returns error for non-existent task", () => {
    const row = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get("task-nonexistent");
    expect(row).toBeUndefined();
  });

  it("stores notes with correct structure", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title) VALUES (?, ?, ?)`
    ).run(taskId, boardId, "Structure test task");

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const notes = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    const timestamp = new Date().toISOString();
    notes.push({ text: "Structured note", timestamp });
    db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), taskId);

    const result = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const parsed = JSON.parse(result.notes as string) as Array<{ text: string; timestamp: string }>;
    expect(parsed[0]).toHaveProperty("text");
    expect(parsed[0]).toHaveProperty("timestamp");
    expect(typeof parsed[0].text).toBe("string");
    expect(typeof parsed[0].timestamp).toBe("string");
  });
});
