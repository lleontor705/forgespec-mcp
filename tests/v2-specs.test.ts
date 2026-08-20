import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDatabase, removeTestDatabases } from "./helpers/database.js";

describe("ForgeSpec v2 Spec-Driven Development Tools", () => {
  let db: Database.Database;
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const testDb = createTestDatabase("v2-specs-");
    db = testDb.database;

    server = createServer({ database: () => db });
    client = new Client({ name: "v2-specs-test", version: "2.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    removeTestDatabases();
  });

  it("saves, retrieves, updates, and lists specification contracts with revision tracking", async () => {
    // 1. Save initial spec phase
    const saveRes = await client.callTool({
      name: "spec_save",
      arguments: {
        project: "payment-gateway",
        phase: "spec",
        change_name: "Stripe Integration",
        status: "success",
        confidence: 0.95,
        executive_summary: "Defined checkout session and webhook contracts",
        contract_data: { endpoints: ["/api/checkout", "/api/webhooks/stripe"] },
        actor: "spec-agent",
      },
    });

    const saveData = JSON.parse((saveRes.content as any)[0].text);
    expect(saveData.ok).toBe(true);
    expect(saveData.revision).toBe(1);

    // 2. Get spec
    const getRes = await client.callTool({
      name: "spec_get",
      arguments: { project: "payment-gateway", phase: "spec" },
    });
    const getData = JSON.parse((getRes.content as any)[0].text);
    expect(getData.ok).toBe(true);
    expect(getData.spec.change_name).toBe("Stripe Integration");
    expect(getData.spec.data.endpoints).toContain("/api/checkout");

    // 3. Update spec -> revision should increment to 2
    const updateRes = await client.callTool({
      name: "spec_save",
      arguments: {
        project: "payment-gateway",
        phase: "spec",
        change_name: "Stripe Integration v2",
        status: "success",
        confidence: 0.98,
        executive_summary: "Added refund idempotency requirements",
        contract_data: { endpoints: ["/api/checkout", "/api/refund"] },
      },
    });
    const updateData = JSON.parse((updateRes.content as any)[0].text);
    expect(updateData.revision).toBe(2);

    // 4. List specs for project
    const listRes = await client.callTool({
      name: "spec_list",
      arguments: { project: "payment-gateway" },
    });
    const listData = JSON.parse((listRes.content as any)[0].text);
    expect(listData.ok).toBe(true);
    expect(listData.specs).toHaveLength(1);
    expect(listData.specs[0].phase).toBe("spec");
  });
});
