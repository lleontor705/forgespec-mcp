import type Database from "better-sqlite3";
import { generateId } from "../utils/id.js";

/**
 * Helper to auto-detect whether a board or task is a direct-v1 resource,
 * and seamlessly normalize input arguments so callers do not have to provide
 * repetitive protocol boilerplate (coordination_mode, api_version, schema_version, etc.).
 */

export interface NormalizedDirectTaskContext {
  isDirect: boolean;
  boardRevision?: number;
  taskRevision?: number;
  currentAttemptId?: string;
}

export function inspectBoardContext(db: Database.Database, boardId: string): { isDirect: boolean; revision?: number; ownerActor?: string } {
  const row = db.prepare("SELECT revision, metadata_json FROM direct_boards WHERE board_id = ?").get(boardId) as
    | { revision: number; metadata_json: string }
    | undefined;
  if (row) {
    let ownerActor: string | undefined;
    try {
      const meta = JSON.parse(row.metadata_json);
      ownerActor = meta.owner_actor;
    } catch {}
    return { isDirect: true, revision: row.revision, ownerActor };
  }
  return { isDirect: false };
}

export function inspectTaskContext(
  db: Database.Database,
  taskId: string
): { isDirect: boolean; revision?: number; boardId?: string; boardRevision?: number; currentAttemptId?: string; ownerActor?: string; attemptActor?: string } {
  const row = db.prepare(
    `SELECT t.revision, t.board_id, t.current_attempt_id, b.revision AS board_revision, b.metadata_json AS board_metadata_json,
            a.actor AS attempt_actor
       FROM direct_tasks t
       JOIN direct_boards b ON t.board_id = b.board_id
  LEFT JOIN task_attempts a ON t.current_attempt_id = a.id
      WHERE t.task_id = ?`
  ).get(taskId) as
    | { revision: number; board_id: string; current_attempt_id: string | null; board_revision: number; board_metadata_json: string; attempt_actor: string | null }
    | undefined;

  if (row) {
    let ownerActor: string | undefined;
    try {
      const meta = JSON.parse(row.board_metadata_json);
      ownerActor = meta.owner_actor;
    } catch {}
    return {
      isDirect: true,
      revision: row.revision,
      boardId: row.board_id,
      boardRevision: row.board_revision,
      currentAttemptId: row.current_attempt_id ?? undefined,
      ownerActor,
      attemptActor: row.attempt_actor ?? undefined,
    };
  }
  return { isDirect: false };
}

/**
 * Resolves an actor identity from either actor or agent field, defaulting to fallback.
 */
export function resolveActor(actor?: string, agent?: string, fallback = "default-agent"): string {
  return actor || agent || fallback;
}

/**
 * Ensures an idempotency key exists, generating a unique one if missing.
 */
export function resolveIdempotencyKey(key?: string): string {
  return key || generateId("idem");
}
