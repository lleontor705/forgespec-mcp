import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import type Database from "better-sqlite3";
import { SDD_TOOL_CATALOG } from "./protocol/capabilities.js";
import { registerCoreTools } from "./tools/core.js";
import { registerPlanningTools } from "./tools/planning.js";
import { registerExecutionTools } from "./tools/execution.js";
import { registerLeaseTools } from "./tools/leases.js";
import { registerContractTools } from "./tools/contracts.js";
import { registerGovernanceTools } from "./tools/governance.js";
import { installIdentityRuntime, type IdentityRuntimeContext, type IdentityVerifierLike } from "./identity/dispatcher.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8"));

export interface ServerOptions {
  database: () => Database.Database;
  cursorSecret: string | readonly string[];
  verifier: IdentityVerifierLike;
  runtime?: IdentityRuntimeContext;
}

export function createServer(options: ServerOptions): McpServer {
  if (!options.database) throw new Error("A final database provider is required");
  if (!options.cursorSecret) throw new Error("A cursor secret is required");
  if (!options.verifier) throw new Error("An identity verifier is required");
  const server = new McpServer({
    name: typeof pkg.name === "string" ? pkg.name : "forgespec-mcp",
    version: typeof pkg.version === "string" ? pkg.version : "0.0.0",
  });

  // Install the context before any tool registration: every registered tool
  // captures the server-local verifier and cannot fall back to process state.
  installIdentityRuntime(server, options.runtime ?? { verifier: options.verifier });

  registerCoreTools(server, { database: options.database, packageVersion: pkg.version });
  registerPlanningTools(server, options.database);
  registerExecutionTools(server, { database: options.database });
  registerLeaseTools(server, { database: options.database });
  registerContractTools(server, options.database);
  registerGovernanceTools(server, { database: options.database, cursorSecret: options.cursorSecret });

  // McpServer preserves registration order; expose the canonical deterministic catalog.
  const registered = (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools;
  (server as unknown as { _registeredTools: Record<string, unknown> })._registeredTools = Object.fromEntries(
    SDD_TOOL_CATALOG.map((name) => [name, registered[name]]),
  );

  return server;
}

