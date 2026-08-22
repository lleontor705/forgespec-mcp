import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { defineTask } from "../../src/domain/tasks.js";
import { claimAttempt } from "../../src/domain/attempts.js";
import { reserveLease, renewLease, releaseLease, LeaseDomainError } from "../../src/domain/leases/service.js";
let db: Database.Database;
afterEach(() => db?.close());
function open() { db = new Database(":memory:"); createFreshStore(db); createBoard(db, { id: "b", project: "p", name: "b", actor: "a", idempotencyKey: "b" }); defineTask(db, { id: "t", boardId: "b", title: "t", priority: "p1", actor: "a", idempotencyKey: "t", expectedBoardRevision: 1 }); const a = claimAttempt(db, { boardId: "b", taskId: "t", actor: "a", expectedTaskRevision: 1, leaseSeconds: 15, idempotencyKey: "a" }); return { ...a, actor: "a" }; }
function input(a: ReturnType<typeof open>, key = "l", paths = ["src/a.ts"]) { return { boardId: "b", taskId: "t", attemptId: a.attemptId, holder: "a", claimToken: a.claimToken!, paths, casePolicy: "sensitive" as const, leaseSeconds: 60, idempotencyKey: key }; }
describe("reserveLease", () => {
  it("normalizes, sorts, dedupes and returns a one-time token", () => { const a = open(); const paths = ["src/b.ts", "./src/a.ts", "src/b.ts"]; const r = reserveLease(db, input(a, "l", paths)); expect(r.scopes).toEqual(["src/a.ts", "src/b.ts"]); expect(r.leaseToken).toEqual(expect.any(String)); expect((db.prepare("SELECT token_hash FROM fs_leases").get() as any).token_hash).not.toContain(r.leaseToken); expect(reserveLease(db, input(a, "l", paths))).toEqual({ ...r, leaseToken: null }); });
  it("rejects overlap, case-insensitive overlap and traversal", () => { const a = open(); reserveLease(db, input(a)); expect(() => reserveLease(db, input(a, "x", ["src/a.ts"]))).toThrow(LeaseDomainError); expect(() => reserveLease(db, { ...input(a, "y", ["SRC/A.TS"]), casePolicy: "insensitive" })).toThrow(LeaseDomainError); expect(() => reserveLease(db, input(a, "z", ["../x"]))).toThrow(LeaseDomainError); });
  it("persists policy and rejects case variants in either policy order", () => {
    const a = open();
    const first = reserveLease(db, { ...input(a, "insensitive-first", ["SRC/A.TS"]), casePolicy: "insensitive" });
    expect((db.prepare("SELECT case_policy FROM fs_leases WHERE lease_id = ?").get(first.leaseId) as any).case_policy).toBe("insensitive");
    expect(() => reserveLease(db, input(a, "sensitive-second", ["src/a.ts"]))).toThrow(LeaseDomainError);
    db.close();
    const b = open();
    reserveLease(db, input(b, "sensitive-first", ["src/a.ts"]));
    expect(() => reserveLease(db, { ...input(b, "insensitive-second", ["SRC/A.TS"]), casePolicy: "insensitive" })).toThrow(LeaseDomainError);
  });
  it("checks authority, caps expiry, and rolls back scopes", () => { const a = open(); expect(() => reserveLease(db, { ...input(a), claimToken: "bad" })).toThrow(LeaseDomainError); const r = reserveLease(db, { ...input(a), idempotencyKey: "ok", leaseSeconds: 3600 }); expect(r.expiresAt).toBeLessThanOrEqual(a.expiresAt); expect((db.prepare("SELECT COUNT(*) n FROM fs_lease_scopes").get() as any).n).toBe(1); expect(() => reserveLease(db, { ...input(a, "bad2", ["x"]), leaseSeconds: 14 })).toThrow(); expect((db.prepare("SELECT COUNT(*) n FROM fs_leases").get() as any).n).toBe(1); });
});
describe("lease lifecycle", () => {
  it("renews with CAS, constant-time token validation, and attempt expiry cap", () => {
    const a = open(); const r = reserveLease(db, input(a));
    expect(renewLease(db, { leaseId: r.leaseId, holder: "a", leaseToken: r.leaseToken!, expectedRevision: 1, extendSeconds: 3600, idempotencyKey: "renew" })).toMatchObject({ leaseId: r.leaseId, revision: 2, state: "renewed", expiresAt: a.expiresAt });
    expect(() => renewLease(db, { leaseId: r.leaseId, holder: "a", leaseToken: r.leaseToken!, expectedRevision: 1, extendSeconds: 60, idempotencyKey: "renew2" })).toThrow();
    expect(() => renewLease(db, { leaseId: r.leaseId, holder: "a", leaseToken: "bad", expectedRevision: 2, extendSeconds: 60, idempotencyKey: "renew3" })).toThrow(LeaseDomainError);
  });
  it("releases an expired lease without deleting it and makes exact retries idempotent", () => {
    const a = open(); const r = reserveLease(db, input(a));
    const expiredAt = Math.floor(Date.now() / 1000) + 1;
    db.prepare("UPDATE fs_leases SET expires_at = ? WHERE lease_id = ?").run(expiredAt, r.leaseId);
    vi.useFakeTimers();
    vi.setSystemTime((expiredAt + 1) * 1000);
    try {
      expect((db.prepare("SELECT state, expires_at, revision FROM fs_leases WHERE lease_id = ?").get(r.leaseId) as any)).toEqual({ state: "active", expires_at: expiredAt, revision: 1 });
      expect(expiredAt).toBeLessThanOrEqual(Math.floor(Date.now() / 1000));
      const release = { leaseId: r.leaseId, holder: "a", leaseToken: r.leaseToken!, expectedRevision: 1, idempotencyKey: "release" };
      const result = releaseLease(db, release); expect(result.state).toBe("released"); expect(result.revision).toBe(2);
      expect(releaseLease(db, release)).toEqual(result);
      expect((db.prepare("SELECT state, revision FROM fs_leases WHERE lease_id = ?").get(r.leaseId) as any)).toEqual({ state: "released", revision: 2 });
      expect(() => releaseLease(db, { ...release, idempotencyKey: "release-replay" })).toThrow(LeaseDomainError);
    } finally { vi.useRealTimers(); }
  });
});
