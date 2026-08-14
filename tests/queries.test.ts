import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHmac } from "node:crypto";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QueryService, QueryError } from "../src/services/query-service.js";
import { TaskService, type DirectBoardCreateInput } from "../src/services/task-service.js";
import { FakeClock } from "../src/core/clock.js";
import { TaskAuthorityService } from "../src/services/task-authority-service.js";
import type { CapabilityContext } from "../src/types/index.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

const cursorSecret = Buffer.alloc(32, 7);
const authorityCapability: CapabilityContext = {
  coordinationMode: "direct-v1",
  apiVersion: "1.0.0",
  schemaVersion: "1.0.0",
  negotiated: ["task-authority@1.0.0"],
};

type ReadRaceCommand =
  | { kind: "revoke"; input: Parameters<TaskService["revokeAuthority"]>[0] }
  | { kind: "query" | "events"; input: Record<string, unknown> };

type ReadRaceOutcome = { ok: true; value: unknown } | { ok: false; code?: string; value: unknown };

const readRaceWorkerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const Database = require("better-sqlite3");
  const { register } = require("tsx/esm/api");
  register();
  (async () => {
    const [{ TaskService }, { QueryService }, { FakeClock }] = await Promise.all([
      import(workerData.serviceUrl), import(workerData.queryUrl), import(workerData.clockUrl),
    ]);
    parentPort.postMessage({ type: "booted" });
    parentPort.on("message", async ({ runId, databasePath, nowMs, command, gate }) => {
      const database = new Database(databasePath);
      try {
        database.pragma("journal_mode = WAL");
        database.pragma("busy_timeout = 5000");
        database.pragma("foreign_keys = ON");
        parentPort.postMessage({ type: "ready", runId });
        Atomics.wait(gate, 0, 0);
        const clock = new FakeClock(nowMs);
        let value;
        if (command.kind === "revoke") value = new TaskService(database, { clock }).revokeAuthority(command.input);
        else {
          const query = new QueryService(database, { cursorSecret: Buffer.alloc(32, 7), clock });
          value = command.kind === "query" ? await query.queryTasks(command.input) : await query.queryEvents(command.input);
        }
        parentPort.postMessage({ type: "result", runId, outcome: { ok: true, value } });
      } catch (error) {
        parentPort.postMessage({ type: "result", runId, outcome: {
          ok: false, code: error && error.code,
          value: error && typeof error === "object" ? { category: error.category, code: error.code, message: error.message } : String(error),
        } });
      } finally {
        database.close();
      }
    });
  })().catch((error) => parentPort.postMessage({ type: "fatal", message: String(error?.stack ?? error) }));
`;

async function createReadRaceHarness(workerCount: number) {
  const moduleUrls = {
    serviceUrl: pathToFileURL(`${process.cwd()}/src/services/task-service.ts`).href,
    queryUrl: pathToFileURL(`${process.cwd()}/src/services/query-service.ts`).href,
    clockUrl: pathToFileURL(`${process.cwd()}/src/core/clock.ts`).href,
  };
  const workers = Array.from({ length: workerCount }, () => new Worker(readRaceWorkerSource, {
    eval: true, workerData: moduleUrls,
  }));
  let runId = 0;
  const booted = workers.map((worker) => new Promise<void>((resolve, reject) => {
    worker.on("message", (message: { type: string; message?: string }) => {
      if (message.type === "booted") resolve();
      else if (message.type === "fatal") reject(new Error(message.message));
    });
    worker.once("error", reject);
    worker.once("exit", (code) => reject(new Error(`Read race worker exited before cleanup with code ${code}`)));
  }));
  await Promise.all(booted);
  return {
    async start(databasePath: string, nowMs: number, commands: ReadRaceCommand[]) {
      expect(commands).toHaveLength(workers.length);
      const currentRun = ++runId;
      const gates = commands.map(() => new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)));
      const channels = workers.map((worker, index) => {
        let markReady!: () => void;
        let resolveResult!: (outcome: ReadRaceOutcome) => void;
        const ready = new Promise<void>((resolve) => { markReady = resolve; });
        const result = new Promise<ReadRaceOutcome>((resolve) => { resolveResult = resolve; });
        const onMessage = (message: { type: string; runId?: number; outcome?: ReadRaceOutcome }) => {
          if (message.runId !== currentRun) return;
          if (message.type === "ready") markReady();
          else if (message.type === "result" && message.outcome) {
            worker.off("message", onMessage);
            resolveResult(message.outcome);
          }
        };
        worker.on("message", onMessage);
        worker.postMessage({ runId: currentRun, databasePath, nowMs, command: commands[index], gate: gates[index] });
        return { ready, result };
      });
      await Promise.all(channels.map(({ ready }) => ready));
      return {
        release(index: number) { Atomics.store(gates[index], 0, 1); Atomics.notify(gates[index], 0, 1); },
        result(index: number) { return channels[index].result; },
        releaseAll() { gates.forEach((gate) => { Atomics.store(gate, 0, 1); Atomics.notify(gate, 0, 1); }); },
      };
    },
    async close() {
      await Promise.allSettled(workers.map((worker) => worker.terminate()));
    },
  };
}

function rewriteSignedCursor(
  cursor: string,
  mutate: (payload: Record<string, unknown>) => void,
  secret = cursorSecret
): string {
  const [encodedBody] = cursor.split(".");
  const payload = JSON.parse(Buffer.from(encodedBody, "base64url").toString("utf8")) as Record<string, unknown>;
  mutate(payload);
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body}.${signature}`;
}

function boardInput(): DirectBoardCreateInput {
  return {
    project: "query-tests",
    name: "Bounded query board",
    change_name: "query-change",
    coordination_mode: "direct-v1",
    api_version: "1.0.0",
    schema_version: "1.0.0",
    actor: "owner",
    idempotency_key: "create-query-board",
    tasks: [
      { title: "WU6 first", priority: "p0", work_unit: "WU6" },
      { title: "WU6 second", priority: "p1", work_unit: "WU6" },
      { title: "WU7 later", priority: "p1", work_unit: "WU7" },
    ],
  };
}

afterEach(removeTestDatabases);

describe("direct-v1 bounded queries", () => {
  it("keeps protected classification, authorization, cursor, and rows in one synchronous transaction", async () => {
    const created = createTestDatabase("forgespec-query-read-transaction-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });
    const authorize = TaskAuthorityService.prototype.authorizeTaskOperation;
    const decisions = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");
    decisions.mockImplementation(function (tx, input) {
      expect(created.database.inTransaction).toBe(true);
      return authorize.call(this, tx, input);
    });

    await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    await query.batchStatus({ board_id: board.board_id, actor: "owner", limit: 1 });
    await query.queryEvents({ board_id: board.board_id, actor: "owner", limit: 1 });

    expect(decisions).toHaveBeenCalledTimes(3);
    decisions.mockRestore();
    created.database.close();
  });
  it("uses only active exact-scope read grants and keeps absent capability owner-compatible", async () => {
    const created = createTestDatabase("forgespec-query-grant-matrix-");
    const clock = new FakeClock(1_900_000_000_000);
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard(boardInput());
    const taskResource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const active = tasks.grantAuthority({
      actor: "owner", resource: taskResource, granteeActor: "active-reader", operation: "read_task",
      expiresAtMs: clock.now() + 60_000, idempotencyKey: "query-active-read",
      expectedBoardRevision: board.board_revision, capability: authorityCapability,
    });
    const expired = tasks.grantAuthority({
      actor: "owner", resource: taskResource, granteeActor: "expired-reader", operation: "read_task",
      expiresAtMs: clock.now() + 1_000, idempotencyKey: "query-expired-read",
      expectedBoardRevision: active.boardRevision, capability: authorityCapability,
    });
    const revocable = tasks.grantAuthority({
      actor: "owner", resource: taskResource, granteeActor: "revoked-reader", operation: "read_task",
      expiresAtMs: clock.now() + 60_000, idempotencyKey: "query-revoked-read",
      expectedBoardRevision: expired.boardRevision, capability: authorityCapability,
    });
    const revoked = tasks.revokeAuthority({
      actor: "owner", grantId: revocable.value.grantId, idempotencyKey: "query-revoke-read",
      expectedBoardRevision: revocable.boardRevision, capability: authorityCapability,
    });
    tasks.grantAuthority({
      actor: "owner", resource: taskResource, granteeActor: "wrong-operation-reader", operation: "update",
      expiresAtMs: clock.now() + 60_000, idempotencyKey: "query-wrong-operation",
      expectedBoardRevision: revoked.boardRevision, capability: authorityCapability,
    });
    const query = new QueryService(created.database, { cursorSecret, clock });
    const protectedContext = {
      coordination_mode: "direct-v1" as const,
      api_version: "1.0.0" as const,
      schema_version: "1.0.0" as const,
      capability: authorityCapability,
    };
    await expect(query.queryTasks({ board_id: board.board_id, actor: "active-reader", task_ids: [board.task_ids[0]], ...protectedContext }))
      .resolves.toMatchObject({ page_count: 1 });
    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner" }))
      .resolves.toMatchObject({ page_count: 3 });

    clock.advance(1_000);
    for (const actor of ["expired-reader", "revoked-reader", "wrong-operation-reader"]) {
      await expect(query.queryTasks({ board_id: board.board_id, actor, task_ids: [board.task_ids[0]], ...protectedContext }))
        .rejects.toMatchObject({ category: "authorization", code: "RESOURCE_NOT_AVAILABLE" });
    }
    await expect(query.queryTasks({
      board_id: board.board_id, actor: "active-reader", task_ids: [board.task_ids[1]], ...protectedContext,
    })).rejects.toMatchObject({ category: "authorization", code: "RESOURCE_NOT_AVAILABLE" });
    await expect(query.queryTasks({
      board_id: board.board_id, actor: "active-reader", task_ids: [board.task_ids[0]], capability: authorityCapability,
    })).rejects.toMatchObject({ category: "authorization", code: "RESOURCE_NOT_AVAILABLE" });
    created.database.close();
  });

  it("propagates validated capability through query batch and event tools without denial leakage", async () => {
    const created = createTestDatabase("forgespec-query-tool-capability-");
    const tasks = new TaskService(created.database);
    const board = tasks.createDirectBoard(boardInput());
    tasks.grantAuthority({
      actor: "owner",
      resource: { kind: "board", boardId: board.board_id },
      granteeActor: "board-reader",
      operation: "read_board",
      expiresAtMs: Date.now() + 60_000,
      idempotencyKey: "query-tool-read-grant",
      expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    });
    const server = new McpServer({ name: "query-authority", version: "1.0.0" });
    registerTaskBoardTools(server, () => created.database, { cursorSecret });
    const client = new Client({ name: "query-authority-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const protectedContext = {
      board_id: board.board_id,
      actor: "board-reader",
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      capability: authorityCapability,
    };
    const authorize = TaskAuthorityService.prototype.authorizeTaskOperation;
    const unblockedDecision = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");
    unblockedDecision.mockImplementation(function (tx, input) {
      expect(created.database.inTransaction).toBe(true);
      return authorize.call(this, tx, input);
    });

    for (const name of ["tb_query", "tb_batch_status", "tb_events", "tb_unblocked"]) {
      const response = await client.callTool({ name, arguments: protectedContext });
      expect(response.isError, name).not.toBe(true);
    }
    expect(unblockedDecision).toHaveBeenCalledTimes(4);
    unblockedDecision.mockRestore();

    for (const authorityContext of [
      { capability: authorityCapability },
      { coordination_mode: "legacy", api_version: "1.0.0", schema_version: "1.0.0", capability: authorityCapability },
    ]) {
      const denied = await client.callTool({
        name: "tb_batch_status",
        arguments: { board_id: board.board_id, actor: "board-reader", ...authorityContext },
      });
      expect(denied.isError).toBe(true);
      expect(denied.structuredContent).toMatchObject({
        ok: false,
        error: { category: "authorization", code: "RESOURCE_NOT_AVAILABLE" },
      });
      expect(denied.structuredContent).not.toHaveProperty("items");
      expect(denied.structuredContent).not.toHaveProperty("counts");
      expect(denied.structuredContent).not.toHaveProperty("page_count");
      expect(denied.structuredContent).not.toHaveProperty("next_cursor");
      expect(JSON.stringify(denied.structuredContent)).not.toContain(board.board_id);
    }

    const compatibleOwner = await client.callTool({
      name: "tb_query",
      arguments: { board_id: board.board_id, actor: "owner" },
    });
    expect(compatibleOwner.isError).not.toBe(true);

    await client.close();
    await server.close();
    created.database.close();
  });

  it("authorized_direct_v1_reads_return_protected_resources_after_async_authority", async () => {
    const created = createTestDatabase("forgespec-query-protected-exact-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    const pending = query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      task_ids: [board.task_ids[0]],
    });
    expect(pending).toBeInstanceOf(Promise);
    await expect(pending).resolves.toMatchObject({
      items: [expect.objectContaining({ task_id: board.task_ids[0] })],
      page_count: 1,
    });
    await expect(query.queryTasks({
      board_id: board.board_id,
      actor: "intruder",
      task_ids: [board.task_ids[0]],
    })).rejects.toMatchObject({ category: "authorization", code: "RESOURCE_NOT_AVAILABLE" });
    await expect(query.queryTasks({
      board_id: board.board_id,
      actor: "intruder",
      task_ids: ["task-unknown"],
    })).rejects.toMatchObject({ category: "authorization", code: "RESOURCE_NOT_AVAILABLE" });
    created.database.close();
  });

  it("counts_are_snapshot_totals_across_all_pages", async () => {
    const created = createTestDatabase("forgespec-query-snapshot-counts-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    const first = await query.batchStatus({ board_id: board.board_id, actor: "owner", limit: 2 });
    const second = await query.batchStatus({
      board_id: board.board_id,
      actor: "owner",
      limit: 2,
      cursor: first.next_cursor!,
    });

    expect(first.counts).toMatchObject({ ready: 3 });
    expect(second.counts).toEqual(first.counts);
    expect(first).toMatchObject({ page_count: 2 });
    expect(second).toMatchObject({ page_count: 1 });
    created.database.close();
  });

  it("counts_handle_empty_and_partial_pages", async () => {
    const created = createTestDatabase("forgespec-query-empty-counts-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    const empty = await query.batchStatus({
      board_id: board.board_id,
      actor: "owner",
      status: ["done"],
      limit: 2,
    });

    expect(empty.items).toEqual([]);
    expect(empty.counts).toMatchObject({ done: 0, ready: 0 });
    expect(empty).toMatchObject({ page_count: 0 });
    expect(empty.next_cursor).toBeNull();
    created.database.close();
  });

  it("denied_snapshot_query_exposes_no_counts_or_cursor", async () => {
    const created = createTestDatabase("forgespec-query-denied-snapshot-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const before = created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get();
    const query = new QueryService(created.database, { cursorSecret });

    await expect(query.batchStatus({ board_id: board.board_id, actor: "intruder", limit: 1 }))
      .rejects.toMatchObject({ category: "authorization", code: "RESOURCE_NOT_AVAILABLE" });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual(before);
    created.database.close();
  });

  it("uses snapshot values and checks board authorization before decoding a cursor", async () => {
    const created = createTestDatabase("forgespec-query-snapshot-values-");
    const clock = new FakeClock(1_900_000_000_000);
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret, clock });

    const first = await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    const taskAfterFirstPage = board.task_ids.find((taskId) => taskId !== first.items[0]?.task_id)!;
    tasks.updateDirectTask({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      task_id: taskAfterFirstPage,
      actor: "owner",
      idempotency_key: "snapshot-status-change",
      expected_revision: 1,
      status: "blocked",
    });

    const second = await query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      limit: 2,
      cursor: first.next_cursor!,
    });
    const snapshotRevision = second.snapshot_revision;
    const snapshotItem = second.items.find((item) => item.task_id === taskAfterFirstPage);
    let authorizationError: unknown;
    try {
      await query.queryTasks({
        board_id: board.board_id,
        actor: "intruder",
        cursor: `${first.next_cursor!}tampered`,
      });
    } catch (error) {
      authorizationError = error;
    }
    created.database.close();

    expect(snapshotRevision).toBe(first.snapshot_revision);
    expect(snapshotItem).toMatchObject({
      task_id: taskAfterFirstPage,
      status: "ready",
    });
    expect(authorizationError).toEqual(expect.objectContaining({ code: "RESOURCE_NOT_AVAILABLE" }));
  });

  it("authorizes owners and denies incomplete read authority contexts", async () => {
    const created = createTestDatabase("forgespec-query-security-");
    const clock = new FakeClock(Date.now());
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard({
      ...boardInput(),
      tasks: [{
        title: "secured task",
        priority: "p0",
        gates: [{ gate_id: "validator-gate", required_for: ["done"], allowed_actors: ["validator"] }],
      }],
      idempotency_key: "create-query-security-board",
    });
    const otherBoard = tasks.createDirectBoard({ ...boardInput(), idempotency_key: "create-query-security-other" });
    const claim = tasks.claimDirectTask({
      task_id: board.task_ids[0],
      agent: "validator",
      expected_revision: 1,
      lease_seconds: 15,
      idempotency_key: "claim-query-security",
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
    });
    const query = new QueryService(created.database, { cursorSecret, clock });

    for (const read of [
      () => query.queryEvents({ board_id: board.board_id, actor: "owner" }),
      () => query.queryTasks({ board_id: board.board_id, actor: "owner" }),
      () => query.batchStatus({ board_id: board.board_id, actor: "owner" }),
    ]) await read();

    for (const actor of ["intruder", "gate-only", "", "validator"]) {
      await expect(query.queryEvents({ board_id: otherBoard.board_id, actor })).rejects.toMatchObject(
        { category: "authorization", code: "RESOURCE_NOT_AVAILABLE" }
      );
    }
    await expect(query.queryEvents({ board_id: "unknown-board", actor: "validator" })).rejects.toMatchObject(
      { category: "authorization", code: "RESOURCE_NOT_AVAILABLE" }
    );

    clock.advance(20_001);
    tasks.recoverDirectClaims({
      board_id: board.board_id,
      expected_board_revision: claim.board_revision,
      attempt_ids: [claim.attempt_id],
      actor: "owner",
      idempotency_key: "recover-query-security",
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
    });
    await expect(query.queryEvents({ board_id: board.board_id, actor: "validator" })).rejects.toMatchObject(
      { category: "authorization", code: "RESOURCE_NOT_AVAILABLE" }
    );
    expect(() => tasks.heartbeatDirectTask({
      task_id: board.task_ids[0], attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      actor: "gate-only", expected_revision: 2, extend_seconds: 15, idempotency_key: "gate-only-heartbeat",
      coordination_mode: "direct-v1", api_version: "1.0.0", schema_version: "1.0.0",
    })).toThrow();
    created.database.close();
  });

  it("returns stable signed task pages and excludes writes after the snapshot", async () => {
    const created = createTestDatabase("forgespec-query-page-");
    const tasks = new TaskService(created.database, { now: () => 1_900_000_000_000 });
    const board = tasks.createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    const first = await query.queryTasks({ board_id: board.board_id, actor: "owner", work_unit: "WU6", ready: true, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));

    const lateTask = tasks.addDirectTask({
      board_id: board.board_id,
      title: "Late WU6 task",
      work_unit: "WU6",
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      actor: "owner",
      idempotency_key: "late-task",
      expected_board_revision: board.board_revision,
    });
    const history = created.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'direct_task_versions'")
      .get() as { name: string } | undefined;
    if (history) {
      created.database.prepare(
        `UPDATE direct_task_versions SET is_deleted = 1
         WHERE task_id = ? AND board_revision = (SELECT MAX(board_revision) FROM direct_task_versions WHERE task_id = ?)`
      ).run(lateTask.task_id, lateTask.task_id);
    }

    const second = await query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      work_unit: "WU6",
      ready: true,
      limit: 1,
      cursor: first.next_cursor!,
    });
    expect(second.snapshot_revision).toBe(first.snapshot_revision);
    expect([...first.items, ...second.items].map((item) => item.title).sort()).toEqual(["WU6 first", "WU6 second"]);
    created.database.close();
  });

  it("rejects malformed, tampered, mismatched, and excessive query inputs without state changes", async () => {
    const created = createTestDatabase("forgespec-query-errors-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });
    const page = await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    const eventCount = created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get();

    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 201 })).rejects.toBeInstanceOf(QueryError);
    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: `${page.next_cursor}x` })).rejects.toThrow(/cursor/i);
    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", status: ["done"], cursor: page.next_cursor! })).rejects.toThrow(/cursor/i);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual(eventCount);
    created.database.close();
  });

  it("keeps snapshot membership and every visible value stable across mutation, addition, and deletion", async () => {
    const created = createTestDatabase("forgespec-query-snapshot-all-fields-");
    const clock = new FakeClock(1_900_000_000_000);
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret, clock });

    const first = await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    const secondTaskId = board.task_ids.find((taskId) => taskId !== first.items[0]!.task_id)!;
    const before = await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200 });
    const beforeById = new Map(before.items.map((item) => [item.task_id, item]));

    tasks.updateDirectTask({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      task_id: secondTaskId,
      actor: "owner",
      idempotency_key: "snapshot-visible-mutation",
      expected_revision: 1,
      status: "blocked",
      notes: "changed after snapshot",
    });
    tasks.addDirectTask({
      board_id: board.board_id,
      title: "created-after-snapshot",
      priority: "p1",
      work_unit: "WU8",
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      actor: "owner",
      idempotency_key: "snapshot-late-add",
      expected_board_revision: board.board_revision + 1,
    });

    const pages = [first];
    let cursor = first.next_cursor;
    while (cursor) {
      const page = await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1, cursor });
      pages.push(page);
      cursor = page.next_cursor;
    }
    const afterIds = pages.flatMap((page) => page.items.map((item) => item.task_id));
    expect(afterIds).toEqual([...beforeById.keys()].sort());
    expect(new Set(afterIds).size).toBe(beforeById.size);
    const snapshotItems = pages.flatMap((page) => page.items);
    for (const item of beforeById.values()) {
      expect(snapshotItems).toEqual(expect.arrayContaining([expect.objectContaining({
        task_id: item.task_id,
        title: item.title,
        status: item.status,
        priority: item.priority,
        revision: item.revision,
        ready: item.ready,
      })]));
    }
    expect(afterIds).not.toContain(expect.stringContaining("created-after-snapshot"));
    created.database.close();
  });

  it("fails explicitly when a required historical version is missing instead of using current state", async () => {
    const created = createTestDatabase("forgespec-query-missing-history-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const history = created.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'direct_task_versions'")
      .get() as { name: string } | undefined;
    if (history) {
      created.database.prepare("DELETE FROM direct_task_versions WHERE task_id = ?").run(board.task_ids[0]);
    }
    const query = new QueryService(created.database, { cursorSecret });

    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200 })).rejects.toMatchObject(
      { code: "SNAPSHOT_INTEGRITY_ERROR" }
    );
    created.database.close();
  });

  it("classifies signed cursor tamper, version, context, and exact expiry failures", async () => {
    const created = createTestDatabase("forgespec-query-cursor-contract-");
    const clock = new FakeClock(1_900_000_000_000);
    const board = new TaskService(created.database, { clock }).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret, clock });
    const page = await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    const cursor = page.next_cursor!;

    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: `${cursor}tampered` }))
      .rejects.toMatchObject({ code: "CURSOR_INVALID" });
    await expect(query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      cursor: rewriteSignedCursor(cursor, (payload) => { payload.v = 999; }),
    })).rejects.toMatchObject({ code: "CURSOR_VERSION_UNSUPPORTED" });
    await expect(query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      work_unit: "different-filter",
      cursor,
    })).rejects.toMatchObject({ code: "CURSOR_CONTEXT_MISMATCH" });
    const expiresAt = clock.now() + 1_000;
    const expiring = rewriteSignedCursor(cursor, (payload) => {
      payload.issued_at_ms = clock.now();
      payload.expires_at_ms = expiresAt;
    });
    clock.set(expiresAt - 1);
    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: expiring })).resolves.toBeDefined();
    clock.set(expiresAt);
    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: expiring }))
      .rejects.toMatchObject({ code: "CURSOR_EXPIRED" });
    created.database.close();
  });

  it("continues a strong cursor after reopening the same database with the same signing material", async () => {
    const created = createTestDatabase("forgespec-query-cursor-restart-");
    const clock = new FakeClock(1_900_000_000_000);
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard(boardInput());
    const firstService = new QueryService(created.database, { cursorSecret, clock });
    const first = await firstService.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    tasks.updateDirectTask({
      coordination_mode: "direct-v1",
      api_version: "1.0.0",
      schema_version: "1.0.0",
      task_id: board.task_ids[1],
      actor: "owner",
      idempotency_key: "restart-snapshot-mutation",
      expected_revision: 1,
      status: "blocked",
    });
    created.database.close();

    const reopened = openTestDatabase(created.path);
    const restarted = new QueryService(reopened, { cursorSecret, clock });
    const second = await restarted.queryTasks({ board_id: board.board_id, actor: "owner", limit: 2, cursor: first.next_cursor! });
    expect(second.snapshot_revision).toBe(first.snapshot_revision);
    expect([...first.items, ...second.items]).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: board.task_ids[1], status: "ready" }),
    ]));
    reopened.close();
  });

  it("accepts the public maximum without partial queries and rejects one above it before SQL", async () => {
    const created = createTestDatabase("forgespec-query-limits-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    expect((await query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200 })).items).toHaveLength(3);
    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 201 })).rejects.toMatchObject(
      { category: "validation", code: "query_limit" }
    );
    const before = created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get();
    await expect(query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200, cursor: "not-a-cursor" }))
      .rejects.toMatchObject({ category: "cursor", code: "CURSOR_INVALID" });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual(before);
    created.database.close();
  });

  it("returns bounded batch status and restart-safe empty/event deltas in stable order", async () => {
    const created = createTestDatabase("forgespec-query-delta-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const first = new QueryService(created.database, { cursorSecret });
    const batch = await first.batchStatus({ board_id: board.board_id, actor: "owner", work_unit: "WU6", limit: 100 });
    expect(batch.items).toHaveLength(2);
    expect(batch.counts.ready).toBe(2);
    await expect(first.batchStatus({ board_id: board.board_id, actor: "owner", task_ids: Array.from({ length: 101 }, (_, i) => `task-${i}`) })).rejects.toThrow(/100/);

    const events = await first.queryEvents({ board_id: board.board_id, actor: "owner", since_revision: 0, limit: 2 });
    expect(events.items).toHaveLength(2);
    expect(events.items.map((event) => [event.board_revision, event.event_ordinal])).toEqual([[1, 0], [1, 1]]);
    created.database.close();

    const reopened = openTestDatabase(created.path);
    const restarted = new QueryService(reopened, { cursorSecret });
    const empty = await restarted.queryEvents({ board_id: board.board_id, actor: "owner", since_revision: board.board_revision });
    expect(empty.items).toEqual([]);
    expect(empty.next_cursor).toBeNull();
    reopened.close();
  });

  it("reauthorizes every page and does not disclose inaccessible event existence", async () => {
    const created = createTestDatabase("forgespec-query-auth-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });
    const page = await query.queryEvents({ board_id: board.board_id, actor: "owner", limit: 1 });

    await expect(query.queryEvents({ board_id: board.board_id, actor: "intruder", cursor: page.next_cursor! })).rejects.toMatchObject(
      { category: "authorization", code: "RESOURCE_NOT_AVAILABLE" }
    );
    await expect(query.queryTasks({ board_id: "board-hidden", actor: "intruder" })).rejects.toMatchObject(
      { category: "authorization", code: "RESOURCE_NOT_AVAILABLE" }
    );
    created.database.close();
  });

  it.each(["query", "events"] as const)("linearizes revoke against independent %s read workers without leakage", async (kind) => {
    const harness = await createReadRaceHarness(2);
    try {
      for (let iteration = 0; iteration < 10; iteration += 1) {
        const created = createTestDatabase(`forgespec-revoke-${kind}-race-`);
        const clock = new FakeClock(1_900_000_000_000 + iteration);
        const service = new TaskService(created.database, { clock });
        const board = service.createDirectBoard({ ...boardInput(), idempotency_key: `read-race-board-${iteration}` });
        const grant = service.grantAuthority({
          actor: "owner", resource: { kind: "board", boardId: board.board_id }, granteeActor: "reader",
          operation: "read_board", expiresAtMs: clock.now() + 60_000, idempotencyKey: `read-race-grant-${iteration}`,
          expectedBoardRevision: board.board_revision, capability: authorityCapability,
        });
        created.database.close();
        const directContext = {
          board_id: board.board_id, actor: "reader", coordination_mode: "direct-v1" as const,
          api_version: "1.0.0", schema_version: "1.0.0", capability: authorityCapability, limit: 1,
        };
        const workers = await harness.start(created.path, clock.now(), [{
          kind: "revoke",
          input: { actor: "owner", grantId: grant.value.grantId, idempotencyKey: `read-race-revoke-${iteration}`,
            expectedBoardRevision: grant.boardRevision, capability: authorityCapability },
        }, { kind, input: directContext }]);
        try {
          if (iteration % 2 === 0) {
            // A committed revoke before the read worker leaves its barrier fixes the deny serial order.
            workers.release(0);
            expect(await workers.result(0)).toMatchObject({ ok: true });
            workers.release(1);
            const denied = await workers.result(1);
            expect(denied).toEqual({
              ok: false,
              code: "RESOURCE_NOT_AVAILABLE",
              value: { category: "authorization", code: "RESOURCE_NOT_AVAILABLE", message: "Resource is not available" },
            });
            expect(JSON.stringify(denied)).not.toContain(board.board_id);
            expect(JSON.stringify(denied)).not.toContain(board.task_ids[0]);
            for (const field of ["items", "counts", "page_count", "next_cursor", "snapshot_revision"]) {
              expect(denied.value).not.toHaveProperty(field);
            }
          } else {
            // A read transaction completed before revoke may return one whole authorized snapshot.
            workers.release(1);
            const allowed = await workers.result(1);
            expect(allowed).toMatchObject({ ok: true, value: { items: expect.any(Array), page_count: 1 } });
            expect((allowed as { ok: true; value: { items: unknown[]; page_count: number } }).value.items).toHaveLength(1);
            workers.release(0);
            expect(await workers.result(0)).toMatchObject({ ok: true });
          }
        } finally {
          workers.releaseAll();
        }
        const reopened = openTestDatabase(created.path);
        const restarted = new QueryService(reopened, { cursorSecret, clock });
        const read = kind === "query" ? restarted.queryTasks(directContext) : restarted.queryEvents(directContext);
        await expect(read).rejects.toMatchObject({ code: "RESOURCE_NOT_AVAILABLE" });
        reopened.close();
      }
    } finally {
      await harness.close();
    }
    // Each variant spawns worker_threads (tsx registration + native SQLite load)
    // and runs 10 sequential DB create/reopen iterations, which exceeds Vitest's
    // 5000 ms default on slow Windows CI. Allow generous, explicit headroom.
  }, 30000);
});

describe("bounded public inventory", () => {
  it("legacy_mixed_read_never_leaks_direct_v1_resources", async () => {
    const created = createTestDatabase("forgespec-query-legacy-mixed-");
    const direct = new TaskService(created.database).createDirectBoard(boardInput());
    created.database.prepare("INSERT INTO boards (id, project, name) VALUES (?, ?, ?)")
      .run("legacy-visible", "query-tests", "Legacy visible");
    created.database.prepare(
      `INSERT INTO tasks (id, board_id, title, description, priority, acceptance_criteria, dependencies, status)
       VALUES (?, ?, ?, '', 'p2', '', '[]', 'ready')`
    ).run("legacy-task-visible", "legacy-visible", "Legacy task visible");
    const server = new McpServer({ name: "legacy-read", version: "1.0.0" });
    registerTaskBoardTools(server, () => created.database, { cursorSecret });
    const client = new Client({ name: "legacy-read-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const boards = await client.callTool({ name: "tb_list_boards", arguments: { project: "query-tests" } });
    const directBoard = await client.callTool({ name: "tb_status", arguments: { board_id: direct.board_id } });
    const directTask = await client.callTool({ name: "tb_get", arguments: { task_id: direct.task_ids[0] } });

    expect(JSON.stringify(boards.content)).toContain("legacy-visible");
    expect(JSON.stringify(boards.content)).not.toContain(direct.board_id);
    expect(JSON.stringify(directBoard.content)).not.toContain(direct.board_id);
    expect(JSON.stringify(directTask.content)).not.toContain(direct.task_ids[0]);

    await client.close();
    await server.close();
    created.database.close();
  });

  it("exposes only direct authority additions and no messaging, DLQ, A2A, or external leases", async () => {
    const created = createTestDatabase("forgespec-query-inventory-");
    const server = new McpServer({ name: "inventory", version: "1.0.0" });
    registerTaskBoardTools(server, () => created.database, { cursorSecret });
    const client = new Client({ name: "inventory-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const names = (await client.listTools()).tools.map((tool) => tool.name);
    expect(names).toEqual(expect.arrayContaining(["tb_approve", "tb_query", "tb_batch_status", "tb_events"]));
    expect(names.some((name) => /(message|inbox|thread|broadcast|notification|dlq|a2a|remote|resource_lease)/i.test(name))).toBe(false);

    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const page = await client.callTool({
      name: "tb_query",
      arguments: { board_id: board.board_id, actor: "owner", limit: 1 },
    });
    expect(page.structuredContent).toMatchObject({ items: expect.any(Array), snapshot_revision: 1 });
    const denied = await client.callTool({
      name: "tb_events",
      arguments: { board_id: board.board_id, actor: "intruder" },
    });
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      ok: false,
      error: { category: "authorization", code: "RESOURCE_NOT_AVAILABLE" },
    });
    expect(JSON.stringify(denied.structuredContent)).not.toContain(board.board_id);

    await client.close();
    await server.close();
    created.database.close();
  });
});
