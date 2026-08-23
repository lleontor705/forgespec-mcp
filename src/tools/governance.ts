import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { recordApproval, ApprovalDomainError } from "../domain/approvals.js";
import { grantAuthority, revokeAuthority, queryAuthority, AuthorityDomainError } from "../domain/authority/service.js";
import { AUTHORITY_OPERATIONS } from "../domain/authority/types.js";
import { queryEvents, EventDomainError } from "../domain/events.js";
import { getIdentityRuntime, registerIdentityTool } from "../identity/dispatcher.js";
import type { VerifiedPrincipal } from "../identity/types.js";
import { approvalResult, authorityResult, eventQueryResult } from "./schemas.js";

const text = (max = 256) => z.string().min(1).max(max);
const resource = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("board"), board_id: text() }).strict(),
  z.object({ kind: z.literal("task"), board_id: text(), task_id: text() }).strict(),
]);
const ops = z.array(z.enum(AUTHORITY_OPERATIONS)).min(1).max(AUTHORITY_OPERATIONS.length).superRefine((v, c) => { if (new Set(v).size !== v.length) c.addIssue({ code: "custom", message: "operations must be unique" }); });
const provenance = z.object({ kind: z.literal("asserted"), source: z.enum(["explicit", "evidence-link-derived"]).optional(), boundary: z.literal("local-trusted-client"), mode: z.literal("native"), approval_ref: z.object({ provider: text(), kind: text(), external_id: text(), digest: z.string().regex(/^sha256:[0-9a-f]{64}$/) }).strict() }).strict();
const approval = z.object({ board_id: text(), task_id: text(), gate_id: text(), attempt_id: text(), decision: z.enum(["allow", "deny"]), notes: z.unknown().optional(), provenance, expected_task_revision: z.number().int().min(1), idempotency_key: text() }).strict();
const authority = z.discriminatedUnion("action", [
  z.object({ action: z.literal("grant"), resource, operations: ops, expires_at: z.number().int().positive(), grantee_handle: text(128), idempotency_key: text() }).strict(),
  z.object({ action: z.literal("handoff"), resource, operations: ops, expires_at: z.number().int().positive(), to_handle: text(128), idempotency_key: text() }).strict(),
  z.object({ action: z.literal("revoke"), board_id: text(), authority_id: text(), reason: text(1024).optional(), idempotency_key: text() }).strict(),
  z.object({ action: z.literal("query"), resource: resource.optional(), operation: z.enum(AUTHORITY_OPERATIONS).optional() }).strict(),
]);
// Publish an explicit SDK union so tools/list carries action-specific required
// fields rather than a permissive union of all authority properties.
const authorityPublishedInput = z.union([
  z.object({ _identity: z.object({}).passthrough(), action: z.literal("grant"), resource, operations: ops, expires_at: z.number().int().positive(), grantee_handle: text(128), idempotency_key: text() }).strict(),
  z.object({ _identity: z.object({}).passthrough(), action: z.literal("handoff"), resource, operations: ops, expires_at: z.number().int().positive(), to_handle: text(128), idempotency_key: text() }).strict(),
  z.object({ _identity: z.object({}).passthrough(), action: z.literal("revoke"), board_id: text(), authority_id: text(), reason: text(1024).optional(), idempotency_key: text() }).strict(),
  z.object({ _identity: z.object({}).passthrough(), action: z.literal("query"), resource: resource.optional(), operation: z.enum(AUTHORITY_OPERATIONS).optional() }).strict(),
]);
// The SDK's list serializer only discovers schemas with an object-like `shape`.
// Preserve the union parser while marking this published schema for that path.
Object.defineProperty(authorityPublishedInput, "shape", { value: {}, enumerable: false });
const authorityResourceJsonSchema = { anyOf: [
  { type: "object", additionalProperties: false, required: ["kind", "board_id"], properties: { kind: { const: "board" }, board_id: { type: "string", minLength: 1, maxLength: 256 } } },
  { type: "object", additionalProperties: false, required: ["kind", "board_id", "task_id"], properties: { kind: { const: "task" }, board_id: { type: "string", minLength: 1, maxLength: 256 }, task_id: { type: "string", minLength: 1, maxLength: 256 } } },
] };
const authorityOperationsJsonSchema = { type: "array", minItems: 1, maxItems: AUTHORITY_OPERATIONS.length, uniqueItems: true, items: { type: "string", enum: [...AUTHORITY_OPERATIONS] } };
const authorityPublishedJsonSchema = {
  type: "object", anyOf: [
    { type: "object", additionalProperties: false, required: ["_identity", "action", "resource", "operations", "expires_at", "grantee_handle", "idempotency_key"], properties: { _identity: {}, action: { const: "grant" }, resource: authorityResourceJsonSchema, operations: authorityOperationsJsonSchema, expires_at: { type: "integer" }, grantee_handle: { type: "string" }, idempotency_key: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["_identity", "action", "resource", "operations", "expires_at", "to_handle", "idempotency_key"], properties: { _identity: {}, action: { const: "handoff" }, resource: authorityResourceJsonSchema, operations: authorityOperationsJsonSchema, expires_at: { type: "integer" }, to_handle: { type: "string" }, idempotency_key: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["_identity", "action", "board_id", "authority_id", "idempotency_key"], properties: { _identity: {}, action: { const: "revoke" }, board_id: { type: "string" }, authority_id: { type: "string" }, reason: { type: "string" }, idempotency_key: { type: "string" } } },
    { type: "object", additionalProperties: false, required: ["_identity", "action"], properties: { _identity: {}, action: { const: "query" }, resource: authorityResourceJsonSchema, operation: { type: "string", enum: [...AUTHORITY_OPERATIONS] } } },
  ],
};
const events = z.object({ board_id: text(), resource_type: z.enum(["board", "task", "contract", "authority", "lease"]).optional(), resource_id: text().optional(), event_type: z.array(text()).max(32).optional(), limit: z.number().int().min(1).max(200).optional(), cursor: text(4096).optional() }).strict();
const mutationAnnotations = { idempotentHint: true, destructiveHint: true, openWorldHint: false } as const;
const readAnnotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false } as const;
const fail = (e: unknown) => {
  const code = e instanceof ApprovalDomainError ? e.error.code : e instanceof EventDomainError ? e.code : e instanceof AuthorityDomainError ? e.code : "REQUEST_INVALID";
  return { ok: false, error: { code, category: code === "AUTH_DENIED" || code === "APPROVAL_FORBIDDEN" ? "authorization" : "validation", message: "Operation could not be completed.", retryable: code === "STALE_REVISION", restartQuery: false } };
};
const actor = (principal: VerifiedPrincipal) => principal.session.worker;
const target = (verifier: { resolveWorkerHandle?: (handle: string) => string | undefined }, handle: string): string => {
  const resolved = verifier.resolveWorkerHandle?.(handle);
  if (!resolved) throw new AuthorityDomainError("AUTH_DENIED");
  return resolved;
};

export interface GovernanceToolContext { database: () => Database.Database; cursorSecret: string | readonly string[] }
export function registerGovernanceTools(server: McpServer, context: GovernanceToolContext): void {
  const secretList = Array.isArray(context.cursorSecret)
    ? context.cursorSecret
    : typeof context.cursorSecret === "string"
      ? context.cursorSecret.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
  if (!secretList.length || secretList.some((s) => typeof s !== "string" || Buffer.byteLength(s, "utf8") < 32)) {
    throw new Error("Cursor secret must contain at least 32 bytes");
  }
  const verifier = getIdentityRuntime(server)?.verifier; if (!verifier) throw new Error("identity runtime is not installed");
  registerIdentityTool<any, any>(server, { verifier, toolName: "approval_record", description: "Record a verified reviewer approval.", businessSchema: approval, outputSchema: approvalResult, annotations: mutationAnnotations, rejectCallerFields: true, handler: async (input: any, principal) => ({
    ok: true, approval: recordApproval(context.database(), { boardId: input.board_id, taskId: input.task_id, gateId: input.gate_id, attemptId: input.attempt_id, reviewerActor: actor(principal), decision: input.decision, notes: input.notes, provenance: { ...input.provenance, assertedActor: actor(principal), approvalRef: { provider: input.provenance.approval_ref.provider, kind: input.provenance.approval_ref.kind, externalId: input.provenance.approval_ref.external_id, digest: input.provenance.approval_ref.digest } }, expectedTaskRevision: input.expected_task_revision, idempotencyKey: input.idempotency_key })
  })});
  registerIdentityTool<any, any>(server, { verifier, toolName: "authority_manage", description: "Manage bounded authority for enrolled worker handles.", businessSchema: authority, publishedInputSchema: authorityPublishedInput, publishedInputJsonSchema: authorityPublishedJsonSchema, outputSchema: authorityResult, annotations: mutationAnnotations, rejectCallerFields: true, handler: async (input: any, principal) => {
    const db = context.database(); const r = input.resource && { kind: input.resource.kind, boardId: input.resource.board_id, ...(input.resource.kind === "task" ? { resourceId: input.resource.task_id } : {}) };
    if (input.action === "grant" || input.action === "handoff") return { ok: true, authorities: grantAuthority(db, { actor: actor(principal), granteeActor: target(verifier, input.action === "grant" ? input.grantee_handle : input.to_handle), resource: r!, operations: input.operations, expiresAt: input.expires_at, idempotencyKey: input.idempotency_key }) };
    if (input.action === "revoke") { revokeAuthority(db, { actor: actor(principal), boardId: input.board_id, authorityId: input.authority_id, reason: input.reason, idempotencyKey: input.idempotency_key }); return { ok: true, revoked: true }; }
    return { ok: true, authorities: queryAuthority(db, { actor: actor(principal), resource: r, operation: input.operation }) };
  }});
  registerIdentityTool<any, any>(server, { verifier, toolName: "event_query", description: "Query audit events bound to the verified worker.", businessSchema: events, outputSchema: eventQueryResult, annotations: readAnnotations, rejectCallerFields: true, handler: async (input: any, principal) => queryEvents(context.database(), { ...input, actor: actor(principal) }, { cursorSecret: context.cursorSecret }) });
}
