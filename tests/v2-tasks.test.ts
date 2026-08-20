import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDatabase, removeTestDatabases } from "./helpers/database.js";

describe("ForgeSpec v2 Task Coordination Tools", () => {
  let db: Database.Database;
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const testDb = createTestDatabase("v2-tasks-");
    db = testDb.database;

    server = createServer({ database: () => db });
    client = new Client({ name: "v2-tasks-test", version: "2.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    removeTestDatabases();
  });

  it("creates a board with inline tasks and correctly initializes status by dependencies", async () => {
    const res = await client.callTool({
      name: "task_board_create",
      arguments: {
        project: "proj-alpha",
        name: "Sprint 1",
        owner_actor: "lead-agent",
        tasks: [
          { title: "Task 1 (Independent)", priority: "p0" },
          { title: "Task 2 (Depends on Task 1)", priority: "p1", dependencies: ["Task 1 (Independent)"] },
        ],
      },
    });

    const data = JSON.parse((res.content as any)[0].text);
    expect(data.ok).toBe(true);
    expect(data.board_id).toBeDefined();
    expect(data.task_count).toBe(2);
    expect(data.task_ids).toHaveLength(2);

    // Verify board status
    const boardRes = await client.callTool({
      name: "task_board_get",
      arguments: { board_id: data.board_id },
    });
    const boardData = JSON.parse((boardRes.content as any)[0].text);
    expect(boardData.ok).toBe(true);
    expect(boardData.summary.by_status.ready).toBe(1);
    expect(boardData.summary.by_status.backlog).toBe(1);
    expect(boardData.tasks.ready[0].title).toBe("Task 1 (Independent)");
    expect(boardData.tasks.backlog[0].title).toBe("Task 2 (Depends on Task 1)");
  });

  it("handles full task lifecycle: claim, heartbeat, complete with DAG auto-unblock and file lease release", async () => {
    // 1. Create board
    const createRes = await client.callTool({
      name: "task_board_create",
      arguments: {
        project: "proj-lifecycle",
        name: "Backend Feature",
        tasks: [
          { title: "Database Migration", priority: "p0" },
          { title: "API Endpoint", priority: "p1", dependencies: ["Database Migration"] },
        ],
      },
    });
    const board = JSON.parse((createRes.content as any)[0].text);
    const [t1Id, t2Id] = board.task_ids;

    // 2. Claim Task 1 with working file reservations
    const claimRes = await client.callTool({
      name: "task_claim",
      arguments: {
        task_id: t1Id,
        actor: "backend-agent",
        lease_seconds: 300,
        project: "proj-lifecycle",
        reserve_files: ["src/database/schema.ts"],
      },
    });
    const claimData = JSON.parse((claimRes.content as any)[0].text);
    expect(claimData.ok).toBe(true);
    expect(claimData.attempt_id).toBeDefined();
    expect(claimData.claim_token).toBeDefined();
    expect(claimData.reserved_files).toContain("src/database/schema.ts");

    // 3. Heartbeat
    const hbRes = await client.callTool({
      name: "task_heartbeat",
      arguments: {
        task_id: t1Id,
        attempt_id: claimData.attempt_id,
        claim_token: claimData.claim_token,
        extend_seconds: 600,
      },
    });
    const hbData = JSON.parse((hbRes.content as any)[0].text);
    expect(hbData.ok).toBe(true);

    // 4. Complete Task 1 -> should auto-unblock Task 2 and release file reservations
    const completeRes = await client.callTool({
      name: "task_complete",
      arguments: {
        task_id: t1Id,
        attempt_id: claimData.attempt_id,
        claim_token: claimData.claim_token,
        notes: "Migration implemented and verified",
      },
    });
    const completeData = JSON.parse((completeRes.content as any)[0].text);
    expect(completeData.ok).toBe(true);
    expect(completeData.status).toBe("done");
    expect(completeData.unblocked_tasks).toContain(t2Id);
    expect(completeData.released_files_count).toBe(1);

    // 5. Verify Task 2 is now ready to claim
    const boardRes = await client.callTool({
      name: "task_board_get",
      arguments: { board_id: board.board_id },
    });
    const boardData = JSON.parse((boardRes.content as any)[0].text);
    expect(boardData.summary.by_status.done).toBe(1);
    expect(boardData.summary.by_status.ready).toBe(1);
    expect(boardData.tasks.ready[0].id).toBe(t2Id);
  });

  it("supports blocking tasks with reasons", async () => {
    const createRes = await client.callTool({
      name: "task_board_create",
      arguments: {
        project: "proj-block",
        name: "Block Test",
        tasks: [{ title: "Flaky Test", priority: "p2" }],
      },
    });
    const board = JSON.parse((createRes.content as any)[0].text);
    const taskId = board.task_ids[0];

    const blockRes = await client.callTool({
      name: "task_block",
      arguments: {
        task_id: taskId,
        reason: "Blocked waiting on external API credentials",
      },
    });
    const blockData = JSON.parse((blockRes.content as any)[0].text);
    expect(blockData.ok).toBe(true);
    expect(blockData.status).toBe("blocked");
    expect(blockData.reason).toContain("external API credentials");
  });
});
