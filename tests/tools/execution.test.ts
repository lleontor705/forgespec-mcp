import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { defineTask } from "../../src/domain/tasks.js";
import { derivePseudonymousHandles } from "../../src/identity/broker.js";
import { registerExecutionTools } from "../../src/tools/execution.js";
import { createIdentityRuntime } from "../helpers/identity-runtime.js";

const session = { root: "execution-root", parent: "execution-parent", worker: "execution-worker" };
const worker = derivePseudonymousHandles(session).worker;

async function open() {
  const db = new Database(":memory:"); createFreshStore(db);
  createBoard(db, { id: "b", project: "p", name: "B", actor: worker, idempotencyKey: "b" });
  defineTask(db, { id: "t", boardId: "b", title: "T", priority: "p1", actor: worker, idempotencyKey: "t", expectedBoardRevision: 1 });
  const server = new McpServer({ name: "execution-test", version: "2" });
  const identity = await createIdentityRuntime(server); registerExecutionTools(server, { database: () => db });
  const client = new Client({ name: "client", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const call = (name: string, args: Record<string, unknown>, s = session) => client.callTool({ name, arguments: identity.signExactToolArgs(name, args, s) });
  return { db, client, identity, call };
}

const claim = { idempotency_key: "claim", board_id: "b", task_id: "t", expected_task_revision: 1, lease_seconds: 15 };
const data = (r: any) => r.structuredContent?.data ?? r.structuredContent as any;

describe("execution MCP tools", () => {
  it("requires signed identity, binds actor to worker, and rejects replay", async () => {
    const { db, identity, client } = await open();
    const frame = identity.signExactToolArgs("attempt_claim", claim, session);
    const first: any = await client.callTool({ name: "attempt_claim", arguments: frame });
    expect(first.isError).toBe(false);
    expect(data(first).claimToken).toEqual(expect.any(String));
    const replay: any = await client.callTool({ name: "attempt_claim", arguments: frame });
    expect(replay.isError).toBe(true);
    expect(JSON.stringify(replay)).not.toContain(data(first).claimToken);
    db.close(); await identity.cleanup();
  });

  it("uses fresh attestations for idempotent retry and rejects forged actor input", async () => {
    const { db, identity, call } = await open();
    const first: any = await call("attempt_claim", claim);
    expect(first.isError).toBe(false);
    const retry: any = await call("attempt_claim", claim);
    expect(retry.isError).toBe(false); expect(data(retry).claimToken).toBeNull();
    const forged: any = await call("attempt_claim", { ...claim, actor: "mallory", idempotency_key: "forged" });
    expect(forged.isError).toBe(true); expect(data(forged).error.code).toBe("STALE_REVISION"); expect(JSON.stringify(forged)).not.toContain("mallory");
    db.close(); await identity.cleanup();
  });

  it("keeps claim tokens out of bad-token errors and enforces bounds", async () => {
    const { db, identity, call } = await open();
    const first: any = await call("attempt_claim", claim);
    const bad: any = await call("attempt_renew", { board_id: "b", task_id: "t", attempt_id: data(first).attemptId, claim_token: "secret-token", extend_seconds: 15, expected_task_revision: 2, idempotency_key: "renew" });
    expect(bad.isError).toBe(true); expect(JSON.stringify(bad)).not.toContain("secret-token");
    const invalid: any = await call("attempt_claim", { ...claim, lease_seconds: 3601, idempotency_key: "bounds" });
    expect(invalid.isError).toBe(true);
    db.close(); await identity.cleanup();
  });
});
