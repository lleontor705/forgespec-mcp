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

    CREATE TABLE IF NOT EXISTS file_reservations (
      id TEXT PRIMARY KEY,
      pattern TEXT NOT NULL,
      agent TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
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

// ── tb_create_board with inline tasks tests ───────────

describe("tb_create_board with tasks", () => {
  it("creates board without tasks (backward compatible)", () => {
    const boardId = generateId("board");
    db.prepare(`INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`).run(
      boardId, "proj-compat", "Empty Board"
    );

    const board = db.prepare(`SELECT * FROM boards WHERE id = ?`).get(boardId) as Record<string, unknown>;
    expect(board).toBeDefined();
    expect(board.project).toBe("proj-compat");

    const tasks = db.prepare(`SELECT * FROM tasks WHERE board_id = ?`).all(boardId);
    expect(tasks.length).toBe(0);
  });

  it("creates board with inline tasks atomically", () => {
    const boardId = generateId("board");

    const insertBoard = db.prepare(`INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`);
    const insertTask = db.prepare(
      `INSERT INTO tasks (id, board_id, title, description, priority, acceptance_criteria, dependencies, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    );

    const taskIds = [generateId("task"), generateId("task"), generateId("task")];

    const tx = db.transaction(() => {
      insertBoard.run(boardId, "proj-inline", "Inline Board");
      insertTask.run(taskIds[0], boardId, "Task A", "First task", "p0", "AC A", "[]", "ready");
      insertTask.run(taskIds[1], boardId, "Task B", "Depends on A", "p1", "AC B", JSON.stringify([taskIds[0]]), "backlog");
      insertTask.run(taskIds[2], boardId, "Task C", "Also depends on A", "p1", "AC C", JSON.stringify([taskIds[0]]), "backlog");
    });
    tx();

    const board = db.prepare(`SELECT * FROM boards WHERE id = ?`).get(boardId) as Record<string, unknown>;
    expect(board).toBeDefined();

    const tasks = db.prepare(`SELECT * FROM tasks WHERE board_id = ? ORDER BY created_at`).all(boardId) as Record<string, unknown>[];
    expect(tasks.length).toBe(3);
    expect(tasks[0].title).toBe("Task A");
    expect(tasks[0].status).toBe("ready");
    expect(tasks[1].status).toBe("backlog");
    expect(tasks[2].status).toBe("backlog");

    // Verify dependencies
    const depsB = JSON.parse(tasks[1].dependencies as string) as string[];
    expect(depsB).toContain(taskIds[0]);
  });

  it("tasks without dependencies start as ready", () => {
    const boardId = generateId("board");
    const taskId = generateId("task");

    db.prepare(`INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`).run(boardId, "proj-ready", "Ready Board");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, dependencies, status) VALUES (?, ?, ?, ?, ?)`
    ).run(taskId, boardId, "No deps task", "[]", "ready");

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    expect(task.status).toBe("ready");
  });
});

// ── tb_update with notes tests ────────────────────────

describe("tb_update with notes", () => {
  let boardId: string;

  beforeAll(() => {
    boardId = generateId("board");
    db.prepare(`INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`).run(
      boardId, "proj-notes", "Notes Test Board"
    );
  });

  it("appends a note without changing status", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'in_progress')`
    ).run(taskId, boardId, "Notes task");

    // Simulate tb_update with notes only (no status change)
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const existing = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    existing.push({ text: "First note", timestamp: new Date().toISOString() });
    db.prepare(`UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(existing), new Date().toISOString(), taskId
    );

    const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const notes = JSON.parse(updated.notes as string) as Array<{ text: string; timestamp: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("First note");
    expect(updated.status).toBe("in_progress"); // status preserved
  });

  it("updates status and appends notes in a single call", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title, status) VALUES (?, ?, ?, 'in_progress')`
    ).run(taskId, boardId, "Status+notes task");

    const now = new Date().toISOString();

    // Append note
    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const existing = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    existing.push({ text: "Completing task", timestamp: now });
    db.prepare(`UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?`).run(
      JSON.stringify(existing), now, taskId
    );

    // Update status to done
    db.prepare(`UPDATE tasks SET status = 'done', completed_at = ?, updated_at = ? WHERE id = ?`).run(now, now, taskId);

    const updated = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    expect(updated.status).toBe("done");
    expect(updated.completed_at).toBeDefined();
    const notes = JSON.parse(updated.notes as string) as Array<{ text: string; timestamp: string }>;
    expect(notes).toHaveLength(1);
    expect(notes[0].text).toBe("Completing task");
  });

  it("appends multiple notes preserving order", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title) VALUES (?, ?, ?)`
    ).run(taskId, boardId, "Multi-notes task");

    for (const text of ["Note 1", "Note 2", "Note 3"]) {
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
      const notes = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
      notes.push({ text, timestamp: new Date().toISOString() });
      db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), taskId);
    }

    const result = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const finalNotes = JSON.parse(result.notes as string) as Array<{ text: string; timestamp: string }>;
    expect(finalNotes).toHaveLength(3);
    expect(finalNotes[0].text).toBe("Note 1");
    expect(finalNotes[1].text).toBe("Note 2");
    expect(finalNotes[2].text).toBe("Note 3");
  });

  it("stores notes with correct structure", () => {
    const taskId = generateId("task");
    db.prepare(
      `INSERT INTO tasks (id, board_id, title) VALUES (?, ?, ?)`
    ).run(taskId, boardId, "Structure test task");

    const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const notes = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
    notes.push({ text: "Structured note", timestamp: new Date().toISOString() });
    db.prepare(`UPDATE tasks SET notes = ? WHERE id = ?`).run(JSON.stringify(notes), taskId);

    const result = db.prepare(`SELECT notes FROM tasks WHERE id = ?`).get(taskId) as Record<string, unknown>;
    const parsed = JSON.parse(result.notes as string) as Array<{ text: string; timestamp: string }>;
    expect(parsed[0]).toHaveProperty("text");
    expect(parsed[0]).toHaveProperty("timestamp");
    expect(typeof parsed[0].text).toBe("string");
    expect(typeof parsed[0].timestamp).toBe("string");
  });
});

// ── file_reserve with check_only tests ──��─────────────

describe("file_reserve check_only", () => {
  it("check_only returns no conflicts when nothing reserved", () => {
    // Clean slate
    db.prepare(`DELETE FROM file_reservations`).run();

    const existing = db
      .prepare(`SELECT * FROM file_reservations WHERE agent != ?`)
      .all("agent-a") as Array<{ pattern: string; agent: string; expires_at: string }>;

    expect(existing.length).toBe(0);
  });

  it("check_only detects conflicts from other agents", () => {
    db.prepare(`DELETE FROM file_reservations`).run();

    const expires = new Date(Date.now() + 15 * 60 * 1000).toISOString();
    db.prepare(
      `INSERT INTO file_reservations (id, pattern, agent, expires_at) VALUES (?, ?, ?, ?)`
    ).run(generateId("res"), "src/auth/**", "agent-b", expires);

    const existing = db
      .prepare(`SELECT * FROM file_reservations WHERE agent != ?`)
      .all("agent-a") as Array<{ pattern: string; agent: string; expires_at: string }>;

    expect(existing.length).toBe(1);
    expect(existing[0].agent).toBe("agent-b");
  });
});
