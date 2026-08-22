import type Database from "better-sqlite3";
import { createHmac, timingSafeEqual } from "node:crypto";
import { canonicalJson } from "../core/canonical-json.js";
import { hasEffectiveAuthority } from "./authority/service.js";
import { insertAuditEvent, ensureCanonicalSha256 } from "../storage/audit-integrity.js";
import { withImmediate } from "../storage/database.js";

export type EventResource = "board" | "task" | "contract" | "authority" | "lease";
export type EvidenceRef = { evidence_id: string; provider: string; kind: string; external_id: string; digest: string; actor?: string; recorded_at?: number };
export type AppendEventInput = {
  actor: string; event_id: string; task_id: string; attempt_id: string; tool: string; event_type: string;
  resource_type: EventResource; resource_id: string; board_id: string; payload_json: unknown; created_at: number;
  evidence_refs?: EvidenceRef[];
};
export type EventQueryInput = {
  actor: string; board_id: string; resource_type?: EventResource; resource_id?: string;
  event_type?: string[]; limit?: number; cursor?: string;
};
export type EventQueryOptions = { cursorSecret: string | readonly string[] };
export type EventRow = AppendEventInput & { event_ordinal: number; prev_hash: string | null; event_hash: string; payload_json: unknown };
export class EventDomainError extends Error { constructor(readonly code: string) { super(code); this.name = "EventDomainError"; } }

const resources = new Set<EventResource>(["board", "task", "contract", "authority", "lease"]);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 256;
const safeResource = (db: Database.Database, input: { board_id: string; resource_type: EventResource; resource_id: string }): boolean => {
  const { board_id: b, resource_type: r, resource_id: id } = input;
  if (r === "board") return Boolean(db.prepare("SELECT 1 FROM fs_boards WHERE id=?").get(b) && id === b);
  if (r === "task") return Boolean(db.prepare("SELECT 1 FROM fs_tasks WHERE board_id=? AND id=?").get(b, id));
  if (r === "contract") return Boolean(db.prepare("SELECT 1 FROM fs_contracts WHERE board_id=? AND id=?").get(b, id));
  if (r === "authority") return Boolean(db.prepare("SELECT 1 FROM fs_authority WHERE board_id=? AND authority_id=?").get(b, id));
  return Boolean(db.prepare("SELECT 1 FROM fs_leases l JOIN fs_attempts a ON a.id=l.attempt_id WHERE a.board_id=? AND l.lease_id=?").get(b, id));
};
function authorize(db: Database.Database, input: EventQueryInput, now: number): void {
  if (!text(input.actor) || !text(input.board_id) || (input.resource_type !== undefined && !resources.has(input.resource_type)) || (input.resource_id !== undefined && !text(input.resource_id))) throw new EventDomainError("REQUEST_INVALID");
  if (input.resource_type === undefined && input.resource_id !== undefined) throw new EventDomainError("REQUEST_INVALID");
  const task = input.resource_type === "task";
  const allowed = hasEffectiveAuthority(db, { actor: input.actor, boardId: input.board_id, resourceKind: "board", resourceId: input.board_id, operation: "read_board", now }) ||
    (task && !!input.resource_id && hasEffectiveAuthority(db, { actor: input.actor, boardId: input.board_id, resourceKind: "task", resourceId: input.resource_id, operation: "read_task", now }));
  if (!allowed || !db.prepare("SELECT 1 FROM fs_boards WHERE id=?").get(input.board_id)) throw new EventDomainError("RESOURCE_NOT_AVAILABLE");
  if (input.resource_type && input.resource_id && !safeResource(db, { board_id: input.board_id, resource_type: input.resource_type, resource_id: input.resource_id })) throw new EventDomainError("RESOURCE_NOT_AVAILABLE");
}
function parseSecrets(secret: string | readonly string[]): { primary: Buffer; all: Buffer[] } {
  const rawList = Array.isArray(secret)
    ? secret
    : typeof secret === "string"
      ? secret.split(",").map((s) => s.trim()).filter((s) => s.length > 0)
      : [];
  if (!rawList.length) throw new EventDomainError("REQUEST_INVALID");
  const buffers: Buffer[] = [];
  for (const s of rawList) {
    if (typeof s !== "string" || Buffer.byteLength(s, "utf8") < 32) throw new EventDomainError("REQUEST_INVALID");
    buffers.push(Buffer.from(s, "utf8"));
  }
  return { primary: buffers[0], all: buffers };
}
function scopeSql(input: EventQueryInput): { sql: string; args: unknown[] } {
  if (input.resource_type && input.resource_id) return { sql: "e.board_id=? AND e.resource_type=? AND e.resource_id=?", args: [input.board_id, input.resource_type, input.resource_id] };
  const b = input.board_id;
  return { sql: `e.board_id=? AND ((e.resource_type='board' AND e.resource_id=?) OR (e.resource_type='task' AND EXISTS (SELECT 1 FROM fs_tasks t WHERE t.board_id=? AND t.id=e.resource_id)) OR (e.resource_type='contract' AND EXISTS (SELECT 1 FROM fs_contracts c WHERE c.board_id=? AND c.id=e.resource_id)) OR (e.resource_type='authority' AND EXISTS (SELECT 1 FROM fs_authority a WHERE a.board_id=? AND a.authority_id=e.resource_id)) OR (e.resource_type='lease' AND EXISTS (SELECT 1 FROM fs_leases l JOIN fs_attempts x ON x.id=l.attempt_id WHERE x.board_id=? AND l.lease_id=e.resource_id)) OR EXISTS (SELECT 1 FROM fs_tasks t WHERE t.board_id=? AND t.id=e.task_id))`, args: [b, b, b, b, b, b, b] };
}
function encode(value: unknown, secret: Buffer): string {
  const body = Buffer.from(canonicalJson(value), "utf8");
  const signature = createHmac("sha256", secret).update(body).digest("base64url");
  return `${body.toString("base64url")}.${signature}`;
}
function decode(value: string, secrets: Buffer[]): any {
  try {
    const [encoded, signature, ...extra] = value.split(".");
    if (!encoded || !signature || extra.length || !/^[A-Za-z0-9_-]+$/.test(encoded) || !/^[A-Za-z0-9_-]+$/.test(signature)) throw new Error();
    const body = Buffer.from(encoded, "base64url");
    const actual = Buffer.from(signature, "base64url");
    let matched = false;
    for (const secret of secrets) {
      const expected = createHmac("sha256", secret).update(body).digest();
      if (actual.length === expected.length && timingSafeEqual(actual, expected)) {
        matched = true;
        break;
      }
    }
    if (!matched) throw new Error();
    return JSON.parse(body.toString("utf8"));
  } catch { throw new EventDomainError("CURSOR_INVALID"); }
}

export function appendEvent(db: Database.Database, input: AppendEventInput): void {
  if (!text(input.actor) || !text(input.event_id) || !text(input.task_id) || !text(input.attempt_id) || !text(input.tool) || !text(input.event_type) || !text(input.board_id) || !text(input.resource_id) || !resources.has(input.resource_type) || !Number.isSafeInteger(input.created_at)) throw new EventDomainError("REQUEST_INVALID");
  withImmediate(db, () => {
    if (!safeResource(db, input)) throw new EventDomainError("RESOURCE_NOT_AVAILABLE");
    const resourceKind = input.resource_type === "task" ? "task" : "board";
    const resourceId = resourceKind === "task" ? input.resource_id : input.board_id;
    if (!hasEffectiveAuthority(db, { actor: input.actor, boardId: input.board_id, resourceKind, resourceId, operation: "update", now: Date.now() })) throw new EventDomainError("RESOURCE_NOT_AVAILABLE");
    insertAuditEvent(db, input);
    for (const ref of input.evidence_refs ?? []) {
      if (!text(ref.evidence_id) || !text(ref.provider) || !text(ref.kind) || !text(ref.external_id)) throw new EventDomainError("REQUEST_INVALID");
      db.prepare("INSERT INTO fs_evidence (evidence_id,resource_type,resource_id,provider,kind,external_id,digest,actor,recorded_at) VALUES (?,?,?,?,?,?,?,?,?)")
        .run(ref.evidence_id, input.resource_type, input.resource_id, ref.provider, ref.kind, ref.external_id, ensureCanonicalSha256(ref.digest), ref.actor ?? input.actor, ref.recorded_at ?? input.created_at);
    }
  });
}

export function queryEvents(db: Database.Database, input: EventQueryInput, options: EventQueryOptions): { items: EventRow[]; total_count: number; next_cursor: string | null } {
  const keyRing = parseSecrets(options?.cursorSecret);
  authorize(db, input, Date.now());
  const limit = input.limit ?? 20;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200 || (input.event_type && (!Array.isArray(input.event_type) || input.event_type.some((x) => !text(x))))) throw new EventDomainError("REQUEST_INVALID");
  const scope = scopeSql(input); const typeSql = input.event_type?.length ? ` AND e.event_type IN (${input.event_type.map(() => "?").join(",")})` : "";
  const typeArgs = input.event_type ?? []; const binding = { actor: input.actor, board_id: input.board_id, resource_type: input.resource_type ?? null, resource_id: input.resource_id ?? null, event_type: [...typeArgs].sort(), limit, order: "rowid_asc" };
  let snapshot = -1; let last = 0;
  if (input.cursor) { const c = decode(input.cursor, keyRing.all); if (c?.v !== 1 || c.kind !== "events" || canonicalJson(c.binding) !== canonicalJson(binding) || !Number.isSafeInteger(c.max_rowid) || !Number.isSafeInteger(c.last_rowid) || c.max_rowid < 0 || c.last_rowid < 0) throw new EventDomainError("CURSOR_INVALID"); snapshot = c.max_rowid; last = c.last_rowid; }
  else snapshot = ((db.prepare(`SELECT MAX(e.rowid) rowid FROM fs_audit_events e WHERE ${scope.sql}${typeSql}`).get(...scope.args, ...typeArgs) as any)?.rowid ?? -1);
  if (snapshot < 0) return { items: [], total_count: 0, next_cursor: null };
  const where = [`${scope.sql}`, typeSql.slice(5), "e.rowid <= ?", "e.rowid > ?"]; const args: unknown[] = [...scope.args, ...typeArgs, snapshot, last];
  const totalWhere = [`${scope.sql}`, `e.rowid <= ?`, typeSql.slice(5)];
  const totalArgs: unknown[] = [...scope.args, snapshot, ...typeArgs];
  const total_count = (db.prepare(`SELECT COUNT(*) n FROM fs_audit_events e WHERE ${totalWhere.filter(Boolean).join(" AND ")}`).get(...totalArgs) as { n: number }).n;
  const rows = db.prepare(`SELECT e.*, e.rowid AS __rowid FROM fs_audit_events e WHERE ${where.filter(Boolean).join(" AND ")} ORDER BY e.rowid LIMIT ?`).all(...args, limit + 1) as any[];
  const items = rows.slice(0, limit).map(({ __rowid: _rowid, ...r }) => ({ ...r, board_id: input.board_id, payload_json: JSON.parse(r.payload_json) })); const final = rows[limit - 1];
  return { items, total_count, next_cursor: rows.length > limit && final ? encode({ v: 1, kind: "events", binding, max_rowid: snapshot, last_rowid: final.__rowid }, keyRing.primary) : null };
}
