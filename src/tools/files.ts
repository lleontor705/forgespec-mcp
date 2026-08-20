import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../database/index.js";
import { FileLeaseServiceV2 } from "../services/file-lease-service-v2.js";
import { compactJson } from "../utils/compact-json.js";

function response(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactJson(data)) }],
    structuredContent: compactJson(data) as Record<string, unknown>,
    isError,
  };
}

export function registerFileLeaseTools(
  server: McpServer,
  databaseProvider: () => Database.Database = getDb
): void {
  // 1. file_reserve
  server.tool(
    "file_reserve",
    "Reserve exclusive working locks on files or glob patterns to prevent multi-agent write collisions.",
    {
      project: z.string().min(1).max(256).describe("Project identifier"),
      paths: z.array(z.string().min(1).max(1024)).min(1).max(50).describe("File paths or glob patterns to reserve"),
      holder: z.string().min(1).max(256).describe("Agent identity acquiring the lease"),
      task_id: z.string().max(256).optional().describe("Associated task ID (auto-released on task completion)"),
      lease_seconds: z.number().int().min(15).max(3600).optional().describe("Lease TTL in seconds (default 300)"),
    },
    async (input) => {
      try {
        const service = new FileLeaseServiceV2(databaseProvider());
        return response(service.reserve(input.project, input.paths, input.holder, input.task_id, input.lease_seconds));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 2. file_release
  server.tool(
    "file_release",
    "Release active file reservations held by an agent.",
    {
      project: z.string().min(1).max(256).describe("Project identifier"),
      paths: z.array(z.string().min(1).max(1024)).min(1).max(50).describe("File paths or glob patterns to release"),
      holder: z.string().min(1).max(256).describe("Agent identity holding the lease"),
    },
    async (input) => {
      try {
        const service = new FileLeaseServiceV2(databaseProvider());
        return response(service.release(input.project, input.paths, input.holder));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );
}
