import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { registerTaskTools } from "./tools/tasks.js";
import { registerSpecTools } from "./tools/specs.js";
import { registerFileLeaseTools } from "./tools/files.js";
import { registerSystemTools } from "./tools/system.js";
import { getDb } from "./database/index.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

export interface ServerOptions {
  database?: () => Database.Database;
}

export function createServer(options?: ServerOptions): McpServer {
  const server = new McpServer({
    name: "forgespec-mcp",
    version: pkg.version,
  });

  const databaseProvider = options?.database ?? getDb;

  // ── ForgeSpec v2.0.0 Clean Break Suite (14 Tools) ──
  registerTaskTools(server, databaseProvider);
  registerSpecTools(server, databaseProvider);
  registerFileLeaseTools(server, databaseProvider);
  registerSystemTools(server, databaseProvider);

  return server;
}

