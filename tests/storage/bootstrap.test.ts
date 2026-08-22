import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createFreshCoreStore, createFreshStore } from "../../src/storage/bootstrap.js";
import { canonicalAuditEventDigest } from "../../src/storage/audit-integrity.js";
import { GOVERNANCE_TABLES_SQL } from "../../src/storage/schema/governance-tables.js";

const tables = (db: Database.Database) => db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((r: any) => r.name);
const open = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); return db; };

describe("full modular bootstrap", () => {
  it("converges empty and core inventories to exactly 16 tables", () => {
    const empty = open();
    createFreshStore(empty);
    expect(tables(empty)).toHaveLength(16);
    empty.close();

    const core = open();
    createFreshCoreStore(core);
    expect(tables(core)).toEqual([
      "fs_attempts",
      "fs_boards",
      "fs_contracts",
      "fs_gate_decisions",
      "fs_gates",
      "fs_schema_meta",
      "fs_task_dependencies",
      "fs_tasks",
    ]);
    createFreshStore(core);
    expect(tables(core)).toHaveLength(16);
    core.close();
  });

  it("rejects a name-complete full inventory containing a non-STRICT table", () => {
    const db = open();
    createFreshCoreStore(db);
    db.exec(GOVERNANCE_TABLES_SQL.replace(
      /(CREATE TABLE IF NOT EXISTS fs_evidence \([\s\S]*?)\) STRICT;/,
      "$1);",
    ));
    const before = db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
    expect(() => createFreshStore(db)).toThrow(/DATABASE_INCOMPATIBLE: expected STRICT tables/);
    expect(db.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all()).toEqual(before);
    db.close();
  });

  it("is idempotent on a full restart", () => {
    const db = open(); createFreshStore(db); const before = tables(db);
    expect(() => createFreshStore(db)).not.toThrow();
    expect(tables(db)).toEqual(before); db.close();
  });

  it("rejects incompatible inventories without mutation", () => {
    const db = open(); db.exec("CREATE TABLE foreign_inventory (value TEXT)");
    expect(() => createFreshStore(db)).toThrow(/DATABASE_INCOMPATIBLE/);
    expect(tables(db)).toEqual(["foreign_inventory"]); db.close();
  });

  it("registers UDFs used by the audit trigger", () => {
    const db = open(); createFreshStore(db);
    expect(db.prepare("SELECT fs_normalize_actor_set(?) AS value").get('[" Bob ","alice","bob"]')).toEqual({ value: '["alice","bob"]' });
    const hash = canonicalAuditEventDigest({ board_id: "b", task_id: "t", attempt_id: "a", actor: "alice", tool: "tool", event_type: "event", resource_type: "task", resource_id: "t", event_ordinal: 1, prev_hash: null, payload_json: {} });
    expect(db.prepare("SELECT fs_canonical_audit_event_hash(?,?,?,?,?,?,?,?,?,?,?) AS value").get("b", "t", "a", "alice", "tool", "event", "task", "t", 1, null, "{}")).toEqual({ value: hash });
    db.close();
  });
});
