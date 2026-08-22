import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { BoardDomainError, createBoard, getBoard } from "../../src/domain/boards.js";

let db: Database.Database;
afterEach(() => db?.close());
const open = () => { db = new Database(":memory:"); createFreshStore(db); return db; };
const input = { project: "p", name: "n", metadata: { z: 1, a: "x" }, actor: "a", idempotencyKey: "k", id: "board-test" };

describe("boards domain", () => {
  it("validates strict text and metadata bounds", () => {
    const database = open();
    expect(() => createBoard(database, { ...input, project: " " })).toThrow(BoardDomainError);
    expect(() => createBoard(database, { ...input, name: "n".repeat(129) })).toThrow(BoardDomainError);
    expect(() => createBoard(database, { ...input, metadata: [] as never })).toThrow(BoardDomainError);
  });
  it("creates revision one with canonical JSON and replays identically", () => {
    const database = open();
    const first = createBoard(database, input);
    const second = createBoard(database, input);
    expect(second).toEqual(first);
    expect(first).toMatchObject({ id: "board-test", revision: 1, metadata: { a: "x", z: 1 } });
    expect(database.prepare("SELECT metadata_json, revision, created_at, updated_at FROM fs_boards").get())
      .toMatchObject({ metadata_json: '{"a":"x","z":1}', revision: 1 });
    expect(database.prepare("SELECT count(*) n FROM fs_authority WHERE resource_id = ? AND actor = ? AND grantee_actor = ? AND granted_by_actor = ? AND lineage_kind = 'owner_root'").get(input.id, input.actor, input.actor, input.actor)).toEqual({ n: 9 });
  });
  it("supports explicit future expiry and rejects expired authority", () => {
    const database = open();
    const expiry = Date.now() + 10_000;
    expect(createBoard(database, { ...input, authorityExpiresAt: expiry }).rootAuthorityExpiresAt).toBe(expiry);
    expect(() => createBoard(open(), { ...input, authorityExpiresAt: Date.now() - 1 })).toThrow(BoardDomainError);
  });
  it("rolls back the board when a root insert fails", () => {
    const database = open();
    database.exec("CREATE TRIGGER fail_root BEFORE INSERT ON fs_authority WHEN NEW.operation = 'grant' BEGIN SELECT RAISE(ABORT, 'root failure'); END");
    expect(() => createBoard(database, input)).toThrow(/root failure/);
    expect(database.prepare("SELECT count(*) n FROM fs_boards").get()).toEqual({ n: 0 });
    expect(database.prepare("SELECT count(*) n FROM fs_authority").get()).toEqual({ n: 0 });
  });
  it("deterministically replays boards when the ID is omitted", () => {
    const database = open();
    const omittedId = { ...input, id: undefined, idempotencyKey: "generated" };
    const first = createBoard(database, omittedId);
    const second = createBoard(database, omittedId);
    expect(second).toEqual(first);
    expect(first.id).toMatch(/^board-[0-9a-f]{64}$/);
  });
  it("rejects an idempotency conflict and hides unauthorized resources", () => {
    const database = open(); createBoard(database, input);
    expect(() => createBoard(database, { ...input, name: "other" })).toThrow(BoardDomainError);
    expect(() => getBoard(database, { boardId: "missing", actor: "a" })).toThrow(/Resource is not available/);
    expect(() => getBoard(database, { boardId: input.id, actor: "unknown" })).toThrow(/Resource is not available/);
    expect(getBoard(database, { boardId: input.id, actor: input.actor })).toMatchObject({ id: input.id });
  });

  it("does not reveal whether a board exists to an unauthorized actor", () => {
    const database = open();
    createBoard(database, input);
    expect(() => getBoard(database, { boardId: input.id, actor: "mallory" })).toThrow(/Resource is not available/);
    expect(() => getBoard(database, { boardId: "other-board", actor: "mallory" })).toThrow(/Resource is not available/);
  });
});
