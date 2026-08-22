import { createHash } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.js";
import type Database from "better-sqlite3";

const FORBIDDEN_PAYLOAD_KEYS = ["secret", "token", "password", "api_key"] as const;

export interface AuditEventDigestInput {
  board_id: string;
  task_id: string; attempt_id: string; actor: string; tool: string; event_type: string;
  resource_type: string; resource_id: string; event_ordinal: number;
  prev_hash: string | null; payload_json: unknown;
}

export interface InsertAuditEventInput {
  event_id: string;
  board_id: string;
  task_id: string; attempt_id: string; actor: string; tool: string; event_type: string;
  resource_type: string; resource_id: string;
  payload_json: unknown;
  created_at: number;
  event_ordinal?: number;
  prev_hash?: string | null;
  event_hash?: string;
}

export function sha256(value: string): string {
  return `sha256:${createHash("sha256").update(value).digest("hex")}`;
}

export function ensureCanonicalSha256(value: string): string {
  if (!/^(sha256:)?[0-9a-f]{64}$/.test(value)) throw new Error("invalid sha256 digest format");
  return value.startsWith("sha256:") ? value : `sha256:${value}`;
}

export function canonicalHash(value: string): string {
  return ensureCanonicalSha256(sha256(value));
}

export function canonicalAuditEventDigest(input: AuditEventDigestInput): string {
  return canonicalHash(canonicalJson({
    board_id: input.board_id,
    task_id: input.task_id, attempt_id: input.attempt_id, actor: input.actor,
    tool: input.tool, event_type: input.event_type, resource_type: input.resource_type,
    resource_id: input.resource_id, event_ordinal: input.event_ordinal,
    prev_hash: input.prev_hash === null ? null : ensureCanonicalSha256(input.prev_hash),
    payload_json: input.payload_json,
  }));
}

function forbiddenKey(key: string): boolean {
  return FORBIDDEN_PAYLOAD_KEYS.includes(key.toLowerCase() as (typeof FORBIDDEN_PAYLOAD_KEYS)[number]);
}

export function findForbiddenPayloadKeyPath(payload: unknown, path = "root"): string | null {
  if (payload === null || payload === undefined) return null;
  if (Array.isArray(payload)) {
    for (let index = 0; index < payload.length; index += 1) {
      const found = findForbiddenPayloadKeyPath(payload[index], `${path}[${index}]`);
      if (found !== null) return found;
    }
    return null;
  }
  if (typeof payload === "object") {
    for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
      const nextPath = `${path}.${key}`;
      if (forbiddenKey(key)) return nextPath;
      const found = findForbiddenPayloadKeyPath(value, nextPath);
      if (found !== null) return found;
    }
  }
  return null;
}

export function assertAuditPayloadSafe(payload: unknown): void {
  const path = findForbiddenPayloadKeyPath(payload);
  if (path !== null) throw new Error(`forbidden payload key at ${path}`);
}

export const validateSecretPayload = assertAuditPayloadSafe;

/** Append an event using the same chain and digest rules enforced by runtime triggers. */
export function insertAuditEvent(database: Database.Database, input: InsertAuditEventInput): void {
  assertAuditPayloadSafe(input.payload_json);
  const payload = JSON.parse(canonicalJson(input.payload_json)) as unknown;
  const tail = database.prepare(
    `SELECT event_ordinal, event_hash FROM fs_audit_events
      WHERE board_id = ? AND resource_type = ? AND resource_id = ?
     ORDER BY event_ordinal DESC LIMIT 1`,
  ).get(input.board_id, input.resource_type, input.resource_id) as { event_ordinal: number; event_hash: string } | undefined;
  const eventOrdinal = tail ? tail.event_ordinal + 1 : 1;
  const prevHash = tail?.event_hash ?? null;
  if (input.event_ordinal !== undefined && input.event_ordinal !== eventOrdinal) {
    throw new Error("event_ordinal must append to the previous resource event");
  }
  if (input.prev_hash !== undefined && (input.prev_hash === null ? prevHash !== null : ensureCanonicalSha256(input.prev_hash) !== prevHash)) {
    throw new Error("audit event prev_hash mismatch for resource chain");
  }
  const eventHash = canonicalAuditEventDigest({ ...input, event_ordinal: eventOrdinal, prev_hash: prevHash, payload_json: payload });
  if (input.event_hash !== undefined && ensureCanonicalSha256(input.event_hash) !== eventHash) {
    throw new Error("event_hash does not match canonical audit payload");
  }
  database.prepare(
    `INSERT INTO fs_audit_events
      (event_id, board_id, task_id, attempt_id, actor, tool, event_type, resource_type, resource_id,
       event_ordinal, prev_hash, event_hash, payload_json, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.event_id, input.board_id, input.task_id, input.attempt_id, input.actor, input.tool, input.event_type,
    input.resource_type, input.resource_id, eventOrdinal, prevHash, eventHash, canonicalJson(payload), input.created_at);
}
