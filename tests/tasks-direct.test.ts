import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { migrateDatabase } from "../src/database/migrations.js";
import {
  TaskConflictError,
  TaskService,
  type DirectBoardCreateInput,
  type DirectTaskUpdateInput,
} from "../src/services/task-service.js";

const directories: string[] = [];

function open(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  return database;
}

function createDatabase(): { path: string; database: Database.Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-tasks-"));
  directories.push(directory);
  const databasePath = path.join(directory, "forgespec.db");
  migrateDatabase(databasePath);
  return { path: databasePath, database: open(databasePath) };
}

function boardInput(overrides: Partial<DirectBoardCreateInput> = {}): DirectBoardCreateInput {
  return {
    project: "task-tests",
    name: "Direct authority board",
    coordination_mode: "direct-v1",
    api_version: "1.0.0",
    schema_version: "1.0.0",
    actor: "owner",
    idempotency_key: "create-board",
    tasks: [{ title: "First task", description: "Initial", priority: "p0", dependencies: [] }],
    ...overrides,
  };
}

function updateInput(taskId: string, overrides: Partial<DirectTaskUpdateInput> = {}): DirectTaskUpdateInput {
  return {
    task_id: taskId,
    coordination_mode: "direct-v1",
    api_version: "1.0.0",
    schema_version: "1.0.0",
    actor: "owner",
    idempotency_key: "update-task",
    expected_revision: 1,
    status: "blocked",
    notes: "Waiting for an external prerequisite",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) fs.rmSync(directory, { recursive: true, force: true });
});

describe("direct-v1 board/task authority", () => {
  it("creates one shadow-authoritative board mutation and exactly replays it", () => {
    const { database } = createDatabase();
    const service = new TaskService(database, { now: () => 1_800_000_000_000 });

    const first = service.createDirectBoard(boardInput());
    const replay = service.createDirectBoard(boardInput());

    expect(replay).toEqual({ ...first, replayed: true });
    expect(first).toMatchObject({ ok: true, replayed: false, board_revision: 1 });
    expect(first.task_ids).toHaveLength(1);
    expect(database.prepare("SELECT COUNT(*) AS count FROM direct_boards").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM direct_tasks").get()).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual({ count: 2 });
    database.close();
  });

  it("records one historical version for each visible change and suppresses no-op updates", () => {
    const { database } = createDatabase();
    const service = new TaskService(database);
    const taskId = service.createDirectBoard(boardInput()).task_ids[0];

    expect(database.prepare("SELECT task_id, board_revision, task_revision, status FROM direct_task_versions ORDER BY board_revision, task_revision, task_id").all()).toEqual([
      { task_id: taskId, board_revision: 1, task_revision: 1, status: "ready" },
    ]);

    service.updateDirectTask(updateInput(taskId, { idempotency_key: "history-change" }));
    expect(database.prepare("SELECT task_id, board_revision, task_revision, status FROM direct_task_versions ORDER BY board_revision, task_revision, task_id").all()).toEqual([
      { task_id: taskId, board_revision: 1, task_revision: 1, status: "ready" },
      { task_id: taskId, board_revision: 2, task_revision: 2, status: "blocked" },
    ]);

    service.updateDirectTask(updateInput(taskId, {
      expected_revision: 2,
      status: "blocked",
      notes: undefined,
      idempotency_key: "history-no-op",
    }));
    expect(database.prepare("SELECT revision, status FROM direct_tasks WHERE task_id = ?").get(taskId)).toEqual({
      revision: 2,
      status: "blocked",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM direct_task_versions WHERE task_id = ?").get(taskId)).toEqual({ count: 2 });
    database.close();
  });

  it("rolls back projection, event, and history when the historical write fails", () => {
    const { database } = createDatabase();
    const service = new TaskService(database);
    const taskId = service.createDirectBoard(boardInput()).task_ids[0];
    database.exec(`
      CREATE TRIGGER fail_task_history
      BEFORE INSERT ON direct_task_versions
      WHEN NEW.board_revision = 2
      BEGIN SELECT RAISE(ABORT, 'injected task history failure'); END;
    `);

    expect(() => service.updateDirectTask(updateInput(taskId, { idempotency_key: "history-failure" }))).toThrow(/injected task history failure/);
    expect(database.prepare("SELECT revision, status FROM direct_tasks WHERE task_id = ?").get(taskId)).toEqual({
      revision: 1,
      status: "ready",
    });
    expect(database.prepare("SELECT revision FROM direct_boards").get()).toEqual({ revision: 1 });
    expect(database.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "ready" });
    expect(database.prepare("SELECT COUNT(*) AS count FROM direct_task_versions WHERE task_id = ?").get(taskId)).toEqual({ count: 1 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM authority_events WHERE resource_id = ?").get(taskId)).toEqual({ count: 1 });
    database.close();
  });

  it("allows exactly one independent connection to win task CAS without a partial merge", () => {
    const created = createDatabase();
    const secondConnection = open(created.path);
    const first = new TaskService(created.database);
    const second = new TaskService(secondConnection);
    const board = first.createDirectBoard(boardInput());
    const taskId = board.task_ids[0];

    const winner = first.updateDirectTask(updateInput(taskId, { idempotency_key: "writer-a" }));
    expect(winner).toMatchObject({ task_revision: 2, board_revision: 2, status: "blocked" });
    expect(() =>
      second.updateDirectTask(updateInput(taskId, {
        idempotency_key: "writer-b",
        status: "ready",
        notes: "Competing writer",
      }))
    ).toThrowError(TaskConflictError);
    expect(() =>
      second.updateDirectTask(updateInput(taskId, { idempotency_key: "writer-c", status: "ready" }))
    ).toThrow(/stale|revision/i);

    const direct = created.database.prepare("SELECT status, revision FROM direct_tasks WHERE task_id = ?").get(taskId);
    const projection = created.database.prepare("SELECT status, notes FROM tasks WHERE id = ?").get(taskId) as {
      status: string;
      notes: string;
    };
    expect(direct).toEqual({ status: "blocked", revision: 2 });
    expect(projection.status).toBe("blocked");
    expect(JSON.parse(projection.notes)).toHaveLength(1);
    secondConnection.close();
    created.database.close();
  });

  it("rejects absent CAS and changed idempotency requests with no effects", () => {
    const { database } = createDatabase();
    const service = new TaskService(database);
    const taskId = service.createDirectBoard(boardInput()).task_ids[0];
    const missingCas = { ...updateInput(taskId), expected_revision: undefined } as unknown as DirectTaskUpdateInput;

    expect(() => service.updateDirectTask(missingCas)).toThrow(/expected revision/i);
    service.updateDirectTask(updateInput(taskId, { idempotency_key: "bound" }));
    expect(() =>
      service.updateDirectTask(updateInput(taskId, {
        idempotency_key: "bound",
        expected_revision: 2,
        status: "ready",
      }))
    ).toThrow(/idempotency/i);
    expect(database.prepare("SELECT revision, status FROM direct_tasks WHERE task_id = ?").get(taskId)).toEqual({
      revision: 2,
      status: "blocked",
    });
    database.close();
  });

  it("rolls notes and projection back atomically when a transition is invalid", () => {
    const { database } = createDatabase();
    const service = new TaskService(database);
    const taskId = service.createDirectBoard(boardInput()).task_ids[0];

    expect(() => service.updateDirectTask(updateInput(taskId, { status: "done", notes: "Must roll back" }))).toThrow(
      /transition/i
    );
    expect(database.prepare("SELECT revision, status FROM direct_tasks WHERE task_id = ?").get(taskId)).toEqual({
      revision: 1,
      status: "ready",
    });
    expect(database.prepare("SELECT status, notes FROM tasks WHERE id = ?").get(taskId)).toEqual({
      status: "ready",
      notes: "[]",
    });
    expect(database.prepare("SELECT COUNT(*) AS count FROM idempotency_records WHERE resource_id = ?").get(taskId)).toEqual({ count: 0 });
    database.close();
  });

  it("repairs legacy projection drift from shadow authority after restart", () => {
    const created = createDatabase();
    const service = new TaskService(created.database);
    const result = service.createDirectBoard(boardInput());
    const taskId = result.task_ids[0];
    service.updateDirectTask(updateInput(taskId));
    created.database.prepare("UPDATE boards SET name = 'tampered' WHERE id = ?").run(result.board_id);
    created.database.prepare("UPDATE tasks SET status = 'done', notes = '[{\"text\":\"tampered\"}]' WHERE id = ?").run(taskId);
    created.database.close();

    const restarted = open(created.path);
    const reconciled = new TaskService(restarted).getBoard(result.board_id);
    expect(reconciled.board).toMatchObject({ name: "Direct authority board", revision: 2, mode: "direct-v1" });
    expect(reconciled.tasks[0]).toMatchObject({ status: "blocked", revision: 2 });
    expect(restarted.prepare("SELECT name FROM boards WHERE id = ?").get(result.board_id)).toEqual({
      name: "Direct authority board",
    });
    expect(restarted.prepare("SELECT status FROM tasks WHERE id = ?").get(taskId)).toEqual({ status: "blocked" });
    restarted.close();
  });

  it("keeps legacy boards compatible and rejects legacy mutation bypass on direct resources", () => {
    const { database } = createDatabase();
    const service = new TaskService(database);
    const direct = service.createDirectBoard(boardInput());
    database.prepare("INSERT INTO boards (id, project, name) VALUES ('legacy-board', 'task-tests', 'Legacy')").run();
    database.prepare("INSERT INTO tasks (id, board_id, title, status) VALUES ('legacy-task', 'legacy-board', 'Legacy task', 'ready')").run();

    expect(service.getBoard("legacy-board")).toMatchObject({ board: { id: "legacy-board", mode: "legacy" } });
    expect(() => service.assertLegacyTaskMutationAllowed(direct.task_ids[0])).toThrow(/legacy.*direct/i);
    expect(() => service.assertLegacyBoardMutationAllowed(direct.board_id)).toThrow(/legacy.*direct/i);
    expect(database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?").get(direct.board_id)).toEqual({ revision: 1 });
    database.close();
  });
});

describe("direct-v1 evidence references and approval gates", () => {
  it("stores payload-free immutable evidence, deduplicates associations, and rejects digest conflicts", () => {
    const { database } = createDatabase();
    const service = new TaskService(database, { now: () => 1_900_000_000_000 });
    const taskId = service.createDirectBoard(boardInput()).task_ids[0];
    const evidence = { provider: "cortex", kind: "observation", external_id: "obs-42", digest: `sha256:${"a".repeat(64)}` };

    service.updateDirectTask(updateInput(taskId, { idempotency_key: "evidence-1", evidence_links: [evidence] }));
    service.updateDirectTask(updateInput(taskId, {
      expected_revision: 2,
      idempotency_key: "evidence-2",
      notes: "Same reference remains one association",
      evidence_links: [evidence],
    }));

    expect(database.prepare("SELECT provider, kind, external_id, digest FROM evidence_objects").all()).toEqual([evidence]);
    expect(database.prepare("SELECT COUNT(*) AS count FROM task_evidence_links").get()).toEqual({ count: 1 });
    expect(() => service.updateDirectTask(updateInput(taskId, {
      expected_revision: 3,
      idempotency_key: "evidence-conflict",
      evidence_links: [{ ...evidence, digest: `sha256:${"b".repeat(64)}` }],
    }))).toThrow(/digest/i);
    expect(database.prepare("SELECT revision FROM direct_tasks WHERE task_id = ?").get(taskId)).toEqual({ revision: 3 });
    database.close();
  });

  it("rejects secret-bearing evidence atomically without echoing the secret into events or errors", () => {
    const { database } = createDatabase();
    const service = new TaskService(database);
    const taskId = service.createDirectBoard(boardInput()).task_ids[0];
    const secret = "super-secret-credential";
    let failure = "";
    try {
      service.updateDirectTask(updateInput(taskId, {
        evidence_links: [{
          provider: "cortex",
          kind: "observation",
          external_id: "obs-secret",
          digest: `sha256:${"c".repeat(64)}`,
          credential: secret,
        } as never],
      }));
    } catch (error) {
      failure = String(error);
    }

    expect(failure).not.toContain(secret);
    expect(database.prepare("SELECT COUNT(*) AS count FROM evidence_objects").get()).toEqual({ count: 0 });
    expect(JSON.stringify(database.prepare("SELECT details_json FROM authority_events").all())).not.toContain(secret);
    expect(database.prepare("SELECT revision FROM direct_tasks WHERE task_id = ?").get(taskId)).toEqual({ revision: 1 });
    database.close();
  });

  it("keeps deny/allow decisions immutable and enforces the deterministic effective gate", () => {
    const { database } = createDatabase();
    const service = new TaskService(database, { now: () => 1_900_000_000_000 });
    const board = service.createDirectBoard(boardInput({
      tasks: [{
        title: "Gated task",
        gates: [{ gate_id: "release", required_for: ["done"], allowed_actors: ["reviewer"] }],
      }],
    }));
    const taskId = board.task_ids[0];
    const claim = service.claimDirectTask({
      task_id: taskId,
      agent: "owner",
      expected_revision: 1,
      lease_seconds: 60,
      idempotency_key: "claim-gated",
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
    });
    const complete = (revision: number, key: string) => service.updateDirectTask(updateInput(taskId, {
      actor: "owner",
      expected_revision: revision,
      idempotency_key: key,
      status: "done",
      notes: undefined,
      attempt_id: claim.attempt_id,
      claim_token: claim.claim_token,
    }));

    expect(() => complete(2, "complete-without-gate")).toThrow(/approval/i);
    const denied = service.approveDirectTask({
      task_id: taskId, gate_id: "release", decision: "deny", expected_revision: 2,
      actor: "reviewer", idempotency_key: "deny", coordination_mode: "direct-v1", api_version: "1.0.0", schema_version: "1.0.0",
    });
    expect(denied.effective_decision).toBe("deny");
    expect(() => complete(3, "complete-denied")).toThrow(/approval/i);
    expect(() => service.approveDirectTask({
      task_id: taskId, gate_id: "release", decision: "allow", expected_revision: 3,
      actor: "intruder", idempotency_key: "unauthorized", coordination_mode: "direct-v1", api_version: "1.0.0", schema_version: "1.0.0",
    })).toThrow(/authoriz/i);
    const allowed = service.approveDirectTask({
      task_id: taskId, gate_id: "release", decision: "allow", expected_revision: 3,
      actor: "reviewer", idempotency_key: "allow", coordination_mode: "direct-v1", api_version: "1.0.0", schema_version: "1.0.0",
    });
    expect(allowed.effective_decision).toBe("allow");
    expect(complete(4, "complete-allowed").status).toBe("done");
    expect(database.prepare("SELECT decision, decision_no FROM approval_decisions ORDER BY decision_no").all()).toEqual([
      { decision: "deny", decision_no: 1 },
      { decision: "allow", decision_no: 2 },
    ]);
    expect(() => database.prepare("UPDATE approval_decisions SET decision = 'deny'").run()).toThrow(/immutable/i);
    database.close();
  });
});
