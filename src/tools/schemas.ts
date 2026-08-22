import { z } from "zod";
import { AUTHORITY_OPERATIONS } from "../domain/authority/types.js";

/** Identity is added by the dispatcher and is never accepted from business input. */
export const identityContext = z.object({ issuer: z.string().min(1).max(256), worker: z.string().min(1).max(256) }).strict();
const errorBody = z.object({
  code: z.string().min(1).max(128), message: z.string().min(1).max(1024),
  category: z.string().max(128).optional(), retryable: z.boolean().optional(), restartQuery: z.boolean().optional(),
}).strict();
export const canonicalErrorSchema = z.object({ ok: z.literal(false), data: z.null(), error: errorBody, _identity_context: identityContext.nullable() }).strict();

const boundedMetadata = z.record(z.string().max(256), z.unknown()).refine((v) => Object.keys(v).length <= 100).describe("bounded metadata");
// Every tool publishes one strict envelope. The private dataSchema marker lets
// the dispatcher validate handlers against the explicit per-tool data shape.
const envelope = <T extends z.AnyZodObject>(success: T) => {
  const result = z.object({ ok: z.literal(true), data: success, error: z.null(), _identity_context: identityContext.nullable() }).strict();
  (result as any).__dataSchema = success;
  return result;
};
const id = z.string().min(1).max(512);
const revision = z.number().int().min(1);
const replay = z.boolean();

export const negotiateOutput = z.object({ protocol_version: z.literal("2.0"), profile: z.enum(["planner", "worker", "orchestrator", "reviewer"]), tools: z.array(z.string().min(1).max(128)).max(100), capability_families: z.array(z.string().min(1).max(128)).max(100), limits: z.object({ maxToolsPerProfile: z.number().int().positive() }).strict() }).strict();
export const negotiateResult = envelope(negotiateOutput);
export const healthOutput = z.object({ package: z.object({ name: z.string().min(1).max(128), version: z.string().min(1).max(64) }).strict(), runtime: z.object({ node: z.string().min(1).max(64) }).strict(), sqlite: z.object({ version: z.string().min(1).max(64) }).strict(), uptime_seconds: z.number().nonnegative(), storage: z.object({ qualified: z.boolean(), table_count: z.number().int().nonnegative() }).strict() }).strict();
export const healthResult = envelope(healthOutput);

const board = z.object({ id, project: z.string().min(1).max(128), name: z.string().min(1).max(128), revision, metadata: boundedMetadata, createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), rootAuthorityExpiresAt: z.number().int().positive().optional() }).strict();
export const boardCreateResult = envelope(board);
export const taskRecord = z.object({ boardId: id, id, title: z.string().min(1).max(128), description: z.string().max(65536), priority: z.enum(["p0", "p1", "p2", "p3"]), status: z.enum(["backlog", "ready", "in_progress", "in_review", "blocked", "done"]), specRef: z.string().max(128).nullable(), acceptanceCriteria: z.string().max(65536), revision, createdAt: z.number().int().nonnegative(), updatedAt: z.number().int().nonnegative(), dependencies: z.array(id).max(100) }).strict();
export const taskDefineResult = envelope(taskRecord);
export const taskQueryResult = envelope(z.object({ total_count: z.number().int().nonnegative(), records: z.array(taskRecord).max(200), dependencies: z.array(z.object({ taskId: id, dependencyTaskId: id }).strict()).max(200) }).strict());

export const claimResult = envelope(z.object({ attemptId: id, attemptNo: z.number().int().positive(), actor: id, claimedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), taskRevision: revision, claimToken: z.string().max(512).nullable() }).strict());
export const renewAttemptResult = envelope(z.object({ attemptId: id, expiresAt: z.number().int().positive(), taskRevision: revision }).strict());
export const transitionResult = envelope(z.object({ taskRevision: revision, status: z.enum(["in_review", "blocked", "recovery_pending", "done", "in_progress"]), promotedTaskIds: z.array(id).max(100) }).strict());
export const recoveryResult = envelope(z.object({ taskRevision: revision }).strict());

export const leaseReserveResult = envelope(z.object({ leaseId: id, attemptId: id, holder: id, scopes: z.array(z.string().min(1).max(4096)).max(100), issuedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive(), leaseToken: z.string().max(512).nullable() }).strict());
export const leaseMutationResult = envelope(z.object({ leaseId: id, revision, expiresAt: z.number().int().positive(), state: z.enum(["renewed", "released"]) }).strict());

export const contractValidateResult = envelope(z.object({ ok: z.literal(true), valid: z.boolean(), errors: z.array(z.string().max(1024)).max(100).optional() }).strict());
export const contractCommitResult = envelope(z.object({ ok: z.literal(true), contract_id: id, revision, board_revision: revision, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), replayed: replay }).strict());
const contractItem = z.object({ contract_id: id, project: z.string().max(256), change_name: z.string().max(256), phase: z.string().max(64), status: z.string().max(64), confidence: z.number().min(0).max(1), executive_summary: z.string().max(4096), revision, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/), parent_contract_id: id.nullable(), created_at: z.number().int().nonnegative(), updated_at: z.number().int().nonnegative() }).strict();
export const contractQueryResult = envelope(z.object({ ok: z.literal(true), items: z.array(contractItem).max(100), total_count: z.number().int().nonnegative() }).strict());

const provenance = z.object({ kind: z.literal("asserted"), source: z.enum(["explicit", "evidence-link-derived"]).optional(), assertedActor: id, boundary: z.literal("local-trusted-client"), mode: z.literal("native"), approvalRef: z.object({ provider: id, kind: id, externalId: id, digest: z.string().regex(/^sha256:[a-f0-9]{64}$/) }).strict() }).strict();
export const approvalResult = envelope(z.object({ ok: z.literal(true), approval: z.object({ approvalId: id, boardId: id, taskId: id, gateId: id, attemptId: id, actor: id, decision: z.enum(["allow", "deny"]), notes: z.unknown().optional().describe("bounded approval notes"), decidedAt: z.number().int().nonnegative(), revision, provenance, replayed: replay.optional() }).strict() }).strict());
const authorityResource = z.discriminatedUnion("kind", [z.object({ kind: z.literal("board"), boardId: id }).strict(), z.object({ kind: z.literal("task"), boardId: id, resourceId: id }).strict()]);
const authority = z.object({ authorityId: id, parentAuthorityId: id.nullable(), resource: authorityResource, actor: id, granteeActor: id, operation: z.enum(AUTHORITY_OPERATIONS), grantedByActor: id, lineageKind: z.string().min(1).max(64), status: z.string().min(1).max(64), grantedAt: z.number().int().nonnegative(), expiresAt: z.number().int().positive() }).strict();
export const authorityResult = envelope(z.object({ ok: z.literal(true).optional(), revoked: z.boolean().optional(), authorities: z.array(authority).max(100).optional() }).strict());
const event = z.object({ event_id: id, task_id: id, attempt_id: id, tool: z.string().min(1).max(256), event_type: z.string().min(1).max(128), resource_type: z.string().min(1).max(64), resource_id: id, board_id: id, payload_json: z.unknown().describe("bounded event payload"), created_at: z.number().int().nonnegative(), event_ordinal: z.number().int().nonnegative(), prev_hash: z.string().nullable(), event_hash: z.string().min(1).max(256) }).strict();
export const eventQueryResult = envelope(z.object({ items: z.array(event).max(200), total_count: z.number().int().nonnegative(), next_cursor: z.string().max(4096).nullable() }).strict());

/** Kept only for compatibility with older imports; new registrations use named contracts above. */
export const toolOutput = () => z.object({ ok: z.boolean(), data: z.unknown().nullable(), error: errorBody.nullable(), _identity_context: identityContext.nullable() }).strict();
