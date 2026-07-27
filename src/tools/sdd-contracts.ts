import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../database/index.js";
import {
  SddContractSchema,
  SDD_PHASES,
  PHASE_TRANSITIONS,
  CONFIDENCE_THRESHOLDS,
} from "../types/index.js";
import {
  ContractConflictError,
  ContractService,
  type DirectContractSaveInput,
} from "../services/contract-service.js";

export function registerSddTools(server: McpServer, databaseProvider = getDb): void {
  // ── Validate SDD Contract ───────────────────────────
  server.tool(
    "sdd_validate",
    "Validate an SDD contract against the phase schema. Returns validation result with confidence check and allowed transitions.",
    {
      contract: z
        .string()
        .max(131072)
        .describe("JSON string of the SDD contract to validate"),
    },
    async ({ contract }) => {
      try {
        const parsed = JSON.parse(contract);
        const result = SddContractSchema.safeParse(parsed);

        if (!result.success) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  valid: false,
                  errors: result.error.issues.map((i) => ({
                    path: i.path.join("."),
                    message: i.message,
                  })),
                }),
              },
            ],
          };
        }

        const data = result.data;
        const threshold = CONFIDENCE_THRESHOLDS[data.phase];
        const meetsConfidence = data.confidence >= threshold;
        const allowedNext = PHASE_TRANSITIONS[data.phase];

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                valid: true,
                phase: data.phase,
                confidence: data.confidence,
                threshold,
                meets_confidence: meetsConfidence,
                allowed_next_phases: allowedNext,
                warnings: !meetsConfidence
                  ? [
                      `Confidence ${data.confidence} is below threshold ${threshold} for phase "${data.phase}"`,
                    ]
                  : [],
              }),
            },
          ],
        };
      } catch (e) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                valid: false,
                errors: [{ path: "root", message: `Invalid JSON: ${e}` }],
              }),
            },
          ],
        };
      }
    }
  );

  // ── Save SDD Contract ──────────────────────────────
  server.tool(
    "sdd_save",
    "Validate and persist an SDD contract. Records the phase transition for project traceability.",
    {
      contract: z.string().max(131072).describe("JSON string of the SDD contract to save"),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
      actor: z.string().min(1).max(256).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
      expected_head_revision: z.number().int().min(0).optional(),
      parent_contract_id: z.string().max(256).optional(),
      submitted_digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(),
    },
    async (input) => {
      try {
        const service = new ContractService(databaseProvider());
        const response = input.coordination_mode === "direct-v1"
          ? service.saveDirect(input as DirectContractSaveInput)
          : service.saveLegacy(input.contract);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response),
            },
          ],
          structuredContent: response as unknown as Record<string, unknown>,
        };
      } catch (e) {
        const conflict = e instanceof ContractConflictError ? e : null;
        const response = input.coordination_mode === "direct-v1"
          ? {
              ok: false as const,
              error: {
                category: conflict?.category ?? "validation",
                code: conflict ? `contract_${conflict.category}_conflict` : "contract_invalid",
                message: `${e instanceof Error ? e.message : e}`,
                retryable: conflict?.category === "cas",
                ...(conflict?.currentRevision === undefined ? {} : { current_revision: conflict.currentRevision }),
              },
            }
          : { saved: false as const, error: `${e}` };
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response),
            },
          ],
          structuredContent: response as Record<string, unknown>,
          ...(input.coordination_mode === "direct-v1" ? { isError: true } : {}),
        };
      }
    }
  );

  // ── Get Project History ────────────────────────────
  server.tool(
    "sdd_history",
    "Get the SDD phase history for a project. Shows all contract transitions in chronological order.",
    {
      project: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Project identifier"),
      change_name: z.string().max(256).optional(),
      phase: z.enum(SDD_PHASES).optional(),
      since_revision: z.number().int().min(0).optional(),
      cursor: z.string().max(256).optional(),
      limit: z.number().min(1).max(100).default(20).describe("Max entries to return"),
    },
    async ({ project, change_name, phase, since_revision, cursor, limit }) => {
      const db = databaseProvider();
      const hasDirectHistory = Boolean(
        db.prepare("SELECT 1 FROM contract_revisions WHERE project = ? LIMIT 1").get(project)
      );
      if (hasDirectHistory || change_name || phase || since_revision !== undefined || cursor) {
        let cursorRevision: number | undefined;
        if (cursor !== undefined) {
          const parsedCursor = Number.parseInt(cursor, 10);
          if (!Number.isSafeInteger(parsedCursor) || parsedCursor < 0) {
            const response = { ok: false, error: { category: "cursor", code: "invalid_cursor", message: "Invalid history cursor", retryable: false } };
            return {
              content: [{ type: "text" as const, text: JSON.stringify(response) }],
              structuredContent: response,
              isError: true,
            };
          }
          cursorRevision = parsedCursor;
        }
        const response = new ContractService(db).history({
          project,
          change_name,
          phase,
          since_revision: cursorRevision ?? since_revision,
          limit,
        });
        return {
          content: [{ type: "text" as const, text: JSON.stringify(response) }],
          structuredContent: response as unknown as Record<string, unknown>,
        };
      }
      const rows = db
        .prepare(
          `SELECT id, phase, change_name, status, confidence, executive_summary, created_at
           FROM contracts WHERE project = ? ORDER BY created_at DESC LIMIT ?`
        )
        .all(project, limit);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ project, history: rows }),
          },
        ],
      };
    }
  );

  // ── Get Single Contract ────────────────────────────
  server.tool(
    "sdd_get",
    "Get a single SDD contract by ID. Returns full contract data.",
    {
      contract_id: z.string().max(256).describe("Contract ID to retrieve"),
    },
    async ({ contract_id }) => {
      try {
        const response = new ContractService(databaseProvider()).get(contract_id);
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify(response),
            },
          ],
          structuredContent: response,
        };
      } catch {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Contract ${contract_id} not found` }) }],
        };
      }
    }
  );

  // ── List Contracts ────────────────────────────────
  server.tool(
    "sdd_list",
    "List all SDD contracts with optional filters by project and phase.",
    {
      project: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).optional().describe("Filter by project identifier"),
      phase: z.enum(SDD_PHASES).optional().describe("Filter by SDD phase"),
      limit: z.number().min(1).max(100).default(20).describe("Max entries to return"),
    },
    async ({ project, phase, limit }) => {
      const db = databaseProvider();
      const conditions: string[] = [];
      const params: unknown[] = [];

      if (project) {
        conditions.push("project = ?");
        params.push(project);
      }
      if (phase) {
        conditions.push("phase = ?");
        params.push(phase);
      }

      const where = conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
      params.push(limit);

      const rows = db
        .prepare(`SELECT * FROM contracts ${where} ORDER BY created_at DESC LIMIT ?`)
        .all(...params);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ contracts: rows, count: rows.length }),
          },
        ],
      };
    }
  );

}
