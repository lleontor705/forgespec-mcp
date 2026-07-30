#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createServer } from "./server.js";
import { closeDb, getDb } from "./database/index.js";

async function main(): Promise<void> {
  // Run migration and capability gates before MCP traffic is accepted. Any
  // failure is reported on stderr and leaves stdout JSON-RPC clean.
  getDb();
  const server = createServer();
  const transport = new StdioServerTransport();
  let closed = false;
  const closeResources = () => {
    if (closed) return;
    closed = true;
    closeDb();
  };

  // StdioServerTransport does not observe EOF itself. Close it explicitly so
  // the transport and SQLite connection are released without writing a
  // startup/shutdown banner to the protocol channel.
  transport.onclose = closeResources;
  process.stdin.once("end", () => {
    void transport.close();
  });

  try {
    // Connect only after preflight has completed successfully.
    await server.connect(transport);
  } catch (error) {
    closeResources();
    throw error;
  }
}

main().catch((error) => {
  console.error(formatStartupError(error));
  process.exit(1);
});

function formatStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  const code = message.match(/\b(MIGRATION_CHECKSUM_MISMATCH|SQLITE_CAPABILITY_MISSING)\b/)?.[1];
  if (code) return message;
  return "ForgeSpec MCP startup failed. Check the database and runtime capabilities before retrying.";
}
