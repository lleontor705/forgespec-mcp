import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { registerSddTools } from "./tools/sdd-contracts.js";
import { registerTaskBoardTools } from "./tools/task-board.js";
import { registerFileTools } from "./tools/file-reservation.js";
import { registerCapabilitiesTool } from "./tools/capabilities.js";
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

  registerCapabilitiesTool(server, { serverVersion: pkg.version });
  registerSddTools(server, databaseProvider);
  registerTaskBoardTools(server, databaseProvider);
  registerFileTools(server, databaseProvider);

  return server;
}
