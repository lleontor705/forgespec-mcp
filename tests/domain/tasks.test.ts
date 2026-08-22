import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { grantAuthority } from "../../src/domain/authority/service.js";
import { defineTask, queryTasks, TaskDomainError } from "../../src/domain/tasks.js";

let db: Database.Database;
afterEach(() => db?.close());
const open = () => { db = new Database(":memory:"); createFreshStore(db); createBoard(db, { project: "p", name: "b", actor: "a", idempotencyKey: "board", id: "b" }); return db; };
const task = (revision = 1, extra: Record<string, unknown> = {}) => ({ boardId: "b", title: "task", priority: "p1" as const, actor: "a", idempotencyKey: "task", expectedBoardRevision: revision, id: "t", ...extra });

describe("tasks domain", () => {
  it("uses board CAS and replays exact requests", () => { const database = open(); const first = defineTask(database, task()); expect(defineTask(database, task())).toEqual(first); expect(() => defineTask(database, { ...task(), title: "other" })).toThrow(TaskDomainError); expect(() => defineTask(database, { ...task(), idempotencyKey: "new", id: "u" })).toThrow(TaskDomainError); });
  it("generates a stable ID without digesting the generated value", () => { const database = open(); const input = { ...task(), id: undefined }; const first = defineTask(database, input); expect(defineTask(database, input)).toEqual(first); expect(first.id).toMatch(/^task-[0-9a-f]{64}$/); });
  it("maps duplicate IDs to REQUEST_INVALID and rolls back", () => { const database = open(); defineTask(database, task()); const before = (database.prepare("SELECT revision FROM fs_boards WHERE id = 'b'").get() as { revision: number }).revision; try { defineTask(database, task(2, { id: "t", idempotencyKey: "different" })); } catch (error) { expect((error as TaskDomainError).error.code).toBe("REQUEST_INVALID"); } expect((database.prepare("SELECT revision FROM fs_boards WHERE id = 'b'").get() as { revision: number }).revision).toBe(before); });
  it("validates dependencies and sets backlog readiness", () => { const database = open(); defineTask(database, task()); const dependent = defineTask(database, task(2, { id: "u", idempotencyKey: "u", dependencies: ["t"] })); expect(dependent.status).toBe("backlog"); expect(() => defineTask(database, task(3, { id: "x", idempotencyKey: "x", dependencies: ["missing"] }))).toThrow(TaskDomainError); });
  it("returns bounded stable pages and filtered totals for an authorized actor", () => { const database = open(); defineTask(database, task()); defineTask(database, task(2, { id: "u", idempotencyKey: "u" })); const page = queryTasks(database, { boardId: "b", actor: "a", limit: 1, statuses: ["ready"] }); expect(page.total_count).toBe(2); expect(page.records).toHaveLength(1); expect(page.records[0].id).toBe("t"); expect(() => queryTasks(database, { boardId: "b", actor: "a", limit: 201 })).toThrow(TaskDomainError); });
  it("rejects null and oversized IDs with exact codes before SQL", () => { const database = open(); try { queryTasks(database, null as never); } catch (error) { expect((error as TaskDomainError).error.code).toBe("REQUEST_INVALID"); } try { queryTasks(database, { boardId: "b", actor: "x", limit: 1, taskIds: Array.from({ length: 40000 }, (_, i) => `t${i}`) }); } catch (error) { expect((error as TaskDomainError).error.code).toBe("REQUEST_INVALID"); } });
  it("rejects more than 100 normalized dependencies before database work", () => {
    const database = open();
    const dependencies = Array.from({ length: 101 }, (_, i) => `dep-${i}`);
    expect(() => defineTask(database, task(1, { dependencies }))).toThrow(TaskDomainError);
    try { defineTask(database, task(1, { dependencies })); } catch (error) { expect((error as TaskDomainError).error.code).toBe("LIMIT_EXCEEDED"); }
    expect(database.prepare("SELECT count(*) AS count FROM fs_tasks").get()).toEqual({ count: 0 });
  });
  it("returns dependencies only for the selected page", () => { const database = open(); defineTask(database, task()); defineTask(database, task(2, { id: "u", idempotencyKey: "u", dependencies: ["t"] })); const page = queryTasks(database, { boardId: "b", actor: "a", limit: 1, taskIds: ["u"] }); expect(page.dependencies).toEqual([{ taskId: "u", dependencyTaskId: "t" }]); });

  it("allows an exact task grant without exposing sibling tasks", () => { const database = open(); defineTask(database, task()); defineTask(database, task(2, { id: "u", idempotencyKey: "u" })); grantAuthority(database, { actor: "a", granteeActor: "alice", resource: { kind: "task", boardId: "b", resourceId: "u" }, operations: ["read_task"], expiresAt: Date.now() + 10000, now: Date.now(), idempotencyKey: "alice-u" }); const page = queryTasks(database, { boardId: "b", actor: "alice", limit: 10 }); expect(page.total_count).toBe(1); expect(page.records.map((r) => r.id)).toEqual(["u"]); });

  it("returns an empty anti-oracle result to an unauthorized actor", () => { const database = open(); defineTask(database, task()); const page = queryTasks(database, { boardId: "b", actor: "mallory", limit: 10, taskIds: ["t"] }); expect(page).toEqual({ total_count: 0, records: [], dependencies: [] }); });
});
