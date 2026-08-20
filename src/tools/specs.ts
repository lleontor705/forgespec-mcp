import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../database/index.js";
import { SpecService } from "../services/spec-service.js";
import { compactJson } from "../utils/compact-json.js";
import { SDD_PHASES } from "../types/index.js";

function response(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactJson(data)) }],
    structuredContent: compactJson(data) as Record<string, unknown>,
    isError,
  };
}

export function registerSpecTools(
  server: McpServer,
  databaseProvider: () => Database.Database = getDb
): void {
  // 1. spec_save
  server.tool(
    "spec_save",
    "Save or update an SDD specification contract for a project phase.",
    {
      project: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Project identifier"),
      phase: z.enum(SDD_PHASES).describe("SDD lifecycle phase (e.g. init, spec, design, tasks, verify)"),
      change_name: z.string().min(1).max(256).describe("Feature or change name"),
      status: z.enum(["success", "partial", "failed", "blocked"]).describe("Phase outcome status"),
      confidence: z.number().min(0).max(1).describe("Confidence score (0.0 to 1.0)"),
      executive_summary: z.string().min(5).max(65536).describe("Summary of decisions, findings, or design"),
      contract_data: z.record(z.unknown()).optional().describe("Structured contract payload, requirements, or architecture data"),
      actor: z.string().max(256).optional().describe("Agent identity"),
    },
    async (input) => {
      try {
        const service = new SpecService(databaseProvider());
        return response(service.saveSpec(input));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 2. spec_get
  server.tool(
    "spec_get",
    "Retrieve an SDD specification contract by project and phase.",
    {
      project: z.string().min(1).max(256).describe("Project identifier"),
      phase: z.enum(SDD_PHASES).describe("Phase name"),
    },
    async ({ project, phase }) => {
      try {
        const service = new SpecService(databaseProvider());
        const spec = service.getSpec(project, phase);
        if (!spec) return response({ ok: false, error: `Spec not found for project "${project}" phase "${phase}"` }, true);
        return response({ ok: true, spec });
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 3. spec_list
  server.tool(
    "spec_list",
    "List all specification phases and contracts recorded for a project.",
    {
      project: z.string().min(1).max(256).describe("Project identifier"),
    },
    async ({ project }) => {
      try {
        const service = new SpecService(databaseProvider());
        return response({ ok: true, project, specs: service.listSpecs(project) });
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );
}
