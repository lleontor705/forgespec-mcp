import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { registerPlanningTools } from "../../src/tools/planning.js";
import { createIdentityRuntime } from "../helpers/identity-runtime.js";

async function setup() {
  const db = new Database(":memory:"); createFreshStore(db);
  const server = new McpServer({ name: "test", version: "1" }); const identity = await createIdentityRuntime(server); registerPlanningTools(server, () => db);
  const client = new Client({ name: "test", version: "1" }); const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]); const callTool = client.callTool.bind(client); (client as any).callTool = async (request: any, schema?: any) => { const args = request.arguments?._identity ? request.arguments : identity.signExactToolArgs(request.name, request.arguments ?? {}, { root: "test-root", parent: "test-parent", worker: (request.arguments as any)?.actor ?? "alice" }); const result: any = await callTool({ ...request, arguments: args }, schema); if (!result.structuredContent && result.content?.[0]?.text?.trimStart().startsWith("{")) result.structuredContent = JSON.parse(result.content[0].text); if (result.structuredContent?.ok !== undefined) result.structuredContent = result.structuredContent.ok ? result.structuredContent.data : { error: result.structuredContent.error }; return result; }; return { client, db };
}
const board = { actor: "alice", idempotency_key: "b1", project: "p", name: "Planning", metadata: { x: 1 } };
const task = (over = {}) => ({ actor: "alice", idempotency_key: "t1", board_id: "board", expected_board_revision: 1, title: "First", priority: "p1", ...over });
async function makeBoard(client: Client) { const r = await client.callTool({ name: "board_create", arguments: board }); return r.structuredContent as any; }

describe("planning MCP tools", () => {
  it("lists exactly final names", async () => { const { client, db } = await setup(); expect((await client.listTools()).tools.map((x) => x.name).sort()).toEqual(["board_create", "task_define", "task_query"]); db.close(); });
  it("creates and replays, while conflicting idempotency fails", async () => { const { client, db } = await setup(); const first = await makeBoard(client); const replay = await makeBoard(client); expect(replay).toEqual(first); const conflict = await client.callTool({ name: "board_create", arguments: { ...board, name: "Other" } }); expect(conflict.isError).toBe(true); expect((conflict.structuredContent as any).error.code).toBe("IDEMPOTENCY_CONFLICT"); db.close(); });
  it("enforces authority, CAS, dependencies, and query bounds", async () => { const { client, db } = await setup(); const created = await makeBoard(client); const input = task({ board_id: created.id }); const defined = await client.callTool({ name: "task_define", arguments: input }); expect(defined.isError).toBe(false); const denied = await client.callTool({ name: "task_define", arguments: task({ board_id: created.id, actor: "mallory" }) }); expect((denied.structuredContent as any).error.code).toBe("RESOURCE_NOT_AVAILABLE"); const stale = await client.callTool({ name: "task_define", arguments: task({ board_id: created.id, idempotency_key: "t2" }) }); expect((stale.structuredContent as any).error.code).toBe("STALE_REVISION"); const queried = await client.callTool({ name: "task_query", arguments: { actor: "alice", board_id: created.id, limit: 1 } }); expect((queried.structuredContent as any).records).toHaveLength(1); const limited = await client.callTool({ name: "task_query", arguments: { actor: "alice", board_id: created.id, limit: 201 } }); expect(limited.isError).toBe(true); db.close(); });
  it("rejects unauthorized query, unknown fields, and invalid dependencies", async () => { const { client, db } = await setup(); const created = await makeBoard(client); const unknown = await client.callTool({ name: "board_create", arguments: { ...board, extra: true } }); expect(unknown.isError).toBe(true); const denied = await client.callTool({ name: "task_query", arguments: { actor: "mallory", board_id: created.id, limit: 10 } }); expect((denied.structuredContent as any).total_count).toBe(0); const invalid = await client.callTool({ name: "task_define", arguments: task({ board_id: created.id, dependencies: ["missing"] }) }); expect((invalid.structuredContent as any).error.code).toBe("REQUEST_INVALID"); db.close(); });
});
