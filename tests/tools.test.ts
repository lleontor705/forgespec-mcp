import { describe, it, expect, beforeAll, afterAll } from "vitest";
import type Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { generateId } from "../src/utils/id.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { migrateDatabase } from "../src/database/migrations.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createServer } from "../src/server.js";
import { createTestDatabase, removeTestDatabases } from "./helpers/database.js";

let DatabaseConstructor: typeof Database | undefined;
try {
  DatabaseConstructor = (await import("better-sqlite3")).default;
  const probe = new DatabaseConstructor(":memory:");
  probe.close();
} catch {
  // Native compatibility tests report unavailable runtimes honestly below.
  DatabaseConstructor = undefined;
}
const databaseAvailable = DatabaseConstructor !== undefined;
const nativeDescribe = databaseAvailable ? describe : describe.skip;

// Use a temporary database for testing
const TEST_DB_DIR = path.join(os.tmpdir(), `forgespec-test-${Date.now()}`);
const TEST_DB_PATH = path.join(TEST_DB_DIR, "test.db");

let db: Database.Database;

function initTestDb(): Database.Database {
  fs.mkdirSync(TEST_DB_DIR, { recursive: true });
  const database = new DatabaseConstructor!(TEST_DB_PATH);
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
  if (!DatabaseConstructor) return;
  db = initTestDb();
});

afterAll(() => {
  if (db) db.close();
  fs.rmSync(TEST_DB_DIR, { recursive: true, force: true });
});

// ── sdd_get tests ──────────────────────────────────────

nativeDescribe("sdd_get", () => {
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

nativeDescribe("sdd_list", () => {
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

nativeDescribe("tb_create_board with tasks", () => {
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

nativeDescribe("direct-v1 task-board handlers", () => {
  it("returns structured CAS errors, exact replay, and rejects legacy bypass", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-handler-"));
    const databasePath = path.join(directory, "handler.db");
    migrateDatabase(databasePath);
    const database = new DatabaseConstructor!(databasePath);
    database.pragma("foreign_keys = ON");
    const server = new McpServer({ name: "task-handler-test", version: "1.0.0" });
    registerTaskBoardTools(server, () => database);
    const client = new Client({ name: "task-handler-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const createArguments = {
      project: "handler-tests",
      name: "Direct handler board",
      tasks: [{ title: "Handler task" }],
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      actor: "handler-owner",
      idempotency_key: "handler-board",
    };
    const created = await client.callTool({ name: "tb_create_board", arguments: createArguments });
    const replayed = await client.callTool({ name: "tb_create_board", arguments: createArguments });
    expect(replayed.structuredContent).toEqual({ ...created.structuredContent, replayed: true });
    const direct = created.structuredContent as { board_id: string; task_ids: string[] };

    const absentCas = await client.callTool({
      name: "tb_update",
      arguments: {
        task_id: direct.task_ids[0],
        status: "blocked",
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        actor: "handler-owner",
        idempotency_key: "missing-cas",
      },
    });
    expect(absentCas.isError).toBe(true);
    expect(absentCas.structuredContent).toMatchObject({
      ok: false,
      error: { category: "cas", code: "expected_revision_required", retryable: false },
    });

    const bypass = await client.callTool({
      name: "tb_update",
      arguments: { task_id: direct.task_ids[0], status: "blocked" },
    });
    expect(bypass.isError).toBe(true);
    expect(bypass.structuredContent).toMatchObject({ ok: false, error: { category: "compatibility" } });

    const claimBypass = await client.callTool({
      name: "tb_claim",
      arguments: { task_id: direct.task_ids[0], agent: "legacy-worker" },
    });
    expect(claimBypass.isError).toBe(true);
    expect(claimBypass.structuredContent).toMatchObject({
      ok: false,
      error: { category: "compatibility", code: "legacy_direct_bypass" },
    });
    expect(database.prepare("SELECT revision, status FROM direct_tasks WHERE task_id = ?").get(direct.task_ids[0])).toEqual({
      revision: 1,
      status: "ready",
    });
    expect(database.prepare("SELECT status, assignee FROM tasks WHERE id = ?").get(direct.task_ids[0])).toEqual({
      status: "ready",
      assignee: null,
    });

    await client.close();
    await server.close();
    database.close();
    fs.rmSync(directory, { recursive: true, force: true });
  });
});

// ── tb_update with notes tests ────────────────────────

nativeDescribe("tb_update with notes", () => {
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

nativeDescribe("file_reserve check_only", () => {
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

// ── WU8 release integration tests ─────────────────────

const RELEASE_P0_CAPS = [
  "forgespec.capabilities", "task-cas", "idempotency", "task-attempt-lease",
  "claim-recovery", "dependency-transitions", "audit-events", "sdd-contract-revisions",
];
const RELEASE_P1_CAPS = [
  "structured-evidence-links", "approval-gates", "batch-status", "query-cursors", "file-lease",
];
const EXCLUDED_TOOL_NAMES = [
  "msg_send", "msg_read_inbox", "msg_broadcast", "msg_request",
  "msg_search", "msg_list_threads", "msg_list_agents", "msg_count", "msg_activity_feed",
  "dlq_list", "dlq_purge", "dlq_retry",
  "a2a_submit_task", "a2a_respond_task", "a2a_get_task", "a2a_cancel_task", "a2a_list_tasks",
  "resource_acquire", "resource_check", "resource_release",
];

const PROJECT_ROOT = path.resolve(__dirname, "..");

function range1x(): { min_inclusive: string; max_exclusive: string } {
  return { min_inclusive: "1.0.0", max_exclusive: "2.0.0" };
}

nativeDescribe("release integration — composed server registration", () => {
  it("registers forgespec_capabilities alongside all direct-v1 tools", async () => {
    const server = createServer();
    const client = new Client({ name: "release-test", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const toolsList = await client.listTools();
    const names = toolsList.tools.map((t) => t.name);

    expect(names).toContain("forgespec_capabilities");
    expect(names).toContain("sdd_save");
    expect(names).toContain("sdd_get");
    expect(names).toContain("sdd_history");
    expect(names).toContain("tb_create_board");
    expect(names).toContain("tb_claim");
    expect(names).toContain("tb_update");
    expect(names).toContain("tb_approve");
    expect(names).toContain("tb_query");
    expect(names).toContain("tb_events");
    expect(names).toContain("file_reserve");

    await client.close();
    await server.close();
  });
});

nativeDescribe("release integration — capability manifest for cortex-ia", () => {
  it("advertises qualified P0 and P1 intervals with local-trusted-client and version >= 1.3.0", async () => {
    const server = createServer();
    const client = new Client({ name: "cortex-ia-probe", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "forgespec_capabilities",
      arguments: {
        client: { name: "cortex-ia", version: "1.0.0" },
        requested_mode: "direct-v1",
        required: [
          ...RELEASE_P0_CAPS.map((id) => ({ id, range: range1x() })),
          ...RELEASE_P1_CAPS.map((id) => ({ id, range: range1x() })),
        ],
      },
    });

    expect(result.isError).not.toBe(true);
    const caps = result.structuredContent as Record<string, unknown>;

    // Server identity and API version
    expect(caps.server).toMatchObject({ name: "forgespec-mcp", api_version: "1.0.0" });
    const serverVersion = (caps.server as { version: string }).version;
    const [major, minor] = serverVersion.split(".").map(Number);
    expect(major).toBe(1);
    expect(minor).toBeGreaterThanOrEqual(3);

    // Security boundary disclosure
    expect(caps.security).toMatchObject({ identity_model: "local-trusted-client" });

    // Modes
    expect(caps.modes).toEqual(["legacy", "direct-v1"]);

    // Schemas
    expect(caps.schemas).toMatchObject({
      sdd_envelope: range1x(),
      task_metadata: range1x(),
      evidence_ref: range1x(),
    });

    // All P0 and P1 capabilities advertised
    const capabilityIds = (caps.capabilities as Array<{ id: string }>).map((c) => c.id);
    for (const p0 of RELEASE_P0_CAPS) {
      expect(capabilityIds).toContain(p0);
    }
    for (const p1 of RELEASE_P1_CAPS) {
      expect(capabilityIds).toContain(p1);
    }

    // Compatibility negotiation
    expect(caps.compatibility).toMatchObject({
      compatible: true,
      selected_mode: "direct-v1",
      missing: [],
      incompatible: [],
    });

    // Limits
    expect(caps.limits).toMatchObject({
      max_page_size: 200,
      max_batch_tasks: 100,
      max_dependencies_per_task: 100,
      min_lease_seconds: 15,
      max_lease_seconds: 3600,
      clock_skew_grace_ms: 5000,
      max_file_scopes: 100,
      max_idempotency_key_bytes: 256,
    });

    await client.close();
    await server.close();
  });

  it("classifies unavailable optional P1 as unavailable without breaking compatibility", async () => {
    const server = createServer();
    const client = new Client({ name: "cortex-ia-probe", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "forgespec_capabilities",
      arguments: {
        client: { name: "cortex-ia", version: "1.0.0" },
        requested_mode: "direct-v1",
        required: [
          ...RELEASE_P0_CAPS.map((id) => ({ id, range: range1x() })),
          { id: "nonexistent-optional-feature", range: range1x(), optional: true },
        ],
      },
    });

    const caps = result.structuredContent as Record<string, unknown>;
    const compatibility = caps.compatibility as { compatible: boolean; unavailable_optional: unknown[] };
    expect(compatibility.compatible).toBe(true);
    expect(compatibility.unavailable_optional.length).toBe(1);

    await client.close();
    await server.close();
  });

  it("rejects incompatible required major", async () => {
    const server = createServer();
    const client = new Client({ name: "cortex-ia-probe", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const result = await client.callTool({
      name: "forgespec_capabilities",
      arguments: {
        client: { name: "cortex-ia", version: "1.0.0" },
        requested_mode: "direct-v1",
        required: [
          { id: "task-cas", range: { min_inclusive: "2.0.0", max_exclusive: "3.0.0" } },
        ],
      },
    });

    const caps = result.structuredContent as Record<string, unknown>;
    const compatibility = caps.compatibility as {
      compatible: boolean;
      incompatible: Array<{ id: string }>;
      selected_mode?: string;
    };
    expect(compatibility.compatible).toBe(false);
    expect(compatibility.incompatible.length).toBe(1);
    expect(compatibility.incompatible[0].id).toBe("task-cas");
    expect(compatibility.selected_mode).toBeUndefined();

    await client.close();
    await server.close();
  });
});

nativeDescribe("release integration — excluded boundary inventory", () => {
  it("exposes no messaging, DLQ, A2A, remote, or non-file external-lease tools", async () => {
    const server = createServer();
    const client = new Client({ name: "boundary-audit", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const toolsList = await client.listTools();
    const names = toolsList.tools.map((t) => t.name);

    for (const excluded of EXCLUDED_TOOL_NAMES) {
      expect(names).not.toContain(excluded);
    }

    await client.close();
    await server.close();
  });
});

nativeDescribe("release integration — docs and version contract", () => {
  it("ships docs/direct-v1.md documenting capabilities, security boundary, and cortex-ia contract", () => {
    const docPath = path.join(PROJECT_ROOT, "docs", "direct-v1.md");
    expect(fs.existsSync(docPath)).toBe(true);
    const content = fs.readFileSync(docPath, "utf-8");
    expect(content).toMatch(/direct-v1/i);
    expect(content).toMatch(/local-trusted-client/);
    expect(content).toMatch(/P0/i);
    expect(content).toMatch(/cortex-ia/i);
  });

  it("ships docs/migrations.md documenting migration, rollback, and interruption recovery", () => {
    const docPath = path.join(PROJECT_ROOT, "docs", "migrations.md");
    expect(fs.existsSync(docPath)).toBe(true);
    const content = fs.readFileSync(docPath, "utf-8");
    expect(content).toMatch(/migration/i);
    expect(content).toMatch(/rollback|restore|backup/i);
    expect(content).toMatch(/interrupt/i);
  });

  it("uses additive 1.x versioning (not a breaking major bump)", () => {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf-8")
    ) as { version: string };
    const major = Number(pkg.version.split(".")[0]);
    expect(major).toBe(1);
  });

  it("documents direct-v1 in README.md", () => {
    const readme = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf-8");
    expect(readme).toMatch(/direct-v1/i);
  });
});

nativeDescribe("compatibility and error boundaries", () => {
  it("keeps strong history as the default and marks legacy opt-in errors", async () => {
    const testDb = createTestDatabase("forgespec-tools-compat-");
    const server = createServer({ database: () => testDb.database });
    const client = new Client({ name: "compat-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const empty = await client.callTool({ name: "sdd_history", arguments: { project: "empty-project" } });
    expect(empty.structuredContent).toMatchObject({
      items: [],
      next_cursor: null,
      snapshot_revision: 0,
    });

    testDb.database.prepare(
      `INSERT INTO contracts (id, phase, change_name, project, status, confidence, executive_summary, data)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).run("legacy-contract", "explore", "legacy-change", "legacy-project", "success", 1, "legacy", "{}");
    const legacy = await client.callTool({ name: "sdd_history", arguments: { project: "legacy-project" } });
    expect(legacy.structuredContent).toMatchObject({
      ok: false,
      error: { code: "LEGACY_OPT_IN_REQUIRED", data: { code: "LEGACY_OPT_IN_REQUIRED" } },
    });

    await client.close();
    await server.close();
    testDb.database.close();
  });

  it("exposes stable data codes for direct contract failures", async () => {
    const testDb = createTestDatabase("forgespec-tools-errors-");
    const server = createServer({ database: () => testDb.database });
    const client = new Client({ name: "error-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.callTool({
      name: "sdd_save",
      arguments: {
        contract: "not-json",
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        actor: "error-owner",
        idempotency_key: "error-contract",
        expected_head_revision: 0,
      },
    });
    expect(response.structuredContent).toMatchObject({
      ok: false,
      error: { code: "contract_validation_conflict", data: { code: "contract_validation_conflict" } },
    });

    await client.close();
    await server.close();
    testDb.database.close();
  });
});

describe("runtime compatibility facts", () => {
  const runtimeTest = process.version === "v24.18.1" || /^v22\./.test(process.version) ? it : it.skip;

  runtimeTest("requires complete supported-runtime evidence before compatibility is accepted", () => {
    if (process.version === "v24.18.1") expect(process.versions.modules).toBe("137");
    else expect(process.versions.modules).toBe("127");
    expect(process.versions.napi).toBeDefined();
  });

  runtimeTest("exposes the bounded snapshot/query tool inventory used by the benchmark", async () => {
    const server = createServer();
    const client = new Client({ name: "runtime-facts", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const tools = await client.listTools();
    const names = tools.tools.map((tool) => tool.name);
    expect(names).toContain("tb_query");
    expect(names).toContain("tb_batch_status");
    expect(names).toContain("tb_events");
    expect(tools.tools.find((tool) => tool.name === "tb_query")?.description).toMatch(/snapshot/i);

    await client.close();
    await server.close();
  });

  runtimeTest("reports schema v3 as the runtime migration boundary", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-runtime-facts-"));
    const databasePath = path.join(directory, "runtime.db");
    migrateDatabase(databasePath);
    const runtimeDb = new DatabaseConstructor!(databasePath, { readonly: true });
    try {
      expect(runtimeDb.pragma("user_version", { simple: true })).toBe(3);
      expect(runtimeDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'direct_task_versions'").get()).toBeDefined();
    } finally {
      runtimeDb.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

nativeDescribe("release integration — E2E direct-v1 lifecycle through composed server", () => {
  let testDb: { path: string; database: Database.Database };
  let sharedBoardId: string;

  beforeAll(() => {
    testDb = createTestDatabase("forgespec-release-");
  });

  afterAll(() => {
    testDb.database.close();
    removeTestDatabases();
  });

  it("completes capability -> board -> claim -> evidence -> approval -> complete -> delta recovery", async () => {
    const server = createServer({ database: () => testDb.database });
    const client = new Client({ name: "e2e-lifecycle", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // 1. Capability negotiation — all P0 and P1 satisfied
    const capsResult = await client.callTool({
      name: "forgespec_capabilities",
      arguments: {
        client: { name: "cortex-ia", version: "1.0.0" },
        requested_mode: "direct-v1",
        required: [
          ...RELEASE_P0_CAPS.map((id) => ({ id, range: range1x() })),
          ...RELEASE_P1_CAPS.map((id) => ({ id, range: range1x() })),
        ],
      },
    });
    expect(capsResult.isError).not.toBe(true);
    const caps = capsResult.structuredContent as { compatibility: { compatible: boolean; selected_mode: string } };
    expect(caps.compatibility.compatible).toBe(true);
    expect(caps.compatibility.selected_mode).toBe("direct-v1");

    // 2. Create direct board with one gated task
    const boardResult = await client.callTool({
      name: "tb_create_board",
      arguments: {
        project: "release-e2e",
        name: "E2E release board",
        tasks: [
          {
            title: "E2E release task",
            priority: "p0",
            work_unit: "wu8-e2e",
            gates: [{ gate_id: "review", required_for: ["done"], allowed_actors: ["reviewer"] }],
          },
        ],
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        actor: "e2e-owner",
        idempotency_key: "e2e-board",
      },
    });
    expect(boardResult.isError).not.toBe(true);
    const board = boardResult.structuredContent as { board_id: string; task_ids: string[]; board_revision: number };
    sharedBoardId = board.board_id;
    const taskId = board.task_ids[0];

    // 3. Claim the ready task
    const claimResult = await client.callTool({
      name: "tb_claim",
      arguments: {
        task_id: taskId,
        agent: "e2e-worker",
        expected_revision: 1,
        lease_seconds: 120,
        idempotency_key: "e2e-claim",
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
      },
    });
    expect(claimResult.isError).not.toBe(true);
    const claim = claimResult.structuredContent as {
      attempt_id: string;
      claim_token: string;
      task_revision: number;
    };
    expect(claim.attempt_id).toBeDefined();
    expect(typeof claim.claim_token).toBe("string");
    expect(claim.claim_token.length).toBeGreaterThan(0);
    expect(claim.task_revision).toBe(2);

    // 4. Attach evidence and move to in_review
    const evidenceResult = await client.callTool({
      name: "tb_update",
      arguments: {
        task_id: taskId,
        status: "in_review",
        expected_revision: claim.task_revision,
        attempt_id: claim.attempt_id,
        claim_token: claim.claim_token,
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        actor: "e2e-worker",
        evidence_links: [
          {
            provider: "cortex",
            kind: "session-summary",
            external_id: "obs-e2e-001",
            digest: "sha256:" + "a".repeat(64),
          },
        ],
        idempotency_key: "e2e-evidence",
      },
    });
    expect(evidenceResult.isError).not.toBe(true);
    const evidence = evidenceResult.structuredContent as { task_revision: number };
    expect(evidence.task_revision).toBeGreaterThan(claim.task_revision);

    // 5. Approve the gate as authorized actor
    const approveResult = await client.callTool({
      name: "tb_approve",
      arguments: {
        task_id: taskId,
        gate_id: "review",
        decision: "allow",
        expected_revision: evidence.task_revision,
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        actor: "reviewer",
        idempotency_key: "e2e-approve",
      },
    });
    expect(approveResult.isError).not.toBe(true);
    const approval = approveResult.structuredContent as {
      task_revision: number;
      effective_decision: string;
    };
    expect(approval.effective_decision).toBe("allow");

    // 6. Complete the task
    const completeResult = await client.callTool({
      name: "tb_update",
      arguments: {
        task_id: taskId,
        status: "done",
        expected_revision: approval.task_revision,
        attempt_id: claim.attempt_id,
        claim_token: claim.claim_token,
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        actor: "e2e-worker",
        idempotency_key: "e2e-complete",
      },
    });
    expect(completeResult.isError).not.toBe(true);

    // 7. Delta recovery — query events since revision 1
    const eventsResult = await client.callTool({
      name: "tb_events",
      arguments: {
        board_id: board.board_id,
        actor: "e2e-owner",
        since_revision: 1,
        limit: 50,
      },
    });
    expect(eventsResult.isError).not.toBe(true);
    const events = eventsResult.structuredContent as {
      items: unknown[];
      snapshot_revision: number;
    };
    expect(events.items.length).toBeGreaterThan(0);
    expect(events.snapshot_revision).toBeGreaterThanOrEqual(approval.task_revision);

    await client.close();
    await server.close();
  });

  it("recovers deltas without messaging or broadcasts (tb_events only)", async () => {
    const server = createServer({ database: () => testDb.database });
    const client = new Client({ name: "delta-recovery", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    // Query events from the board created in the previous test
    const result = await client.callTool({
      name: "tb_events",
      arguments: { board_id: sharedBoardId, actor: "e2e-owner", limit: 100 },
    });
    expect(result.isError).not.toBe(true);
    const events = result.structuredContent as { items: unknown[] };
    expect(events.items.length).toBeGreaterThan(0);

    // The tools list MUST not include any broadcast/messaging tools
    const toolsList = await client.listTools();
    const names = toolsList.tools.map((t) => t.name);
    for (const excluded of EXCLUDED_TOOL_NAMES) {
      expect(names).not.toContain(excluded);
    }

    await client.close();
    await server.close();
  });
});
