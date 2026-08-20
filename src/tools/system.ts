import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../database/index.js";
import { AuditService } from "../services/audit-service.js";
import { compactJson } from "../utils/compact-json.js";

function response(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactJson(data)) }],
    structuredContent: compactJson(data) as Record<string, unknown>,
    isError,
  };
}

export function registerSystemTools(
  server: McpServer,
  databaseProvider: () => Database.Database = getDb
): void {
  // 1. system_health
  server.tool(
    "system_health",
    "Get server diagnostics, database status, memory usage, and runtime environment.",
    {},
    async () => {
      const db = databaseProvider();
      const sqliteVersion = (db.prepare("SELECT sqlite_version() as v").get() as any).v;
      const mem = process.memoryUsage();

      return response({
        ok: true,
        version: "2.0.0",
        node_version: process.version,
        sqlite_version: sqliteVersion,
        memory: {
          rss_mb: Math.round(mem.rss / 1024 / 1024),
          heap_used_mb: Math.round(mem.heapUsed / 1024 / 1024),
        },
        uptime_seconds: Math.round(process.uptime()),
      });
    }
  );

  // 2. system_audit_log
  server.tool(
    "system_audit_log",
    "Query the immutable audit log of task and spec mutations.",
    {
      entity_type: z.string().max(64).optional().describe("Filter by entity type (board, task, spec, file_lease)"),
      entity_id: z.string().max(256).optional().describe("Filter by entity ID"),
      limit: z.number().int().min(1).max(200).optional().describe("Number of records to return (default 50)"),
    },
    async (input) => {
      try {
        const audit = new AuditService(databaseProvider());
        const events = audit.query({
          entityType: input.entity_type,
          entityId: input.entity_id,
          limit: input.limit,
        });
        return response({ ok: true, count: events.length, events });
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );
}
