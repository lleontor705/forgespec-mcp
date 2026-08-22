import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { CAPABILITY_FAMILIES, CAPABILITY_LIMITS, PROFILE_TOOLSETS, type CapabilityProfileRole } from "../protocol/capabilities.js";
import { getIdentityRuntime, registerIdentityTool } from "../identity/dispatcher.js";
import type { VerifiedPrincipal } from "../identity/types.js";
import { negotiateResult, healthResult } from "./schemas.js";

const profiles = ["planner", "worker", "orchestrator", "reviewer"] as const;
const negotiateInput = z.object({
  profile: z.enum(profiles),
  requiredCapabilities: z.array(z.string().min(1)).max(64).optional(),
  optionalCapabilities: z.array(z.string().min(1)).max(64).optional(),
}).strict();
const negotiateOutput = z.object({
  protocol_version: z.literal("2.0"), profile: z.enum(profiles), tools: z.array(z.string()),
  capability_families: z.array(z.string()), limits: z.object({ maxToolsPerProfile: z.number().int().positive() }),
}).strict();
const healthInput = z.object({}).strict();
const healthOutput = z.object({
  package: z.object({ name: z.string(), version: z.string() }),
  runtime: z.object({ node: z.string() }), sqlite: z.object({ version: z.string() }),
  uptime_seconds: z.number().nonnegative(), storage: z.object({ qualified: z.boolean(), table_count: z.literal(16) }),
}).strict();

export interface CoreToolContext { database: () => Database.Database; packageVersion?: string; }
const annotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false } as const;

export function registerCoreTools(server: McpServer, context: CoreToolContext): void {
  const verifier = getIdentityRuntime(server)?.verifier;
  if (!verifier) throw new Error("identity runtime is not installed");
  registerIdentityTool<any, any>(server, { verifier, toolName: "forge_negotiate", description: "Negotiate the ForgeSpec Protocol 2.0 MCP profile and capabilities.", businessSchema: negotiateInput, outputSchema: negotiateResult, annotations,
  handler: async (input) => {
    const requested = [...(input.requiredCapabilities ?? []), ...(input.optionalCapabilities ?? [])];
    const unsupported = requested.filter((cap: string) => !CAPABILITY_FAMILIES.includes(cap as never));
    if ((input.requiredCapabilities ?? []).some((cap: string) => unsupported.includes(cap))) throw Object.assign(new Error("protocol incompatibility"), { code: "PROTOCOL_INCOMPATIBLE" });
    return { protocol_version: "2.0" as const, profile: input.profile, tools: [...PROFILE_TOOLSETS[input.profile as CapabilityProfileRole]], capability_families: [...CAPABILITY_FAMILIES], limits: { maxToolsPerProfile: CAPABILITY_LIMITS.maxToolsPerProfile } };
  }});
  registerIdentityTool<any, any>(server, { verifier, toolName: "forge_health", description: "Report safe runtime and storage health without revealing paths or secrets.", businessSchema: healthInput, outputSchema: healthResult, annotations,
  handler: async (_input, _principal: VerifiedPrincipal) => {
    const db = context.database();
    const version = String((db.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version);
    const tableCount = (db.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'").get() as { count: number }).count;
    let qualified = tableCount === 16;
    if (qualified) {
      const integrity = db.pragma("quick_check") as Array<{ quick_check: string }>;
      if (!integrity?.length || integrity[0]?.quick_check !== "ok") {
        qualified = false;
      }
    }
    return { package: { name: "forgespec-mcp", version: context.packageVersion ?? "2.0.0" }, runtime: { node: process.version }, sqlite: { version }, uptime_seconds: process.uptime(), storage: { qualified, table_count: tableCount as 16 } };
  }});
}
