import { describe, expect, it } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { registerCoreTools } from "../../src/tools/core.js";
import { createIdentityRuntime } from "../helpers/identity-runtime.js";

async function setup() {
  const db = new Database(":memory:");
  for (let i = 0; i < 16; i++) db.exec(`CREATE TABLE t${i} (v TEXT)`);
  const server = new McpServer({ name: "test", version: "2.0.0" });
  const identity = await createIdentityRuntime(server);
  registerCoreTools(server, { database: () => db });
  const client = new Client({ name: "test", version: "1" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  const callTool = client.callTool.bind(client); (client as any).callTool = async (request: any, schema?: any) => { const args = request.arguments?._identity ? request.arguments : identity.signExactToolArgs(request.name, request.arguments ?? {}); const result: any = await callTool({ ...request, arguments: args }, schema); if (!result.structuredContent && result.content?.[0]?.text) result.structuredContent = JSON.parse(result.content[0].text); if (result.structuredContent?.ok !== undefined) result.structuredContent = result.structuredContent.ok ? result.structuredContent.data : { error: result.structuredContent.error }; return result; };
  return { client, db };
}

describe("core MCP adapter", () => {
  it("lists and invokes exactly the two core tools", async () => {
    const { client, db } = await setup();
    const listed = await client.listTools();
    expect(listed.tools.map((tool) => tool.name).sort()).toEqual(["forge_health", "forge_negotiate"]);
    expect((listed.tools.find((tool) => tool.name === "forge_negotiate") as any).inputSchema.properties.actor).toBeUndefined();
    const response = await client.callTool({ name: "forge_negotiate", arguments: { profile: "worker" } });
    expect((response.structuredContent as any).protocol_version).toBe("2.0");
    db.close();
  });
  it("rejects caller-supplied identity", async () => { const { client, db } = await setup(); const response = await client.callTool({ name: "forge_negotiate", arguments: { profile: "worker", actor: "mallory", _identity: {} } }); expect(response.isError).toBe(true); expect((response.structuredContent as any).error.code).toBe("IDENTITY_INVALID"); db.close(); });
  it("rejects strict input and unsupported required capabilities", async () => {
    const { client, db } = await setup();
    const strict = await client.callTool({ name: "forge_health", arguments: { extra: true } });
    expect(strict.isError).toBe(true);
    const response = await client.callTool({ name: "forge_negotiate", arguments: { profile: "worker", requiredCapabilities: ["nope"] } });
    expect(response.isError).toBe(true);
    expect((response.structuredContent as any).error.code).toBe("PROTOCOL_INCOMPATIBLE");
    db.close();
  });
});
