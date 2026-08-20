import { describe, expect, it, beforeEach, afterEach } from "vitest";
import type Database from "better-sqlite3";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTestDatabase, removeTestDatabases } from "./helpers/database.js";

describe("Security Hardening & Input Sanitization", () => {
  let db: Database.Database;
  let client: Client;
  let server: ReturnType<typeof createServer>;

  beforeEach(async () => {
    const testDb = createTestDatabase("sec-hardening-");
    db = testDb.database;

    server = createServer({ database: () => db });
    client = new Client({ name: "security-hardening-test", version: "2.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  });

  afterEach(() => {
    removeTestDatabases();
  });

  it("file_reserve rejects path traversal attempts with .. securely", async () => {
    const res = await client.callTool({
      name: "file_reserve",
      arguments: {
        project: "test-proj",
        paths: ["src/../../etc/passwd"],
        holder: "attacker",
      },
    });
    expect(res.isError).toBe(true);
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ok).toBe(false);
    expect(parsed.error).toMatch(/Path traversal disallowed/i);
  });

  it("file_reserve normalizes Windows backslashes", async () => {
    const res = await client.callTool({
      name: "file_reserve",
      arguments: {
        project: "test-proj",
        paths: ["src\\auth\\tokens.ts"],
        holder: "windows-agent",
      },
    });
    const parsed = JSON.parse((res.content as Array<{ text: string }>)[0].text);
    expect(parsed.ok).toBe(true);
    expect(parsed.leases[0].path_pattern).toBe("src/auth/tokens.ts");
  });
});
