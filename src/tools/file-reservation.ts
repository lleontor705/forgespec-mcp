import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../database/index.js";
import { generateId } from "../utils/id.js";

const DEFAULT_TTL_MINUTES = 15;

export function registerFileTools(server: McpServer): void {
  // ── Reserve Files ──────────────────────────────────
  server.tool(
    "file_reserve",
    "Reserve files or glob patterns to prevent conflicts between agents. Use check_only=true to check for conflicts without reserving. Reservations expire after TTL.",
    {
      patterns: z
        .array(z.string())
        .describe("File paths or glob patterns to reserve (e.g. ['src/auth/**', 'package.json'])"),
      agent: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Agent reserving the files"),
      ttl_minutes: z
        .number()
        .default(DEFAULT_TTL_MINUTES)
        .describe("Reservation TTL in minutes (default 15)"),
      check_only: z
        .boolean()
        .default(false)
        .describe("If true, only check for conflicts without creating reservations"),
    },
    async ({ patterns, agent, ttl_minutes, check_only }) => {
      const db = getDb();
      const now = new Date();
      const expiresAt = new Date(
        now.getTime() + ttl_minutes * 60 * 1000
      ).toISOString();

      // Clean expired reservations first
      db.prepare(
        `DELETE FROM file_reservations WHERE expires_at < datetime('now')`
      ).run();

      // Check for conflicts
      const existing = db
        .prepare(`SELECT * FROM file_reservations WHERE agent != ?`)
        .all(agent) as Array<{ pattern: string; agent: string; expires_at: string }>;

      const conflicts = existing.filter((r) =>
        patterns.some(
          (p) => patternsOverlap(p, r.pattern)
        )
      );

      if (conflicts.length > 0) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                reserved: false,
                has_conflicts: true,
                conflicts: conflicts.map((c) => ({
                  pattern: c.pattern,
                  held_by: c.agent,
                  expires_at: c.expires_at,
                })),
              }),
            },
          ],
        };
      }

      // Check-only mode: return clean result without reserving
      if (check_only) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                reserved: false,
                has_conflicts: false,
                conflicts: [],
              }),
            },
          ],
        };
      }

      const insert = db.prepare(
        `INSERT INTO file_reservations (id, pattern, agent, expires_at) VALUES (?, ?, ?, ?)`
      );

      const ids: string[] = [];
      const tx = db.transaction(() => {
        for (const pattern of patterns) {
          const id = generateId("res");
          insert.run(id, pattern, agent, expiresAt);
          ids.push(id);
        }
      });
      tx();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              reserved: true,
              has_conflicts: false,
              reservation_ids: ids,
              agent,
              patterns,
              expires_at: expiresAt,
            }),
          },
        ],
      };
    }
  );

  // ── Release File Reservations ──────────────────────
  server.tool(
    "file_release",
    "Release file reservations held by an agent.",
    {
      agent: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Agent releasing reservations"),
      patterns: z
        .array(z.string())
        .optional()
        .describe("Specific patterns to release (omit to release all)"),
    },
    async ({ agent, patterns }) => {
      const db = getDb();

      if (patterns && patterns.length > 0) {
        const placeholders = patterns.map(() => "?").join(",");
        const result = db
          .prepare(
            `DELETE FROM file_reservations WHERE agent = ? AND pattern IN (${placeholders})`
          )
          .run(agent, ...patterns);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                released: true,
                count: result.changes,
                agent,
                patterns,
              }),
            },
          ],
        };
      }

      const result = db
        .prepare(`DELETE FROM file_reservations WHERE agent = ?`)
        .run(agent);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              released: true,
              count: result.changes,
              agent,
            }),
          },
        ],
      };
    }
  );
}

function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  if (a.startsWith(b.replace("/**", "/")) || b.startsWith(a.replace("/**", "/")))
    return true;
  if (a.includes("**") || b.includes("**")) {
    const aBase = a.split("/**")[0].split("/*")[0];
    const bBase = b.split("/**")[0].split("/*")[0];
    if (aBase.startsWith(bBase) || bBase.startsWith(aBase)) return true;
  }
  return false;
}
