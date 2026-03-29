import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerSddTools } from "./tools/sdd-contracts.js";
import { registerTaskBoardTools } from "./tools/task-board.js";
import { registerFileTools } from "./tools/file-reservation.js";

export function createServer(): McpServer {
  const server = new McpServer({
    name: "forgespec-mcp",
    version: "1.0.0",
  });

  registerSddTools(server);
  registerTaskBoardTools(server);
  registerFileTools(server);

  return server;
}
