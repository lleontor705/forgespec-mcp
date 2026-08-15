import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../database/index.js";

export function registerHealthTool(server: McpServer, databaseProvider = getDb): void {
  server.tool(
    "forgespec_health",
    "Get server health diagnostics, database integrity status, system time, active leases, and version telemetry.",
    {},
    { readOnlyHint: true, idempotentHint: true },
    async () => {
      const db = databaseProvider();
      let dbHealthy = false;
      let quickIntegrity = "unknown";
      let boardCount = 0;
      let taskCount = 0;
      let activeLeases = 0;

      try {
        const pragma = db.prepare("PRAGMA quick_check").get() as Record<string, unknown> | undefined;
        quickIntegrity = String(pragma?.quick_check || Object.values(pragma || {})[0] || "ok");
        dbHealthy = quickIntegrity === "ok";

        const boards = db.prepare("SELECT COUNT(*) as count FROM boards").get() as { count: number };
        boardCount = boards.count;

        const tasks = db.prepare("SELECT COUNT(*) as count FROM tasks").get() as { count: number };
        taskCount = tasks.count;

        const leases = db.prepare("SELECT COUNT(*) as count FROM file_leases WHERE released_at_ms IS NULL").get() as { count: number };
        activeLeases = leases.count;
      } catch {
        dbHealthy = false;
      }

      const telemetry = {
        status: dbHealthy ? "healthy" : "degraded",
        timestamp: new Date().toISOString(),
        version: "1.5.2",
        database: {
          healthy: dbHealthy,
          integrity: quickIntegrity,
          counts: {
            boards: boardCount,
            tasks: taskCount,
            active_leases: activeLeases,
          },
        },
      };

      return {
        content: [{ type: "text" as const, text: JSON.stringify(telemetry) }],
        structuredContent: telemetry,
      };
    }
  );
}
