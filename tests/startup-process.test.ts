import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createV2Database } from "./helpers/database.js";

const projectRoot = path.resolve(".");
const temporaryDirectories: string[] = [];
const STARTUP_TIMEOUT_MS = 15_000;

type ProcessResult = {
  code: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
};

function runServer(databasePath: string, input: string, expectedLines = 0): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx/esm", path.join(projectRoot, "src/index.ts")], {
      cwd: projectRoot,
      env: { ...process.env, FORGESPEC_DB: databasePath, NODE_NO_WARNINGS: "1" },
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
  it("aborts before initialize on a migration checksum mismatch with zero stdout", async () => {
    const { path: databasePath, database } = createV2Database("forgespec-startup-checksum-");
    database
      .prepare("UPDATE schema_migrations SET checksum = ? WHERE version = 2")
      .run("sha256:tampered");
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
    expect(result.stderr).toMatch(/version|migration/i);
    expect(result.stderr).toMatch(/expected|observed|restore|repair|safe/i);
  }, STARTUP_TIMEOUT_MS);

  it("reports STRICT, JSON1, and effective WAL qualification on stderr only", async () => {
    const databasePath = createTemporaryDatabasePath("forgespec-startup-capabilities-");
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

    expect(result.stdout).not.toMatch(/SQLite|STRICT|JSON1|journal_mode/i);
    expect(result.stderr).toMatch(/STRICT/i);
    expect(result.stderr).toMatch(/JSON1|json_valid/i);
    expect(result.stderr).toMatch(/WAL.*wal|journal_mode.*wal/i);
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
