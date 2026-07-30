import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createHmac } from "node:crypto";
import { afterEach, describe, expect, it } from "vitest";
import { QueryService, QueryError } from "../src/services/query-service.js";
import { TaskService, type DirectBoardCreateInput } from "../src/services/task-service.js";
import { FakeClock } from "../src/core/clock.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

const cursorSecret = Buffer.alloc(32, 7);

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
  it("uses snapshot values and checks board authorization before decoding a cursor", () => {
    const created = createTestDatabase("forgespec-query-snapshot-values-");
    const clock = new FakeClock(1_900_000_000_000);
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret, clock });

    const first = query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
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

    const second = query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      limit: 2,
      cursor: first.next_cursor!,
    });
    const snapshotRevision = second.snapshot_revision;
    const snapshotItem = second.items.find((item) => item.task_id === taskAfterFirstPage);
    let authorizationError: unknown;
    try {
      query.queryTasks({
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
    expect(authorizationError).toEqual(expect.objectContaining({ code: "BOARD_QUERY_FORBIDDEN" }));
  });

  it("authorizes board owners and current active attempt actors, but denies all other read authorities", () => {
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
      () => query.queryEvents({ board_id: board.board_id, actor: "validator" }),
      () => query.queryTasks({ board_id: board.board_id, actor: "validator" }),
      () => query.batchStatus({ board_id: board.board_id, actor: "validator" }),
    ]) read();

    for (const actor of ["intruder", "gate-only", "", "validator"]) {
      expect(() => query.queryEvents({ board_id: otherBoard.board_id, actor })).toThrowError(
        expect.objectContaining({ category: "authorization", code: "BOARD_QUERY_FORBIDDEN" })
      );
    }
    expect(() => query.queryEvents({ board_id: "unknown-board", actor: "validator" })).toThrowError(
      expect.objectContaining({ category: "authorization", code: "BOARD_QUERY_FORBIDDEN" })
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
    expect(() => query.queryEvents({ board_id: board.board_id, actor: "validator" })).toThrowError(
      expect.objectContaining({ category: "authorization", code: "BOARD_QUERY_FORBIDDEN" })
    );
    expect(() => tasks.heartbeatDirectTask({
      task_id: board.task_ids[0], attempt_id: claim.attempt_id, claim_token: claim.claim_token,
      actor: "gate-only", expected_revision: 2, extend_seconds: 15, idempotency_key: "gate-only-heartbeat",
      coordination_mode: "direct-v1", api_version: "1.0.0", schema_version: "1.0.0",
    })).toThrow();
    created.database.close();
  });

  it("returns stable signed task pages and excludes writes after the snapshot", () => {
    const created = createTestDatabase("forgespec-query-page-");
    const tasks = new TaskService(created.database, { now: () => 1_900_000_000_000 });
    const board = tasks.createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    const first = query.queryTasks({ board_id: board.board_id, actor: "owner", work_unit: "WU6", ready: true, limit: 1 });
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

    const second = query.queryTasks({
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

  it("rejects malformed, tampered, mismatched, and excessive query inputs without state changes", () => {
    const created = createTestDatabase("forgespec-query-errors-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });
    const page = query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    const eventCount = created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get();

    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 201 })).toThrow(QueryError);
    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: `${page.next_cursor}x` })).toThrow(/cursor/i);
    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", status: ["done"], cursor: page.next_cursor! })).toThrow(/cursor/i);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual(eventCount);
    created.database.close();
  });

  it("keeps snapshot membership and every visible value stable across mutation, addition, and deletion", () => {
    const created = createTestDatabase("forgespec-query-snapshot-all-fields-");
    const clock = new FakeClock(1_900_000_000_000);
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret, clock });

    const first = query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    const secondTaskId = board.task_ids.find((taskId) => taskId !== first.items[0]!.task_id)!;
    const before = query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200 });
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
      const page = query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1, cursor });
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

  it("fails explicitly when a required historical version is missing instead of using current state", () => {
    const created = createTestDatabase("forgespec-query-missing-history-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const history = created.database
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'direct_task_versions'")
      .get() as { name: string } | undefined;
    if (history) {
      created.database.prepare("DELETE FROM direct_task_versions WHERE task_id = ?").run(board.task_ids[0]);
    }
    const query = new QueryService(created.database, { cursorSecret });

    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200 })).toThrowError(
      expect.objectContaining({ code: "SNAPSHOT_INTEGRITY_ERROR" })
    );
    created.database.close();
  });

  it("classifies signed cursor tamper, version, context, and exact expiry failures", () => {
    const created = createTestDatabase("forgespec-query-cursor-contract-");
    const clock = new FakeClock(1_900_000_000_000);
    const board = new TaskService(created.database, { clock }).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret, clock });
    const page = query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
    const cursor = page.next_cursor!;

    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: `${cursor}tampered` }))
      .toThrowError(expect.objectContaining({ code: "CURSOR_INVALID" }));
    expect(() => query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      cursor: rewriteSignedCursor(cursor, (payload) => { payload.v = 999; }),
    })).toThrowError(expect.objectContaining({ code: "CURSOR_VERSION_UNSUPPORTED" }));
    expect(() => query.queryTasks({
      board_id: board.board_id,
      actor: "owner",
      work_unit: "different-filter",
      cursor,
    })).toThrowError(expect.objectContaining({ code: "CURSOR_CONTEXT_MISMATCH" }));
    const expiresAt = clock.now() + 1_000;
    const expiring = rewriteSignedCursor(cursor, (payload) => {
      payload.issued_at_ms = clock.now();
      payload.expires_at_ms = expiresAt;
    });
    clock.set(expiresAt - 1);
    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: expiring })).not.toThrow();
    clock.set(expiresAt);
    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", cursor: expiring }))
      .toThrowError(expect.objectContaining({ code: "CURSOR_EXPIRED" }));
    created.database.close();
  });

  it("continues a strong cursor after reopening the same database with the same signing material", () => {
    const created = createTestDatabase("forgespec-query-cursor-restart-");
    const clock = new FakeClock(1_900_000_000_000);
    const tasks = new TaskService(created.database, { clock });
    const board = tasks.createDirectBoard(boardInput());
    const firstService = new QueryService(created.database, { cursorSecret, clock });
    const first = firstService.queryTasks({ board_id: board.board_id, actor: "owner", limit: 1 });
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
    const second = restarted.queryTasks({ board_id: board.board_id, actor: "owner", limit: 2, cursor: first.next_cursor! });
    expect(second.snapshot_revision).toBe(first.snapshot_revision);
    expect([...first.items, ...second.items]).toEqual(expect.arrayContaining([
      expect.objectContaining({ task_id: board.task_ids[1], status: "ready" }),
    ]));
    reopened.close();
  });

  it("accepts the public maximum without partial queries and rejects one above it before SQL", () => {
    const created = createTestDatabase("forgespec-query-limits-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    expect(query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200 }).items).toHaveLength(3);
    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 201 })).toThrowError(
      expect.objectContaining({ category: "validation", code: "query_limit" })
    );
    const before = created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get();
    expect(() => query.queryTasks({ board_id: board.board_id, actor: "owner", limit: 200, cursor: "not-a-cursor" }))
      .toThrowError(expect.objectContaining({ category: "cursor", code: "CURSOR_INVALID" }));
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual(before);
    created.database.close();
  });

  it("returns bounded batch status and restart-safe empty/event deltas in stable order", () => {
    const created = createTestDatabase("forgespec-query-delta-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const first = new QueryService(created.database, { cursorSecret });
    const batch = first.batchStatus({ board_id: board.board_id, actor: "owner", work_unit: "WU6", limit: 100 });
    expect(batch.items).toHaveLength(2);
    expect(batch.counts.ready).toBe(2);
    expect(() => first.batchStatus({ board_id: board.board_id, actor: "owner", task_ids: Array.from({ length: 101 }, (_, i) => `task-${i}`) })).toThrow(/100/);

    const events = first.queryEvents({ board_id: board.board_id, actor: "owner", since_revision: 0, limit: 2 });
    expect(events.items).toHaveLength(2);
    expect(events.items.map((event) => [event.board_revision, event.event_ordinal])).toEqual([[1, 0], [1, 1]]);
    created.database.close();

    const reopened = openTestDatabase(created.path);
    const restarted = new QueryService(reopened, { cursorSecret });
    const empty = restarted.queryEvents({ board_id: board.board_id, actor: "owner", since_revision: board.board_revision });
    expect(empty.items).toEqual([]);
    expect(empty.next_cursor).toBeNull();
    reopened.close();
  });

  it("reauthorizes every page and does not disclose inaccessible event existence", () => {
    const created = createTestDatabase("forgespec-query-auth-");
    const board = new TaskService(created.database).createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });
    const page = query.queryEvents({ board_id: board.board_id, actor: "owner", limit: 1 });

    expect(() => query.queryEvents({ board_id: board.board_id, actor: "intruder", cursor: page.next_cursor! })).toThrowError(
      expect.objectContaining({ category: "authorization", code: "BOARD_QUERY_FORBIDDEN" })
    );
    expect(() => query.queryTasks({ board_id: "board-hidden", actor: "intruder" })).toThrowError(
      expect.objectContaining({ category: "authorization", code: "BOARD_QUERY_FORBIDDEN" })
    );
    created.database.close();
  });
});

describe("bounded public inventory", () => {
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
      error: { category: "authorization", code: "BOARD_QUERY_FORBIDDEN" },
    });
    expect(JSON.stringify(denied.structuredContent)).not.toContain(board.board_id);

    await client.close();
    await server.close();
    created.database.close();
  });
});
