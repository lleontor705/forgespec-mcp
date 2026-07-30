import type Database from "better-sqlite3";
import { generateId } from "../utils/id.js";

export interface AuthorityEvent {
  event_id: string;
  resource_type: string;
  resource_id: string;
  resource_revision: number;
  event_type: string;
  actor: string;
  outcome: string;
  correlation_hash: string | null;
  details: Record<string, unknown>;
  created_at_ms: number;
  board_id?: string | null;
  attempt_id?: string | null;
}

export type AuthorityEventInput = Omit<AuthorityEvent, "event_id"> & { event_id?: string };

export interface TaskVersion {
  board_id: string;
  task_id: string;
  board_revision: number;
  task_revision: number;
  status: string;
  current_attempt_id?: string | null;
  blocked_reason?: string | null;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
  is_deleted?: boolean;
}

export function appendAuthorityEvent(
  database: Database.Database,
  event: AuthorityEventInput
): string {
  const eventId = event.event_id ?? generateId("event");
  database
    .prepare(
      `INSERT INTO authority_events
         (event_id, resource_type, resource_id, board_id, attempt_id, resource_revision, event_ordinal,
          event_type, actor, outcome, correlation_hash, details_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eventId,
      event.resource_type,
      event.resource_id,
      event.board_id ?? null,
      event.attempt_id ?? null,
      event.resource_revision,
      event.event_type,
      event.actor,
      event.outcome,
      event.correlation_hash,
      JSON.stringify(event.details),
      event.created_at_ms
    );
  return eventId;
}

/** Append the complete task snapshot while the caller's IMMEDIATE transaction is open. */
export function appendTaskVersion(database: Database.Database, version: TaskVersion): void {
  database
    .prepare(
      `INSERT INTO direct_task_versions
         (board_id, task_id, board_revision, task_revision, status, current_attempt_id,
          blocked_reason, metadata_json, created_at_ms, updated_at_ms, is_deleted)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      version.board_id,
      version.task_id,
      version.board_revision,
      version.task_revision,
      version.status,
      version.current_attempt_id ?? null,
      version.blocked_reason ?? null,
      version.metadata_json,
      version.created_at_ms,
      version.updated_at_ms,
      version.is_deleted ? 1 : 0
    );
}
