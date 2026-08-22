import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.js";
import { executeMutation } from "./transaction.js";
import { queryAuthority } from "./authority/service.js";
import { antiOracleError, type AntiOracleError } from "../protocol/errors.js";

export type ApprovalDecision = "allow" | "deny";
export type ApprovalProvenance = {
  kind: "asserted"; source?: "explicit" | "evidence-link-derived"; assertedActor: string;
  boundary: "local-trusted-client"; mode: "native";
  approvalRef: { provider: string; kind: string; externalId: string; digest: `sha256:${string}` };
};
export type ApprovalInput = {
  boardId: string; taskId: string; gateId: string; attemptId: string; reviewerActor: string;
  decision: ApprovalDecision; notes?: unknown; provenance: ApprovalProvenance;
  expectedTaskRevision: number; idempotencyKey: string; nowMs?: number;
};
export type ApprovalRecord = {
  approvalId: string; boardId: string; taskId: string; gateId: string; attemptId: string;
  actor: string; decision: ApprovalDecision; notes: unknown; decidedAt: number; revision: number;
  provenance: ApprovalProvenance; replayed?: boolean;
};
export type ApprovalQuery = { boardId: string; actor: string; taskId?: string; gateId?: string; attemptId?: string; nowMs?: number };

export class ApprovalDomainError extends Error {
  readonly error: AntiOracleError; readonly envelope: { ok: false; error: AntiOracleError };
  constructor(code: string) { const error = antiOracleError(code); super(error.message); this.name = "ApprovalDomainError"; this.error = error; this.envelope = { ok: false, error }; }
}

const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const digest = (v: string): v is `sha256:${string}` => /^sha256:[0-9a-f]{64}$/.test(v);
const id = (value: string): string => `approval-${createHash("sha256").update(value).digest("hex")}`;

function validate(i: ApprovalInput): void {
  if (!i || !text(i.boardId) || !text(i.taskId) || !text(i.gateId) || !text(i.attemptId) || !text(i.reviewerActor, 128) ||
    !["allow", "deny"].includes(i.decision) || !text(i.idempotencyKey) || !Number.isInteger(i.expectedTaskRevision) || i.expectedTaskRevision < 1 ||
    !i.provenance || i.provenance.kind !== "asserted" || i.provenance.assertedActor !== i.reviewerActor ||
    i.provenance.boundary !== "local-trusted-client" || i.provenance.mode !== "native" ||
    !text(i.provenance.approvalRef?.provider) || !text(i.provenance.approvalRef?.kind) || !text(i.provenance.approvalRef?.externalId) ||
    !digest(i.provenance.approvalRef?.digest)) throw new ApprovalDomainError("REQUEST_INVALID");
  try { canonicalJson(i.notes ?? []); } catch { throw new ApprovalDomainError("REQUEST_INVALID"); }
}

function row(value: any): ApprovalRecord {
  return { approvalId: value.approval_id, boardId: value.board_id, taskId: value.task_id, gateId: value.gate_id,
    attemptId: value.attempt_id, actor: value.actor, decision: value.decision, notes: JSON.parse(value.notes_json),
    decidedAt: value.decided_at, revision: value.revision, provenance: { kind: "asserted", assertedActor: value.provenance_asserted_actor,
      boundary: value.provenance_boundary, mode: value.provenance_mode, approvalRef: { provider: value.provenance_ref_provider,
        kind: value.provenance_ref_kind, externalId: value.provenance_ref_external_id, digest: value.provenance_ref_digest } } };
}

export function recordApproval(db: Database.Database, input: ApprovalInput): ApprovalRecord {
  validate(input);
  const now = input.nowMs ?? Date.now();
  if (!Number.isFinite(now)) throw new ApprovalDomainError("REQUEST_INVALID");
  const request = canonicalJson(input);
  const approvalId = id(request);
  try {
    return executeMutation(db, { actor: input.reviewerActor, tool: "approvals.record", idempotencyKey: input.idempotencyKey, request: input, work: () => {
      const task = db.prepare("SELECT revision FROM fs_tasks WHERE board_id=? AND id=?").get(input.boardId, input.taskId) as { revision: number } | undefined;
      const gate = db.prepare("SELECT allowed_actors_json FROM fs_gates WHERE board_id=? AND id=?").get(input.boardId, input.gateId) as { allowed_actors_json: string } | undefined;
      const attempt = db.prepare("SELECT actor, state, expires_at FROM fs_attempts WHERE id=? AND board_id=? AND task_id=?").get(input.attemptId, input.boardId, input.taskId) as { actor: string; state: string; expires_at: number } | undefined;
      if (!task || !gate || !attempt) throw new ApprovalDomainError("RESOURCE_NOT_AVAILABLE");
      if (task.revision !== input.expectedTaskRevision) throw new ApprovalDomainError("STALE_REVISION");
      if (attempt.state !== "active" || attempt.expires_at <= Math.floor(now / 1000)) throw new ApprovalDomainError("AUTHORITY_EXPIRED");
      let allowed: unknown;
      try { allowed = JSON.parse(gate.allowed_actors_json); } catch { allowed = null; }
      if (!Array.isArray(allowed) || allowed.length === 0 || !allowed.includes(input.reviewerActor)) throw new ApprovalDomainError("APPROVAL_FORBIDDEN");
      const next = (db.prepare("SELECT COALESCE(MAX(decision_no),0)+1 AS n FROM fs_gate_decisions WHERE board_id=? AND task_id=? AND gate_id=?").get(input.boardId, input.taskId, input.gateId) as { n: number }).n;
      const notesJson = canonicalJson(input.notes ?? []);
      const p = input.provenance;
      db.prepare(`INSERT INTO fs_approvals(approval_id,board_id,attempt_id,task_id,gate_id,actor,status,decision,decided_at,revision,notes_json,provenance_asserted_actor,provenance_boundary,provenance_mode,provenance_ref_provider,provenance_ref_kind,provenance_ref_external_id,provenance_ref_digest)
        VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(approvalId,input.boardId,input.attemptId,input.taskId,input.gateId,input.reviewerActor,input.decision,input.decision,now,input.expectedTaskRevision+1,notesJson,input.reviewerActor,p.boundary,p.mode,p.approvalRef.provider,p.approvalRef.kind,p.approvalRef.externalId,p.approvalRef.digest);
      db.prepare("INSERT INTO fs_gate_decisions(board_id,task_id,gate_id,decision_no,attempt_id,status,actor,decided_at) VALUES(?,?,?,?,?,?,?,?)").run(input.boardId,input.taskId,input.gateId,next,input.attemptId,input.decision,input.reviewerActor,now);
      if (db.prepare("UPDATE fs_tasks SET revision=revision+1, updated_at=? WHERE board_id=? AND id=? AND revision=?").run(now,input.boardId,input.taskId,input.expectedTaskRevision).changes !== 1) throw new ApprovalDomainError("STALE_REVISION");
      return row(db.prepare("SELECT * FROM fs_approvals WHERE approval_id=?").get(approvalId));
    }}).response;
  } catch (error) {
    if (error instanceof ApprovalDomainError) throw error;
    if (error instanceof Error && /unique|constraint|immutable/i.test(error.message)) throw new ApprovalDomainError("IDEMPOTENCY_CONFLICT");
    throw error;
  }
}

export function queryApprovals(db: Database.Database, input: ApprovalQuery): ApprovalRecord[] {
  if (!text(input.boardId) || !text(input.actor, 128) || [input.taskId, input.gateId, input.attemptId].some(v => v !== undefined && !text(v))) throw new ApprovalDomainError("REQUEST_INVALID");
  const args: unknown[] = [input.boardId]; const where = ["a.board_id=?"];
  if (input.taskId) { where.push("a.task_id=?"); args.push(input.taskId); }
  if (input.gateId) { where.push("a.gate_id=?"); args.push(input.gateId); }
  if (input.attemptId) { where.push("a.attempt_id=?"); args.push(input.attemptId); }
  const rows = db.prepare(`SELECT a.* FROM fs_approvals a WHERE ${where.join(" AND ")} ORDER BY a.decided_at,a.approval_id LIMIT 100`).all(...args) as any[];
  const readable = rows.filter(r => r.actor === input.actor || queryAuthority(db, { actor: input.actor, resource: { kind: "task", boardId: r.board_id, resourceId: r.task_id }, operation: "read_task", now: input.nowMs }).length > 0 || queryAuthority(db, { actor: input.actor, resource: { kind: "task", boardId: r.board_id, resourceId: r.task_id }, operation: "approve", now: input.nowMs }).length > 0);
  return readable.map(row);
}
