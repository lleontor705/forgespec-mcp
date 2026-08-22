import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { appendEvent, EventDomainError, queryEvents } from "../../src/domain/events.js";

let db: Database.Database;
afterEach(() => db?.close());
const open = () => { db = new Database(":memory:"); createFreshStore(db); createBoard(db, { id: "b", project: "p", name: "n", metadata: {}, actor: "owner", idempotencyKey: "board" }); return db; };
const event = (id: string, created_at: number, extra = {}) => ({ actor: "owner", event_id: id, task_id: "t", attempt_id: "a", tool: "test", event_type: "write", resource_type: "board" as const, resource_id: "b", board_id: "b", payload_json: { id }, created_at, ...extra });
const secret = { cursorSecret: "s".repeat(32) };

describe("domain events", () => {
  it("appends the canonical chain and evidence atomically", () => {
    const database = open();
    appendEvent(database, event("e1", 1, { evidence_refs: [{ evidence_id: "ev", provider: "cortex", kind: "test", external_id: "x", digest: `sha256:${"a".repeat(64)}` }] }));
    appendEvent(database, event("e2", 2));
    expect(database.prepare("SELECT event_ordinal,prev_hash FROM fs_audit_events ORDER BY event_ordinal").all()).toHaveLength(2);
    expect(database.prepare("SELECT count(*) n FROM fs_evidence").get()).toEqual({ n: 1 });
    expect(() => appendEvent(database, event("e3", 3, { payload_json: { token: "secret" } }))).toThrow();
  });
  it("rolls back an event when an evidence reference fails", () => {
    const database = open();
    expect(() => appendEvent(database, event("e1", 1, { evidence_refs: [{ evidence_id: "x", provider: "p", kind: "k", external_id: "x", digest: "bad" }] }))).toThrow();
    expect(database.prepare("SELECT count(*) n FROM fs_audit_events").get()).toEqual({ n: 0 });
  });
  it("paginates a stable snapshot and rejects cursor tampering or actor changes", () => {
    const database = open(); appendEvent(database, event("e1", 1)); appendEvent(database, event("e2", 2)); appendEvent(database, event("e3", 3));
     const first = queryEvents(database, { actor: "owner", board_id: "b", limit: 2 }, secret); expect(first.items).toHaveLength(2); appendEvent(database, event("e4", 4));
     const second = queryEvents(database, { actor: "owner", board_id: "b", limit: 2, cursor: first.next_cursor! }, secret);
    expect(second.items.map((x) => x.event_id)).toEqual(["e3"]); expect(second.total_count).toBe(3);
     expect(() => queryEvents(database, { actor: "mallory", board_id: "b" }, secret)).toThrow(EventDomainError);
     expect(() => queryEvents(database, { actor: "owner", board_id: "b", cursor: first.next_cursor!.slice(0, -1) + "A" }, secret)).toThrow(/CURSOR_INVALID/);
    expect(() => queryEvents(database, { actor: "owner", board_id: "b", limit: 201 }, secret)).toThrow();
  });
  it("supports key ring rotation for cursor validation across secrets", () => {
    const database = open();
    appendEvent(database, event("e1", 1));
    appendEvent(database, event("e2", 2));
    appendEvent(database, event("e3", 3));

    const oldSecret = "old-secret-key-that-is-at-least-32-chars-long";
    const newSecret = "new-secret-key-that-is-at-least-32-chars-long";

    // Generate cursor using the old secret
    const first = queryEvents(database, { actor: "owner", board_id: "b", limit: 2 }, { cursorSecret: oldSecret });
    expect(first.next_cursor).toBeTruthy();

    // Verify the cursor can be decoded when passing key ring with [newSecret, oldSecret]
    const keyRing = { cursorSecret: [newSecret, oldSecret] };
    const second = queryEvents(database, { actor: "owner", board_id: "b", limit: 2, cursor: first.next_cursor! }, keyRing);
    expect(second.items.map((x) => x.event_id)).toEqual(["e3"]);

    // Also verify comma-separated string format in keyRing
    const commaKeyRing = { cursorSecret: `${newSecret}, ${oldSecret}` };
    const secondComma = queryEvents(database, { actor: "owner", board_id: "b", limit: 2, cursor: first.next_cursor! }, commaKeyRing);
    expect(secondComma.items.map((x) => x.event_id)).toEqual(["e3"]);

    // Reject when secret is not in key ring
    const unrelatedSecret = { cursorSecret: "unrelated-secret-32-bytes-minimum-length" };
    expect(() => queryEvents(database, { actor: "owner", board_id: "b", limit: 2, cursor: first.next_cursor! }, unrelatedSecret)).toThrow(EventDomainError);
  });
});
