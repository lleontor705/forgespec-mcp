import { describe, expect, it, afterEach } from "vitest";
import Database from "better-sqlite3";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { createBoard } from "../../src/domain/boards.js";
import { commitContract, queryContracts, validateContract, ContractDomainError } from "../../src/domain/contracts.js";

const base = (phase = "init") => ({ board_id: "b", project: "p", change_name: "c", phase, status: "success", confidence: .5, executive_summary: "summary", data: { z: 1, a: true } });
let db: Database.Database; afterEach(() => db?.close());
const open = () => { db = new Database(":memory:"); db.pragma("foreign_keys = ON"); createFreshStore(db); return db; };

describe("final contract domain", () => {
  it("normalizes and hashes only strict contract data", () => {
    const result = validateContract({ ...base(), data: { b: 2, a: 1 } });
    expect(result.valid).toBe(true); expect(result.digest).toMatch(/^sha256:[0-9a-f]{64}$/); expect(result.normalized?.data).toEqual({ b: 2, a: 1 });
    expect(validateContract({ ...base(), phase: "propose" }).valid).toBe(false);
    expect(validateContract({ ...base(), confidence: 2 }).valid).toBe(false);
    expect(validateContract({ ...base(), digest: "sha256:" + "0".repeat(64) }).valid).toBe(false);
    // Phase-specific data validation tests
    expect(validateContract({ ...base("spec"), data: { user_stories: 123 } }).valid).toBe(false);
    expect(validateContract({ ...base("spec"), data: { user_stories: ["As a user..."], requirements: ["Must support X"] } }).valid).toBe(true);
    expect(validateContract({ ...base("tasks"), data: { tasks: "not-an-array" } }).valid).toBe(false);
    expect(validateContract({ ...base("tasks"), data: { tasks: [{ id: "t1" }] } }).valid).toBe(true);
    expect(validateContract({ ...base("design"), data: { components: 123 } }).valid).toBe(false);
  });

  it("commits with authority, CAS and idempotent replay", () => {
    const database = open(); createBoard(database, { id: "b", project: "p", name: "board", actor: "owner", idempotencyKey: "board" });
    const input = { actor: "owner", idempotency_key: "k", expected_board_revision: 1, contract: base() };
    const first = commitContract(database, input), replay = commitContract(database, input);
    expect(first.replayed).toBe(false); expect(replay.replayed).toBe(true); expect(replay.contract_id).toBe(first.contract_id);
    expect(() => commitContract(database, { ...input, idempotency_key: "other", expected_board_revision: 1 })).toThrow(ContractDomainError);
    expect(queryContracts(database, { actor: "owner", board_id: "b", limit: 1 }).total_count).toBe(1);
  });

  it("does not disclose unauthorized boards and enforces bounds", () => {
    const database = open(); createBoard(database, { id: "b", project: "p", name: "board", actor: "owner", idempotencyKey: "board" });
    expect(() => queryContracts(database, { actor: "intruder", board_id: "b" })).toThrow(ContractDomainError);
    expect(() => queryContracts(database, { actor: "owner", board_id: "b", limit: 101 })).toThrow(ContractDomainError);
  });
});
