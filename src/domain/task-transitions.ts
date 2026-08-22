import type Database from "better-sqlite3";
import { antiOracleError, type AntiOracleError } from "../protocol/errors.js";
import { verifyClaimToken } from "./authority/tokens.js";
import { executeMutation, TransactionDomainError } from "./transaction.js";

type Target = "in_review" | "blocked" | "recovery_pending" | "done" | "in_progress";
export interface TaskTransitionInput {
  boardId: string; taskId: string; target: Target; actor: string; attemptId: string;
  claimToken: string; expectedRevision: number; idempotencyKey: string; reason?: string;
}
export interface TaskTransitionResult { taskRevision: number; status: string; promotedTaskIds: string[]; }
export class TaskTransitionError extends Error {
  readonly error: AntiOracleError; readonly envelope: { ok: false; error: AntiOracleError };
  constructor(code: "REQUEST_INVALID" | "RESOURCE_NOT_AVAILABLE" | "STALE_REVISION" | "INVALID_TRANSITION" | "AUTHORITY_EXPIRED" | "IDEMPOTENCY_CONFLICT" | "TASK_BLOCKED" | "GATE_REQUIRED") {
    const error = antiOracleError(code); super(error.message); this.name = "TaskTransitionError";
    this.error = error; this.envelope = { ok: false, error };
  }
}
const text = (v: unknown, max = 256): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const targets: Target[] = ["in_review", "blocked", "recovery_pending", "done", "in_progress"];
function validate(i: TaskTransitionInput): void {
  if (!i || typeof i !== "object" || !text(i.boardId) || !text(i.taskId) || !text(i.actor, 128) ||
    !text(i.attemptId) || !text(i.claimToken) || !text(i.idempotencyKey) || !targets.includes(i.target) ||
    !Number.isInteger(i.expectedRevision) || i.expectedRevision < 1 || (i.reason !== undefined && !text(i.reason, 4096)))
    throw new TaskTransitionError("REQUEST_INVALID");
}
function gate(db: Database.Database, boardId: string, taskId: string, status: string): boolean {
  return !!db.prepare(`SELECT 1 FROM fs_gates g JOIN json_each(g.required_for_json) r ON lower(r.value)=?
    WHERE g.board_id=? AND NOT EXISTS (SELECT 1 FROM fs_gate_decisions d WHERE d.board_id=? AND d.task_id=? AND d.gate_id=g.id
      AND d.decision_no=(SELECT MAX(latest.decision_no) FROM fs_gate_decisions latest
        WHERE latest.board_id=d.board_id AND latest.task_id=d.task_id AND latest.gate_id=d.gate_id)
      AND d.status='allow')`)
    .get(status, boardId, boardId, taskId);
}
function depsDone(db: Database.Database, boardId: string, taskId: string): boolean {
  return !db.prepare(`SELECT 1 FROM fs_task_dependencies d JOIN fs_tasks t ON t.board_id=d.dependency_board_id AND t.id=d.dependency_task_id
    WHERE d.task_board_id=? AND d.task_id=? AND t.status<>'done'`).get(boardId, taskId);
}
function mapError(error: unknown): never {
  if (error instanceof TaskTransitionError) throw error;
  if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new TaskTransitionError("IDEMPOTENCY_CONFLICT");
  if (error instanceof Error && error.name === "SqliteError") {
    const message = error.message.toLowerCase();
    if (message.includes("gate") || message.includes("allow")) throw new TaskTransitionError("GATE_REQUIRED");
    if (message.includes("depend") || message.includes("blocked")) throw new TaskTransitionError("TASK_BLOCKED");
    throw new TaskTransitionError("INVALID_TRANSITION");
  }
  throw error;
}

export function transitionTask(database: Database.Database, input: TaskTransitionInput): TaskTransitionResult {
  validate(input);
  try {
    return executeMutation(database, { actor: input.actor, tool: "tasks.transition", idempotencyKey: input.idempotencyKey,
      request: input, work: (db) => {
        const task = db.prepare("SELECT status, revision FROM fs_tasks WHERE board_id=? AND id=?").get(input.boardId, input.taskId) as { status: string; revision: number } | undefined;
        if (!task) throw new TaskTransitionError("RESOURCE_NOT_AVAILABLE");
        if (task.revision !== input.expectedRevision) throw new TaskTransitionError("STALE_REVISION");
        const allowed: Record<string, string[]> = { in_progress: ["in_review", "blocked", "recovery_pending"], in_review: ["done", "in_progress", "blocked"] };
        if (!allowed[task.status]?.includes(input.target)) throw new TaskTransitionError("INVALID_TRANSITION");
        const attempt = db.prepare("SELECT actor, token_hash, state, expires_at FROM fs_attempts WHERE id=? AND board_id=? AND task_id=?").get(input.attemptId, input.boardId, input.taskId) as { actor: string; token_hash: string; state: string; expires_at: number } | undefined;
        if (!attempt || attempt.actor !== input.actor || attempt.state !== "active" || attempt.expires_at <= Math.floor(Date.now() / 1000) || !verifyClaimToken(input.claimToken, attempt.token_hash)) throw new TaskTransitionError("AUTHORITY_EXPIRED");
        if (input.target !== "blocked" && input.target !== "recovery_pending" && !depsDone(db, input.boardId, input.taskId)) throw new TaskTransitionError("TASK_BLOCKED");
        if (input.target !== "blocked" && input.target !== "recovery_pending" && gate(db, input.boardId, input.taskId, input.target)) throw new TaskTransitionError("GATE_REQUIRED");
        const now = Date.now(); const revision = input.expectedRevision + 1;
        const blocked = input.target === "blocked" || input.target === "recovery_pending";
        const storedStatus = input.target === "recovery_pending" ? "blocked" : input.target;
        if (db.prepare(`UPDATE fs_tasks SET status=?, blocked_reason=?, recovery_pending=?, revision=?, updated_at=? WHERE board_id=? AND id=? AND revision=?`)
          .run(storedStatus, blocked ? (input.reason ?? input.target) : null, input.target === "recovery_pending" ? 1 : 0, revision, now, input.boardId, input.taskId, input.expectedRevision).changes !== 1) throw new TaskTransitionError("STALE_REVISION");
        if (input.target === "done" || blocked) db.prepare("UPDATE fs_attempts SET state=?, closed_at=?, reason=? WHERE id=? AND state='active'").run(input.target === "done" ? "succeeded" : "failed", Math.floor(now / 1000), input.reason ?? input.target, input.attemptId);
        const promoted: string[] = [];
        if (input.target === "done") {
          const rows = db.prepare("SELECT id, revision FROM fs_tasks WHERE board_id=? AND status='backlog'").all(input.boardId) as { id: string; revision: number }[];
          for (const row of rows) if (depsDone(db, input.boardId, row.id) && !gate(db, input.boardId, row.id, "ready") && db.prepare("UPDATE fs_tasks SET status='ready', revision=revision+1, updated_at=? WHERE board_id=? AND id=? AND status='backlog' AND revision=?").run(now, input.boardId, row.id, row.revision).changes === 1) promoted.push(row.id);
        }
        return { taskRevision: revision, status: input.target, promotedTaskIds: promoted };
      } }).response;
  } catch (error) { return mapError(error); }
}
