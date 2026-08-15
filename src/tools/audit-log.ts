import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../database/index.js";

export function registerAuditLogTool(server: McpServer, databaseProvider = getDb): void {
  server.tool(
    "tb_audit_log",
    "Query historical audit trail of authority grants, revocations, and approval decisions.",
    {
      actor: z.string().min(1).max(256).optional().describe("Filter events by actor identifier"),
      board_id: z.string().max(256).optional().describe("Filter events by board ID"),
      event_type: z.enum(["grant", "revocation", "approval", "all"]).default("all").describe("Type of authority audit event"),
      limit: z.number().int().min(1).max(100).default(50).describe("Maximum entries to return"),
    },
    { readOnlyHint: true, idempotentHint: true },
    async ({ actor, board_id, event_type, limit }) => {
      const db = databaseProvider();
      const events: Record<string, unknown>[] = [];

      try {
        if (event_type === "all" || event_type === "grant") {
          let sql = "SELECT grant_id, granted_by_actor as actor, grantee_actor, operation, resource_kind, board_id, resource_id as task_id, expires_at_ms, created_at_ms FROM task_authority_grants WHERE 1=1";
          const params: unknown[] = [];
          if (actor) { sql += " AND (granted_by_actor = ? OR grantee_actor = ?)"; params.push(actor, actor); }
          if (board_id) { sql += " AND board_id = ?"; params.push(board_id); }
          sql += " ORDER BY created_at_ms DESC LIMIT ?";
          params.push(limit);
          const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
          events.push(...rows.map((r) => ({ ...r, type: "grant" })));
        }

        if (event_type === "all" || event_type === "revocation") {
          let sql = "SELECT revoke_id as revocation_id, grant_id, revoked_by_actor as actor, created_at_ms FROM task_authority_revocations WHERE 1=1";
          const params: unknown[] = [];
          if (actor) { sql += " AND revoked_by_actor = ?"; params.push(actor); }
          sql += " ORDER BY created_at_ms DESC LIMIT ?";
          params.push(limit);
          const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
          events.push(...rows.map((r) => ({ ...r, type: "revocation" })));
        }

        if (event_type === "all" || event_type === "approval") {
          let sql = "SELECT task_id, gate_id, decision, actor, reason, created_at_ms FROM approval_decisions WHERE 1=1";
          const params: unknown[] = [];
          if (actor) { sql += " AND actor = ?"; params.push(actor); }
          sql += " ORDER BY created_at_ms DESC LIMIT ?";
          params.push(limit);
          const rows = db.prepare(sql).all(...params) as Record<string, unknown>[];
          events.push(...rows.map((r) => ({ ...r, type: "approval" })));
        }

        // Sort merged events by timestamp descending and apply limit
        events.sort((a, b) => Number(b.created_at_ms || 0) - Number(a.created_at_ms || 0));
        const truncated = events.slice(0, limit);

        return {
          content: [{ type: "text" as const, text: JSON.stringify({ events: truncated, count: truncated.length }) }],
          structuredContent: { events: truncated, count: truncated.length },
        };
      } catch (error) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Failed to query audit log: ${error}` }) }],
          isError: true,
        };
      }
    }
  );
}
