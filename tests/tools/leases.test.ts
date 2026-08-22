import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { defineTask } from "../../src/domain/tasks.js";
import { claimAttempt } from "../../src/domain/attempts.js";
import { derivePseudonymousHandles } from "../../src/identity/broker.js";
import { registerLeaseTools } from "../../src/tools/leases.js";
import { createIdentityRuntime } from "../helpers/identity-runtime.js";

let db: Database.Database | undefined;
let cleanup: (() => Promise<void>) | undefined;
const session = { root: "lease-root", parent: "lease-parent", worker: "lease-worker" };
const worker = derivePseudonymousHandles(session).worker;
const data = (r: any) => r.structuredContent?.data ?? r.structuredContent as any;

async function setup() {
  db = new Database(":memory:"); createFreshStore(db);
  createBoard(db, { id: "b", project: "p", name: "b", actor: worker, idempotencyKey: "b" });
  defineTask(db, { id: "t", boardId: "b", title: "t", priority: "p1", actor: worker, idempotencyKey: "t", expectedBoardRevision: 1 });
  const attempt = claimAttempt(db, { boardId: "b", taskId: "t", actor: worker, expectedTaskRevision: 1, leaseSeconds: 60, idempotencyKey: "claim" });
  const server = new McpServer({ name: "lease-test", version: "2" });
  const identity = await createIdentityRuntime(server); registerLeaseTools(server, { database: () => db! });
  cleanup = identity.cleanup;
  const client = new Client({ name: "test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair(); await Promise.all([server.connect(b), client.connect(a)]);
  const call = (name: string, args: Record<string, unknown>, s = session) => client.callTool({ name, arguments: identity.signExactToolArgs(name, args, s) });
  const reserve = (paths = ["src/a.ts"], key = "reserve", s = session) => call("lease_reserve", { board_id: "b", task_id: "t", attempt_id: attempt.attemptId, claim_token: attempt.claimToken, paths, case_policy: "sensitive", lease_seconds: 60, idempotency_key: key }, s);
  return { client, attempt, reserve, call, identity };
}

afterEach(async () => { db?.close(); db = undefined; await cleanup?.(); cleanup = undefined; });

describe("lease MCP tools", () => {
  it("requires signed identity, preserves token redaction, and rejects replay", async () => {
    const { client, identity } = await setup();
    const args = { board_id: "b", task_id: "t", attempt_id: "attempt-missing", claim_token: "bad", paths: ["src/a.ts"], case_policy: "sensitive", lease_seconds: 60, idempotency_key: "replay" };
    const frame = identity.signExactToolArgs("lease_reserve", args, session);
    const first: any = await client.callTool({ name: "lease_reserve", arguments: frame });
    expect(first.isError).toBe(true); expect(JSON.stringify(first)).not.toContain("bad");
    const replay: any = await client.callTool({ name: "lease_reserve", arguments: frame });
    expect(replay.isError).toBe(true);
  });

  it("binds lease mutations to the attested worker and uses fresh idempotent calls", async () => {
    const { reserve, call } = await setup();
    const first: any = await reserve(); expect(data(first).leaseToken).toEqual(expect.any(String));
    const retry: any = await reserve(["src/a.ts"], "reserve"); expect(data(retry).leaseToken).toBeNull();
    const renewArgs = { lease_id: data(first).leaseId, lease_token: data(first).leaseToken, expected_revision: 1, extend_seconds: 60, idempotency_key: "renew" };
    const renewed: any = await call("lease_renew", renewArgs); expect(data(renewed).revision).toBe(2);
    const other: any = await call("lease_renew", { ...renewArgs, idempotency_key: "other" }, { root: "other-root", parent: "other-parent", worker: "other-worker" });
    expect(other.isError).toBe(true); expect(JSON.stringify(other)).not.toContain(data(first).leaseToken);
  });

  it("rejects caller holder fields and invalid scopes", async () => {
    const { reserve, call } = await setup();
    const forged: any = await call("lease_reserve", { board_id: "b", task_id: "t", attempt_id: "x", claim_token: "x", paths: ["src/a.ts"], case_policy: "sensitive", lease_seconds: 60, idempotency_key: "forged", holder: "mallory" });
    expect(forged.isError).toBe(true);
    const traversal: any = await reserve(["../secret"], "traversal"); expect(data(traversal).error.code).toBe("INVALID_SCOPE");
  });
});
