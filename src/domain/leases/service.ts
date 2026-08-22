import type Database from "better-sqlite3";
import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { executeMutation, TransactionDomainError } from "../transaction.js";
import { hashClaimToken } from "../authority/tokens.js";
import { antiOracleError } from "../../protocol/errors.js";
import type { StableErrorCode } from "../../protocol/types.js";
import { normalizeFileScope, scopesOverlap, type FileCasePolicy, type NormalizedFileScope } from "./file-scopes.js";

export interface ReserveLeaseInput { boardId: string; taskId: string; attemptId: string; holder: string; claimToken: string; paths: string[]; casePolicy: FileCasePolicy; leaseSeconds: number; idempotencyKey: string; }
export interface ReserveLeaseResult { leaseId: string; attemptId: string; holder: string; scopes: string[]; issuedAt: number; expiresAt: number; leaseToken: string | null; }
export interface RenewLeaseInput { leaseId: string; holder: string; leaseToken: string; expectedRevision: number; extendSeconds: number; idempotencyKey: string; }
export interface ReleaseLeaseInput { leaseId: string; holder: string; leaseToken: string; expectedRevision: number; idempotencyKey: string; }
export interface LeaseMutationResult { leaseId: string; revision: number; expiresAt: number; state: "renewed" | "released"; }
export class LeaseDomainError extends Error {
  readonly error; readonly envelope;
  constructor(code: StableErrorCode) { const error = antiOracleError(code); super(error.message); this.name = "LeaseDomainError"; this.error = error; this.envelope = { ok: false as const, error }; }
}
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const tokenHash = (token: string): string => createHash("sha256").update(token, "utf8").digest("hex");
const sameToken = (token: string, stored: string): boolean => { const a = Buffer.from(hashClaimToken(token)); const b = Buffer.from(stored); return a.length === b.length && timingSafeEqual(a, b); };
const sameLeaseToken = (token: string, stored: string): boolean => { const a = Buffer.from(tokenHash(token)); const b = Buffer.from(stored); return a.length === b.length && timingSafeEqual(a, b); };

function validate(input: ReserveLeaseInput): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || !text(input.boardId) || !text(input.taskId) || !text(input.attemptId) ||
    !text(input.holder, 128) || !text(input.claimToken, 512) || !Array.isArray(input.paths) || input.paths.length < 1 || input.paths.length > 100 ||
    (input.casePolicy !== "sensitive" && input.casePolicy !== "insensitive") || !Number.isInteger(input.leaseSeconds) || input.leaseSeconds < 15 || input.leaseSeconds > 3600 || !text(input.idempotencyKey)) throw new LeaseDomainError("REQUEST_INVALID");
}
function canonicalScopes(paths: string[], policy: FileCasePolicy): NormalizedFileScope[] {
  try { const seen = new Map<string, NormalizedFileScope>(); for (const path of paths) { const scope = normalizeFileScope(path, policy); seen.set(scope.normalized_scope, scope); } return [...seen.values()].sort((a, b) => a.normalized_scope.localeCompare(b.normalized_scope)); }
  catch { throw new LeaseDomainError("INVALID_SCOPE"); }
}
function comparable(scope: NormalizedFileScope, policy: FileCasePolicy): NormalizedFileScope { if (policy === "sensitive") return scope; return { ...scope, base_path: scope.base_path.toLocaleLowerCase("en-US"), normalized_scope: scope.normalized_scope.toLocaleLowerCase("en-US") }; }

export function reserveLease(database: Database.Database, input: ReserveLeaseInput): ReserveLeaseResult {
  validate(input);
  const scopes = canonicalScopes(input.paths, input.casePolicy);
  const request = { ...input, claimToken: hashClaimToken(input.claimToken), paths: scopes.map((s) => s.normalized_scope) };
  try {
    return executeMutation< typeof request, ReserveLeaseResult, ReserveLeaseResult>(database, { actor: input.holder, tool: "leases.reserve", idempotencyKey: input.idempotencyKey, request,
      toPersisted: (result) => ({ ...result, leaseToken: null }), fromPersisted: (result) => result,
      work: (db) => {
        const now = Math.floor(Date.now() / 1000);
        const attempt = db.prepare("SELECT actor, token_hash, state, expires_at FROM fs_attempts WHERE id = ? AND board_id = ? AND task_id = ?").get(input.attemptId, input.boardId, input.taskId) as { actor: string; token_hash: string; state: string; expires_at: number } | undefined;
        if (!attempt) throw new LeaseDomainError("RESOURCE_NOT_AVAILABLE");
        if (attempt.actor !== input.holder || attempt.state !== "active" || attempt.expires_at <= now || !sameToken(input.claimToken, attempt.token_hash)) throw new LeaseDomainError("AUTHORITY_EXPIRED");
        const active = db.prepare("SELECT s.normalized_scope, s.base_path, s.scope_kind, l.case_policy FROM fs_lease_scopes s JOIN fs_leases l ON l.lease_id = s.lease_id WHERE l.state IN ('active','renewed') AND l.expires_at > ?").all(now) as (NormalizedFileScope & { case_policy: FileCasePolicy })[];
        for (const requested of scopes) for (const existing of active) {
          const policy: FileCasePolicy = input.casePolicy === "insensitive" || existing.case_policy === "insensitive" ? "insensitive" : "sensitive";
          if (scopesOverlap(comparable(requested, policy), comparable(existing, policy))) throw new LeaseDomainError("LEASE_CONFLICT");
        }
        const issuedAt = now; const expiresAt = Math.min(now + input.leaseSeconds, attempt.expires_at); const leaseId = `lease-${randomUUID()}`; const leaseToken = randomBytes(32).toString("base64url");
        db.prepare("INSERT INTO fs_leases (lease_id, attempt_id, holder, path_pattern, case_policy, token_hash, state, revision, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)").run(leaseId, input.attemptId, input.holder, scopes.map((s) => s.normalized_scope).join(","), input.casePolicy, tokenHash(leaseToken), issuedAt, expiresAt, issuedAt);
        const insert = db.prepare("INSERT INTO fs_lease_scopes (lease_id, normalized_scope, base_path, scope_kind) VALUES (?, ?, ?, ?)"); for (const scope of scopes) insert.run(leaseId, scope.normalized_scope, scope.base_path, scope.scope_kind);
        return { leaseId, attemptId: input.attemptId, holder: input.holder, scopes: scopes.map((s) => s.normalized_scope), issuedAt, expiresAt, leaseToken };
      } }).response;
  } catch (error) { if (error instanceof LeaseDomainError) throw error; if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new LeaseDomainError("IDEMPOTENCY_CONFLICT"); throw error; }
}

function validateMutation(input: RenewLeaseInput | ReleaseLeaseInput, renew: boolean): void {
  if (!input || typeof input !== "object" || Array.isArray(input) || !text(input.leaseId) || !text(input.holder, 128) ||
    !text(input.leaseToken, 512) || !Number.isInteger(input.expectedRevision) || input.expectedRevision < 1 || !text(input.idempotencyKey) ||
    (renew && (!Number.isInteger((input as RenewLeaseInput).extendSeconds) || (input as RenewLeaseInput).extendSeconds < 15 || (input as RenewLeaseInput).extendSeconds > 3600))) {
    throw new LeaseDomainError("REQUEST_INVALID");
  }
}

export function renewLease(database: Database.Database, input: RenewLeaseInput): LeaseMutationResult {
  validateMutation(input, true);
  const request = { ...input };
  try {
    return executeMutation<typeof request, LeaseMutationResult>(database, { actor: input.holder, tool: "leases.renew", idempotencyKey: input.idempotencyKey, request,
      work: (db) => {
        const now = Math.floor(Date.now() / 1000);
        const lease = db.prepare("SELECT attempt_id, holder, token_hash, state, revision, expires_at FROM fs_leases WHERE lease_id = ?").get(input.leaseId) as { attempt_id: string; holder: string; token_hash: string; state: string; revision: number; expires_at: number } | undefined;
        if (!lease || lease.holder !== input.holder || !sameLeaseToken(input.leaseToken, lease.token_hash)) throw new LeaseDomainError("AUTHORITY_EXPIRED");
        if (lease.revision !== input.expectedRevision) throw new LeaseDomainError("STALE_REVISION");
        const attempt = db.prepare("SELECT actor, state, expires_at FROM fs_attempts WHERE id = ?").get(lease.attempt_id) as { actor: string; state: string; expires_at: number } | undefined;
        if (lease.state !== "active" && lease.state !== "renewed" || lease.expires_at <= now || !attempt || attempt.actor !== input.holder || attempt.state !== "active" || attempt.expires_at <= now) throw new LeaseDomainError("AUTHORITY_EXPIRED");
        const expiresAt = Math.min(now + input.extendSeconds, attempt.expires_at);
        const revision = input.expectedRevision + 1;
        if (db.prepare("UPDATE fs_leases SET state = 'renewed', expires_at = ?, revision = ? WHERE lease_id = ? AND holder = ? AND revision = ? AND state IN ('active','renewed') AND expires_at > ?").run(expiresAt, revision, input.leaseId, input.holder, input.expectedRevision, now).changes !== 1) throw new LeaseDomainError("STALE_REVISION");
        return { leaseId: input.leaseId, revision, expiresAt, state: "renewed" };
      } }).response;
  } catch (error) { if (error instanceof LeaseDomainError) throw error; if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new LeaseDomainError("IDEMPOTENCY_CONFLICT"); throw error; }
}

export function releaseLease(database: Database.Database, input: ReleaseLeaseInput): LeaseMutationResult {
  validateMutation(input, false);
  const request = { ...input };
  try {
    return executeMutation<typeof request, LeaseMutationResult>(database, { actor: input.holder, tool: "leases.release", idempotencyKey: input.idempotencyKey, request,
      work: (db) => {
        const lease = db.prepare("SELECT token_hash, holder, state, revision, expires_at FROM fs_leases WHERE lease_id = ?").get(input.leaseId) as { token_hash: string; holder: string; state: string; revision: number; expires_at: number } | undefined;
        if (!lease || lease.holder !== input.holder || !sameLeaseToken(input.leaseToken, lease.token_hash)) throw new LeaseDomainError("AUTHORITY_EXPIRED");
        if (lease.revision !== input.expectedRevision) throw new LeaseDomainError("STALE_REVISION");
        if (lease.state !== "active" && lease.state !== "renewed") throw new LeaseDomainError("INVALID_TRANSITION");
        const revision = input.expectedRevision + 1;
        if (db.prepare("UPDATE fs_leases SET state = 'released', revision = ? WHERE lease_id = ? AND holder = ? AND revision = ? AND state IN ('active','renewed')").run(revision, input.leaseId, input.holder, input.expectedRevision).changes !== 1) throw new LeaseDomainError("STALE_REVISION");
        return { leaseId: input.leaseId, revision, expiresAt: lease.expires_at, state: "released" };
      } }).response;
  } catch (error) { if (error instanceof LeaseDomainError) throw error; if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new LeaseDomainError("IDEMPOTENCY_CONFLICT"); throw error; }
}
