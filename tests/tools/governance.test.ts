import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { registerGovernanceTools } from "../../src/tools/governance.js";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { createIdentityRuntime } from "../helpers/identity-runtime.js";

async function client() {
  const db = new Database(":memory:"); createFreshStore(db);
  const server = new McpServer({ name: "g", version: "2" });
  const identity = await createIdentityRuntime(server);
  registerGovernanceTools(server, { database: () => db, cursorSecret: "01234567890123456789012345678901" });
  const c = new Client({ name: "c", version: "2" }); const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), c.connect(a)]);
  return { c, db, identity, async cleanup() { await identity.cleanup(); db.close(); } };
}
const invalid = (r: any) => expect(r.isError === true || !!r.structuredContent?.error).toBe(true);
const signed = (identity: Awaited<ReturnType<typeof createIdentityRuntime>>, tool: string, args: Record<string, unknown>, worker = "test-worker") => identity.signExactToolArgs(tool, args, { root: "root", parent: "parent", worker });
const workerHandle = (frame: any) => frame._identity.payload.session.worker;

describe("governance tools", () => {
  it("registers exact names and rejects caller/reviewer spoof fields", async () => {
    const { c, cleanup, identity } = await client();
    try {
      expect((await c.listTools()).tools.map(x => x.name).sort()).toEqual(["approval_record", "authority_manage", "event_query"]);
      invalid(await c.callTool({ name: "authority_manage", arguments: signed(identity, "authority_manage", { action: "query", actor: "spoof" }) }));
      invalid(await c.callTool({ name: "approval_record", arguments: signed(identity, "approval_record", { board_id: "b", task_id: "t", gate_id: "g", attempt_id: "a", decision: "allow", expected_task_revision: 1, idempotency_key: "x", reviewer_actor: "spoof" }) }));
    } finally { await cleanup(); }
  });

  it("enrolls grantees through signed calls and accepts only enrolled handles", async () => {
    const { c, db, identity, cleanup } = await client();
    try {
      const ownerFrame = signed(identity, "event_query", { board_id: "missing", limit: 1 });
      const owner = workerHandle(ownerFrame);
      invalid(await c.callTool({ name: "event_query", arguments: ownerFrame }));
      const board = createBoard(db, { project: "p", name: "n", actor: owner, idempotencyKey: "board-1", authorityExpiresAt: Date.now() + 60_000 });
      const granteeFrame = signed(identity, "event_query", { board_id: "missing", limit: 1 }, "grantee");
      const grantee = workerHandle(granteeFrame);
      const enrolled = await c.callTool({ name: "event_query", arguments: granteeFrame });
      invalid(enrolled);
      expect((identity.database.prepare("SELECT worker FROM fsi_sessions WHERE worker=?").get(grantee) as any)?.worker).toBe(grantee);
      const grant = await c.callTool({ name: "authority_manage", arguments: signed(identity, "authority_manage", { action: "grant", resource: { kind: "board", board_id: board.id }, operations: ["read_board"], expires_at: Date.now() + 30_000, grantee_handle: grantee, idempotency_key: "grant-1" }) });
      expect(grant.isError).not.toBe(true);
      invalid(await c.callTool({ name: "authority_manage", arguments: signed(identity, "authority_manage", { action: "grant", resource: { kind: "board", board_id: board.id }, operations: ["read_board"], expires_at: Date.now() + 30_000, grantee_handle: "never-enrolled", idempotency_key: "grant-unknown" }) }));
    } finally { await cleanup(); }
  });

  it("rejects opaque or malformed authority resources and duplicate operations", async () => {
    const { c, identity, cleanup } = await client();
    try {
      const base = { action: "grant", expires_at: Date.now() + 30_000, grantee_handle: "grantee", idempotency_key: "bad" };
      for (const resource of [
        { kind: "board", board_id: "b", resource_id: "opaque" },
        { kind: "task", board_id: "b" },
      ]) invalid(await c.callTool({ name: "authority_manage", arguments: signed(identity, "authority_manage", { ...base, resource }) }));
      invalid(await c.callTool({ name: "authority_manage", arguments: signed(identity, "authority_manage", { ...base, resource: { kind: "board", board_id: "b" }, operations: ["read_board", "read_board"] }) }));
    } finally { await cleanup(); }
  });

  it("binds event cursors to the verified worker", async () => {
    const { c, identity, cleanup } = await client();
    try {
      const first = await c.callTool({ name: "event_query", arguments: signed(identity, "event_query", { board_id: "missing", limit: 1 }) });
      invalid(first);
      invalid(await c.callTool({ name: "event_query", arguments: signed(identity, "event_query", { board_id: "missing", cursor: "tampered", limit: 1 }, "other-worker") }));
    } finally { await cleanup(); }
  });
});
