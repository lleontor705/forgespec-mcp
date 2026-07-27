import type Database from "better-sqlite3";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { TASK_STATUSES, type TaskStatus } from "../types/index.js";

export interface TaskQueryInput {
  board_id: string;
  actor: string;
  status?: TaskStatus[];
  ready?: boolean;
  work_unit?: string;
  task_ids?: string[];
  updated_after_revision?: number;
  limit?: number;
  cursor?: string;
}

export interface EventQueryInput {
  board_id: string;
  actor: string;
  task_id?: string;
  since_revision?: number;
  event_type?: string[];
  limit?: number;
  cursor?: string;
}

export interface TaskSummary {
  task_id: string;
  board_id: string;
  title: string;
  status: TaskStatus;
  priority: string;
  revision: number;
  work_unit: string | null;
  ready: boolean;
  current_attempt: null | {
    attempt_id: string;
    attempt_no: number;
    actor: string;
    state: string;
    lease_expires_at: string;
  };
}

export interface EventSummary {
  event_id: string;
  resource_type: string;
  resource_id: string;
  board_id: string;
  board_revision: number;
  resource_revision: number;
  event_ordinal: number;
  event_type: string;
  actor: string;
  attempt_id: string | null;
  outcome: string;
  details: Record<string, unknown>;
  created_at: string;
}

export interface Page<T> {
  items: T[];
  next_cursor: string | null;
  snapshot_revision: number;
}

interface CursorPayload {
  v: 1;
  kind: "tasks" | "events";
  filter: string;
  snapshot: number;
  last: string;
}

interface TaskRow {
  task_id: string;
  board_id: string;
  revision: number;
  status: TaskStatus;
  current_attempt_id: string | null;
  metadata_json: string;
  created_at_ms: number;
}

interface EventRow {
  event_id: string;
  resource_type: string;
  resource_id: string;
  board_id: string;
  board_revision: number;
  resource_revision: number;
  event_ordinal: number;
  event_type: string;
  actor: string;
  attempt_id: string | null;
  outcome: string;
  details_json: string;
  created_at_ms: number;
}

export class QueryError extends Error {
  constructor(
    message: string,
    readonly category: "validation" | "authorization" | "cursor",
    readonly code: string,
    readonly restartQuery = false
  ) {
    super(message);
    this.name = "QueryError";
  }
}

export class QueryService {
  private readonly cursorSecret: Buffer;

  constructor(
    private readonly database: Database.Database,
    options: { cursorSecret: Buffer }
  ) {
    if (options.cursorSecret.length < 32) throw new Error("Cursor secret must contain at least 32 bytes");
    this.cursorSecret = options.cursorSecret;
  }

  queryTasks(input: TaskQueryInput): Page<TaskSummary> {
    const boardRevision = this.authorize(input.board_id, input.actor);
    const limit = this.limit(input.limit, 200);
    if (input.task_ids && input.task_ids.length > 100) {
      throw new QueryError("At most 100 task IDs may be queried", "validation", "batch_limit");
    }
    const filter = this.filterHash({
      board_id: input.board_id,
      status: input.status ? [...input.status].sort() : undefined,
      ready: input.ready,
      work_unit: input.work_unit,
      task_ids: input.task_ids ? [...input.task_ids].sort() : undefined,
      updated_after_revision: input.updated_after_revision,
    });
    const cursor = input.cursor ? this.decodeCursor(input.cursor, "tasks", filter) : null;
    const snapshot = cursor?.snapshot ?? boardRevision;
    if (snapshot > boardRevision) throw new QueryError("Cursor snapshot is unavailable", "cursor", "cursor_restart", true);
    const last = cursor?.last ?? "";

    const clauses = [
      "t.board_id = ?",
      "t.task_id > ?",
      `EXISTS (
         SELECT 1 FROM authority_events e
         WHERE e.board_id = t.board_id AND e.resource_id = t.task_id
           AND e.event_type = 'task_created' AND e.board_revision <= ?
       )`,
    ];
    const parameters: unknown[] = [input.board_id, last, snapshot];
    if (input.status?.length) {
      clauses.push(`t.status IN (${input.status.map(() => "?").join(",")})`);
      parameters.push(...input.status);
    }
    if (input.ready !== undefined) {
      clauses.push(input.ready ? "t.status = 'ready' AND t.current_attempt_id IS NULL" : "NOT (t.status = 'ready' AND t.current_attempt_id IS NULL)");
    }
    if (input.work_unit !== undefined) {
      clauses.push("json_extract(t.metadata_json, '$.work_unit') = ?");
      parameters.push(input.work_unit);
    }
    if (input.task_ids?.length) {
      clauses.push(`t.task_id IN (${input.task_ids.map(() => "?").join(",")})`);
      parameters.push(...input.task_ids);
    }
    if (input.updated_after_revision !== undefined) {
      clauses.push("t.revision > ?");
      parameters.push(input.updated_after_revision);
    }
    parameters.push(limit + 1);
    const rows = this.database.prepare(
      `SELECT t.* FROM direct_tasks t
       WHERE ${clauses.join(" AND ")}
       ORDER BY t.task_id LIMIT ?`
    ).all(...parameters) as TaskRow[];
    const pageItems = rows.slice(0, limit).map((row) => this.taskSummary(row));
    const hasMore = rows.length > limit;
    return {
      items: pageItems,
      next_cursor: hasMore
        ? this.encodeCursor({ v: 1, kind: "tasks", filter, snapshot, last: pageItems.at(-1)!.task_id })
        : null,
      snapshot_revision: snapshot,
    };
  }

  batchStatus(input: TaskQueryInput): Page<TaskSummary> & { board_revision: number; counts: Record<TaskStatus, number> } {
    const page = this.queryTasks(input);
    const counts = Object.fromEntries(TASK_STATUSES.map((status) => [status, 0])) as Record<TaskStatus, number>;
    page.items.forEach((item) => { counts[item.status] += 1; });
    return { ...page, board_revision: this.authorize(input.board_id, input.actor), counts };
  }

  queryEvents(input: EventQueryInput): Page<EventSummary> {
    const boardRevision = this.authorize(input.board_id, input.actor);
    const limit = this.limit(input.limit, 200);
    const filter = this.filterHash({
      board_id: input.board_id,
      task_id: input.task_id,
      since_revision: input.since_revision,
      event_type: input.event_type ? [...input.event_type].sort() : undefined,
    });
    const cursor = input.cursor ? this.decodeCursor(input.cursor, "events", filter) : null;
    const snapshot = cursor?.snapshot ?? boardRevision;
    if (snapshot > boardRevision) throw new QueryError("Cursor snapshot is unavailable", "cursor", "cursor_restart", true);
    const [lastRevision, lastOrdinal, lastId] = cursor
      ? this.parseEventPosition(cursor.last)
      : input.since_revision === undefined
        ? [0, -1, ""]
        : [input.since_revision, Number.MAX_SAFE_INTEGER, ""];
    const clauses = [
      "board_id = ?",
      "board_revision <= ?",
      `(board_revision > ? OR (board_revision = ? AND event_ordinal > ?)
       OR (board_revision = ? AND event_ordinal = ? AND event_id > ?))`,
    ];
    const parameters: unknown[] = [
      input.board_id, snapshot,
      lastRevision, lastRevision, lastOrdinal,
      lastRevision, lastOrdinal, lastId,
    ];
    if (input.task_id) {
      clauses.push("resource_id = ?");
      parameters.push(input.task_id);
    }
    if (input.event_type?.length) {
      clauses.push(`event_type IN (${input.event_type.map(() => "?").join(",")})`);
      parameters.push(...input.event_type);
    }
    parameters.push(limit + 1);
    const rows = this.database.prepare(
      `SELECT * FROM authority_events
       WHERE ${clauses.join(" AND ")}
       ORDER BY board_revision, event_ordinal, event_id LIMIT ?`
    ).all(...parameters) as EventRow[];
    const pageItems = rows.slice(0, limit).map((row) => this.eventSummary(row));
    const hasMore = rows.length > limit;
    const final = pageItems.at(-1);
    return {
      items: pageItems,
      next_cursor: hasMore && final
        ? this.encodeCursor({
            v: 1,
            kind: "events",
            filter,
            snapshot,
            last: `${final.board_revision}:${final.event_ordinal}:${final.event_id}`,
          })
        : null,
      snapshot_revision: snapshot,
    };
  }

  private authorize(boardId: string, actor: string): number {
    const row = this.database.prepare(
      "SELECT revision, metadata_json FROM direct_boards WHERE board_id = ?"
    ).get(boardId) as { revision: number; metadata_json: string } | undefined;
    const owner = row ? (JSON.parse(row.metadata_json) as { owner_actor?: string }).owner_actor : undefined;
    if (!row || !actor || actor !== owner) {
      throw new QueryError("Query authority is invalid", "authorization", "query_not_authorized");
    }
    return row.revision;
  }

  private taskSummary(row: TaskRow): TaskSummary {
    const metadata = JSON.parse(row.metadata_json) as {
      title: string;
      priority: string;
      work_unit?: string | null;
    };
    const attempt = row.current_attempt_id
      ? this.database.prepare(
          `SELECT id, attempt_no, actor, state, expires_at_ms FROM task_attempts WHERE id = ?`
        ).get(row.current_attempt_id) as {
          id: string; attempt_no: number; actor: string; state: string; expires_at_ms: number;
        } | undefined
      : undefined;
    return {
      task_id: row.task_id,
      board_id: row.board_id,
      title: metadata.title,
      status: row.status,
      priority: metadata.priority,
      revision: row.revision,
      work_unit: metadata.work_unit ?? null,
      ready: row.status === "ready" && row.current_attempt_id === null,
      current_attempt: attempt ? {
        attempt_id: attempt.id,
        attempt_no: attempt.attempt_no,
        actor: attempt.actor,
        state: attempt.state,
        lease_expires_at: new Date(attempt.expires_at_ms).toISOString(),
      } : null,
    };
  }

  private eventSummary(row: EventRow): EventSummary {
    return {
      event_id: row.event_id,
      resource_type: row.resource_type,
      resource_id: row.resource_id,
      board_id: row.board_id,
      board_revision: row.board_revision,
      resource_revision: row.resource_revision,
      event_ordinal: row.event_ordinal,
      event_type: row.event_type,
      actor: row.actor,
      attempt_id: row.attempt_id,
      outcome: row.outcome,
      details: JSON.parse(row.details_json) as Record<string, unknown>,
      created_at: new Date(row.created_at_ms).toISOString(),
    };
  }

  private limit(value: number | undefined, maximum: number): number {
    const limit = value ?? 50;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > maximum) {
      throw new QueryError(`Query limit must be between 1 and ${maximum}`, "validation", "query_limit");
    }
    return limit;
  }

  private filterHash(value: Record<string, unknown>): string {
    const normalized = Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
    return createHash("sha256").update(JSON.stringify(normalized)).digest("hex");
  }

  private encodeCursor(payload: CursorPayload): string {
    const body = Buffer.from(JSON.stringify(payload)).toString("base64url");
    const signature = createHmac("sha256", this.cursorSecret).update(body).digest("base64url");
    return `${body}.${signature}`;
  }

  private decodeCursor(encoded: string, kind: CursorPayload["kind"], filter: string): CursorPayload {
    try {
      const [body, signature, extra] = encoded.split(".");
      if (!body || !signature || extra) throw new Error("shape");
      const expected = createHmac("sha256", this.cursorSecret).update(body).digest();
      const received = Buffer.from(signature, "base64url");
      if (received.length !== expected.length || !timingSafeEqual(received, expected)) throw new Error("signature");
      const payload = JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as CursorPayload;
      if (payload.v !== 1 || payload.kind !== kind || payload.filter !== filter ||
          !Number.isSafeInteger(payload.snapshot) || payload.snapshot < 1 || typeof payload.last !== "string") {
        throw new Error("payload");
      }
      return payload;
    } catch {
      throw new QueryError("Cursor is invalid for this query", "cursor", "cursor_invalid");
    }
  }

  private parseEventPosition(value: string): [number, number, string] {
    const match = /^(\d+):(\d+):(.+)$/.exec(value);
    if (!match) throw new QueryError("Cursor position is invalid", "cursor", "cursor_invalid");
    return [Number(match[1]), Number(match[2]), match[3]];
  }
}
