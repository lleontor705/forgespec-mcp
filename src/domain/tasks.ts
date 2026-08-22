import type Database from "better-sqlite3";
import { canonicalJson } from "../core/canonical-json.js";
import { antiOracleError, type AntiOracleError } from "../protocol/errors.js";
import { executeMutation, TransactionDomainError } from "./transaction.js";
import { withImmediate } from "../storage/database.js";
import { createHash } from "node:crypto";
import { createTaskAuthorityRows, hasEffectiveAuthority } from "./authority/service.js";

const statuses = ["backlog", "ready", "in_progress", "in_review", "blocked", "done"] as const;
type Status = typeof statuses[number];
export interface TaskInput { boardId: string; title: string; description?: string; priority: "p0"|"p1"|"p2"|"p3"; specRef?: string; acceptanceCriteria?: string; dependencies?: string[]; actor: string; idempotencyKey: string; expectedBoardRevision: number; id?: string }
export interface TaskRecord { boardId: string; id: string; title: string; description: string; priority: TaskInput["priority"]; status: Status; specRef: string|null; acceptanceCriteria: string; revision: number; createdAt: number; updatedAt: number; dependencies: string[] }
export interface QueryTasksInput { boardId: string; actor: string; limit: number; statuses?: Status[]; taskIds?: string[] }
export class TaskDomainError extends Error {
  readonly error: AntiOracleError; readonly envelope: { ok: false; error: AntiOracleError };
  constructor(code: "REQUEST_INVALID"|"IDEMPOTENCY_CONFLICT"|"RESOURCE_NOT_AVAILABLE"|"STALE_REVISION"|"LIMIT_EXCEEDED") { const error = antiOracleError(code); super(error.message); this.name = "TaskDomainError"; this.error = error; this.envelope = { ok: false, error }; }
}
const text = (v: unknown, max = 128): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;
const optionalText = (v: unknown, max = 64 * 1024): v is string => v === undefined || (typeof v === "string" && v.length <= max);
function validate(input: TaskInput): void {
  if (!input || typeof input !== "object" || !text(input.boardId) || !text(input.title) || !text(input.actor) || !text(input.idempotencyKey) ||
    !["p0", "p1", "p2", "p3"].includes(input.priority) || !Number.isInteger(input.expectedBoardRevision) || input.expectedBoardRevision < 1 ||
    !optionalText(input.description) || !optionalText(input.specRef, 128) || !optionalText(input.acceptanceCriteria) || (input.id !== undefined && !text(input.id))) throw new TaskDomainError("REQUEST_INVALID");
  if (input.dependencies !== undefined && (!Array.isArray(input.dependencies) || input.dependencies.some((d) => !text(d)))) throw new TaskDomainError("REQUEST_INVALID");
}
function generatedTaskId(actor: string, idempotencyKey: string): string {
  return `task-${createHash("sha256").update(`${actor}\0${idempotencyKey}`).digest("hex")}`;
}
function record(row: any, dependencies: string[] = []): TaskRecord { return { boardId: row.board_id, id: row.id, title: row.title, description: row.description, priority: row.priority, status: row.status, specRef: row.spec_ref, acceptanceCriteria: row.acceptance_criteria, revision: row.revision, createdAt: row.created_at, updatedAt: row.updated_at, dependencies }; }

export function defineTask(database: Database.Database, input: TaskInput): TaskRecord {
  validate(input);
  const dependencies = [...new Set(input.dependencies ?? [])].sort();
  if (dependencies.length > 100) throw new TaskDomainError("LIMIT_EXCEEDED");
  const id = input.id ?? generatedTaskId(input.actor, input.idempotencyKey);
  const request = { boardId: input.boardId, title: input.title, description: input.description ?? "", priority: input.priority, specRef: input.specRef ?? null, acceptanceCriteria: input.acceptanceCriteria ?? "", dependencies, expectedBoardRevision: input.expectedBoardRevision, ...(input.id === undefined ? {} : { id }) };
  try {
    return executeMutation(database, { actor: input.actor, tool: "tasks.define", idempotencyKey: input.idempotencyKey,
      request,
      work: (db) => {
         const board = db.prepare("SELECT revision FROM fs_boards WHERE id = ?").get(input.boardId) as { revision: number } | undefined;
         if (!board) throw new TaskDomainError("RESOURCE_NOT_AVAILABLE");
         if (!hasEffectiveAuthority(db, { actor: input.actor, boardId: input.boardId, resourceKind: "board", resourceId: input.boardId, operation: "add", now: Date.now() })) throw new TaskDomainError("RESOURCE_NOT_AVAILABLE");
        if (board.revision !== input.expectedBoardRevision) throw new TaskDomainError("STALE_REVISION");
        if (dependencies.some((d) => d === id || !(db.prepare("SELECT 1 FROM fs_tasks WHERE board_id = ? AND id = ?").get(input.boardId, d)))) throw new TaskDomainError("REQUEST_INVALID");
        const status = dependencies.length === 0 || dependencies.every((d) => (db.prepare("SELECT status FROM fs_tasks WHERE board_id = ? AND id = ?").get(input.boardId, d) as { status: string }).status === "done") ? "ready" : "backlog";
        const now = Date.now();
        db.prepare("INSERT INTO fs_tasks (board_id,id,title,description,priority,status,spec_ref,acceptance_criteria,revision,created_at,updated_at) VALUES (?,?,?,?,?,?,?, ?,1,?,?)")
          .run(input.boardId, id, input.title, input.description ?? "", input.priority, status, input.specRef ?? null, input.acceptanceCriteria ?? "", now, now);
        const insert = db.prepare("INSERT INTO fs_task_dependencies (task_board_id,task_id,dependency_board_id,dependency_task_id) VALUES (?,?,?,?)");
         dependencies.forEach((d) => insert.run(input.boardId, id, input.boardId, d));
         const authorityExpiry = (db.prepare("SELECT MIN(expires_at) AS expires_at FROM fs_authority WHERE board_id = ? AND resource_kind = 'board' AND grantee_actor = ? AND status = 'active'").get(input.boardId, input.actor) as { expires_at: number }).expires_at;
         createTaskAuthorityRows(db, { boardId: input.boardId, taskId: id, actor: input.actor, expiresAt: authorityExpiry, now });
        if (db.prepare("UPDATE fs_boards SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(now, input.boardId, input.expectedBoardRevision).changes !== 1) throw new TaskDomainError("STALE_REVISION");
        return record({ board_id: input.boardId, id, title: input.title, description: input.description ?? "", priority: input.priority, status, spec_ref: input.specRef ?? null, acceptance_criteria: input.acceptanceCriteria ?? "", revision: 1, created_at: now, updated_at: now }, dependencies);
      } }).response;
  } catch (error) {
    if (error instanceof TaskDomainError) throw error;
    if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new TaskDomainError("IDEMPOTENCY_CONFLICT");
    if (error instanceof Error && error.name === "SqliteError") throw new TaskDomainError("REQUEST_INVALID");
    throw error;
  }
}

export function queryTasks(database: Database.Database, input: QueryTasksInput): { total_count: number; records: TaskRecord[]; dependencies: Array<{ taskId: string; dependencyTaskId: string }> } {
  if (!input || typeof input !== "object" || Array.isArray(input) || !text(input.boardId) || !text(input.actor) || !Number.isInteger(input.limit) || input.limit < 1 || input.limit > 200 || (input.statuses !== undefined && (!Array.isArray(input.statuses) || input.statuses.some((s) => !statuses.includes(s)))) || (input.taskIds !== undefined && (!Array.isArray(input.taskIds) || input.taskIds.length > 100 || input.taskIds.some((id) => !text(id))))) throw new TaskDomainError(input && typeof input === "object" && "limit" in input && input.limit > 200 ? "LIMIT_EXCEEDED" : "REQUEST_INVALID");
  return withImmediate(database, () => {
    if (!database.prepare("SELECT 1 FROM fs_boards WHERE id = ?").get(input.boardId)) throw new TaskDomainError("RESOURCE_NOT_AVAILABLE");
     const clauses = ["board_id = ?"]; const args: unknown[] = [input.boardId];
    if (input.statuses?.length) { clauses.push(`status IN (${input.statuses.map(() => "?").join(",")})`); args.push(...input.statuses); }
    if (input.taskIds?.length) { clauses.push(`id IN (${input.taskIds.map(() => "?").join(",")})`); args.push(...input.taskIds); }
     const where = clauses.join(" AND "); const now = Date.now();
     const authorized = (database.prepare(`SELECT * FROM fs_tasks WHERE ${where} ORDER BY created_at ASC, id ASC`).all(...args) as any[])
       .filter((r) => hasEffectiveAuthority(database, { actor: input.actor, boardId: input.boardId, resourceKind: "board", resourceId: input.boardId, operation: "read_task", now }) ||
         hasEffectiveAuthority(database, { actor: input.actor, boardId: input.boardId, resourceKind: "task", resourceId: r.id, operation: "read_task", now }));
     const rows = authorized.slice(0, input.limit); const total_count = authorized.length;
    const pageIds = rows.map((r) => r.id);
    const deps = pageIds.length === 0 ? [] : database.prepare(`SELECT task_id, dependency_task_id FROM fs_task_dependencies WHERE task_board_id = ? AND task_id IN (${pageIds.map(() => "?").join(",")}) ORDER BY task_id, dependency_task_id`).all(input.boardId, ...pageIds) as any[];
    return { total_count, records: rows.map((r) => record(r, deps.filter((d) => d.task_id === r.id).map((d) => d.dependency_task_id))), dependencies: deps.map((d) => ({ taskId: d.task_id, dependencyTaskId: d.dependency_task_id })) };
  });
}
