import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { createFreshCoreStore, SCHEMA_CORE_TABLES } from "../../src/v2/storage/schema-core";

function openMemoryStore(): Database.Database {
  const database = new Database(":memory:");
  database.pragma("foreign_keys = ON");
  database.pragma("journal_mode = WAL");
  return database;
}

function tableSql(database: Database.Database, tableName: string): string {
  return (database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) as { sql: string } | undefined)?.sql ?? "";
}

function tableExists(database: Database.Database, tableName: string): boolean {
  return database.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(tableName) !== undefined;
}

function createTempFileDatabase(): { database: Database.Database; filePath: string } {
  const filePath = join(tmpdir(), `schema-core-${randomUUID()}.sqlite`);
  const database = new Database(filePath);
  return { database, filePath };
}

describe("forge-spec v2 schema-core", () => {
  it("creates strict normalized tables for boards, tasks, dependencies, gates, attempts, contracts, and bootstrap metadata", () => {
    const database = openMemoryStore();
    try {
      createFreshCoreStore(database);
      createFreshCoreStore(database);

      for (const tableName of SCHEMA_CORE_TABLES) {
        expect(tableExists(database, tableName)).toBe(true);
        expect(tableSql(database, tableName).toUpperCase()).toContain("STRICT");
      }

      const [metaCount, boardCount, taskCount, gateCount, dependencyCount, attemptCount, contractCount] =
        ["fs_schema_meta", "fs_boards", "fs_tasks", "fs_gates", "fs_task_dependencies", "fs_attempts", "fs_contracts"].map((tableName) => {
          return database.prepare(`SELECT COUNT(*) AS count FROM sqlite_master WHERE name = ? AND type = 'table'`).get(tableName).count;
        });

      expect(metaCount).toBe(1);
      expect(boardCount).toBe(1);
      expect(taskCount).toBe(1);
      expect(gateCount).toBe(1);
      expect(dependencyCount).toBe(1);
      expect(attemptCount).toBe(1);
      expect(contractCount).toBe(1);

      const metadata = database
        .prepare("SELECT schema_version, json_valid(bootstrap_metadata_json) AS metadata_is_json FROM fs_schema_meta WHERE key = 'core'")
        .get() as { schema_version: string; metadata_is_json: number };

      expect(metadata.schema_version).toBe("2.0.0");
      expect(metadata.metadata_is_json).toBe(1);
    } finally {
      database.close();
    }
  });

  it("validates FK and CHECK invariants for task/dependency/gate/attempt/contracts metadata", () => {
    const database = openMemoryStore();
    try {
      createFreshCoreStore(database);

      const now = 1_700_000_000;
      const tokenA = `sha256:${"a".repeat(64)}`;
      const tokenB = `sha256:${"b".repeat(64)}`;
      const tokenC = `sha256:${"c".repeat(64)}`;

      database.prepare("INSERT INTO fs_boards (id, project, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)").run(
        "board-A",
        "proj",
        "Board A",
        now,
        now
      );

      database.prepare(
        "INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("board-A", "task-1", "Task 1", now, now, "backlog", "p0");

      database.prepare(
        "INSERT INTO fs_gates (board_id, id, name, required_for_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
      ).run("board-A", "gate-1", "Review", '[\"ready\", \"in_review\"]', now, now);

      database
        .prepare(
          "INSERT INTO fs_contracts (id, board_id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "contract-1",
          "board-A",
          "forgespec",
          null,
          tokenA,
          "schema-core",
          '{"plan":"root"}',
          "tasks",
          "success",
          0.9,
          "",
          1,
          now,
          now
        );

      database
        .prepare(
          "INSERT INTO fs_contracts (id, board_id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        )
        .run(
          "contract-2",
          null,
          "forgespec",
          "contract-1",
          tokenB,
          "schema-core",
          '{"plan":"child"}',
          "apply",
          "partial",
          0.8,
          "",
          2,
          now,
          now
        );

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_gates (board_id, id, name, required_for_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("board-A", "gate-2", "Bad required_for", '[\"ready\", \"ready\"]', now, now)
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_gates (board_id, id, name, required_for_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("board-A", "gate-3", "Bad required_for", '[\"in_review\", \"ready\"]', now, now)
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_gates (board_id, id, name, required_for_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("board-A", "gate-4", "Bad required_for", '[\"nonsense\"]', now, now)
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_task_dependencies (task_board_id, task_id, dependency_board_id, dependency_task_id) VALUES (?, ?, ?, ?)"
          )
          .run("board-A", "missing", "board-A", "task-1")
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_task_dependencies (task_board_id, task_id, dependency_board_id, dependency_task_id) VALUES (?, ?, ?, ?)"
          )
          .run("board-A", "task-1", "board-A", "task-1")
      ).toThrow();

      const linkedContract = database
        .prepare(
          "SELECT c.id, c.parent_contract_id, c.digest, c.planning_json, c.project, c.change_name FROM fs_contracts c WHERE c.id = ?"
        )
        .get("contract-2") as {
        id: string;
        parent_contract_id: string;
        digest: string;
        planning_json: string;
        project: string;
        change_name: string;
      };

      expect(linkedContract.id).toBe("contract-2");
      expect(linkedContract.parent_contract_id).toBe("contract-1");
      expect(linkedContract.project).toBe("forgespec");
      expect(linkedContract.change_name).toBe("schema-core");
      expect(linkedContract.digest).toBe(tokenB);
      expect(JSON.parse(linkedContract.planning_json)).toEqual({ plan: "child" });

      database.prepare(
        "INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("board-A", "task-2", "Task 2", now, now, "ready", "p1");

      database.prepare(
        "INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "attempt-1",
        "board-A",
        "task-1",
        1,
        "agent-a",
        tokenA,
        "active",
        now,
        now + 5000
      );

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run("attempt-2", "board-A", "task-1", 2, "agent-a", tokenB, "active", now, now + 5000)
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run(
            "attempt-3",
            "board-A",
            "task-1",
            3,
            "agent-a",
            "SHA256:ZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZZ",
            "succeeded",
            now,
            now + 5000
          )
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_gate_decisions (board_id, task_id, gate_id, status, actor, decided_at) VALUES (?, ?, ?, ?, ?, ?)"
          )
          .run("board-A", "task-1", "gate-1", "allow", null, now)
      ).toThrow();

      database
        .prepare(
          "INSERT INTO fs_gate_decisions (board_id, task_id, gate_id, status, actor, attempt_id, decided_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .run("board-A", "task-1", "gate-1", "allow", "reviewer", "attempt-1", now);

      expect(() =>
        database
          .prepare(
            "UPDATE fs_gate_decisions SET actor = ? WHERE board_id = ? AND task_id = ? AND gate_id = ? AND decision_no = ?"
          )
          .run("new-actor", "board-A", "task-1", "gate-1", 1)
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority, recovery_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run("board-A", "task-3", "Task 3", now, now, "ready", "p1", 2)
      ).toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority, recovery_pending) VALUES (?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run("board-A", "task-4", "Task 4", now, now, "ready", "p1", -1)
      ).toThrow();

      database.prepare(
        "INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("board-A", "task-5", "Task 5", now, now, "ready", "p2");

      expect(() =>
        database
          .prepare("UPDATE fs_tasks SET recovery_pending = ? WHERE board_id = ? AND id = ?")
          .run(1, "board-A", "task-5")
      ).not.toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run("attempt-4", "board-A", "task-5", 1, "agent-a", tokenC, "active", now, now + 5000)
      ).not.toThrow();

      expect(() =>
        database.prepare("UPDATE fs_tasks SET status = ? WHERE board_id = ? AND id = ?").run("done", "board-A", "task-2")
      ).toThrow();

      expect(() =>
        database
          .prepare("INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)")
          .run("board-A", "task-6", "Task 6", now, now, "in_progress", "p2")
      ).not.toThrow();

      expect(() =>
        database
          .prepare(
            "INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
          )
          .run("attempt-5", "board-A", "task-6", 1, "agent-a", tokenA, "active", now, now + 5000)
      ).not.toThrow();

      expect(() =>
        database
          .prepare("UPDATE fs_tasks SET status = ? WHERE board_id = ? AND id = ?")
          .run("done", "board-A", "task-6")
      ).not.toThrow();
    } finally {
      database.close();
    }
  });

  it("is idempotent on pre-bootstrapped core store", () => {
    const database = openMemoryStore();
    try {
      createFreshCoreStore(database);

      expect(() => createFreshCoreStore(database)).not.toThrow();
      expect(database.prepare("SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name LIKE 'fs_%'").get().count)
        .toBe(SCHEMA_CORE_TABLES.length);

      for (const tableName of SCHEMA_CORE_TABLES) {
        expect(tableExists(database, tableName)).toBe(true);
      }
    } finally {
      database.close();
    }
  });

  it("rejects partial/non-core table sets and uses strict set-match", () => {
    const database = openMemoryStore();
    try {
      database.prepare("CREATE TABLE boards(id TEXT PRIMARY KEY)").run();
      database.prepare("CREATE TABLE app_config(id INTEGER PRIMARY KEY)").run();

      expect(() => createFreshCoreStore(database)).toThrowError(/DATABASE_INCOMPATIBLE/);
      expect(tableExists(database, "fs_boards")).toBe(false);
      expect(tableExists(database, "boards")).toBe(true);
      expect(tableExists(database, "app_config")).toBe(true);
    } finally {
      database.close();
    }
  });

  it("enforces task status terminal and attempt-gated done transitions", () => {
    const database = openMemoryStore();
    try {
      createFreshCoreStore(database);

      const now = 1_700_000_100;
      const tokenA = `sha256:${"a".repeat(64)}`;

      database.prepare(
        "INSERT INTO fs_boards (id, project, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)"
      ).run("board-B", "proj", "Board B", now, now);

      database.prepare(
        "INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("board-B", "task-ready", "Task Ready", now, now, "ready", "p0");

      expect(() =>
        database.prepare("UPDATE fs_tasks SET status = ? WHERE board_id = ? AND id = ?").run("done", "board-B", "task-ready")
      ).toThrow();

      database.prepare(
        "INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("attempt-1", "board-B", "task-ready", 1, "agent-a", tokenA, "active", now, now + 5000);

      expect(() =>
        database.prepare("UPDATE fs_tasks SET status = ? WHERE board_id = ? AND id = ?").run("done", "board-B", "task-ready")
      ).toThrow();

      expect(() =>
        database.prepare("UPDATE fs_tasks SET status = ? WHERE board_id = ? AND id = ?").run("backlog", "board-B", "task-ready")
      ).not.toThrow();

      database.prepare(
        "INSERT INTO fs_tasks (board_id, id, title, created_at, updated_at, status, priority) VALUES (?, ?, ?, ?, ?, ?, ?)"
      ).run("board-B", "task-in-progress", "Task In Progress", now, now, "in_progress", "p2");

      database.prepare(
        "INSERT INTO fs_attempts (id, board_id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run("attempt-2", "board-B", "task-in-progress", 1, "agent-a", tokenA, "active", now, now + 5000);

      expect(() =>
        database.prepare("UPDATE fs_tasks SET status = ? WHERE board_id = ? AND id = ?").run("done", "board-B", "task-in-progress")
      ).not.toThrow();

      expect(() =>
        database.prepare("UPDATE fs_tasks SET status = ? WHERE board_id = ? AND id = ?").run("backlog", "board-B", "task-in-progress")
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("enforces contract lineage: parent context, revision, phase and immutability", () => {
    const database = openMemoryStore();
    try {
      createFreshCoreStore(database);

      const now = 1_700_000_200;
      const tokenA = `sha256:${"a".repeat(64)}`;
      const tokenB = `sha256:${"b".repeat(64)}`;
      const tokenC = `sha256:${"c".repeat(64)}`;

      database.prepare(
        "INSERT INTO fs_contracts (id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
      ).run(
        "root-1",
        "proj",
        null,
        tokenA,
        "strict-lineage",
        '{"plan":"root"}',
        "tasks",
        "success",
        0.95,
        "",
        1,
        now,
        now
      );

      expect(() =>
        database.prepare(
          "INSERT INTO fs_contracts (id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          "child-mismatch",
          "proj",
          "root-1",
          tokenB,
          "other",
          '{"plan":"bad"}',
          "apply",
          "partial",
           0.8,
           "",
           3,
           now,
           now
        )
      ).toThrow();

      expect(() =>
        database.prepare(
          "INSERT INTO fs_contracts (id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          "child-rev-mismatch",
          "proj",
          "root-1",
          tokenB,
          "bad-revision",
          '{"plan":"bad"}',
          "apply",
          "partial",
           0.8,
           "",
           3,
           now,
           now
        )
      ).toThrow();

      expect(() =>
        database.prepare(
          "INSERT INTO fs_contracts (id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          "child-reverse-phase",
          "proj",
          "root-1",
          tokenB,
          "strict-lineage",
          '{"plan":"bad"}',
          "spec",
          "partial",
           0.8,
           "",
           2,
           now,
           now
        )
      ).toThrow();

      expect(() =>
        database.prepare(
          "INSERT INTO fs_contracts (id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)"
        ).run(
          "child-valid",
          "proj",
          "root-1",
          tokenB,
          "strict-lineage",
          '{"plan":"good"}',
          "apply",
          "partial",
           0.8,
           "",
           2,
           now,
           now
        )
      ).not.toThrow();

      expect(() =>
        database.prepare(
          "UPDATE fs_contracts SET digest = ?, change_name = ? WHERE id = ?"
        ).run(tokenC, "moved-lineage", "child-valid")
      ).toThrow();

      expect(() =>
        database.prepare(
          "UPDATE fs_contracts SET parent_contract_id = ? WHERE id = ?"
        ).run("other-parent", "child-valid")
      ).toThrow();
    } finally {
      database.close();
    }
  });

  it("validates sqlite runtime prerequisites before bootstrap", () => {
    const databaseNoFk = new Database(":memory:");
    try {
      databaseNoFk.pragma("foreign_keys = OFF");
      expect(() => createFreshCoreStore(databaseNoFk)).toThrowError(/DATABASE_INCOMPATIBLE/);
    } finally {
      databaseNoFk.close();
    }

    const { database: databaseWal, filePath } = createTempFileDatabase();
    try {
      databaseWal.pragma("foreign_keys = ON");
      databaseWal.pragma("journal_mode = DELETE");
      expect(() => createFreshCoreStore(databaseWal)).toThrowError(/DATABASE_INCOMPATIBLE/);
    } finally {
      databaseWal.close();
      rmSync(filePath, { force: true });
    }
  });
});
