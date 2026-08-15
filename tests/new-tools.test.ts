import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { createTestDatabase } from "./helpers/database.js";

describe("New MCP Tools (health & audit_log)", () => {
  it("forgespec_health returns valid server telemetry and database status", async () => {
    const created = createTestDatabase("forgespec-health-test-");
    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "health-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.callTool({ name: "forgespec_health", arguments: {} });
    expect(response.content).toHaveLength(1);
    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(parsed.status).toBe("healthy");
    expect(parsed.database.healthy).toBe(true);
    expect(parsed.database.integrity).toBe("ok");
    expect(typeof parsed.database.counts.boards).toBe("number");

    await client.close();
    await server.close();
    created.database.close();
  });

  it("tb_audit_log queries historical grants and revocations", async () => {
    const created = createTestDatabase("forgespec-audit-test-");
    const server = createServer({ database: () => created.database });
    const client = new Client({ name: "audit-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.callTool({ name: "tb_audit_log", arguments: { event_type: "all", limit: 10 } });
    expect(response.content).toHaveLength(1);
    const parsed = JSON.parse((response.content[0] as { text: string }).text);
    expect(Array.isArray(parsed.events)).toBe(true);

    await client.close();
    await server.close();
    created.database.close();
  });
});
