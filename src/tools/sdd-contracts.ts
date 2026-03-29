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
      contract: z.string().describe("JSON string of the SDD contract to save"),
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
      project: z.string().describe("Project identifier"),
      limit: z.number().default(20).describe("Max entries to return"),
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
