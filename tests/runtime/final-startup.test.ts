import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { IdentityBroker } from "../../src/identity/broker.js";
import { sha256 } from "../../src/identity/canonical.js";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(".");
const STARTUP_TIMEOUT_MS = 15_000;
const initialize = JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {
  protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "final-startup", version: "1" },
} });
const listTools = JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} });

function run(databasePath: string, secret: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  const broker = new IdentityBroker();
  const sidecarPath = path.join(path.dirname(databasePath), "identity.sqlite");
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", path.join(ROOT, "src/index.ts")], {
      cwd: ROOT, env: { ...process.env, FORGESPEC_DB: databasePath, FORGESPEC_CURSOR_SECRET: secret, NODE_NO_WARNINGS: "1", FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY: broker.rootPublicKey, FORGESPEC_IDENTITY_ISSUER: `root:${sha256(JSON.stringify(broker.rootPublicKey))}`, FORGESPEC_IDENTITY_AUDIENCE: "broker", FORGESPEC_IDENTITY_SIDECAR_PATH: sidecarPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => child.kill(), STARTUP_TIMEOUT_MS);
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.trim().split("\n").filter(Boolean).length >= 2) child.stdin.end();
    });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("close", (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    child.stdin.end(`${initialize}\n${listTools}\n`);
  });
}

describe("final runtime startup", () => {
  it("initializes, lists exactly 18 tools, and bootstraps exactly 16 tables", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-final-startup-"));
    const databasePath = path.join(directory, "fresh.db");
    const sidecarPath = path.join(directory, "identity.sqlite");
    try {
      const result = await run(databasePath, "s".repeat(32));
      expect(result.code).toBe(0);
      expect(result.stderr).not.toMatch(/startup banner|SQLite/i);
      const messages = result.stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
      expect(messages).toHaveLength(2);
      expect(messages[0].id).toBe(1);
      expect(messages[1].id).toBe(2);
      expect(messages[1].result.tools).toHaveLength(18);
      const database = new Database(databasePath, { readonly: true });
      const count = database.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { count: number };
       expect(count.count).toBe(16);
       database.close();
       const identity = new Database(sidecarPath, { readonly: true });
       const identityCount = identity.prepare("SELECT count(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { count: number };
       expect(identityCount.count).toBe(5);
       identity.close();
    } finally {
      try { await fs.promises.rm(directory, { recursive: true, force: true, maxRetries: 2, retryDelay: 25 }); } catch { /* Windows may release child SQLite handles after close. */ }
    }
  }, STARTUP_TIMEOUT_MS);
});
