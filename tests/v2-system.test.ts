import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDatabase, removeTestDatabases } from "./helpers/database.js";

describe("ForgeSpec v2 System & Audit Tools", () => {
  let db: Database.Database;
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const testDb = createTestDatabase("v2-system-");
    db = testDb.database;

    server = createServer({ database: () => db });
    client = new Client({ name: "v2-system-test", version: "2.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    removeTestDatabases();
  });

  it("returns runtime diagnostics and records searchable audit events", async () => {
    // 1. Check system_health
    const healthRes = await client.callTool({
      name: "system_health",
      arguments: {},
    });
    const healthData = JSON.parse((healthRes.content as any)[0].text);
    expect(healthData.ok).toBe(true);
    expect(healthData.version).toBe("2.0.0");
    expect(healthData.sqlite_version).toBeDefined();
    expect(healthData.memory.rss_mb).toBeGreaterThan(0);

    // 2. Perform actions to trigger audit logs
    await client.callTool({
      name: "task_board_create",
      arguments: {
        project: "audit-proj",
        name: "Audit Board",
        owner_actor: "audit-tester",
      },
    });

    // 3. Query audit log
    const auditRes = await client.callTool({
      name: "system_audit_log",
      arguments: { entity_type: "board" },
    });
    const auditData = JSON.parse((auditRes.content as any)[0].text);
    expect(auditData.ok).toBe(true);
    expect(auditData.count).toBeGreaterThan(0);
    expect(auditData.events[0].entity_type).toBe("board");
    expect(auditData.events[0].actor).toBe("audit-tester");
  });
});
