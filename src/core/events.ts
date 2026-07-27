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
}

export function appendAuthorityEvent(
  database: Database.Database,
  event: Omit<AuthorityEvent, "event_id"> & { event_id?: string }
): string {
  const eventId = event.event_id ?? generateId("event");
  database
    .prepare(
      `INSERT INTO authority_events
         (event_id, resource_type, resource_id, resource_revision, event_ordinal,
          event_type, actor, outcome, correlation_hash, details_json, created_at_ms)
       VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      eventId,
      event.resource_type,
      event.resource_id,
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
