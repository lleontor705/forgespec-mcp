import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { sanitizeBusinessArgs } from "./broker.js";
import type { VerifiedPrincipal } from "./types.js";
import type { ReplayAudit, ReplayOutcome } from "./store.js";
import { canonicalErrorSchema, identityContext } from "../tools/schemas.js";

export const MAX_TOOL_FRAME_BYTES = 16_384;
const CALLER_FIELDS = /^(?:caller|caller_id|callerId|actor|actor_id|actorId|identity|_identity)$/i;

export interface IdentityVerifierLike {
  verify(tool: string, rawArgs: unknown): { principal: VerifiedPrincipal; args: unknown; audit?: ReplayAudit };
  finalizeReplay?(audit: ReplayAudit, outcome: ReplayOutcome): void | Promise<void>;
  resolveWorkerHandle?(handle: string): string | undefined;
}

export interface IdentityRuntimeContext { readonly verifier: IdentityVerifierLike }
const runtimeContexts = new WeakMap<object, IdentityRuntimeContext>();

/** Bind identity verification to one server instance; contexts are never process-global. */
export function installIdentityRuntime(server: object, context: IdentityRuntimeContext): void {
  runtimeContexts.set(server, context);
}

export function getIdentityRuntime(server: object): IdentityRuntimeContext | undefined {
  return runtimeContexts.get(server);
}

/** Resolve a target only through the verifier's enrolled-worker sidecar. */
export function resolveWorkerHandle(server: object, handle: string): string | undefined {
  return runtimeContexts.get(server)?.verifier.resolveWorkerHandle?.(handle);
}

export type IdentityToolHandler<Input, Output> = (args: Input, principal: VerifiedPrincipal) => Output | Promise<Output>;

export interface IdentityToolOptions<Input, Output> {
  verifier: IdentityVerifierLike;
  toolName: string;
  description?: string;
  businessSchema: z.ZodTypeAny;
  /** Optional SDK-published contract when the wire contract is richer than the business parser. */
  publishedInputSchema?: z.ZodTypeAny;
  publishedInputJsonSchema?: Record<string, unknown>;
  outputSchema: z.ZodType<Output>;
  annotations?: ToolAnnotations;
  rejectCallerFields?: boolean;
  handler: IdentityToolHandler<Input, Output>;
}

/** The transport accepts only a bounded object with a mandatory attestation slot. */
export const identityTransportSchema = z.object({
  _identity: z.record(z.string(), z.unknown()),
}).catchall(z.unknown()).superRefine((value, issue) => {
  let encoded: string;
  try { encoded = JSON.stringify(value); } catch { issue.addIssue({ code: z.ZodIssueCode.custom, message: "frame exceeds bound" }); return; }
  if (Buffer.byteLength(encoded, "utf8") > MAX_TOOL_FRAME_BYTES || depth(value) > 32) issue.addIssue({ code: z.ZodIssueCode.custom, message: "frame exceeds bound" });
});

/**
 * The SDK validates this bounded envelope before invoking the callback. Keep
 * the actual business schemas here (rather than replacing them with a JSON
 * union): tools/list is the public contract, while the verifier still runs
 * before the explicit strict business parse below. No handler/domain effect
 * occurs during this SDK validation.
 */
const defaultPublishedInputSchema = (businessSchema: z.ZodTypeAny) => {
  const shape = objectShape(businessSchema);
  // Keep the transport envelope permissive so malformed/caller-supplied keys
  // reach the verifier and produce the canonical structured error. The
  // business schema itself is strict and is parsed only after verification.
  return z.object({ _identity: z.record(z.string(), z.unknown()), ...shape }).catchall(z.unknown());
};

const errorResult = (code: string, message: string, context: unknown = null) => {
  const structuredContent = { ok: false, data: null, error: { code, message }, _identity_context: context };
  return { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: true };
};
const canonicalError = (error: unknown) => {
  const value = error as { code?: unknown; error?: { code?: unknown } };
  const code = typeof value?.code === "string" ? value.code : typeof value?.error?.code === "string" ? value.error.code : "HANDLER_ERROR";
  return errorResult(code, "request could not be completed");
};

const isBusy = (error: unknown) => {
  const value = error as { code?: unknown; message?: unknown };
  return value?.code === "SQLITE_BUSY" || value?.code === "SQLITE_LOCKED" || /SQLITE_(?:BUSY|LOCKED)|database is locked/i.test(String(value?.message ?? error));
};

async function finalizeReplayOrFail(verifier: IdentityVerifierLike, audit: ReplayAudit, outcome: ReplayOutcome): Promise<boolean> {
  if (!verifier.finalizeReplay) return true;
  for (let attempt = 0; attempt < 3; attempt++) {
    try { await verifier.finalizeReplay(audit, outcome); return true; }
    catch (error) {
      if (!isBusy(error) || attempt === 2) return false;
      await new Promise((resolve) => setTimeout(resolve, 5 * (attempt + 1)));
    }
  }
  return false;
}

/** Register an MCP tool whose attestation is verified and consumed before business validation. */
export function registerIdentityTool<Input extends Record<string, unknown>, Output>(
  server: Pick<McpServer, "registerTool">,
  options: IdentityToolOptions<Input, Output>,
): void {
  const shape = objectShape(options.businessSchema);
  if (!options.toolName || schemaContainsCallerField(options.businessSchema)) throw new Error("business schema contains caller identity field");
  const businessSchema = typeof (options.businessSchema as z.AnyZodObject).strict === "function" ? (options.businessSchema as z.AnyZodObject).strict() : options.businessSchema;
  const declaredOutput = options.outputSchema as any;
  const declaredShape = typeof declaredOutput._def?.shape === "function" ? declaredOutput._def.shape() : declaredOutput.shape;
  const dataSchema = declaredOutput.__dataSchema ?? declaredShape?.data ?? options.outputSchema;
  // Publish the exact per-tool data contract inside the strict wire envelope.
  const publishedOutputSchema = z.object({
    ok: z.boolean(), data: dataSchema.nullable(),
    error: z.object({ code: z.string(), message: z.string() }).strict().nullable(),
    _identity_context: identityContext.nullable(),
  }).strict();
  server.registerTool(options.toolName, {
    description: options.description,
    inputSchema: options.publishedInputSchema ?? defaultPublishedInputSchema(businessSchema),
    outputSchema: publishedOutputSchema,
    annotations: options.annotations,
  }, async (rawArgs: Record<string, unknown>) => {
    const frame = identityTransportSchema.safeParse(rawArgs);
    if (!frame.success) return errorResult("IDENTITY_INVALID", "identity verification failed");
    let verified: { principal: VerifiedPrincipal; args: unknown; audit?: ReplayAudit };
    try {
      const runtime = getIdentityRuntime(server);
      if (!runtime) throw new Error("identity runtime is not installed");
      verified = runtime.verifier.verify(options.toolName, rawArgs);
    } catch { return errorResult("IDENTITY_INVALID", "identity verification failed"); }
    const context = { issuer: verified.principal.issuer, worker: verified.principal.session?.worker ?? (verified.principal as any).worker ?? verified.principal.issuer };
    let outcome: ReplayOutcome = { outcome: "error", code: "INTERNAL_ERROR" };
    let response: any;
    try {
      if (options.rejectCallerFields && Object.keys(rawArgs as Record<string, unknown>).some((key) => key !== "_identity" && CALLER_FIELDS.test(key))) { outcome = { outcome: "error", code: "INVALID_ARGUMENTS" }; response = errorResult("INVALID_ARGUMENTS", "invalid tool arguments"); }
      else {
      const business = businessSchema.safeParse(sanitizeBusinessArgs(verified.args));
      if (!business.success) { outcome = { outcome: "error", code: "INVALID_ARGUMENTS" }; response = errorResult("INVALID_ARGUMENTS", "invalid tool arguments"); }
      else {
        let output: Output;
        try { output = await options.handler(business.data as Input, verified.principal); } catch (error) { response = canonicalError(error); outcome = { outcome: "error", code: response.structuredContent.error.code }; }
        if (!response) {
          const published = options.outputSchema as any;
          const shape = typeof published._def?.shape === "function" ? published._def.shape() : published.shape;
          const dataSchema = published.__dataSchema ?? shape?.data ?? options.outputSchema;
          // console.debug(options.toolName, !!published.__dataSchema, !!shape?.data);
          const checked = dataSchema.safeParse(output!);
          if (!checked.success) { outcome = { outcome: "error", code: "OUTPUT_INVALID" }; response = errorResult("OUTPUT_INVALID", "invalid tool output", context); }
           else {
             outcome = { outcome: "success", code: "OK" };
             const structuredContent = { ok: true, data: checked.data, error: null, _identity_context: context };
             if (!publishedOutputSchema.safeParse(structuredContent).success) {
               outcome = { outcome: "error", code: "OUTPUT_INVALID" };
               response = errorResult("OUTPUT_INVALID", "invalid tool output", context);
             } else response = { content: [{ type: "text" as const, text: JSON.stringify(structuredContent) }], structuredContent, isError: false };
           }
        }
      }
      }
    } catch { response = errorResult("HANDLER_ERROR", "request could not be completed"); outcome = { outcome: "error", code: "HANDLER_ERROR" }; }
    if (verified.audit && !(await finalizeReplayOrFail(runtimeContexts.get(server)!.verifier, verified.audit, outcome))) return errorResult("IDENTITY_AUDIT_FAILED", "identity audit could not be persisted", context);
    return response;
  });
  if (options.publishedInputJsonSchema) {
    const sdkServer = server as any;
    sdkServer.setToolRequestHandlers?.();
    const handlers: Map<string, Function> | undefined = sdkServer.server?._requestHandlers;
    const listHandler = handlers?.get("tools/list");
    if (handlers && listHandler && !sdkServer.__publishedSchemaRegistry) {
      const registry = new Map<string, Record<string, unknown>>();
      sdkServer.__publishedSchemaRegistry = registry;
      handlers.set("tools/list", async (request: unknown) => {
        const result = await listHandler(request);
        for (const tool of result.tools ?? []) if (registry.has(tool.name)) tool.inputSchema = registry.get(tool.name);
        return result;
      });
    }
    sdkServer.__publishedSchemaRegistry?.set(options.toolName, options.publishedInputJsonSchema);
  }
}

function objectShape(schema: z.ZodTypeAny): z.ZodRawShape {
  const candidate = schema as z.AnyZodObject;
  if (candidate.shape) return candidate.shape;
  const inner = (schema as any)._def?.schema as z.ZodTypeAny | undefined;
  return inner ? objectShape(inner) : {};
}

function schemaContainsCallerField(schema: z.ZodTypeAny, seen = new Set<unknown>()): boolean {
  if (!schema || seen.has(schema)) return false;
  seen.add(schema);
  const shape = objectShape(schema);
  if (Object.keys(shape).some((key) => CALLER_FIELDS.test(key))) return true;
  for (const child of Object.values(shape)) if (schemaContainsCallerField(child, seen)) return true;
  const def = (schema as any)._def ?? {};
  for (const value of Object.values(def)) {
    if (value && typeof value === "object") {
      if (Array.isArray(value) && value.some((item) => item && typeof item === "object" && schemaContainsCallerField(item as z.ZodTypeAny, seen))) return true;
      if (!Array.isArray(value) && (value as any)._def && schemaContainsCallerField(value as z.ZodTypeAny, seen)) return true;
    }
  }
  return false;
}

function depth(value: unknown, current = 0): number {
  if (!value || typeof value !== "object") return current;
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.reduce((max, item) => Math.max(max, depth(item, current + 1)), current);
}
