import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDatabase, removeTestDatabases } from "./helpers/database.js";

describe("ForgeSpec v2 File Advisory Leases & Concurrency", () => {
  let db: Database.Database;
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const testDb = createTestDatabase("v2-files-");
    db = testDb.database;

    server = createServer({ database: () => db });
    client = new Client({ name: "v2-files-test", version: "2.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    removeTestDatabases();
  });

  it("reserves files, prevents conflicting locks by other agents, and releases successfully", async () => {
    // 1. Agent A acquires lease
    const resA = await client.callTool({
      name: "file_reserve",
      arguments: {
        project: "auth-service",
        paths: ["src/auth/jwt.ts", "src/auth/session.ts"],
        holder: "agent-a",
        lease_seconds: 300,
      },
    });
    const dataA = JSON.parse((resA.content as any)[0].text);
    expect(dataA.ok).toBe(true);
    expect(dataA.leases).toHaveLength(2);

    // 2. Agent B attempts to acquire conflicting lease -> should fail with conflict error
    const resB = await client.callTool({
      name: "file_reserve",
      arguments: {
        project: "auth-service",
        paths: ["src/auth/jwt.ts"],
        holder: "agent-b",
      },
    });
    expect(resB.isError).toBe(true);
    const dataB = JSON.parse((resB.content as any)[0].text);
    expect(dataB.ok).toBe(false);
    expect(dataB.error).toContain("held by \"agent-a\"");

    // 3. Agent A releases lease
    const releaseRes = await client.callTool({
      name: "file_release",
      arguments: {
        project: "auth-service",
        paths: ["src/auth/jwt.ts"],
        holder: "agent-a",
      },
    });
    const releaseData = JSON.parse((releaseRes.content as any)[0].text);
    expect(releaseData.ok).toBe(true);
    expect(releaseData.released_count).toBe(1);

    // 4. Agent B can now acquire the released path
    const retryB = await client.callTool({
      name: "file_reserve",
      arguments: {
        project: "auth-service",
        paths: ["src/auth/jwt.ts"],
        holder: "agent-b",
      },
    });
    const retryDataB = JSON.parse((retryB.content as any)[0].text);
    expect(retryDataB.ok).toBe(true);
  });

  it("rejects path traversal attempts securely", async () => {
    const res = await client.callTool({
      name: "file_reserve",
      arguments: {
        project: "secure-proj",
        paths: ["../../etc/passwd"],
        holder: "attacker",
      },
    });
    expect(res.isError).toBe(true);
    const data = JSON.parse((res.content as any)[0].text);
    expect(data.error).toContain("Path traversal disallowed");
  });
});
