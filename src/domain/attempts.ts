import type Database from "better-sqlite3";
import { randomUUID } from "node:crypto";
import { antiOracleError, type AntiOracleError } from "../protocol/errors.js";
import { executeMutation, TransactionDomainError } from "./transaction.js";
import { hasEffectiveAuthority } from "./authority/service.js";
import { generateClaimToken, hashClaimToken, verifyClaimToken } from "./authority/tokens.js";

export interface ClaimAttemptInput {
  boardId: string;
  taskId: string;
  actor: string;
  expectedTaskRevision: number;
  leaseSeconds: number;
  idempotencyKey: string;
}

export interface ClaimAttemptResult {
  attemptId: string;
  attemptNo: number;
  actor: string;
  claimedAt: number;
  expiresAt: number;
  taskRevision: number;
  claimToken: string | null;
}

export class AttemptsDomainError extends Error {
  readonly error: AntiOracleError;
  readonly envelope: { ok: false; error: AntiOracleError };
  constructor(code: "REQUEST_INVALID" | "RESOURCE_NOT_AVAILABLE" | "STALE_REVISION" | "INVALID_TRANSITION" | "IDEMPOTENCY_CONFLICT" | "AUTHORITY_EXPIRED" | "TASK_BLOCKED" | "GATE_REQUIRED") {
    const error = antiOracleError(code);
    super(error.message);
    this.name = "AttemptsDomainError";
    this.error = error;
    this.envelope = { ok: false, error };
  }
}

const text = (value: unknown, max = 256): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;
const nowSeconds = () => Math.floor(Date.now() / 1000);

function validate(input: ClaimAttemptInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || !text(input.boardId) || !text(input.taskId) || !text(input.actor, 128) ||
    !text(input.idempotencyKey) || !Number.isInteger(input.expectedTaskRevision) || input.expectedTaskRevision < 1 ||
    !Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 15 || input.leaseSeconds > 3600) throw new AttemptsDomainError("REQUEST_INVALID");
}

export function claimAttempt(database: Database.Database, input: ClaimAttemptInput): ClaimAttemptResult {
  validate(input);
  const request = { boardId: input.boardId, taskId: input.taskId, actor: input.actor, expectedTaskRevision: input.expectedTaskRevision, leaseSeconds: input.leaseSeconds };
  try {
    return executeMutation<Omit<ClaimAttemptInput, "idempotencyKey">, ClaimAttemptResult, ClaimAttemptResult>(database, {
      actor: input.actor, tool: "attempts.claim", idempotencyKey: input.idempotencyKey, request,
      toPersisted: (result) => ({ ...result, claimToken: null }),
      fromPersisted: (result) => result,
      work: (db) => {
         const task = db.prepare("SELECT status, revision FROM fs_tasks WHERE board_id = ? AND id = ?").get(input.boardId, input.taskId) as { status: string; revision: number } | undefined;
         if (!task) throw new AttemptsDomainError("RESOURCE_NOT_AVAILABLE");
         const now = nowSeconds();
         if (!hasEffectiveAuthority(db, { actor: input.actor, boardId: input.boardId, resourceKind: "board", resourceId: input.boardId, operation: "update", now }))
           throw new AttemptsDomainError("RESOURCE_NOT_AVAILABLE");
         if (task.revision !== input.expectedTaskRevision) throw new AttemptsDomainError("STALE_REVISION");
         if (task.status !== "ready") throw new AttemptsDomainError("INVALID_TRANSITION");
        const attemptId = `attempt-${randomUUID()}`;
        const claimToken = generateClaimToken();
        const attemptNo = (db.prepare("SELECT COALESCE(MAX(attempt_no), 0) + 1 AS n FROM fs_attempts WHERE board_id = ? AND task_id = ?").get(input.boardId, input.taskId) as { n: number }).n;
        db.prepare("INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, ?)").run(attemptId, input.boardId, input.taskId, attemptNo, input.actor, hashClaimToken(claimToken), now, now + input.leaseSeconds);
        const revision = input.expectedTaskRevision + 1;
        if (db.prepare("UPDATE fs_tasks SET status = 'in_progress', revision = ?, updated_at = ? WHERE board_id = ? AND id = ? AND status = 'ready' AND revision = ?").run(revision, now, input.boardId, input.taskId, input.expectedTaskRevision).changes !== 1) throw new AttemptsDomainError("STALE_REVISION");
        return { attemptId, attemptNo, actor: input.actor, claimedAt: now, expiresAt: now + input.leaseSeconds, taskRevision: revision, claimToken };
      },
    }).response;
  } catch (error) {
    if (error instanceof AttemptsDomainError) throw error;
    if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new AttemptsDomainError("IDEMPOTENCY_CONFLICT");
    if (error instanceof Error && error.name === "SqliteError") throw new AttemptsDomainError("REQUEST_INVALID");
    throw error;
  }
}

export interface RenewAttemptInput {
  boardId: string; taskId: string; attemptId: string; actor: string; claimToken: string;
  extendSeconds: number; expectedTaskRevision: number; idempotencyKey: string;
}
export interface RenewAttemptResult { attemptId: string; expiresAt: number; taskRevision: number; }
export interface RecoverAttemptInput {
  boardId: string; taskId: string; attemptId: string; expectedTaskRevision: number; idempotencyKey: string; actor: string;
}
export interface RequeueRecoveredTaskInput {
  boardId: string; taskId: string; expectedTaskRevision: number; idempotencyKey: string; actor: string;
}
export interface RecoveryResult { taskRevision: number; }

function validateLifecycle(input: any, token = false): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || !text(input.boardId) || !text(input.taskId) ||
    !text(input.attemptId) || !text(input.actor, 128) || !text(input.idempotencyKey) ||
    !Number.isInteger(input.expectedTaskRevision) || input.expectedTaskRevision < 1 || (token && !text(input.claimToken)))
    throw new AttemptsDomainError("REQUEST_INVALID");
}
function mapError(error: unknown): never {
  if (error instanceof AttemptsDomainError) throw error;
  if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new AttemptsDomainError("IDEMPOTENCY_CONFLICT");
  if (error instanceof Error && error.name === "SqliteError") throw new AttemptsDomainError("REQUEST_INVALID");
  throw error;
}

export function renewAttempt(database: Database.Database, input: RenewAttemptInput): RenewAttemptResult {
  validateLifecycle(input, true);
  if (!Number.isInteger(input.extendSeconds) || input.extendSeconds < 15 || input.extendSeconds > 3600) throw new AttemptsDomainError("REQUEST_INVALID");
  try {
    return executeMutation(database, { actor: input.actor, tool: "attempts.renew", idempotencyKey: input.idempotencyKey,
      request: { ...input }, work: (db) => {
        const task = db.prepare("SELECT status, revision FROM fs_tasks WHERE board_id = ? AND id = ?").get(input.boardId, input.taskId) as { status: string; revision: number } | undefined;
        const attempt = db.prepare("SELECT actor, token_hash, state, expires_at FROM fs_attempts WHERE id = ? AND board_id = ? AND task_id = ?").get(input.attemptId, input.boardId, input.taskId) as { actor: string; token_hash: string; state: string; expires_at: number } | undefined;
        const now = nowSeconds();
        if (!task || !attempt) throw new AttemptsDomainError("RESOURCE_NOT_AVAILABLE");
        if (task.revision !== input.expectedTaskRevision) throw new AttemptsDomainError("STALE_REVISION");
        if (task.status !== "in_progress" && task.status !== "in_review") throw new AttemptsDomainError("INVALID_TRANSITION");
        if (attempt.actor !== input.actor || attempt.state !== "active" || attempt.expires_at <= now || !verifyClaimToken(input.claimToken, attempt.token_hash)) throw new AttemptsDomainError("AUTHORITY_EXPIRED");
        const expiresAt = now + input.extendSeconds;
        if (db.prepare("UPDATE fs_attempts SET expires_at = ? WHERE id = ? AND state = 'active' AND expires_at > ?").run(expiresAt, input.attemptId, now).changes !== 1) throw new AttemptsDomainError("AUTHORITY_EXPIRED");
        const revision = input.expectedTaskRevision + 1;
        if (db.prepare("UPDATE fs_tasks SET revision = ?, updated_at = ? WHERE board_id = ? AND id = ? AND revision = ? AND status IN ('in_progress','in_review')").run(revision, now * 1000, input.boardId, input.taskId, input.expectedTaskRevision).changes !== 1) throw new AttemptsDomainError("STALE_REVISION");
        return { attemptId: input.attemptId, expiresAt, taskRevision: revision };
      } }).response;
  } catch (error) { return mapError(error); }
}

export function recoverAttempt(database: Database.Database, input: RecoverAttemptInput): RecoveryResult {
  validateLifecycle(input);
  try {
    return executeMutation(database, { actor: input.actor, tool: "attempts.recover", idempotencyKey: input.idempotencyKey,
      request: { ...input }, work: (db) => {
        const task = db.prepare("SELECT status, revision FROM fs_tasks WHERE board_id = ? AND id = ?").get(input.boardId, input.taskId) as { status: string; revision: number } | undefined;
         const attempt = db.prepare("SELECT actor, state, expires_at FROM fs_attempts WHERE id = ? AND board_id = ? AND task_id = ?").get(input.attemptId, input.boardId, input.taskId) as { actor: string; state: string; expires_at: number } | undefined;
         const now = nowSeconds();
         if (!task || !attempt) throw new AttemptsDomainError("RESOURCE_NOT_AVAILABLE");
         if (task.revision !== input.expectedTaskRevision) throw new AttemptsDomainError("STALE_REVISION");
          // Recovery is performed by the verified caller, not by impersonating
          // the vanished worker.  Authority is scoped to this exact task (and
          // may resolve through its board grant).
          if (!hasEffectiveAuthority(db, { actor: input.actor, boardId: input.boardId, resourceKind: "task", resourceId: input.taskId, operation: "recover", now: Date.now() }))
            throw new AttemptsDomainError("RESOURCE_NOT_AVAILABLE");
          if (attempt.state !== "active" || attempt.expires_at > now) throw new AttemptsDomainError("INVALID_TRANSITION");
         db.prepare("UPDATE fs_leases SET state = 'expired', revision = revision + 1 WHERE attempt_id = ? AND state IN ('active', 'renewed')").run(input.attemptId);
         if (db.prepare("UPDATE fs_attempts SET state = 'expired', closed_at = ?, reason = 'recovered' WHERE id = ? AND state = 'active' AND expires_at <= ?").run(now, input.attemptId, now).changes !== 1) throw new AttemptsDomainError("INVALID_TRANSITION");
        const revision = input.expectedTaskRevision + 1;
        if (db.prepare("UPDATE fs_tasks SET status = 'blocked', recovery_pending = 1, revision = ?, updated_at = ? WHERE board_id = ? AND id = ? AND revision = ?").run(revision, now * 1000, input.boardId, input.taskId, input.expectedTaskRevision).changes !== 1) throw new AttemptsDomainError("STALE_REVISION");
        return { taskRevision: revision };
      } }).response;
  } catch (error) { return mapError(error); }
}

export function requeueRecoveredTask(database: Database.Database, input: RequeueRecoveredTaskInput): RecoveryResult {
  validateLifecycle({ ...input, attemptId: "requeue" });
  try {
    return executeMutation(database, { actor: input.actor, tool: "attempts.requeue", idempotencyKey: input.idempotencyKey,
      request: { ...input }, work: (db) => {
        const task = db.prepare("SELECT revision, recovery_pending FROM fs_tasks WHERE board_id = ? AND id = ?").get(input.boardId, input.taskId) as { revision: number; recovery_pending: number } | undefined;
         if (!task) throw new AttemptsDomainError("RESOURCE_NOT_AVAILABLE");
         if (task.revision !== input.expectedTaskRevision) throw new AttemptsDomainError("STALE_REVISION");
         if (!task.recovery_pending) throw new AttemptsDomainError("INVALID_TRANSITION");
          if (!hasEffectiveAuthority(db, { actor: input.actor, boardId: input.boardId, resourceKind: "task", resourceId: input.taskId, operation: "recover", now: Date.now() }))
            throw new AttemptsDomainError("RESOURCE_NOT_AVAILABLE");
        if (db.prepare("SELECT 1 FROM fs_attempts WHERE board_id = ? AND task_id = ? AND state = 'active'").get(input.boardId, input.taskId)) throw new AttemptsDomainError("INVALID_TRANSITION");
        const blocked = db.prepare("SELECT 1 FROM fs_task_dependencies d JOIN fs_tasks t ON t.board_id = d.dependency_board_id AND t.id = d.dependency_task_id WHERE d.task_board_id = ? AND d.task_id = ? AND t.status <> 'done'").get(input.boardId, input.taskId);
        if (blocked) throw new AttemptsDomainError("TASK_BLOCKED");
        const gate = db.prepare("SELECT 1 FROM fs_gates g WHERE g.board_id = ? AND EXISTS (SELECT 1 FROM json_each(g.required_for_json) WHERE value = 'ready') AND NOT EXISTS (SELECT 1 FROM fs_gate_decisions d WHERE d.board_id = ? AND d.task_id = ? AND d.gate_id = g.id AND d.status = 'allow' AND d.decision_no = (SELECT MAX(x.decision_no) FROM fs_gate_decisions x WHERE x.board_id = d.board_id AND x.task_id = d.task_id AND x.gate_id = d.gate_id))").get(input.boardId, input.boardId, input.taskId);
        if (gate) throw new AttemptsDomainError("GATE_REQUIRED");
        const revision = input.expectedTaskRevision + 1; const now = nowSeconds() * 1000;
        if (db.prepare("UPDATE fs_tasks SET status = 'ready', recovery_pending = 0, revision = ?, updated_at = ? WHERE board_id = ? AND id = ? AND revision = ? AND recovery_pending = 1").run(revision, now, input.boardId, input.taskId, input.expectedTaskRevision).changes !== 1) throw new AttemptsDomainError("STALE_REVISION");
        return { taskRevision: revision };
      } }).response;
  } catch (error) { return mapError(error); }
}
