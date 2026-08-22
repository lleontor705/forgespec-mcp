import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { get as getDb } from "../storage/database.js";
import { reserveLease, renewLease, releaseLease } from "../domain/leases/service.js";
import { registerIdentityTool, getIdentityRuntime } from "../identity/dispatcher.js";
import type { VerifiedPrincipal } from "../identity/types.js";
import { leaseReserveResult, leaseMutationResult } from "./schemas.js";

const text = (max: number) => z.string().min(1).max(max);
const reserve = z.object({
  board_id: text(256), task_id: text(256), attempt_id: text(256), claim_token: text(512),
  paths: z.array(text(4096)).min(1).max(100), case_policy: z.enum(["sensitive", "insensitive"]),
  lease_seconds: z.number().int().min(15).max(3600), idempotency_key: text(256),
}).strict();
const mutation = z.object({
  lease_id: text(256), lease_token: text(512), expected_revision: z.number().int().min(1), idempotency_key: text(256),
}).strict();
const renew = mutation.extend({ extend_seconds: z.number().int().min(15).max(3600) }).strict();

export interface LeaseToolContext { database: () => Database.Database }
const actor = (principal: VerifiedPrincipal) => principal.session.worker;

export function registerLeaseTools(server: McpServer, context: LeaseToolContext | (() => Database.Database) = getDb): void {
  const database = typeof context === "function" ? context : context.database;
  const verifier = getIdentityRuntime(server)?.verifier;
  if (!verifier) throw new Error("identity runtime is not installed");
  const register = <I extends Record<string, unknown>>(name: string, schema: z.AnyZodObject, outputSchema: z.ZodTypeAny, handler: (i: I, p: VerifiedPrincipal) => unknown) => registerIdentityTool<any, any>(server, { verifier, toolName: name, businessSchema: schema, outputSchema, description: name, annotations: { idempotentHint: true, destructiveHint: true, openWorldHint: false }, handler });
  register("lease_reserve", reserve, leaseReserveResult, (i: any, p) => reserveLease(database(), { boardId: i.board_id, taskId: i.task_id, attemptId: i.attempt_id, holder: actor(p), claimToken: i.claim_token, paths: i.paths, casePolicy: i.case_policy, leaseSeconds: i.lease_seconds, idempotencyKey: i.idempotency_key }));
  register("lease_renew", renew, leaseMutationResult, (i: any, p) => renewLease(database(), { leaseId: i.lease_id, holder: actor(p), leaseToken: i.lease_token, expectedRevision: i.expected_revision, extendSeconds: i.extend_seconds, idempotencyKey: i.idempotency_key }));
  register("lease_release", mutation, leaseMutationResult, (i: any, p) => releaseLease(database(), { leaseId: i.lease_id, holder: actor(p), leaseToken: i.lease_token, expectedRevision: i.expected_revision, idempotencyKey: i.idempotency_key }));
}
