#!/usr/bin/env node

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { randomBytes } from "node:crypto";
import { createServer } from "./server.js";
import { close, get, open } from "./storage/database.js";
import { openIdentityStore } from "./identity/store.js";
import { IdentityVerifier } from "./identity/verifier.js";
import { readIdentityBootstrap } from "./runtime/identity-bootstrap.js";

function resolveCursorSecret(): string {
  const configured = process.env.FORGESPEC_CURSOR_SECRET;
  if (configured && Buffer.byteLength(configured, "utf8") >= 32) return configured;
  return randomBytes(32).toString("hex");
}

async function main(): Promise<void> {
  // Run startup and capability gates before MCP traffic is accepted. Any
  // failure is reported on stderr and leaves stdout JSON-RPC clean.
  const bootstrap = readIdentityBootstrap();
  let identityDatabase: ReturnType<typeof openIdentityStore> | undefined;
  identityDatabase = openIdentityStore(bootstrap.sidecarPath);
  try {
    open();
    const verifier = new IdentityVerifier(identityDatabase, bootstrap);
    const server = createServer({ database: get, cursorSecret: resolveCursorSecret(), verifier });
  const transport = new StdioServerTransport();
  let closed = false;
  const closeResources = () => {
    if (closed) return;
    closed = true;
    close();
    if (identityDatabase?.open) identityDatabase.close();
  };

  // StdioServerTransport does not observe EOF itself. Close it explicitly so
  // the transport and SQLite connection are released without writing a
  // startup/shutdown banner to the protocol channel.
  transport.onclose = closeResources;
  process.stdin.once("end", () => {
    void transport.close();
  });
  const shutdown = () => {
    void transport.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);

    try {
      // Connect only after preflight has completed successfully.
      await server.connect(transport);
    } catch (error) {
      closeResources();
      throw error;
    }
  } catch (error) {
    close();
    if (identityDatabase?.open) identityDatabase.close();
    throw error;
  }
}

main().catch((error) => {
  console.error(formatStartupError(error));
  process.exit(1);
});

function formatStartupError(error: unknown): string {
  const message = error instanceof Error ? error.message : "Unknown startup failure";
  const code = message.match(/\b(SQLITE_CAPABILITY_MISSING|TRUST_BOOTSTRAP_INVALID)\b/)?.[1];
  if (code) return message;
  return "ForgeSpec MCP startup failed. Check the database and runtime capabilities before retrying.";
}
