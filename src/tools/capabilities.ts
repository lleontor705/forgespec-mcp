import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import {
  negotiateCapabilities,
  type CapabilityNegotiationOptions,
} from "../core/capabilities.js";

const RangeSchema = z.object({
  min_inclusive: z.string().regex(/^\d+\.\d+\.\d+$/),
  max_exclusive: z.string().regex(/^\d+\.\d+\.\d+$/).optional(),
}).strict();

const RequirementSchema = z.object({
  id: z.string().min(1).max(128),
  range: RangeSchema,
  optional: z.boolean().optional(),
}).strict();

const CapabilitiesInputSchema = z.object({
  client: z.object({ name: z.string().min(1).max(256), version: z.string().min(1).max(64) }).strict().optional(),
  requested_mode: z.enum(["legacy", "direct-v1"]).optional(),
  required: z.array(RequirementSchema).max(100).optional(),
}).strict();

const CapabilitiesOutputSchema = z.object({
  server: z.object({ name: z.literal("forgespec-mcp"), version: z.string(), api_version: z.literal("1.0.0") }),
  security: z.object({ identity_model: z.literal("local-trusted-client") }),
  modes: z.array(z.enum(["legacy", "direct-v1"])),
  schemas: z.object({ sdd_envelope: RangeSchema, task_metadata: RangeSchema, evidence_ref: RangeSchema }),
  capabilities: z.array(z.object({ id: z.string(), supported: RangeSchema, selected: z.string().optional() })),
  limits: z.object({
    max_page_size: z.number(),
    max_batch_tasks: z.number(),
    max_dependencies_per_task: z.number(),
    min_lease_seconds: z.number(),
    max_lease_seconds: z.number(),
    clock_skew_grace_ms: z.number(),
    max_file_scopes: z.number(),
    max_idempotency_key_bytes: z.number(),
  }),
  compatibility: z.object({
    compatible: z.boolean(),
    selected_mode: z.enum(["legacy", "direct-v1"]).optional(),
    missing: z.array(RequirementSchema),
    incompatible: z.array(z.object({ id: z.string(), required: RangeSchema, supported: RangeSchema.optional() })),
    unavailable_optional: z.array(RequirementSchema),
  }),
});

export function registerCapabilitiesTool(
  server: McpServer,
  options: CapabilityNegotiationOptions = {}
): void {
  server.registerTool(
    "forgespec_capabilities",
    {
      title: "ForgeSpec Capabilities",
      description: "Negotiate ForgeSpec coordination mode, schemas, independently versioned features, and limits.",
      inputSchema: CapabilitiesInputSchema,
      outputSchema: CapabilitiesOutputSchema,
      annotations: { readOnlyHint: true, idempotentHint: true },
    },
    async (input) => {
      const output = negotiateCapabilities(input, options);
      return {
        content: [{ type: "text" as const, text: JSON.stringify(output) }],
        structuredContent: output,
      };
    }
  );
}
