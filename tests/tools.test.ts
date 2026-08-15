import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach, vi } from "vitest";
import type Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { generateId } from "../src/utils/id.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { LATEST_SCHEMA_VERSION, migrateDatabase } from "../src/database/migrations.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createServer } from "../src/server.js";
import { FakeClock } from "../src/core/clock.js";
import { TaskAuthorityService } from "../src/services/task-authority-service.js";
import { TaskConflictError, TaskService } from "../src/services/task-service.js";
import type { CapabilityContext, GrantCommand, HandoffCommand, RevokeCommand } from "../src/types/index.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

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

const unblockedRaceWorkerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const Database = require("better-sqlite3");
  const { register } = require("tsx/esm/api");
  register();
  (async () => {
    const database = new Database(workerData.databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(workerData.gate, 0, 0);
    try {
      let value;
      if (workerData.command.kind === "revoke") {
        const [{ TaskService }, { FakeClock }] = await Promise.all([
          import(workerData.serviceUrl), import(workerData.clockUrl),
        ]);
        value = new TaskService(database, { clock: new FakeClock(workerData.nowMs) })
          .revokeAuthority(workerData.command.input);
      } else {
        const [{ createServer }, { Client }, { InMemoryTransport }] = await Promise.all([
          import(workerData.serverUrl), import(workerData.clientUrl), import(workerData.transportUrl),
        ]);
        const server = createServer({ database: () => database });
        const client = new Client({ name: "unblocked-race-worker", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
        try { value = await client.callTool({ name: "tb_unblocked", arguments: workerData.command.input }); }
        finally { await client.close(); await server.close(); }
      }
      parentPort.postMessage({ type: "result", outcome: { ok: true, value } });
    } catch (error) {
      parentPort.postMessage({ type: "result", outcome: { ok: false, code: error && error.code, message: String(error?.message ?? error) } });
    } finally { database.close(); }
  })().catch((error) => parentPort.postMessage({ type: "fatal", message: String(error?.stack ?? error) }));
`;

async function startUnblockedRaceWorkers(databasePath: string, nowMs: number, commands: unknown[]) {
  const require = createRequire(import.meta.url);
  const moduleUrls = {
    serviceUrl: pathToFileURL(`${process.cwd()}/src/services/task-service.ts`).href,
    clockUrl: pathToFileURL(`${process.cwd()}/src/core/clock.ts`).href,
    serverUrl: pathToFileURL(`${process.cwd()}/src/server.ts`).href,
    clientUrl: pathToFileURL(require.resolve("@modelcontextprotocol/sdk/client/index.js")).href,
    transportUrl: pathToFileURL(require.resolve("@modelcontextprotocol/sdk/inMemory.js")).href,
  };
  const gates = commands.map(() => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)));
  const workers = commands.map((command, index) => new Worker(unblockedRaceWorkerSource, {
    eval: true, workerData: { databasePath, nowMs, command, gate: gates[index], ...moduleUrls },
  }));
  const channels = workers.map((worker) => {
    let markReady!: () => void;
    let resolveResult!: (outcome: { ok: boolean; value?: unknown; code?: string; message?: string }) => void;
    let rejectResult!: (error: Error) => void;
    const ready = new Promise<void>((resolve) => { markReady = resolve; });
    const result = new Promise<{ ok: boolean; value?: unknown; code?: string; message?: string }>((resolve, reject) => {
      resolveResult = resolve; rejectResult = reject;
    });
    worker.on("message", (message: { type: string; outcome?: unknown; message?: string }) => {
      if (message.type === "ready") markReady();
      else if (message.type === "result") resolveResult(message.outcome);
      else if (message.type === "fatal") rejectResult(new Error(message.message));
    });
    worker.once("error", rejectResult);
    worker.once("exit", (code) => { if (code !== 0) rejectResult(new Error(`Unblocked race worker exited with code ${code}`)); });
    return { ready, result };
  });
  await Promise.all(channels.map(({ ready }) => ready));
  return {
    release(index: number) { Atomics.store(gates[index], 0, 1); Atomics.notify(gates[index], 0, 1); },
    result(index: number) { return channels[index].result; },
    async close() { await Promise.all(workers.map((worker) => worker.terminate())); },
  };
}

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
    expect(content).toMatch(/Schema 4 is the original additive task-authority schema/);
    expect(content).toMatch(/Schema 5 is a separate additive migration/);
    expect(content).toMatch(/latest schema is 5/i);
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
  const supportedAbiByNodeMajor: Record<number, string> = { 22: "127", 24: "137", 26: "147" };
  const nodeMajor = Number(/^v(\d+)/.exec(process.version)?.[1]);

  it("requires complete supported-runtime evidence before compatibility is accepted", () => {
    expect(Object.hasOwn(supportedAbiByNodeMajor, nodeMajor)).toBe(true);
    expect(process.versions.modules).toBe(supportedAbiByNodeMajor[nodeMajor]);
    expect(process.versions.napi).toBeDefined();
  });

  it("exposes the bounded snapshot/query tool inventory used by the benchmark", async () => {
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

  it("reports the latest schema as the runtime migration boundary", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-runtime-facts-"));
    const databasePath = path.join(directory, "runtime.db");
    migrateDatabase(databasePath);
    const runtimeDb = new DatabaseConstructor!(databasePath, { readonly: true });
    try {
      expect(runtimeDb.pragma("user_version", { simple: true })).toBe(LATEST_SCHEMA_VERSION);
      expect(runtimeDb.prepare("SELECT 1 FROM sqlite_master WHERE name = 'direct_task_versions'").get()).toBeDefined();
    } finally {
      runtimeDb.close();
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

nativeDescribe("release integration — E2E direct-v1 lifecycle through composed server", () => {
  let testDb: { path: string; database: Database.Database };

  beforeEach(() => {
    testDb = createTestDatabase("forgespec-release-");
  });

  afterEach(() => {
    testDb.database.close();
  });

  afterAll(() => {
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
        asserted_provenance: {
          kind: "asserted",
          asserted_actor: "reviewer",
          boundary: "local-trusted-client",
          mode: "direct-v1",
          approval_ref: {
            provider: "forgespec",
            kind: "approval",
            external_id: "e2e-approval-001",
            digest: "sha256:" + "b".repeat(64),
          },
        },
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

    const boardResult = await client.callTool({
      name: "tb_create_board",
      arguments: {
        project: "delta-recovery",
        name: "Self-contained delta recovery board",
        tasks: [{ title: "Delta recovery task" }],
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        actor: "e2e-owner",
        idempotency_key: "delta-recovery-board",
      },
    });
    expect(boardResult.isError).not.toBe(true);
    const board = boardResult.structuredContent as { board_id: string };

    const result = await client.callTool({
      name: "tb_events",
      arguments: { board_id: board.board_id, actor: "e2e-owner", limit: 100 },
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

const authorityCapability: CapabilityContext = {
  coordinationMode: "direct-v1",
  apiVersion: "1.0.0",
  schemaVersion: "1.0.0",
  negotiated: ["task-authority@1.0.0"],
};

function authoritySnapshot(database: Database.Database): string {
  return JSON.stringify({
    boards: database.prepare("SELECT * FROM direct_boards ORDER BY board_id").all(),
    tasks: database.prepare("SELECT * FROM direct_tasks ORDER BY task_id").all(),
    grants: database.prepare("SELECT * FROM task_authority_grants ORDER BY grant_id").all(),
    handoffs: database.prepare("SELECT * FROM task_authority_handoffs ORDER BY handoff_id").all(),
    refs: database.prepare("SELECT * FROM task_authority_handoff_refs ORDER BY handoff_id, ordinal").all(),
    revocations: database.prepare("SELECT * FROM task_authority_revocations ORDER BY revoke_id").all(),
    events: database.prepare("SELECT * FROM authority_events ORDER BY id").all(),
  });
}

nativeDescribe("WU-07 authority security matrix", () => {
  it("tb_approve requires active exact approve authority plus allowed actor and canonical asserted provenance", async () => {
    const created = createTestDatabase("forgespec-delegated-approve-");
    const clock = new FakeClock(Date.now() - 10_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Delegated approve",
      actor: "owner",
      idempotency_key: "delegated-approve-board",
      tasks: ["Approved resource", "Wrong resource", "Wrong operation", "Expired grant", "Revoked grant"].map((title) => ({
        title,
        gates: [{
          gate_id: "security",
          required_for: ["done" as const],
          allowed_actors: ["reviewer", "operation-reviewer", "expired-reviewer", "revoked-reviewer"],
        }],
      })),
    });
    const approveGrant = service.grantAuthority({
      actor: "owner",
      resource: { kind: "task", boardId: board.board_id, taskId: board.task_ids[0] },
      granteeActor: "reviewer",
      operation: "approve",
      expiresAtMs: clock.now() + 60_000,
      idempotencyKey: "delegated-approve-grant",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    });
    const operationGrant = service.grantAuthority({
      actor: "owner",
      resource: { kind: "task", boardId: board.board_id, taskId: board.task_ids[2] },
      granteeActor: "operation-reviewer",
      operation: "update",
      expiresAtMs: clock.now() + 60_000,
      idempotencyKey: "delegated-approve-wrong-operation",
      expectedBoardRevision: approveGrant.boardRevision,
      capability: authorityCapability,
    });
    const expiredGrant = service.grantAuthority({
      actor: "owner",
      resource: { kind: "task", boardId: board.board_id, taskId: board.task_ids[3] },
      granteeActor: "expired-reviewer",
      operation: "approve",
      expiresAtMs: clock.now() + 1,
      idempotencyKey: "delegated-approve-expired",
      expectedBoardRevision: operationGrant.boardRevision,
      capability: authorityCapability,
    });
    const revokedGrant = service.grantAuthority({
      actor: "owner",
      resource: { kind: "task", boardId: board.board_id, taskId: board.task_ids[4] },
      granteeActor: "revoked-reviewer",
      operation: "approve",
      expiresAtMs: clock.now() + 60_000,
      idempotencyKey: "delegated-approve-revoked",
      expectedBoardRevision: expiredGrant.boardRevision,
      capability: authorityCapability,
    });
    service.revokeAuthority({
      actor: "owner",
      grantId: revokedGrant.value.grantId,
      idempotencyKey: "delegated-approve-revoke",
      expectedBoardRevision: revokedGrant.boardRevision,
      capability: authorityCapability,
    });

    const server = createServer({ database: () => created.database, clock });
    const client = new Client({ name: "delegated-approve", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const provenance = {
      kind: "asserted",
      asserted_actor: "reviewer",
      boundary: "local-trusted-client",
      mode: "direct-v1",
      approval_ref: {
        provider: "forgespec",
        kind: "approval",
        external_id: "delegated-approval",
        digest: `sha256:${"f".repeat(64)}`,
      },
    };
    const base = {
      name: "tb_approve",
      arguments: {
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        task_id: board.task_ids[0],
        gate_id: "security",
        decision: "allow",
        expected_revision: 1,
        actor: "reviewer",
        capability: authorityCapability,
        asserted_provenance: provenance,
      },
    };

    const allowed = await client.callTool({
      ...base,
      arguments: { ...base.arguments, idempotency_key: "delegated-approve-success" },
    });
    expect(allowed.isError).not.toBe(true);
    const persisted = created.database.prepare("SELECT * FROM task_approval_provenance").all();
    expect(persisted).toHaveLength(1);

    const snapshot = () => JSON.stringify({
      gates: created.database.prepare("SELECT * FROM approval_gates ORDER BY task_id, gate_id").all(),
      decisions: created.database.prepare("SELECT * FROM approval_decisions ORDER BY id").all(),
      provenance: created.database.prepare("SELECT * FROM task_approval_provenance ORDER BY decision_event_id").all(),
      events: created.database.prepare("SELECT * FROM authority_events WHERE event_type = 'approval_decided' ORDER BY id").all(),
    });
    const unchanged = snapshot();
    const deniedInputs = [
      { idempotency_key: "approve-wrong-resource", task_id: board.task_ids[1] },
      {
        idempotency_key: "approve-wrong-operation",
        task_id: board.task_ids[2],
        actor: "operation-reviewer",
        asserted_provenance: { ...provenance, asserted_actor: "operation-reviewer" },
      },
      {
        idempotency_key: "approve-expired-grant",
        task_id: board.task_ids[3],
        actor: "expired-reviewer",
        asserted_provenance: { ...provenance, asserted_actor: "expired-reviewer" },
      },
      {
        idempotency_key: "approve-revoked-grant",
        task_id: board.task_ids[4],
        actor: "revoked-reviewer",
        asserted_provenance: { ...provenance, asserted_actor: "revoked-reviewer" },
      },
      { idempotency_key: "approve-no-capability", capability: undefined },
      { idempotency_key: "approve-wrong-actor", actor: "intruder", asserted_provenance: { ...provenance, asserted_actor: "intruder" } },
      { idempotency_key: "approve-missing-provenance", asserted_provenance: undefined },
      { idempotency_key: "approve-malformed-provenance", asserted_provenance: { ...provenance, approval_ref: { ...provenance.approval_ref, digest: "sha256:weak" } } },
      { idempotency_key: "approve-conflicting-source", evidence_links: [provenance.approval_ref] },
    ];
    for (const overrides of deniedInputs) {
      const result = await client.callTool({ ...base, arguments: { ...base.arguments, ...overrides } });
      expect(result.isError, overrides.idempotency_key).toBe(true);
      expect(snapshot()).toBe(unchanged);
    }

    const replayChanged = await client.callTool({
      ...base,
      arguments: {
        ...base.arguments,
        idempotency_key: "delegated-approve-success",
        asserted_provenance: {
          ...provenance,
          approval_ref: { ...provenance.approval_ref, external_id: "changed-on-replay" },
        },
      },
    });
    expect(replayChanged.isError).toBe(true);
    expect(snapshot()).toBe(unchanged);

    await client.close();
    await server.close();
    created.database.close();
  });

  it("propagates task-authority context through each protected public mutation exactly once", async () => {
    const created = createTestDatabase("forgespec-mutation-capability-");
    const setup = new TaskService(created.database);
    const board = setup.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "mutation-capability",
      name: "Protected mutation board",
      actor: "owner",
      idempotency_key: "mutation-capability-board",
      tasks: [
        { title: "Update task" },
        {
          title: "Approval task",
          gates: [{ gate_id: "security", required_for: ["done"], allowed_actors: ["owner"] }],
        },
        { title: "Recovery task" },
      ],
    });
    const claim = setup.claimDirectTask({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      task_id: board.task_ids[2],
      agent: "worker",
      expected_revision: 1,
      lease_seconds: 15,
      idempotency_key: "mutation-capability-claim",
    });
    created.database.prepare("UPDATE task_attempts SET expires_at_ms = ? WHERE id = ?")
      .run(Date.now() - 10_000, claim.attempt_id);

    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "mutation-capability", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const decisionSpy = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");
    const directContext = {
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      actor: "owner",
      capability: authorityCapability,
    };

    const recovered = await client.callTool({
      name: "tb_recover_claims",
      arguments: {
        board_id: board.board_id,
        expected_board_revision: claim.board_revision,
        attempt_ids: [claim.attempt_id],
        idempotency_key: "mutation-capability-recover",
        ...directContext,
      },
    });
    expect(recovered.isError).not.toBe(true);
    const recoveredTask = created.database.prepare("SELECT revision FROM direct_tasks WHERE task_id = ?")
      .get(board.task_ids[2]) as { revision: number };

    const requeued = await client.callTool({
      name: "tb_requeue",
      arguments: {
        task_id: board.task_ids[2],
        expected_revision: recoveredTask.revision,
        reason: "retry under delegated authority",
        idempotency_key: "mutation-capability-requeue",
        ...directContext,
      },
    });
    expect(requeued.isError).not.toBe(true);

    const updated = await client.callTool({
      name: "tb_update",
      arguments: {
        task_id: board.task_ids[0],
        expected_revision: 1,
        status: "blocked",
        idempotency_key: "mutation-capability-update",
        ...directContext,
      },
    });
    expect(updated.isError).not.toBe(true);

    const approved = await client.callTool({
      name: "tb_approve",
      arguments: {
        task_id: board.task_ids[1],
        gate_id: "security",
        decision: "allow",
        expected_revision: 1,
        idempotency_key: "mutation-capability-approve",
        asserted_provenance: {
          kind: "asserted",
          asserted_actor: "owner",
          boundary: "local-trusted-client",
          mode: "direct-v1",
          approval_ref: {
            provider: "forgespec",
            kind: "approval",
            external_id: "mutation-capability-approval",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
        ...directContext,
      },
    });
    expect(approved.isError).not.toBe(true);

    const boardRevision = (created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?")
      .get(board.board_id) as { revision: number }).revision;
    const added = await client.callTool({
      name: "tb_add_task",
      arguments: {
        board_id: board.board_id,
        title: "Delegated addition",
        expected_board_revision: boardRevision,
        idempotency_key: "mutation-capability-add",
        ...directContext,
      },
    });
    expect(added.isError).not.toBe(true);

    expect(decisionSpy).toHaveBeenCalledTimes(5);
    expect(decisionSpy.mock.calls.map((call) => call[1].operation)).toEqual([
      "recover", "recover", "update", "approve", "add",
    ]);
    for (const call of decisionSpy.mock.calls) {
      expect(call[1].capability).toEqual(authorityCapability);
    }

    decisionSpy.mockRestore();
    await client.close();
    await server.close();
    created.database.close();
  });

  it("enforces active, expired, revoked, and out-of-scope grants at the MCP mutation boundary", async () => {
    const created = createTestDatabase("forgespec-mutation-grant-matrix-");
    const clock = new FakeClock(Date.now() - 20_000);
    const setup = new TaskService(created.database, { clock });
    const board = setup.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "mutation-grant-matrix",
      name: "Mutation grant matrix",
      actor: "owner",
      idempotency_key: "mutation-grant-board",
      tasks: [{ title: "Update target" }, { title: "Requeue target" }],
    });
    const updateResource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const requeueResource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[1] };
    const active = setup.grantAuthority({
      actor: "owner",
      resource: updateResource,
      granteeActor: "active-updater",
      operation: "update",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "active-update-grant",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    });
    const expired = setup.grantAuthority({
      actor: "owner",
      resource: { kind: "board", boardId: board.board_id },
      granteeActor: "expired-adder",
      operation: "add",
      expiresAtMs: clock.now() + 1_000,
      idempotencyKey: "expired-add-grant",
      expectedBoardRevision: active.boardRevision,
      capability: authorityCapability,
    });
    const revocable = setup.grantAuthority({
      actor: "owner",
      resource: { kind: "board", boardId: board.board_id },
      granteeActor: "revoked-recoverer",
      operation: "recover",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "revoked-recover-grant",
      expectedBoardRevision: expired.boardRevision,
      capability: authorityCapability,
    });
    const revoked = setup.revokeAuthority({
      actor: "owner",
      grantId: revocable.value.grantId,
      idempotencyKey: "revoke-recover-grant",
      expectedBoardRevision: revocable.boardRevision,
      capability: authorityCapability,
    });
    setup.grantAuthority({
      actor: "owner",
      resource: requeueResource,
      granteeActor: "wrong-scope-requeuer",
      operation: "update",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "wrong-scope-requeue-grant",
      expectedBoardRevision: revoked.boardRevision,
      capability: authorityCapability,
    });
    created.database.prepare(
      "UPDATE direct_tasks SET status = 'blocked', blocked_reason = 'requeue_required' WHERE task_id = ?"
    ).run(board.task_ids[1]);

    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "mutation-grant-matrix", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const directContext = {
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      capability: authorityCapability,
    };

    const allowed = await client.callTool({
      name: "tb_update",
      arguments: {
        task_id: board.task_ids[0],
        expected_revision: 1,
        status: "blocked",
        actor: "active-updater",
        idempotency_key: "active-grant-update",
        ...directContext,
      },
    });
    expect(allowed.isError).not.toBe(true);

    const deniedCases = [
      {
        name: "expired add grant",
        tool: "tb_add_task",
        arguments: () => ({
          board_id: board.board_id,
          title: "Must not be added",
          expected_board_revision: (created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?")
            .get(board.board_id) as { revision: number }).revision,
          actor: "expired-adder",
          idempotency_key: "expired-grant-add",
          ...directContext,
        }),
      },
      {
        name: "revoked recover grant",
        tool: "tb_recover_claims",
        arguments: () => ({
          board_id: board.board_id,
          expected_board_revision: (created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?")
            .get(board.board_id) as { revision: number }).revision,
          actor: "revoked-recoverer",
          idempotency_key: "revoked-grant-recover",
          ...directContext,
        }),
      },
      {
        name: "out-of-scope requeue grant",
        tool: "tb_requeue",
        arguments: () => ({
          task_id: board.task_ids[1],
          expected_revision: 1,
          reason: "must not requeue",
          actor: "wrong-scope-requeuer",
          idempotency_key: "wrong-scope-grant-requeue",
          ...directContext,
        }),
      },
    ];
    for (const testCase of deniedCases) {
      const before = authoritySnapshot(created.database);
      const result = await client.callTool({ name: testCase.tool, arguments: testCase.arguments() });
      expect(result.isError, testCase.name).toBe(true);
      expect(result.structuredContent, testCase.name).toMatchObject({
        ok: false,
        error: { category: "authorization", code: "AUTH_OWNER_OR_GRANT_REQUIRED" },
      });
      expect(authoritySnapshot(created.database), testCase.name).toBe(before);
    }

    await client.close();
    await server.close();
    created.database.close();
  });

  it("serializes same-key grant, handoff, and revoke replays with one canonical effect", async () => {
    const created = createTestDatabase("forgespec-delegation-race-");
    const other = openTestDatabase(created.path);
    const clock = new FakeClock(1_800_000_000_000);
    const first = new TaskService(created.database, { clock });
    const second = new TaskService(other, { clock });
    const board = first.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Delegation race",
      actor: "owner",
      idempotency_key: "delegation-board",
      tasks: [{ title: "Protected task" }],
    });
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const grant: GrantCommand = {
      actor: "owner",
      resource,
      granteeActor: "worker",
      operation: "update",
      expiresAtMs: clock.now() + 60_000,
      idempotencyKey: "grant-same-key",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    };

    const [grantA, grantB] = await Promise.all([
      Promise.resolve().then(() => first.grantAuthority(grant)),
      Promise.resolve().then(() => second.grantAuthority(grant)),
    ]);
    expect(grantB).toEqual({ ...grantA, replayed: true });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_grants").get()).toEqual({ count: 1 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events WHERE event_type = 'authority_granted'").get())
      .toEqual({ count: 1 });

    const handoff: HandoffCommand = {
      actor: "owner",
      toActor: "delegate",
      resource,
      operations: ["update", "revoke"],
      expiresAtMs: clock.now() + 30_000,
      refs: [{
        provider: "forgespec",
        kind: "task",
        externalId: board.task_ids[0],
        digest: `sha256:${"b".repeat(64)}`,
      }],
      idempotencyKey: "handoff-same-key",
      expectedBoardRevision: grantA.boardRevision,
      capability: authorityCapability,
    };
    const [handoffA, handoffB] = await Promise.all([
      Promise.resolve().then(() => first.handoffAuthority(handoff)),
      Promise.resolve().then(() => second.handoffAuthority(handoff)),
    ]);
    expect(handoffB).toEqual({ ...handoffA, replayed: true });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_handoffs").get()).toEqual({ count: 1 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_handoff_refs").get()).toEqual({ count: 1 });
    expect(JSON.stringify(created.database.prepare("SELECT * FROM task_authority_handoffs").all())).not.toMatch(/transcript/i);

    clock.advance(60_000);
    const revoke: RevokeCommand = {
      actor: "owner",
      grantId: grantA.value.grantId,
      reason: "expired concurrently",
      idempotencyKey: "revoke-same-key",
      expectedBoardRevision: handoffA.boardRevision,
      capability: authorityCapability,
    };
    const [revokeA, revokeB] = await Promise.all([
      Promise.resolve().then(() => first.revokeAuthority(revoke)),
      Promise.resolve().then(() => second.revokeAuthority(revoke)),
    ]);
    expect(revokeB).toEqual({ ...revokeA, replayed: true });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_revocations").get()).toEqual({ count: 1 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events WHERE event_type = 'authority_revoked'").get())
      .toEqual({ count: 1 });
    expect(JSON.parse((created.database.prepare("SELECT metadata_json FROM direct_boards WHERE board_id = ?")
      .get(board.board_id) as { metadata_json: string }).metadata_json)).toMatchObject({ owner_actor: "owner" });

    other.close();
    created.database.close();
  });

  it("keeps asserted approval provenance immutable on replay and conflicting reuse", () => {
    const created = createTestDatabase("forgespec-provenance-replay-");
    const service = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Provenance replay",
      actor: "owner",
      idempotency_key: "provenance-board",
      tasks: [{
        title: "Approval task",
        gates: [{ gate_id: "security", required_for: ["done"], allowed_actors: ["reviewer"] }],
      }],
    });
    const input = {
      coordination_mode: "direct-v1" as const,
      api_version: "1.0.0",
      schema_version: "1.0.0",
      task_id: board.task_ids[0],
      gate_id: "security",
      decision: "allow" as const,
      expected_revision: 1,
      actor: "reviewer",
      idempotency_key: "approval-replay",
      asserted_provenance: {
        kind: "asserted" as const,
        asserted_actor: "reviewer",
        boundary: "local-trusted-client" as const,
        mode: "direct-v1" as const,
        approval_ref: {
          provider: "forgespec",
          kind: "approval",
          external_id: "approval-original",
          digest: `sha256:${"c".repeat(64)}`,
        },
      },
    };
    const original = service.approveDirectTask(input);
    const replay = service.approveDirectTask(input);
    expect(replay).toEqual({ ...original, replayed: true });
    const persisted = created.database.prepare("SELECT * FROM task_approval_provenance").all();
    expect(() => service.approveDirectTask({
      ...input,
      asserted_provenance: {
        ...input.asserted_provenance,
        approval_ref: { ...input.asserted_provenance.approval_ref, external_id: "approval-altered" },
      },
    })).toThrowError(expect.objectContaining({ code: "idempotency_conflict" }));
    expect(created.database.prepare("SELECT * FROM task_approval_provenance").all()).toEqual(persisted);
    expect(persisted).toHaveLength(1);
    created.database.close();
  });

  it("marks explicit and evidence-link-derived asserted provenance without inventing authentication", async () => {
    const created = createTestDatabase("forgespec-provenance-source-");
    const service = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Provenance source",
      actor: "owner",
      idempotency_key: "provenance-source-board",
      tasks: ["Explicit", "Derived", "Ambiguous", "Weak", "Missing"].map((title) => ({
        title,
        gates: [{ gate_id: "security", required_for: ["done" as const], allowed_actors: ["reviewer"] }],
      })),
    });
    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "provenance-source", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const base = {
      gate_id: "security",
      decision: "allow",
      expected_revision: 1,
      actor: "reviewer",
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
    };
    const reference = {
      provider: "forgespec",
      kind: "approval",
      external_id: "approval-source",
      digest: `sha256:${"e".repeat(64)}`,
    };

    const explicit = await client.callTool({
      name: "tb_approve",
      arguments: {
        ...base,
        task_id: board.task_ids[0],
        idempotency_key: "explicit-source",
        asserted_provenance: {
          kind: "asserted",
          asserted_actor: "reviewer",
          boundary: "local-trusted-client",
          mode: "direct-v1",
          approval_ref: reference,
        },
      },
    });
    expect(explicit.isError).not.toBe(true);
    const derived = await client.callTool({
      name: "tb_approve",
      arguments: {
        ...base,
        task_id: board.task_ids[1],
        idempotency_key: "derived-source",
        evidence_links: [{ ...reference, external_id: "derived-source" }],
      },
    });
    expect(derived.isError).not.toBe(true);

    const persistedDetails = created.database.prepare(
      "SELECT resource_id, details_json FROM authority_events WHERE event_type = 'approval_decided' ORDER BY resource_id"
    ).all() as Array<{ resource_id: string; details_json: string }>;
    expect(persistedDetails.map(({ resource_id, details_json }) => ({
      resource_id,
      source: (JSON.parse(details_json) as { provenance_source: string }).provenance_source,
    }))).toEqual([
      { resource_id: board.task_ids[1], source: "evidence-link-derived" },
      { resource_id: board.task_ids[0], source: "explicit" },
    ].sort((left, right) => left.resource_id.localeCompare(right.resource_id)));
    expect(persistedDetails.map(({ details_json }) => details_json)).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/authenticat/i)])
    );

    const sourceChangeReplay = await client.callTool({
      name: "tb_approve",
      arguments: {
        ...base,
        task_id: board.task_ids[1],
        idempotency_key: "derived-source",
        asserted_provenance: {
          kind: "asserted",
          source: "explicit",
          asserted_actor: "reviewer",
          boundary: "local-trusted-client",
          mode: "direct-v1",
          approval_ref: { ...reference, external_id: "derived-source" },
        },
      },
    });
    expect(sourceChangeReplay.isError).toBe(true);
    expect(sourceChangeReplay.structuredContent).toMatchObject({
      error: { category: "idempotency", code: "idempotency_conflict" },
    });

    const countsBeforeDenials = created.database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM approval_decisions) AS decisions,
         (SELECT COUNT(*) FROM task_approval_provenance) AS provenance,
         (SELECT COUNT(*) FROM authority_events WHERE event_type = 'approval_decided') AS events`
    ).get();
    const denied = await Promise.all([
      client.callTool({
        name: "tb_approve",
        arguments: {
          ...base,
          task_id: board.task_ids[2],
          idempotency_key: "ambiguous-source",
          asserted_provenance: {
            kind: "asserted",
            asserted_actor: "reviewer",
            boundary: "local-trusted-client",
            mode: "direct-v1",
            source: "explicit",
            approval_ref: reference,
          },
          evidence_links: [reference],
        },
      }),
      client.callTool({
        name: "tb_approve",
        arguments: {
          ...base,
          task_id: board.task_ids[3],
          idempotency_key: "weak-source",
          evidence_links: [{ ...reference, digest: "sha256:weak" }],
        },
      }),
      client.callTool({
        name: "tb_approve",
        arguments: { ...base, task_id: board.task_ids[4], idempotency_key: "missing-source" },
      }),
    ]);
    expect(denied.every((result) => result.isError)).toBe(true);
    expect(created.database.prepare(
      `SELECT
         (SELECT COUNT(*) FROM approval_decisions) AS decisions,
         (SELECT COUNT(*) FROM task_approval_provenance) AS provenance,
         (SELECT COUNT(*) FROM authority_events WHERE event_type = 'approval_decided') AS events`
    ).get()).toEqual(countsBeforeDenials);

    await client.close();
    await server.close();
    created.database.close();
    const restarted = openTestDatabase(created.path);
    expect(restarted.prepare(
      "SELECT details_json FROM authority_events WHERE event_type = 'approval_decided' ORDER BY resource_id"
    ).all()).toEqual(persistedDetails.map(({ details_json }) => ({ details_json })));
    expect(() => restarted.prepare(
      "UPDATE authority_events SET details_json = '{}' WHERE event_type = 'approval_decided'"
    ).run()).toThrow(/immutable/);
    restarted.close();
  });

  it("allows the grantor to revoke after expiry without rewriting the board owner", () => {
    const created = createTestDatabase("forgespec-grantor-revoke-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Grantor revoke",
      actor: "owner",
      idempotency_key: "grantor-board",
      tasks: [{ title: "Protected task" }],
    });
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const parent = service.grantAuthority({
      actor: "owner",
      resource,
      granteeActor: "grantor",
      operation: "update",
      expiresAtMs: clock.now() + 60_000,
      idempotencyKey: "parent-grant",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    });
    const child = service.grantAuthority({
      actor: "grantor",
      resource,
      granteeActor: "worker",
      operation: "update",
      expiresAtMs: clock.now() + 30_000,
      idempotencyKey: "child-grant",
      expectedBoardRevision: parent.boardRevision,
      capability: authorityCapability,
    });
    clock.advance(30_000);
    const revoked = service.revokeAuthority({
      actor: "grantor",
      grantId: child.value.grantId,
      idempotencyKey: "grantor-revoke-after-expiry",
      expectedBoardRevision: child.boardRevision,
      capability: authorityCapability,
    });
    expect(revoked.value.grantId).toBe(child.value.grantId);
    expect(new TaskAuthorityService(created.database).authorizeTaskOperation(created.database, {
      actor: "worker",
      operation: "update",
      resource,
      capability: authorityCapability,
      nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    expect(JSON.parse((created.database.prepare("SELECT metadata_json FROM direct_boards WHERE board_id = ?")
      .get(board.board_id) as { metadata_json: string }).metadata_json)).toMatchObject({ owner_actor: "owner" });
    created.database.close();
  });

  it("executes 100 percent of the declared negative manifest with stable codes and unchanged snapshots", () => {
    const created = createTestDatabase("forgespec-negative-manifest-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Negative manifest",
      actor: "owner",
      idempotency_key: "negative-board",
      tasks: [{ title: "Protected task" }],
    });
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const authorizer = new TaskAuthorityService(created.database);
    const activeGrant = service.grantAuthority({
      actor: "owner",
      resource,
      granteeActor: "revoked-worker",
      operation: "update",
      expiresAtMs: clock.now() + 60_000,
      idempotencyKey: "negative-grant",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    });
    const revoked = service.revokeAuthority({
      actor: "owner",
      grantId: activeGrant.value.grantId,
      idempotencyKey: "negative-revoke",
      expectedBoardRevision: activeGrant.boardRevision,
      capability: authorityCapability,
    });
    const expiredGrant = service.grantAuthority({
      actor: "owner",
      resource,
      granteeActor: "expired-worker",
      operation: "update",
      expiresAtMs: clock.now() + 50,
      idempotencyKey: "expired-grant",
      expectedBoardRevision: revoked.boardRevision,
      capability: authorityCapability,
    });
    service.grantAuthority({
      actor: "owner",
      resource,
      granteeActor: "scoped-worker",
      operation: "update",
      expiresAtMs: clock.now() + 60_000,
      idempotencyKey: "scoped-grant",
      expectedBoardRevision: expiredGrant.boardRevision,
      capability: authorityCapability,
    });
    clock.advance(50);

    const cases = [
      {
        name: "unknown operation",
        expected: "AUTH_UNKNOWN_OPERATION",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "owner", operation: "unknown" as never, resource, nowMs: clock.now(),
        }),
      },
      {
        name: "incomplete context",
        expected: "AUTH_CONTEXT_REQUIRED",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "", operation: "update", resource, nowMs: clock.now(),
        }),
      },
      {
        name: "non-owner update without attempt or grant",
        expected: "AUTH_OWNER_OR_GRANT_REQUIRED",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "intruder", operation: "update", resource, nowMs: clock.now(), capability: authorityCapability,
        }),
      },
      {
        name: "non-owner add without grant",
        expected: "AUTH_OWNER_OR_GRANT_REQUIRED",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "intruder", operation: "add", resource: { kind: "board", boardId: board.board_id },
          nowMs: clock.now(), capability: authorityCapability,
        }),
      },
      {
        name: "revoked grant use",
        expected: "AUTH_OWNER_OR_GRANT_REQUIRED",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "revoked-worker", operation: "update", resource, nowMs: clock.now(), capability: authorityCapability,
        }),
      },
      {
        name: "expired grant use at E",
        expected: "AUTH_OWNER_OR_GRANT_REQUIRED",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "expired-worker", operation: "update", resource, nowMs: clock.now(), capability: authorityCapability,
        }),
      },
      {
        name: "grant outside operation scope",
        expected: "AUTH_OWNER_OR_GRANT_REQUIRED",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "scoped-worker", operation: "read_task", resource, nowMs: clock.now(), capability: authorityCapability,
        }),
      },
      {
        name: "missing capability cannot grant",
        expected: "AUTH_CAPABILITY_REQUIRED",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "owner", operation: "grant", resource, nowMs: clock.now(),
          delegation: { kind: "grant", granteeActor: "worker", operation: "update", expiresAtMs: clock.now() + 10_000 },
        }),
      },
      {
        name: "unauthorized grant",
        expected: "AUTH_SCOPE_MISMATCH",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "intruder", operation: "grant", resource, nowMs: clock.now(), capability: authorityCapability,
          delegation: { kind: "grant", granteeActor: "worker", operation: "update", expiresAtMs: clock.now() + 10_000 },
        }),
      },
      {
        name: "unauthorized handoff",
        expected: "AUTH_SCOPE_MISMATCH",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "intruder", operation: "handoff", resource, nowMs: clock.now(), capability: authorityCapability,
          delegation: {
            kind: "handoff", toActor: "worker", operations: ["update"], expiresAtMs: clock.now() + 10_000,
            refs: [{ provider: "forgespec", kind: "task", externalId: board.task_ids[0], digest: `sha256:${"d".repeat(64)}` }],
          },
        }),
      },
      {
        name: "unauthorized revoke",
        expected: "AUTH_SCOPE_MISMATCH",
        run: () => authorizer.authorizeTaskOperation(created.database, {
          actor: "intruder", operation: "revoke", resource, nowMs: clock.now(), capability: authorityCapability,
          delegation: { kind: "revoke", grantId: activeGrant.value.grantId },
        }),
      },
    ];

    let executed = 0;
    for (const testCase of cases) {
      const before = authoritySnapshot(created.database);
      const decision = testCase.run();
      expect(decision, testCase.name).toMatchObject({ allowed: false, code: testCase.expected });
      expect(authoritySnapshot(created.database), testCase.name).toBe(before);
      executed += 1;
    }
    expect(executed).toBe(cases.length);
    expect(executed).toBe(11);
    created.database.close();
  });

  it("prevents omitted or forged legacy mode from mutating or revealing direct-v1 resources", async () => {
    const created = createTestDatabase("forgespec-anti-downgrade-");
    const service = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Anti downgrade",
      actor: "owner",
      idempotency_key: "anti-downgrade-board",
      tasks: [{ title: "Secret direct task" }],
    });
    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "anti-downgrade", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const before = authoritySnapshot(created.database);

    const omittedMutation = await client.callTool({
      name: "tb_update",
      arguments: { task_id: board.task_ids[0], status: "blocked" },
    });
    expect(omittedMutation.isError).toBe(true);
    expect(omittedMutation.structuredContent).toMatchObject({
      ok: false,
      error: { category: "compatibility", code: "legacy_direct_bypass" },
    });
    const forgedLegacyRead = await client.callTool({
      name: "tb_get",
      arguments: { task_id: board.task_ids[0] },
    });
    expect(JSON.stringify(forgedLegacyRead.structuredContent ?? forgedLegacyRead.content)).not.toContain("Secret direct task");
    expect(authoritySnapshot(created.database)).toBe(before);

    await client.close();
    await server.close();
    created.database.close();
  });

  it("tb_unblocked denies missing, expired, revoked, and out-of-scope direct-v1 authority without effects", async () => {
    const created = createTestDatabase("forgespec-unblocked-authority-");
    const clock = new FakeClock(Date.now() - 20_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "security-matrix",
      name: "Protected unblocked board",
      actor: "owner",
      idempotency_key: "unblocked-board",
      tasks: [{ title: "Protected ready task" }],
    });
    const boardResource = { kind: "board" as const, boardId: board.board_id };
    const taskResource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const expired = service.grantAuthority({
      actor: "owner",
      resource: boardResource,
      granteeActor: "expired-reader",
      operation: "read_board",
      expiresAtMs: clock.now() + 1_000,
      idempotencyKey: "expired-read-board",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    });
    const active = service.grantAuthority({
      actor: "owner",
      resource: boardResource,
      granteeActor: "active-reader",
      operation: "read_board",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "active-read-board",
      expectedBoardRevision: expired.boardRevision,
      capability: authorityCapability,
    });
    const revocable = service.grantAuthority({
      actor: "owner",
      resource: boardResource,
      granteeActor: "revoked-reader",
      operation: "read_board",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "revoked-read-board",
      expectedBoardRevision: active.boardRevision,
      capability: authorityCapability,
    });
    const revoked = service.revokeAuthority({
      actor: "owner",
      grantId: revocable.value.grantId,
      idempotencyKey: "revoke-read-board",
      expectedBoardRevision: revocable.boardRevision,
      capability: authorityCapability,
    });
    service.grantAuthority({
      actor: "owner",
      resource: taskResource,
      granteeActor: "scoped-reader",
      operation: "read_task",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "scoped-read-task",
      expectedBoardRevision: revoked.boardRevision,
      capability: authorityCapability,
    });

    const legacyBoardId = generateId("board");
    const legacyTaskId = generateId("task");
    created.database.prepare("INSERT INTO boards (id, project, name) VALUES (?, ?, ?)")
      .run(legacyBoardId, "security-matrix", "Legacy unblocked board");
    created.database.prepare(
      "INSERT INTO tasks (id, board_id, title, status, dependencies) VALUES (?, ?, ?, 'ready', '[]')"
    ).run(legacyTaskId, legacyBoardId, "Legacy ready task");

    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "unblocked-authority", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const decisionSpy = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");
    const directContext = {
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      capability: authorityCapability,
    };

    const allowed = await client.callTool({
      name: "tb_unblocked",
      arguments: { board_id: board.board_id, actor: "active-reader", ...directContext },
    });
    expect(allowed.isError).not.toBe(true);
    expect(allowed.structuredContent).toMatchObject({
      board_id: board.board_id,
      unblocked_count: 1,
      tasks: [{ id: board.task_ids[0], title: "Protected ready task" }],
    });
    expect(decisionSpy).toHaveBeenCalledTimes(1);

    const deniedCases = [
      { name: "omitted mode", arguments: { board_id: board.board_id, actor: "owner" } },
      { name: "expired authority", arguments: { board_id: board.board_id, actor: "expired-reader", ...directContext } },
      { name: "revoked authority", arguments: { board_id: board.board_id, actor: "revoked-reader", ...directContext } },
      { name: "out-of-scope authority", arguments: { board_id: board.board_id, actor: "scoped-reader", ...directContext } },
    ];
    for (const [index, testCase] of deniedCases.entries()) {
      const before = authoritySnapshot(created.database);
      const result = await client.callTool({ name: "tb_unblocked", arguments: testCase.arguments });
      expect(result.isError, testCase.name).toBe(true);
      expect(result.structuredContent, testCase.name).toEqual({
        ok: false,
        error: {
          category: "authorization",
          code: "RESOURCE_NOT_AVAILABLE",
          message: "Resource is not available",
          data: { code: "RESOURCE_NOT_AVAILABLE" },
          retryable: false,
        },
      });
      expect(JSON.stringify(result.structuredContent), testCase.name).not.toContain(board.task_ids[0]);
      expect(authoritySnapshot(created.database), testCase.name).toBe(before);
      expect(decisionSpy, testCase.name).toHaveBeenCalledTimes(index + 2);
    }

    const legacy = await client.callTool({ name: "tb_unblocked", arguments: { board_id: legacyBoardId } });
    expect(legacy.isError).not.toBe(true);
    expect(JSON.parse((legacy.content[0] as { text: string }).text)).toMatchObject({
      board_id: legacyBoardId,
      unblocked_count: 1,
      tasks: [{ id: legacyTaskId, title: "Legacy ready task" }],
    });
    expect(decisionSpy).toHaveBeenCalledTimes(5);

    decisionSpy.mockRestore();
    await client.close();
    await server.close();
    created.database.close();
  });

  it("linearizes revoke against independent tb_unblocked workers without readiness or count leakage", async () => {
    for (let iteration = 0; iteration < 10; iteration += 1) {
      const created = createTestDatabase("forgespec-revoke-unblocked-race-");
      const clock = new FakeClock(1_900_000_100_000 + iteration);
      const service = new TaskService(created.database, { clock });
      const board = service.createDirectBoard({
        coordination_mode: "direct-v1", api_version: "1.0.0", schema_version: "1.0.0",
        project: "unblocked-race", name: "Unblocked race", actor: "owner",
        idempotency_key: `unblocked-race-board-${iteration}`, tasks: [{ title: "Secret ready task" }],
      });
      const grant = service.grantAuthority({
        actor: "owner", resource: { kind: "board", boardId: board.board_id }, granteeActor: "reader",
        operation: "read_board", expiresAtMs: clock.now() + 60_000,
        idempotencyKey: `unblocked-race-grant-${iteration}`, expectedBoardRevision: board.board_revision,
        capability: authorityCapability,
      });
      created.database.close();
      const readInput = {
        board_id: board.board_id, actor: "reader", coordination_mode: "direct-v1",
        api_version: "1.0.0", schema_version: "1.0.0", capability: authorityCapability,
      };
      const workers = await startUnblockedRaceWorkers(created.path, clock.now(), [{
        kind: "revoke",
        input: { actor: "owner", grantId: grant.value.grantId, idempotencyKey: `unblocked-race-revoke-${iteration}`,
          expectedBoardRevision: grant.boardRevision, capability: authorityCapability },
      }, { kind: "unblocked", input: readInput }]);
      try {
        if (iteration % 2 === 0) {
          workers.release(0);
          expect(await workers.result(0)).toMatchObject({ ok: true });
          workers.release(1);
          const denied = await workers.result(1);
          expect(denied).toMatchObject({ ok: true, value: { isError: true } });
          const serialized = JSON.stringify(denied);
          expect(serialized).toContain("RESOURCE_NOT_AVAILABLE");
          expect(serialized).not.toContain(board.board_id);
          expect(serialized).not.toContain(board.task_ids[0]);
          expect(serialized).not.toContain("unblocked_count");
          expect(serialized).not.toContain("Secret ready task");
        } else {
          workers.release(1);
          const allowed = await workers.result(1);
          expect(allowed).toMatchObject({
            ok: true,
            value: { structuredContent: {
              board_id: board.board_id, unblocked_count: 1, tasks: [{ id: board.task_ids[0] }],
            } },
          });
          expect((allowed.value as { isError?: boolean }).isError).not.toBe(true);
          workers.release(0);
          expect(await workers.result(0)).toMatchObject({ ok: true });
        }
      } finally {
        await workers.close();
      }

      const reopened = openTestDatabase(created.path);
      const server = createServer({ database: () => reopened });
      const client = new Client({ name: "unblocked-race-reopen", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const deniedAfterRestart = await client.callTool({ name: "tb_unblocked", arguments: readInput });
      expect(deniedAfterRestart.isError).toBe(true);
      expect(JSON.stringify(deniedAfterRestart)).not.toContain(board.task_ids[0]);
      await client.close();
      await server.close();
      reopened.close();
    }
  }, 30_000);
});

nativeDescribe("direct-v1 indistinguishable legacy reads and authorized board discovery", () => {
  it("tb_status and tb_get answer a protected direct-v1 ID exactly like a nonexistent ID", async () => {
    const created = createTestDatabase("forgespec-indistinguishable-");
    const service = new TaskService(created.database);
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "indistinguishable",
      name: "Secret indistinguishable board",
      actor: "owner",
      idempotency_key: "indistinguishable-board",
      tasks: [{ title: "Secret indistinguishable task" }],
    });
    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "indistinguishable", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const statusExisting = await client.callTool({ name: "tb_status", arguments: { board_id: board.board_id } });
    const statusMissing = await client.callTool({ name: "tb_status", arguments: { board_id: "board-indistinguishable-missing" } });
    expect(statusExisting.content).toEqual(statusMissing.content);
    expect(JSON.parse((statusExisting.content[0] as { text: string }).text)).toEqual({ error: "Board not found" });

    const getExisting = await client.callTool({ name: "tb_get", arguments: { task_id: board.task_ids[0] } });
    const getMissing = await client.callTool({ name: "tb_get", arguments: { task_id: "task-indistinguishable-missing" } });
    expect(getExisting.content).toEqual(getMissing.content);
    expect(JSON.parse((getExisting.content[0] as { text: string }).text)).toEqual({ error: "Task not found" });

    const serialized = JSON.stringify([statusExisting, getExisting]);
    expect(serialized).not.toContain(board.board_id);
    expect(serialized).not.toContain(board.task_ids[0]);
    expect(serialized).not.toContain("Secret indistinguishable");
    expect(serialized).not.toMatch(/direct-v1/i);

    await client.close();
    await server.close();
    created.database.close();
  });

  it("tb_list_boards includes direct-v1 boards only for the owner or an active grantee", async () => {
    const created = createTestDatabase("forgespec-board-discovery-");
    const clock = new FakeClock(Date.now() - 20_000);
    const service = new TaskService(created.database, { clock });
    const owned = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "discovery",
      name: "Owned direct board",
      actor: "owner",
      idempotency_key: "discovery-owned",
      tasks: [{ title: "Owned secret task" }],
    });
    const foreign = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "discovery",
      name: "Foreign direct board",
      actor: "other-owner",
      idempotency_key: "discovery-foreign",
      tasks: [{ title: "Foreign secret task" }],
    });
    const activeGrant = service.grantAuthority({
      actor: "owner",
      resource: { kind: "board", boardId: owned.board_id },
      granteeActor: "active-grantee",
      operation: "read_board",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "discovery-active-grant",
      expectedBoardRevision: owned.board_revision,
      capability: authorityCapability,
    });
    const expiredGrant = service.grantAuthority({
      actor: "owner",
      resource: { kind: "board", boardId: owned.board_id },
      granteeActor: "expired-grantee",
      operation: "read_board",
      expiresAtMs: clock.now() + 1_000,
      idempotencyKey: "discovery-expired-grant",
      expectedBoardRevision: activeGrant.boardRevision,
      capability: authorityCapability,
    });
    const revocable = service.grantAuthority({
      actor: "owner",
      resource: { kind: "board", boardId: owned.board_id },
      granteeActor: "revoked-grantee",
      operation: "read_board",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "discovery-revocable-grant",
      expectedBoardRevision: expiredGrant.boardRevision,
      capability: authorityCapability,
    });
    service.revokeAuthority({
      actor: "owner",
      grantId: revocable.value.grantId,
      idempotencyKey: "discovery-revoke-grant",
      expectedBoardRevision: revocable.boardRevision,
      capability: authorityCapability,
    });
    const legacyBoardId = generateId("board");
    created.database.prepare("INSERT INTO boards (id, project, name) VALUES (?, ?, ?)")
      .run(legacyBoardId, "discovery", "Legacy discovery board");

    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "board-discovery", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const directContext = {
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
    };

    const noActor = await client.callTool({ name: "tb_list_boards", arguments: { project: "discovery" } });
    const noActorBoards = JSON.parse((noActor.content[0] as { text: string }).text).boards;
    expect(noActorBoards.map((entry: Record<string, unknown>) => entry.id)).toEqual([legacyBoardId]);
    expect(JSON.stringify(noActorBoards)).not.toContain(owned.board_id);
    expect(JSON.stringify(noActorBoards)).not.toContain(foreign.board_id);

    const ownerListing = await client.callTool({
      name: "tb_list_boards",
      arguments: { project: "discovery", actor: "owner", ...directContext },
    });
    const ownerBoards = JSON.parse((ownerListing.content[0] as { text: string }).text).boards as Record<string, unknown>[];
    const ownerIds = ownerBoards.map((entry) => entry.id);
    expect(ownerIds).toEqual(expect.arrayContaining([legacyBoardId, owned.board_id]));
    const ownedEntry = ownerBoards.find((entry) => entry.id === owned.board_id);
    expect(ownedEntry).toMatchObject({ mode: "direct-v1", project: "discovery" });
    expect(typeof ownedEntry!.revision).toBe("number");
    expect(JSON.stringify(ownerBoards)).not.toContain(foreign.board_id);
    expect(JSON.stringify(ownerBoards)).not.toContain("Foreign direct board");

    const granteeListing = await client.callTool({
      name: "tb_list_boards",
      arguments: { project: "discovery", actor: "active-grantee", ...directContext, capability: authorityCapability },
    });
    const granteeBoards = JSON.parse((granteeListing.content[0] as { text: string }).text).boards;
    expect(granteeBoards.map((entry: Record<string, unknown>) => entry.id)).toEqual(
      expect.arrayContaining([legacyBoardId, owned.board_id])
    );
    expect(JSON.stringify(granteeBoards)).not.toContain(foreign.board_id);

    for (const actor of ["expired-grantee", "revoked-grantee", "intruder"]) {
      const denied = await client.callTool({
        name: "tb_list_boards",
        arguments: { project: "discovery", actor, ...directContext, capability: authorityCapability },
      });
      const deniedBoards = JSON.parse((denied.content[0] as { text: string }).text).boards;
      expect(deniedBoards.map((entry: Record<string, unknown>) => entry.id)).toEqual([legacyBoardId]);
      const serialized = JSON.stringify(deniedBoards);
      expect(serialized).not.toContain(owned.board_id);
      expect(serialized).not.toContain(foreign.board_id);
      expect(serialized).not.toContain("Owned direct board");
      expect(serialized).not.toContain("Owned secret task");
    }

    await client.close();
    await server.close();
    created.database.close();
  });

  it("authorized discovery enforces the grant expiry boundary and requires full direct-v1 context", async () => {
    const created = createTestDatabase("forgespec-discovery-boundary-");
    const clock = new FakeClock(Date.now() - 20_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      project: "boundary",
      name: "Boundary board",
      actor: "owner",
      idempotency_key: "boundary-board",
      tasks: [{ title: "Secret boundary task" }],
    });
    service.grantAuthority({
      actor: "owner",
      resource: { kind: "board", boardId: board.board_id },
      granteeActor: "grantee",
      operation: "read_board",
      expiresAtMs: clock.now() + 1_000,
      idempotencyKey: "boundary-grant",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    });
    const granteeContext = {
      actor: "grantee",
      coordination_mode: "direct-v1" as const,
      api_version: "1.0.0",
      schema_version: "1.0.0",
      capability: authorityCapability,
    };

    clock.set(clock.now() + 999);
    const beforeBoundary = await service.listBoardsForActor(granteeContext);
    expect(beforeBoundary.map((entry) => entry.id)).toContain(board.board_id);

    clock.set(clock.now() + 1);
    const atBoundary = await service.listBoardsForActor(granteeContext);
    expect(atBoundary.map((entry) => entry.id)).not.toContain(board.board_id);
    const ownerAtBoundary = await service.listBoardsForActor({ ...granteeContext, actor: "owner", capability: undefined });
    expect(ownerAtBoundary.map((entry) => entry.id)).toContain(board.board_id);

    const partialContext = await service.listBoardsForActor({ actor: "owner", project: "boundary" });
    expect(partialContext.map((entry) => entry.id)).not.toContain(board.board_id);

    created.database.close();
  });
});
