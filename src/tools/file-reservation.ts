import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import type { Clock } from "../core/clock.js";
import { directErrorResponse } from "../core/errors.js";
import { getDb } from "../database/index.js";
import {
  FileLeaseConflictError,
  FileLeaseService,
  type DirectFileReleaseInput,
  type DirectFileRenewInput,
  type DirectFileReserveInput,
} from "../services/file-lease-service.js";
import { generateId } from "../utils/id.js";

const DEFAULT_TTL_MINUTES = 15;

function success(response: Record<string, unknown>) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response,
  };
}

function directFailure(error: unknown) {
  const response = directErrorResponse(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response,
    isError: true,
  };
}

const directVersionFields = {
  coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
  api_version: z.string().max(32).optional(),
  schema_version: z.string().max(32).optional(),
};

function resolveDirectIdentity(agent: string | undefined, actor: string | undefined): string {
  if (agent !== undefined && actor !== undefined && agent !== actor) {
    throw new FileLeaseConflictError(
      "agent and actor must match when both are provided",
      "validation",
      "identity_conflict"
    );
  }
  const identity = agent ?? actor;
  if (!identity) {
    throw new FileLeaseConflictError("File lease authority fields are required", "validation");
  }
  return identity;
}

function resolveExpectedTaskRevision(
  expectedTaskRevision: number | undefined,
  expectedRevision: number | undefined
): number {
  if (
    expectedTaskRevision !== undefined
    && expectedRevision !== undefined
    && expectedTaskRevision !== expectedRevision
  ) {
    throw new FileLeaseConflictError(
      "expected_task_revision and expected_revision must match when both are provided",
      "validation",
      "expected_revision_conflict"
    );
  }
  const revision = expectedTaskRevision ?? expectedRevision;
  if (revision === undefined) {
    throw new FileLeaseConflictError("Expected task revision is required", "cas", "expected_revision_required");
  }
  return revision;
}

export function registerFileTools(
  server: McpServer,
  databaseProvider: () => Database.Database = getDb,
  options: { clock?: Clock } = {}
): void {
  // ── Reserve Files ──────────────────────────────────
  server.tool(
    "file_reserve",
    "Reserve files or glob patterns to prevent conflicts between agents. Use check_only=true to check for conflicts without reserving. Reservations expire after TTL.",
    {
      patterns: z
        .array(z.string())
        .describe("File paths or glob patterns to reserve (e.g. ['src/auth/**', 'package.json'])"),
      agent: z
        .string()
        .max(256)
        .regex(/^[a-zA-Z0-9_.-]+$/)
        .optional()
        .describe("Agent reserving the files (legacy advisory mode; direct-v1 also accepts actor)"),
      actor: z
        .string()
        .min(1)
        .max(256)
        .optional()
        .describe("Direct-v1 actor identity for the lease; mapped onto the internal agent field"),
      ttl_minutes: z
        .number()
        .min(1)
        .max(1440)
        .default(DEFAULT_TTL_MINUTES)
        .describe("Reservation TTL in minutes (default 15)"),
      check_only: z
        .boolean()
        .default(false)
        .describe("If true, only check for conflicts without creating reservations"),
      ...directVersionFields,
      workspace_id: z.string().min(1).max(512).optional(),
      case_policy: z.enum(["sensitive", "insensitive"]).optional(),
      task_id: z.string().min(1).max(256).optional(),
      attempt_id: z.string().min(1).max(256).optional(),
      claim_token: z.string().min(1).max(512).optional(),
      expected_task_revision: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Expected direct task revision for direct-v1 CAS (direct-v1 also accepts expected_revision)"),
      expected_revision: z
        .number()
        .int()
        .min(1)
        .optional()
        .describe("Direct-v1 alias mapped onto expected_task_revision"),
      idempotency_key: z.string().min(1).max(256).optional(),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (input) => {
      const { patterns, agent, ttl_minutes, check_only } = input;
      const db = databaseProvider();
      if (input.coordination_mode === "direct-v1") {
        if (check_only) return directFailure(new Error("check_only is a legacy advisory operation"));
        try {
          const directInput = {
            coordination_mode: "direct-v1",
            api_version: input.api_version,
            schema_version: input.schema_version,
            patterns,
            agent: resolveDirectIdentity(agent, input.actor),
            ttl_minutes,
            workspace_id: input.workspace_id,
            case_policy: input.case_policy,
            task_id: input.task_id,
            attempt_id: input.attempt_id,
            claim_token: input.claim_token,
            expected_task_revision: resolveExpectedTaskRevision(
              input.expected_task_revision,
              input.expected_revision
            ),
            idempotency_key: input.idempotency_key,
          } as DirectFileReserveInput;
          return success(new FileLeaseService(db, options).reserve(directInput) as unknown as Record<string, unknown>);
        } catch (error) {
          return directFailure(error);
        }
      }
      if (!agent) {
        return directFailure(
          new FileLeaseConflictError("agent is required for advisory file reservations", "validation", "agent_required")
        );
      }
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
      ...directVersionFields,
      actor: z.string().min(1).max(256).optional(),
      lease_id: z.string().min(1).max(256).optional(),
      lease_token: z.string().min(1).max(512).optional(),
      task_id: z.string().min(1).max(256).optional(),
      attempt_id: z.string().min(1).max(256).optional(),
      claim_token: z.string().min(1).max(512).optional(),
      expected_revision: z.number().int().min(1).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
    },
    { readOnlyHint: false, idempotentHint: true },
    async (input) => {
      const { agent, patterns } = input;
      const db = databaseProvider();
      if (input.coordination_mode === "direct-v1") {
        try {
          return success(new FileLeaseService(db, options).release(input as DirectFileReleaseInput) as unknown as Record<string, unknown>);
        } catch (error) {
          return directFailure(error);
        }
      }

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

  server.tool(
    "file_renew",
    "Renew an active direct-v1 file lease with matching task-attempt authority and revision.",
    {
      coordination_mode: z.literal("direct-v1"),
      api_version: z.string().max(32),
      schema_version: z.string().max(32),
      actor: z.string().min(1).max(256),
      lease_id: z.string().min(1).max(256),
      lease_token: z.string().min(1).max(512),
      task_id: z.string().min(1).max(256),
      attempt_id: z.string().min(1).max(256),
      claim_token: z.string().min(1).max(512),
      expected_revision: z.number().int().min(1),
      extend_seconds: z.number().int().min(15).max(3600),
      idempotency_key: z.string().min(1).max(256),
    },
    async (input) => {
      try {
        return success(
          new FileLeaseService(databaseProvider(), options).renew(input as DirectFileRenewInput) as unknown as Record<string, unknown>
        );
      } catch (error) {
        return directFailure(error);
      }
    }
  );
}

function patternsOverlap(a: string, b: string): boolean {
  if (a === b) return true;
  // Normalize: remove trailing slashes
  const na = a.replace(/\/+$/, "");
  const nb = b.replace(/\/+$/, "");
  if (na === nb) return true;
  // Check if one is a parent directory of the other
  const aBase = na.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  const bBase = nb.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  // If either has wildcards, check prefix containment
  if (na.includes("*") || nb.includes("*")) {
    return aBase.startsWith(bBase) || bBase.startsWith(aBase);
  }
  // Exact file paths: check if one is under the other's directory
  return na.startsWith(nb + "/") || nb.startsWith(na + "/");
}
