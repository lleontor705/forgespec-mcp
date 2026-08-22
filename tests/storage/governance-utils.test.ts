import { describe, expect, it } from "vitest";
import { normalizeActorSet } from "../../src/storage/actor-set.js";
import { assertAuditPayloadSafe, canonicalAuditEventDigest } from "../../src/storage/audit-integrity.js";
import { canonicalIdempotencyKeyHash, canonicalRequestDigest, validateIdempotencyKeyHash } from "../../src/storage/idempotency.js";
import Database from "better-sqlite3";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { insertAuditEvent } from "../../src/storage/audit-integrity.js";
import { insertIdempotencyRecord } from "../../src/storage/idempotency.js";

describe("governance utilities", () => {
  it("normalizes actor sets exactly once", () => {
    expect(normalizeActorSet('[" Reviewer ","reviewer","AGENT",3]')).toBe('["agent","reviewer"]');
    expect(normalizeActorSet("{}" )).toBeNull();
  });

  it("rejects secret payload keys recursively", () => {
    expect(() => assertAuditPayloadSafe({ nested: [{ API_KEY: "x" }] })).toThrow("root.nested[0].API_KEY");
    expect(() => assertAuditPayloadSafe({ safe: true })).not.toThrow();
  });

  it("hashes canonical audit and idempotency inputs", () => {
    const digest = canonicalAuditEventDigest({ board_id: "b", task_id: "t", attempt_id: "a", actor: "x", tool: "y", event_type: "e", resource_type: "r", resource_id: "i", event_ordinal: 1, prev_hash: null, payload_json: { b: 2, a: 1 } });
    expect(digest).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(canonicalRequestDigest({ b: 2, a: 1 })).toBe(canonicalRequestDigest({ a: 1, b: 2 }));
    const keyHash = canonicalIdempotencyKeyHash("key");
    expect(() => validateIdempotencyKeyHash("key", keyHash)).not.toThrow();
    expect(() => validateIdempotencyKeyHash("key", canonicalIdempotencyKeyHash("other"))).toThrow();
  });

  it("appends canonical audit events and safely replays idempotency records", () => {
    const db = new Database(":memory:"); createFreshStore(db);
    db.prepare("INSERT INTO fs_boards VALUES ('b','p','B',1,'{}',1,1)").run();
    db.prepare("INSERT INTO fs_tasks VALUES ('b','t','T','', 'p2','ready',NULL,'',1,NULL,'[]',1,1,0)").run();
    insertAuditEvent(db, { event_id: "e1", board_id: "b", task_id: "t", attempt_id: "a", actor: "x", tool: "y", event_type: "create", resource_type: "task", resource_id: "t", payload_json: { b: 2, a: 1 }, created_at: 1 });
    insertAuditEvent(db, { event_id: "e2", board_id: "b", task_id: "t", attempt_id: "a", actor: "x", tool: "y", event_type: "update", resource_type: "task", resource_id: "t", payload_json: {}, created_at: 2 });
    expect(db.prepare("SELECT event_ordinal, prev_hash, payload_json FROM fs_audit_events ORDER BY event_ordinal").all()).toHaveLength(2);
    const record = { actor: "x", tool: "y", scope: "task:t", idempotency_key: "secret-key", request: { a: 1 }, response_json: { ok: true }, result_code: "ok" as const, resulting_revision: 1, created_at: 1 };
    insertIdempotencyRecord(db, record); insertIdempotencyRecord(db, record);
    expect(db.prepare("SELECT COUNT(*) AS count FROM fs_idempotency").get()).toEqual({ count: 1 });
    expect(() => insertIdempotencyRecord(db, { ...record, request: { a: 2 } })).toThrow("conflict");
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name = 'fs_idempotency'").get().sql).not.toContain("idempotency_key");
    db.close();
  });
});
