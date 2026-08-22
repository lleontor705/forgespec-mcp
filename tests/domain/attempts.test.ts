import Database from "better-sqlite3";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { defineTask } from "../../src/domain/tasks.js";
import { AttemptsDomainError, claimAttempt, recoverAttempt, requeueRecoveredTask, renewAttempt } from "../../src/domain/attempts.js";
import { hashClaimToken, verifyClaimToken } from "../../src/domain/authority/tokens.js";
import { grantAuthority } from "../../src/domain/authority/service.js";

let db: Database.Database;
afterEach(() => db?.close());
function open(): Database.Database {
  db = new Database(":memory:"); createFreshStore(db);
  createBoard(db, { id: "b", project: "p", name: "b", actor: "a", idempotencyKey: "b" });
  defineTask(db, { id: "t", boardId: "b", title: "t", priority: "p1", actor: "a", idempotencyKey: "t", expectedBoardRevision: 1 });
  return db;
}
const input = (key = "claim") => ({ boardId: "b", taskId: "t", actor: "a", expectedTaskRevision: 1, leaseSeconds: 15, idempotencyKey: key });

describe("claimAttempt", () => {
  it("returns a one-time token and only its hash is persisted", () => {
    const database = open(); const result = claimAttempt(database, input());
    expect(result.claimToken).toEqual(expect.any(String));
    expect(verifyClaimToken(result.claimToken!, (database.prepare("SELECT token_hash FROM fs_attempts").get() as { token_hash: string }).token_hash)).toBe(true);
    expect((database.prepare("SELECT token_hash FROM fs_attempts").get() as { token_hash: string }).token_hash).not.toContain(result.claimToken);
  });
  it("rejects an actor without board-qualified update authority", () => {
    const database = open();
    expect(() => claimAttempt(database, { ...input(), actor: "mallory", idempotencyKey: "mallory-claim" }))
      .toThrowError(AttemptsDomainError);
    expect((database.prepare("SELECT COUNT(*) AS n FROM fs_attempts").get() as { n: number }).n).toBe(0);
  });
  it("redacts replay and rejects changed requests", () => {
    const database = open(); const first = claimAttempt(database, input()); const replay = claimAttempt(database, input());
    expect(replay).toEqual({ ...first, claimToken: null });
    expect(() => claimAttempt(database, { ...input(), leaseSeconds: 16 })).toThrowError(AttemptsDomainError);
  });
  it("enforces CAS, readiness, and rollback", () => {
    const database = open();
    expect(() => claimAttempt(database, { ...input(), expectedTaskRevision: 2 })).toThrowError(AttemptsDomainError);
    database.prepare("UPDATE fs_tasks SET status = 'in_progress' WHERE board_id = 'b' AND id = 't'").run();
    expect(() => claimAttempt(database, { ...input(), idempotencyKey: "other" })).toThrowError(AttemptsDomainError);
    expect(database.prepare("SELECT COUNT(*) AS n FROM fs_attempts").get()).toEqual({ n: 0 });
  });
  it("serializes a second claim after the first", () => {
    const database = open(); claimAttempt(database, input());
    expect(() => claimAttempt(database, input("second"))).toThrowError(AttemptsDomainError);
    expect((database.prepare("SELECT COUNT(*) AS n FROM fs_attempts WHERE state = 'active'").get() as { n: number }).n).toBe(1);
  });
  it("uses the canonical hash format", () => expect(hashClaimToken("x")).toMatch(/^sha256:[0-9a-f]{64}$/));
  it("renews with actor/token/CAS checks and replays idempotently", () => {
    const database = open(); const first = claimAttempt(database, input());
    const renewal = renewAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "a", claimToken: first.claimToken!, extendSeconds: 30, expectedTaskRevision: 2, idempotencyKey: "renew" });
    expect(renewal.taskRevision).toBe(3); expect(renewal.expiresAt).toBeGreaterThan(first.expiresAt);
    expect(renewAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "a", claimToken: first.claimToken!, extendSeconds: 30, expectedTaskRevision: 2, idempotencyKey: "renew" })).toEqual(renewal);
    expect(() => renewAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "x", claimToken: first.claimToken!, extendSeconds: 30, expectedTaskRevision: 3, idempotencyKey: "bad" })).toThrow(AttemptsDomainError);
    expect(() => renewAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "a", claimToken: "wrong", extendSeconds: 30, expectedTaskRevision: 3, idempotencyKey: "bad-token" })).toThrow(AttemptsDomainError);
  });
  it("rejects recovery before expiry and supports recovery/requeue", () => {
    const database = open(); const first = claimAttempt(database, input());
    expect(() => recoverAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "a", expectedTaskRevision: 2, idempotencyKey: "recover-early" })).toThrow(AttemptsDomainError);
    const realNow = Date.now(); database.prepare("UPDATE fs_attempts SET expires_at = ? WHERE id = ?").run(Math.floor(realNow / 1000) + 1, first.attemptId); vi.setSystemTime(realNow + 2000);
    const recovered = recoverAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "a", expectedTaskRevision: 2, idempotencyKey: "recover" });
    expect(recovered.taskRevision).toBe(3);
    expect(database.prepare("SELECT state FROM fs_attempts WHERE id = ?").get(first.attemptId)).toEqual({ state: "expired" });
    expect(requeueRecoveredTask(database, { boardId: "b", taskId: "t", actor: "a", expectedTaskRevision: 3, idempotencyKey: "requeue" })).toEqual({ taskRevision: 4 });
    expect(database.prepare("SELECT status, recovery_pending FROM fs_tasks WHERE id = 't'").get()).toEqual({ status: "ready", recovery_pending: 0 });
    vi.useRealTimers();
  });
  it("fails recovery and requeue closed to the original attempt actor and expires leases atomically", () => {
    const database = open(); const first = claimAttempt(database, input());
    const now = Math.floor(Date.now() / 1000); database.prepare("UPDATE fs_attempts SET expires_at = ? WHERE id = ?").run(now + 1, first.attemptId);
    database.prepare("INSERT INTO fs_leases (lease_id, attempt_id, holder, path_pattern, token_hash, state, revision, issued_at, expires_at, created_at) VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?, ?)").run("l", first.attemptId, "a", "src/**", "a".repeat(64), now, now + 1, now);
    vi.setSystemTime((now + 2) * 1000);
    expect(() => recoverAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "mallory", expectedTaskRevision: 2, idempotencyKey: "mallory-recover" })).toThrow(AttemptsDomainError);
    const recovered = recoverAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "a", expectedTaskRevision: 2, idempotencyKey: "recover-with-lease" });
    expect(recovered.taskRevision).toBe(3);
    expect(database.prepare("SELECT state, revision FROM fs_leases WHERE lease_id = 'l'").get()).toEqual({ state: "expired", revision: 2 });
    expect(() => requeueRecoveredTask(database, { boardId: "b", taskId: "t", actor: "mallory", expectedTaskRevision: 3, idempotencyKey: "mallory-requeue" })).toThrow(AttemptsDomainError);
    expect(requeueRecoveredTask(database, { boardId: "b", taskId: "t", actor: "a", expectedTaskRevision: 3, idempotencyKey: "requeue-after-cleanup" })).toEqual({ taskRevision: 4 });
    vi.useRealTimers();
  });
  it("allows an explicitly authorized recovering worker without impersonating the vanished actor", () => {
    const database = open(); const first = claimAttempt(database, input());
    grantAuthority(database, { actor: "a", granteeActor: "orchestrator", resource: { kind: "board", boardId: "b" }, operations: ["recover", "update"], expiresAt: Date.now() + 60_000, idempotencyKey: "recover-grant" });
    const realNow = Date.now(); const now = Math.floor(realNow / 1000); database.prepare("UPDATE fs_attempts SET expires_at = ? WHERE id = ?").run(now + 1, first.attemptId); vi.setSystemTime(realNow + 2000);
    expect(() => recoverAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "unrelated", expectedTaskRevision: 2, idempotencyKey: "unrelated-recover" })).toThrow(AttemptsDomainError);
    const recovered = recoverAttempt(database, { boardId: "b", taskId: "t", attemptId: first.attemptId, actor: "orchestrator", expectedTaskRevision: 2, idempotencyKey: "orchestrator-recover" });
    expect(recovered.taskRevision).toBe(3);
    expect(requeueRecoveredTask(database, { boardId: "b", taskId: "t", actor: "orchestrator", expectedTaskRevision: 3, idempotencyKey: "orchestrator-requeue" })).toEqual({ taskRevision: 4 });
    const fresh = claimAttempt(database, { ...input("fresh-claim"), actor: "orchestrator", expectedTaskRevision: 4 });
    expect(fresh.attemptId).not.toBe(first.attemptId);
    expect((database.prepare("SELECT actor FROM fs_attempts WHERE id = ?").get(first.attemptId) as { actor: string }).actor).toBe("a");
    vi.useRealTimers();
  });
});
