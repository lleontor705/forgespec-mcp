import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { QueryService, QueryError } from "../src/services/query-service.js";
import { TaskService, type DirectBoardCreateInput } from "../src/services/task-service.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

const cursorSecret = Buffer.alloc(32, 7);

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
  it("returns stable signed task pages and excludes writes after the snapshot", () => {
    const created = createTestDatabase("forgespec-query-page-");
    const tasks = new TaskService(created.database, { now: () => 1_900_000_000_000 });
    const board = tasks.createDirectBoard(boardInput());
    const query = new QueryService(created.database, { cursorSecret });

    const first = query.queryTasks({ board_id: board.board_id, actor: "owner", work_unit: "WU6", ready: true, limit: 1 });
    expect(first.items).toHaveLength(1);
    expect(first.next_cursor).toEqual(expect.any(String));

    tasks.addDirectTask({
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
      expect.objectContaining({ category: "authorization", code: "query_not_authorized" })
    );
    expect(() => query.queryTasks({ board_id: "board-hidden", actor: "intruder" })).toThrowError(
      expect.objectContaining({ category: "authorization", code: "query_not_authorized" })
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
      error: { category: "authorization", code: "query_not_authorized" },
    });
    expect(JSON.stringify(denied.structuredContent)).not.toContain(board.board_id);

    await client.close();
    await server.close();
    created.database.close();
  });
});
