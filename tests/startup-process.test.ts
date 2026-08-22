import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFreshStore } from "../src/storage/bootstrap.js";
import { IdentityBroker } from "../src/identity/broker.js";
import { sha256 } from "../src/identity/canonical.js";

const projectRoot = path.resolve(".");
const temporaryDirectories: string[] = [];
const STARTUP_TIMEOUT_MS = 15_000;

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runServer(databasePath: string, input: string, expectedLines = 0, validBootstrap = true): Promise<ProcessResult> {
  const sidecarPath = path.join(path.dirname(databasePath), "identity.sqlite");
  const broker = new IdentityBroker();
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", path.join(projectRoot, "src/index.ts")], {
      cwd: projectRoot,
      env: { ...process.env, FORGESPEC_DB: databasePath, NODE_NO_WARNINGS: "1", ...(validBootstrap ? { FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY: broker.rootPublicKey, FORGESPEC_IDENTITY_ISSUER: `root:${sha256(JSON.stringify(broker.rootPublicKey))}`, FORGESPEC_IDENTITY_AUDIENCE: "broker", FORGESPEC_IDENTITY_SIDECAR_PATH: sidecarPath } : {}) },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timer = setTimeout(() => {
      child.kill();
    }, STARTUP_TIMEOUT_MS);

    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ code, signal, stdout, stderr });
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (expectedLines > 0 && stdout.trim().split("\n").filter(Boolean).length >= expectedLines) {
        child.stdin.end();
      }
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("close", finish);
    child.stdin.end(input);
  });
}

function createTemporaryDatabasePath(prefix: string): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return path.join(directory, "startup.db");
}

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("startup process gates", () => {
  it("fails closed on an unsupported inventory without mutating the store", async () => {
    const databasePath = createTemporaryDatabasePath("forgespec-startup-malformed-");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE unsupported_inventory (id INTEGER NOT NULL)");
    const before = database
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();
    database.close();

    const result = await runServer(
      databasePath,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "startup-test", version: "1.0.0" },
        },
      })}\n`
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ForgeSpec MCP startup failed. Check the database and runtime capabilities before retrying.\n");

    const reopened = new Database(databasePath, { readonly: true });
    const after = reopened
      .prepare("SELECT type, name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
      .all();
    reopened.close();
    expect(after).toEqual(before);
  }, STARTUP_TIMEOUT_MS);

  it("rejects a malformed final store with DATABASE_INCOMPATIBLE and no mutation", async () => {
    const databasePath = createTemporaryDatabasePath("forgespec-startup-capabilities-");
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("foreign_keys = ON");
    createFreshStore(database);
    database.prepare("DELETE FROM fs_schema_meta WHERE key = 'core'").run();
    const before = database
      .prepare("SELECT key, schema_version, bootstrap_metadata_json, recovery_mode FROM fs_schema_meta")
      .all();
    database.close();
    const result = await runServer(
      databasePath,
      "",
    );

    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("ForgeSpec MCP startup failed. Check the database and runtime capabilities before retrying.\n");

    const reopened = new Database(databasePath, { readonly: true });
    const after = reopened
      .prepare("SELECT key, schema_version, bootstrap_metadata_json, recovery_mode FROM fs_schema_meta")
      .all();
    reopened.close();
    expect(after).toEqual(before);
  }, STARTUP_TIMEOUT_MS);

  it("rejects missing trust bootstrap before opening the domain store", async () => {
    const databasePath = createTemporaryDatabasePath("forgespec-startup-trust-");
    const result = await runServer(databasePath, "", 0, false);
    expect(result.code).not.toBe(0);
    expect(result.stdout).toBe("");
    expect(result.stderr).toBe("TRUST_BOOTSTRAP_INVALID\n");
    expect(fs.existsSync(databasePath)).toBe(false);
  }, STARTUP_TIMEOUT_MS);

  it("closes cleanly on EOF before initialize without a startup banner", async () => {
    const databasePath = createTemporaryDatabasePath("forgespec-startup-eof-");
    const result = await runServer(databasePath, "");

    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
  }, STARTUP_TIMEOUT_MS);

  it("serves initialize and tools/list as JSON-RPC-only stdout", async () => {
    const databasePath = createTemporaryDatabasePath("forgespec-startup-jsonrpc-");
    const result = await runServer(
      databasePath,
      `${JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "initialize",
        params: {
          protocolVersion: "2025-06-18",
          capabilities: {},
          clientInfo: { name: "startup-test", version: "1.0.0" },
        },
      })}\n${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`,
      2
    );

    const messages = result.stdout
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as { jsonrpc: string; id: number; result?: unknown });
    expect(messages).toHaveLength(2);
    expect(messages.every(({ jsonrpc }) => jsonrpc === "2.0")).toBe(true);
    expect(messages.map(({ id }) => id)).toEqual([1, 2]);
    expect(messages.every(({ result }) => result !== undefined)).toBe(true);
  }, STARTUP_TIMEOUT_MS);
});
