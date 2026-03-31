import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../database/index.js";
import {
  SddContractSchema,
  SDD_PHASES,
  PHASE_TRANSITIONS,
  CONFIDENCE_THRESHOLDS,
} from "../types/index.js";
import { generateId } from "../utils/id.js";

export function registerSddTools(server: McpServer): void {
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
    },
    async ({ contract }) => {
      try {
        const parsed = JSON.parse(contract);
        const result = SddContractSchema.parse(parsed);
        const db = getDb();
        const id = generateId("sdd");

        db.prepare(
          `INSERT INTO contracts (id, phase, change_name, project, status, confidence, executive_summary, data)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
        ).run(
          id,
          result.phase,
          result.change_name,
          result.project,
          result.status,
          result.confidence,
          result.executive_summary,
          JSON.stringify(result.data)
        );

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                saved: true,
                id,
                phase: result.phase,
                project: result.project,
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
                saved: false,
                error: `${e}`,
              }),
            },
          ],
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
      limit: z.number().min(1).max(100).default(20).describe("Max entries to return"),
    },
    async ({ project, limit }) => {
      const db = getDb();
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
      const db = getDb();
      const row = db
        .prepare(`SELECT * FROM contracts WHERE id = ?`)
        .get(contract_id) as Record<string, unknown> | undefined;

      if (!row) {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ error: `Contract ${contract_id} not found` }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ contract: row }),
          },
        ],
      };
    }
  );

  // ── List Contracts ────────────────────────────────
  server.tool(
    "sdd_list",
    "List all SDD contracts with optional filters by project and phase.",
    {
      project: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).optional().describe("Filter by project identifier"),
      phase: z.string().max(64).optional().describe("Filter by SDD phase"),
      limit: z.number().min(1).max(100).default(20).describe("Max entries to return"),
    },
    async ({ project, phase, limit }) => {
      const db = getDb();
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

  // ── Get Phase Info ─────────────────────────────────
  server.tool(
    "sdd_phases",
    "Get information about all SDD phases, including transitions and confidence thresholds.",
    {},
    async () => {
      const phases = SDD_PHASES.map((p) => ({
        phase: p,
        confidence_threshold: CONFIDENCE_THRESHOLDS[p],
        can_transition_to: PHASE_TRANSITIONS[p],
      }));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ phases }),
          },
        ],
      };
    }
  );
}
