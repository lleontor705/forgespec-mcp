import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { claimResult, renewAttemptResult, transitionResult, recoveryResult } from "./schemas.js";
import { registerIdentityTool, getIdentityRuntime } from "../identity/dispatcher.js";
import type { VerifiedPrincipal } from "../identity/types.js";
import { claimAttempt, renewAttempt, recoverAttempt, requeueRecoveredTask, AttemptsDomainError } from "../domain/attempts.js";
import { transitionTask } from "../domain/task-transitions.js";

const text = (max: number) => z.string().min(1).max(max);
const common = { idempotency_key: text(256), board_id: text(256), task_id: text(256) };
const claim = z.object({ ...common, expected_task_revision: z.number().int().min(1), lease_seconds: z.number().int().min(15).max(3600) });
const renew = z.object({ ...common, attempt_id: text(256), claim_token: text(512), extend_seconds: z.number().int().min(15).max(3600), expected_task_revision: z.number().int().min(1) });
const transition = z.object({ ...common, target: z.enum(["in_review", "blocked", "recovery_pending", "done", "in_progress"]), attempt_id: text(256), claim_token: text(512), expected_revision: z.number().int().min(1), reason: z.string().max(4096).optional() });
const recover = z.object({ ...common, action: z.enum(["recover", "requeue"]), attempt_id: text(256).optional(), expected_task_revision: z.number().int().min(1) });

export interface ExecutionToolContext { database: () => Database.Database }
const actor = (principal: VerifiedPrincipal) => principal.session.worker;

export function registerExecutionTools(server: McpServer, context: ExecutionToolContext): void {
  const verifier = getIdentityRuntime(server)?.verifier;
  if (!verifier) throw new Error("identity runtime is not installed");
  const register = <I extends Record<string, unknown>>(name: string, schema: z.AnyZodObject, outputSchema: z.ZodTypeAny, handler: (i: I, p: VerifiedPrincipal) => unknown) => registerIdentityTool<any, any>(server, { verifier, toolName: name, businessSchema: schema, outputSchema, description: name, annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: false }, handler });
  register("attempt_claim", claim, claimResult, (i: any, p) => claimAttempt(context.database(), { boardId: i.board_id, taskId: i.task_id, actor: actor(p), expectedTaskRevision: i.expected_task_revision, leaseSeconds: i.lease_seconds, idempotencyKey: i.idempotency_key }));
  register("attempt_renew", renew, renewAttemptResult, (i: any, p) => renewAttempt(context.database(), { boardId: i.board_id, taskId: i.task_id, attemptId: i.attempt_id, actor: actor(p), claimToken: i.claim_token, extendSeconds: i.extend_seconds, expectedTaskRevision: i.expected_task_revision, idempotencyKey: i.idempotency_key }));
  register("task_transition", transition, transitionResult, (i: any, p) => transitionTask(context.database(), { boardId: i.board_id, taskId: i.task_id, target: i.target, actor: actor(p), attemptId: i.attempt_id, claimToken: i.claim_token, expectedRevision: i.expected_revision, idempotencyKey: i.idempotency_key, reason: i.reason }));
  register("attempt_recover", recover, recoveryResult, (i: any, p) => { const base = { boardId: i.board_id, taskId: i.task_id, actor: actor(p), expectedTaskRevision: i.expected_task_revision, idempotencyKey: i.idempotency_key }; return i.action === "recover" ? recoverAttempt(context.database(), { ...base, attemptId: i.attempt_id! }) : requeueRecoveredTask(context.database(), base); });
}
