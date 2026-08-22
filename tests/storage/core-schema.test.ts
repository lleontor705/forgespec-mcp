import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createFreshCoreStore } from "../../src/storage/bootstrap";

const tables = ["fs_schema_meta", "fs_boards", "fs_tasks", "fs_task_dependencies", "fs_gates", "fs_gate_decisions", "fs_attempts", "fs_contracts"];
const open = () => { const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); db.pragma("journal_mode = WAL"); return db; };

describe("modular core bootstrap", () => {
  it("creates exact core inventory and restarts idempotently", () => {
    const db = open();
    createFreshCoreStore(db); createFreshCoreStore(db);
    expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((x: any) => x.name)).toEqual([...tables].sort());
    expect(db.prepare("SELECT COUNT(*) AS n FROM fs_schema_meta").get().n).toBe(1);
    db.close();
  });
  it("restores missing indexes and triggers on a qualified core restart", () => {
    const db = open();
    createFreshCoreStore(db);
    db.exec("DROP INDEX idx_fs_tasks_board; DROP INDEX idx_fs_tasks_board_status; DROP INDEX idx_fs_task_dependencies_task; DROP INDEX idx_fs_gates_board; DROP INDEX idx_fs_contracts_parent; DROP INDEX idx_fs_contracts_digests; DROP INDEX idx_fs_attempts_one_active; DROP INDEX idx_fs_gate_decisions_board_status; DROP INDEX idx_fs_attempts_board_task; DROP INDEX idx_fs_contracts_board_phase; DROP INDEX idx_fs_contracts_project_phase_status; DROP INDEX idx_fs_gate_decisions_one_pending;");
    db.exec("DROP TRIGGER trg_fs_gates_required_for_json_validate; DROP TRIGGER trg_fs_gates_required_for_json_validate_update; DROP TRIGGER trg_fs_gate_decisions_immutable_update; DROP TRIGGER trg_fs_tasks_status_transition_guard; DROP TRIGGER trg_fs_contracts_parent_phase_guard; DROP TRIGGER trg_fs_contracts_parent_digest_immutable_update; DROP TRIGGER trg_fs_gate_decisions_immutable_delete; DROP TRIGGER trg_fs_task_dependencies_active_guard;");
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").get().n).toBe(0);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get().n).toBe(0);

    createFreshCoreStore(db);

    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_%'").get().n).toBe(12);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type = 'trigger'").get().n).toBe(8);
    db.close();
  });
  it("rejects incompatible inventory before mutation", () => {
    const db = open(); db.exec("CREATE TABLE unrelated (id INTEGER)");
    expect(() => createFreshCoreStore(db)).toThrow(/DATABASE_INCOMPATIBLE/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table'").get().n).toBe(1); db.close();
  });
  it("installs a representative trigger", () => {
    const db = open(); createFreshCoreStore(db); const now = 1;
    db.prepare("INSERT INTO fs_boards (id,project,name,created_at,updated_at) VALUES ('b','p','B',?,?)").run(now, now);
    expect(() => db.prepare("INSERT INTO fs_gates (board_id,id,name,required_for_json,created_at,updated_at) VALUES ('b','g','G','[\\\"ready\\\",\\\"ready\\\"]',?,?)").run(now, now)).toThrow(); db.close();
  });
});
