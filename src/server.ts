import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { registerSddTools } from "./tools/sdd-contracts.js";
import { registerTaskBoardTools } from "./tools/task-board.js";
import { registerFileTools } from "./tools/file-reservation.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

export function createServer(): McpServer {
  const server = new McpServer({
    name: "forgespec-mcp",
    version: pkg.version,
  });

  registerSddTools(server);
  registerTaskBoardTools(server);
  registerFileTools(server);

  return server;
}
