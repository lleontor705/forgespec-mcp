import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { executeMutation, TransactionDomainError } from "../../src/domain/transaction.js";

let db: Database.Database;
afterEach(() => db?.close());
function open(): Database.Database {
  db = new Database(":memory:");
  createFreshStore(db);
  return db;
}
const call = (database: Database.Database, key = "k", request = { value: 1 }, work = () => ({ value: 2 })) =>
  executeMutation(database, { actor: "actor", tool: "tool", idempotencyKey: key, request, work });

describe("executeMutation", () => {
  it("commits once and replays the canonical response", () => {
    const database = open(); let calls = 0;
    const first = call(database, "secret", undefined, () => { calls++; return { b: 2, a: 1 }; });
    const second = call(database, "secret", undefined, () => { calls++; return { nope: true }; });
    expect(first).toEqual({ response: { a: 1, b: 2 }, replayed: false });
    expect(second).toEqual({ response: { a: 1, b: 2 }, replayed: true });
    expect(calls).toBe(1);
    expect(database.prepare("SELECT key_hash, response_json FROM fs_idempotency").get()).toMatchObject({ response_json: '{"a":1,"b":2}' });
    expect(database.prepare("SELECT 1 FROM fs_idempotency WHERE response_json LIKE '%secret%'").get()).toBeUndefined();
  });

  it("returns one-time secrets without persisting or replaying them", () => {
    const database = open(); let calls = 0;
    const options = {
      actor: "actor", tool: "claims", idempotencyKey: "one-time", request: { value: 1 },
      work: () => { calls++; return { id: "claim-1", secret: "synthetic-secret" }; },
      toPersisted: (response: { id: string; secret: string }) => ({ id: response.id }),
      fromPersisted: (stored: { id: string }) => ({ id: stored.id, secret: null }),
    };
    const first = executeMutation(database, options);
    const replay = executeMutation(database, { ...options, work: () => { calls++; return { id: "wrong", secret: "wrong" }; } });
    expect(first).toEqual({ response: { id: "claim-1", secret: "synthetic-secret" }, replayed: false });
    expect(replay).toEqual({ response: { id: "claim-1", secret: null }, replayed: true });
    expect(calls).toBe(1);
    expect(database.prepare("SELECT response_json FROM fs_idempotency").pluck().get()).toBe('{"id":"claim-1"}');
  });

  it("rolls back both mutation and idempotency record", () => {
    const database = open();
    expect(() => call(database, "rollback", undefined, (d) => { d.exec("CREATE TABLE transient (id INTEGER)"); throw new Error("boom"); })).toThrow("boom");
    expect(database.prepare("SELECT name FROM sqlite_master WHERE name = 'transient'").get()).toBeUndefined();
    expect(database.prepare("SELECT count(*) AS count FROM fs_idempotency").get()).toEqual({ count: 0 });
  });

  it("rejects conflicts but permits different keys for the same request", () => {
    const database = open();
    call(database, "one");
    expect(() => call(database, "one", { value: 9 })).toThrow(TransactionDomainError);
    expect(() => call(database, "two")).not.toThrow();
    expect(database.prepare("SELECT count(*) AS count FROM fs_idempotency").get()).toEqual({ count: 2 });
  });

  it("validates bounded inputs and runs sequential retries safely", () => {
    const database = open();
    for (const field of ["actor", "tool", "idempotencyKey"] as const) {
      const input = { actor: "actor", tool: "tool", idempotencyKey: "key", request: {}, work: () => ({}) };
      input[field] = " ";
      expect(() => executeMutation(database, input)).toThrow(TransactionDomainError);
    }
    expect(() => executeMutation(database, { actor: "a", tool: "t", idempotencyKey: "k", request: {}, work: () => "x".repeat(70000) })).toThrow(TransactionDomainError);
    let calls = 0;
    call(database, "safe", {}, () => { calls++; return { ok: true }; });
    call(database, "safe", {}, () => { calls++; return { ok: false }; });
    expect(calls).toBe(1);
  });

  it("limits idempotency keys by UTF-8 bytes", () => {
    const database = open();
    expect(() => call(database, "😀".repeat(128))).toThrow(TransactionDomainError);
    try { call(database, "😀".repeat(128)); } catch (error) { expect((error as TransactionDomainError).error.code).toBe("REQUEST_INVALID"); }
    expect(() => call(database, "😀".repeat(64))).not.toThrow();
  });
});
