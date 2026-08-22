import Database from "better-sqlite3";
import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFreshStore } from "../storage/bootstrap.js";
import { qualifySQLite } from "../storage/qualify.js";
import { SDD_TOOL_CATALOG } from "../protocol/capabilities.js";
import { IdentityBroker } from "../identity/broker.js";
import { sha256 } from "../identity/canonical.js";

const EXPECTED_STORAGE_TABLES = [
  "fs_approvals", "fs_attempts", "fs_audit_events", "fs_authority", "fs_authority_revocations",
  "fs_boards", "fs_contracts", "fs_evidence", "fs_gate_decisions", "fs_gates", "fs_idempotency",
  "fs_lease_scopes", "fs_leases", "fs_schema_meta", "fs_task_dependencies", "fs_tasks",
].sort();

export interface RuntimeEvidence {
  schema_version: 1;
  node_version: string;
  npm_version: string;
  modules_abi: string;
  napi_version: string;
  better_sqlite3_loaded: boolean;
  sqlite_version: string;
  sqlite_features: { strict: boolean; json1: boolean; wal: boolean };
  storage_ok: boolean;
  storage_inventory: string[];
  handshake: { initialize: boolean; tools_list: boolean; tool_count: number };
}

export interface RuntimeSmokeOptions {
  entrypoint: string;
  mode: "source" | "build";
  expectedAbi?: "127" | "137" | "147";
  tempRoot?: string;
  timeoutMs?: number;
}

export async function collectRuntimeEvidence(options: RuntimeSmokeOptions): Promise<RuntimeEvidence> {
  const tempRoot = options.tempRoot ?? fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-runtime-smoke-"));
  const databasePath = path.join(tempRoot, "runtime.db");
  const evidence: RuntimeEvidence = {
    schema_version: 1,
    node_version: process.version,
    npm_version: readNpmVersion(),
    modules_abi: process.versions.modules,
    napi_version: process.versions.napi ?? "unknown",
    better_sqlite3_loaded: false,
    sqlite_version: "",
    sqlite_features: { strict: false, json1: false, wal: false },
    storage_ok: false,
    storage_inventory: [],
    handshake: { initialize: false, tools_list: false, tool_count: 0 },
  };

  try {
    assertSupportedRuntime(evidence, options.expectedAbi);
    evidence.better_sqlite3_loaded = true;
    const database = new Database(databasePath);
    try {
      database.pragma("busy_timeout = 10000");
      database.pragma("foreign_keys = ON");
      database.pragma("journal_mode = WAL");
      createFreshStore(database);
      qualifySQLite(database);
      evidence.sqlite_version = (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version;
      evidence.sqlite_features = { strict: true, json1: true, wal: String(database.pragma("journal_mode", { simple: true })).toLowerCase() === "wal" };
      evidence.storage_inventory = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'fs_%' ORDER BY name").all() as Array<{ name: string }>).map((row) => row.name);
      evidence.storage_ok = JSON.stringify(evidence.storage_inventory) === JSON.stringify(EXPECTED_STORAGE_TABLES) && SDD_TOOL_CATALOG.length === 18;
    } finally {
      database.close();
    }
    evidence.handshake = await runMcpHandshake({ ...options, tempRoot });
    return evidence;
  } finally {
    if (options.tempRoot === undefined) fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

export function expectedAbiForNodeMajor(nodeMajor: number): "127" | "137" | "147" {
  if (nodeMajor === 22) return "127";
  if (nodeMajor === 24) return "137";
  if (nodeMajor === 26) return "147";
  throw new Error(`Unsupported observed Node major ${nodeMajor}; supported majors are 22, 24, and 26`);
}

export function validateRuntimeEvidence(
  evidence: Pick<RuntimeEvidence, "node_version" | "modules_abi">,
  explicitAbi?: "127" | "137" | "147",
): { nodeMajor: number; expectedAbi: "127" | "137" | "147"; observedAbi: string } {
  const match = /^v(\d+)(?:\.|$)/.exec(evidence.node_version);
  const nodeMajor = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(nodeMajor)) throw new Error(`Unable to determine observed Node major from ${evidence.node_version}`);
  const mappedAbi = expectedAbiForNodeMajor(nodeMajor);
  if (evidence.modules_abi !== mappedAbi) {
    throw new Error(`Node major ${nodeMajor} has expected ABI ${mappedAbi}, but observed ABI ${evidence.modules_abi}; verify the Node installation or selection`);
  }
  if (explicitAbi !== undefined && explicitAbi !== mappedAbi) {
    throw new Error(`Node major ${nodeMajor} has mapped ABI ${mappedAbi}, observed ABI ${evidence.modules_abi}, but explicit ABI ${explicitAbi}`);
  }
  return { nodeMajor, expectedAbi: mappedAbi, observedAbi: evidence.modules_abi };
}

export function assertSupportedRuntime(
  evidence: Pick<RuntimeEvidence, "node_version" | "modules_abi">,
  expectedAbi?: "127" | "137" | "147",
): void {
  validateRuntimeEvidence(evidence, expectedAbi);
}

export function runMcpHandshake(options: RuntimeSmokeOptions): Promise<RuntimeEvidence["handshake"]> {
  const databasePath = path.join(options.tempRoot ?? os.tmpdir(), "handshake.db");
  const sidecarPath = path.join(options.tempRoot ?? os.tmpdir(), "handshake-identity.sqlite");
  const broker = new IdentityBroker();
  const args = options.mode === "source" ? ["--import", "tsx/esm", options.entrypoint] : [options.entrypoint];
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: process.cwd(),
      shell: false,
      env: { ...process.env, FORGESPEC_DB: databasePath, NODE_NO_WARNINGS: "1", FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY: broker.rootPublicKey, FORGESPEC_IDENTITY_ISSUER: `root:${sha256(JSON.stringify(broker.rootPublicKey))}`, FORGESPEC_IDENTITY_AUDIENCE: "broker", FORGESPEC_IDENTITY_SIDECAR_PATH: sidecarPath },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const timeout = setTimeout(() => {
      child.kill();
      finish(new Error("MCP handshake timed out"));
    }, options.timeoutMs ?? 15_000);
    const finish = (error?: Error, result?: RuntimeEvidence["handshake"]) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(new Error(`${error.message}${stderr ? ` (${redact(stderr)})` : ""}`));
      else resolve(result!);
    };
    child.stdout.on("data", (chunk: Buffer) => { stdout += chunk.toString("utf8"); });
    child.stderr.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (error) => finish(error));
    child.on("close", (code) => {
      if (code !== 0) return finish(new Error(`MCP child exited with code ${code}`));
      try {
        const messages = stdout.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line) as {
          jsonrpc?: string; id?: number; result?: { tools?: unknown[] };
        });
        const initialize = messages.find((message) => message.id === 1);
        const tools = messages.find((message) => message.id === 2);
        const valid = messages.length === 2 && messages.every((message) => message.jsonrpc === "2.0" && message.result !== undefined);
        if (!valid || !initialize || !tools) return finish(new Error("Invalid MCP JSON-RPC handshake"));
        finish(undefined, { initialize: true, tools_list: true, tool_count: tools.result?.tools?.length ?? 0 });
      } catch (error) {
        finish(new Error(`Malformed MCP JSON-RPC output: ${error instanceof Error ? error.message : "unknown"}`));
      }
    });
    child.stdin.end([
      JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "runtime-smoke", version: "1.0.0" } } }),
      JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    ].join("\n") + "\n");
  });
}

function readNpmVersion(): string {
  try {
    const executable = process.platform === "win32" ? (process.env.ComSpec ?? "cmd.exe") : "npm";
    const args = process.platform === "win32" ? ["/d", "/s", "/c", "npm --version"] : ["--version"];
    return execFileSync(executable, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return process.env.npm_config_user_agent?.match(/npm\/([^ ]+)/)?.[1] ?? "unavailable";
  }
}

function redact(value: string): string {
  return value.replace(/[A-Za-z]:\\[^\r\n ]+/g, "<path>").replace(/(token|secret|password)=?[^\s]+/gi, "$1=<redacted>");
}
