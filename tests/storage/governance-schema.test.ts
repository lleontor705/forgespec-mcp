import { describe, expect, it } from "vitest";
import Database from "better-sqlite3";
import { createFreshCoreStore } from "../../src/storage/bootstrap";
import { GOVERNANCE_TABLE_NAMES, GOVERNANCE_TABLES_SQL } from "../../src/storage/schema/governance-tables";
import { AUTHORITY_TRIGGERS_SQL } from "../../src/storage/schema/authority-triggers";
import { FS_CANONICAL_AUDIT_EVENT_HASH, FS_NORMALIZE_ACTOR_SET, RUNTIME_TRIGGERS_SQL } from "../../src/storage/schema/runtime-triggers";
import { canonicalAuditEventDigest } from "../../src/storage/audit-integrity";
import { normalizeActorSet } from "../../src/storage/actor-set";

describe("modular governance schema", () => {
  function installRuntime(db: Database.Database) {
    db.function(FS_CANONICAL_AUDIT_EVENT_HASH, (boardId: string, taskId: string, attemptId: string, actor: string, tool: string, eventType: string, resourceType: string, resourceId: string, ordinal: number, prevHash: string | null, payloadJson: string) => canonicalAuditEventDigest({
      board_id: boardId, task_id: taskId, attempt_id: attemptId, actor, tool, event_type: eventType,
      resource_type: resourceType, resource_id: resourceId, event_ordinal: Number(ordinal),
      prev_hash: prevHash, payload_json: JSON.parse(payloadJson),
    }));
    db.function(FS_NORMALIZE_ACTOR_SET, (json: string) => normalizeActorSet(json));
    db.exec(RUNTIME_TRIGGERS_SQL);
  }

  it("creates exactly eight strict governance tables over core", () => {
    const db = new Database(":memory:");
    db.pragma("foreign_keys = ON");
    createFreshCoreStore(db);
    db.exec(GOVERNANCE_TABLES_SQL);
    db.exec(AUTHORITY_TRIGGERS_SQL);
    installRuntime(db);
    const names = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all().map((row: any) => row.name);
    expect(names).toHaveLength(16);
    expect(names).toEqual([...GOVERNANCE_TABLE_NAMES, "fs_schema_meta", "fs_boards", "fs_tasks", "fs_task_dependencies", "fs_gates", "fs_gate_decisions", "fs_attempts", "fs_contracts"].sort());
    for (const name of GOVERNANCE_TABLE_NAMES) expect(db.prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?").get(name).sql).toMatch(/STRICT/);
    expect(db.prepare("PRAGMA foreign_key_list(fs_lease_scopes)").all().map((row: any) => row.table)).toContain("fs_leases");
    expect(db.prepare("PRAGMA table_info(fs_leases)").all().map((row: any) => row.name)).toContain("case_policy");
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='fs_leases'").get().sql).toMatch(/case_policy TEXT NOT NULL/);
    expect(db.prepare("PRAGMA foreign_key_list(fs_approvals)").all().map((row: any) => row.table)).toEqual(expect.arrayContaining(["fs_boards", "fs_attempts", "fs_tasks", "fs_gates"]));
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='fs_authority'").get().sql).toMatch(/lineage_kind = 'delegated'/);
    expect(db.prepare("SELECT sql FROM sqlite_master WHERE name='fs_idempotency'").get().sql).toMatch(/json_valid/);
    expect(db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='trigger' AND name LIKE 'trg_fs_%'").get().n).toBeGreaterThan(0);
    db.close();
  });

  it("rejects forged delegation and approval actor bypasses", () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); createFreshCoreStore(db);
     db.exec(GOVERNANCE_TABLES_SQL); db.exec(AUTHORITY_TRIGGERS_SQL); installRuntime(db);
     const h = "a".repeat(64), now = Math.floor(Date.now() / 1000) + 100;
     db.prepare("INSERT INTO fs_boards VALUES ('b','p','B',1,'{}',1,1)").run();
     db.prepare("INSERT INTO fs_boards VALUES ('other','p','Other',1,'{}',1,1)").run();
     db.prepare("INSERT INTO fs_tasks VALUES ('b','t','T','', 'p2','in_progress',NULL,'',1,NULL,'[]',1,1,0)").run();
     db.prepare("INSERT INTO fs_tasks VALUES ('other','t','T','', 'p2','in_progress',NULL,'',1,NULL,'[]',1,1,0)").run();
     const authoritySql = "INSERT INTO fs_authority (authority_id,board_id,parent_authority_id,resource_kind,resource_id,actor,grantee_actor,operation,granted_by_actor,lineage_kind,status,token_hash,revision,granted_at,expires_at,revoked_at,revoked_by_actor,revoked_reason) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)";
     db.prepare(authoritySql).run("root", "b", null, "board", "b", "owner", "alice", "read_task", "owner", "owner_root", "active", h, 1, now, now + 1000, null, null, null);
     expect(() => db.prepare(authoritySql).run("child", "b", "root", "board", "b", "delegator", "bob", "read_task", "mallory", "delegated", "active", h, 1, now, now + 500, null, null, null)).toThrow(/granted by parent/);
     expect(() => db.prepare(authoritySql).run("task-child", "b", "root", "task", "t", "owner", "bob", "read_task", "alice", "delegated", "active", h, 1, now, now + 500, null, null, null)).not.toThrow();
     expect(() => db.prepare(authoritySql).run("bad-task", "b", "root", "task", "missing", "owner", "bob", "read_task", "alice", "delegated", "active", h, 1, now, now + 500, null, null, null)).toThrow(/board scope/);
     expect(() => db.prepare(authoritySql).run("cross-board", "other", "root", "task", "t", "owner", "bob", "read_task", "alice", "delegated", "active", h, 1, now, now + 500, null, null, null)).toThrow(/invalid authority parent lineage/);
    db.prepare("INSERT INTO fs_gates VALUES ('b','g','G','[\"in_progress\"]','[\"alice\"]',1,1)").run();
     db.prepare("INSERT INTO fs_attempts VALUES ('a','b','t',1,'alice',?, 'active',?,?,NULL,NULL)").run("sha256:" + "a".repeat(64), now, now + 1000);
     const approval = ["x","b","a","t","g","bob","allow","allow",1,1,"[]","alice","local-trusted-client","native","p","k","e","sha256:"+"a".repeat(64)];
    expect(() => db.prepare("INSERT INTO fs_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...approval)).toThrow(/approval actor/);
    approval[5] = " "; approval[11] = " "; expect(() => db.prepare("INSERT INTO fs_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...approval)).toThrow(/approval actor/);
     db.close();
  });

  it("rejects noncanonical approval actor sets while allowing canonical sets", () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); createFreshCoreStore(db);
    db.exec(GOVERNANCE_TABLES_SQL); db.exec(AUTHORITY_TRIGGERS_SQL); installRuntime(db);
    const now = Math.floor(Date.now() / 1000) + 100;
    db.prepare("INSERT INTO fs_boards VALUES ('b','p','B',1,'{}',1,1)").run();
    db.prepare("INSERT INTO fs_tasks VALUES ('b','t','T','', 'p2','in_progress',NULL,'',1,NULL,'[]',1,1,0)").run();
    db.prepare("INSERT INTO fs_gates VALUES ('b','noncanonical','N','[\"in_progress\"]','[\" Reviewer \",\"reviewer\"]',1,1)").run();
    db.prepare("INSERT INTO fs_gates VALUES ('b','canonical','C','[\"in_progress\"]','[\"reviewer\"]',1,1)").run();
    db.prepare("INSERT INTO fs_attempts VALUES ('a','b','t',1,'reviewer',?, 'active',?,?,NULL,NULL)").run("sha256:" + "a".repeat(64), now, now + 1000);
    const insertApproval = db.prepare("INSERT INTO fs_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
     const approval = (id: string, gate: string) => [id, "b", "a", "t", gate, "reviewer", "allow", "allow", 1, 1, "[]", "reviewer", "local-trusted-client", "native", "p", "k", "e", "sha256:" + "a".repeat(64)];
    expect(() => insertApproval.run(...approval("noncanonical-approval", "noncanonical"))).toThrow(/approval actor/);
    expect(() => insertApproval.run(...approval("canonical-approval", "canonical"))).not.toThrow();
    db.close();
  });

  it("allows a listed reviewer to approve a worker attempt", () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); createFreshCoreStore(db);
    db.exec(GOVERNANCE_TABLES_SQL); db.exec(AUTHORITY_TRIGGERS_SQL); installRuntime(db);
    const now = Math.floor(Date.now() / 1000) + 100;
    db.prepare("INSERT INTO fs_boards VALUES ('b','p','B',1,'{}',1,1)").run();
    db.prepare("INSERT INTO fs_tasks VALUES ('b','t','T','', 'p2','in_progress',NULL,'',1,NULL,'[]',1,1,0)").run();
    db.prepare("INSERT INTO fs_gates VALUES ('b','g','G','[\"in_progress\"]','[\"reviewer\"]',1,1)").run();
    db.prepare("INSERT INTO fs_attempts VALUES ('a','b','t',1,'worker',?, 'active',?,?,NULL,NULL)").run("sha256:" + "a".repeat(64), now, now + 1000);
      const approval = ["x","b","a","t","g","reviewer","allow","allow",1,1,"[]","reviewer","local-trusted-client","native","p","k","e","sha256:"+"a".repeat(64)];
    expect(() => db.prepare("INSERT INTO fs_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run(...approval)).not.toThrow();
    db.close();
  });

  it("rejects unlisted, inactive, expired, and mismatched approvals", () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); createFreshCoreStore(db);
    db.exec(GOVERNANCE_TABLES_SQL); db.exec(AUTHORITY_TRIGGERS_SQL); installRuntime(db);
    const now = Math.floor(Date.now() / 1000) + 100;
    db.prepare("INSERT INTO fs_boards VALUES ('b','p','B',1,'{}',1,1)").run();
    db.prepare("INSERT INTO fs_boards VALUES ('other','p','Other',1,'{}',1,1)").run();
    db.prepare("INSERT INTO fs_tasks VALUES ('b','t','T','', 'p2','in_progress',NULL,'',1,NULL,'[]',1,1,0)").run();
    db.prepare("INSERT INTO fs_tasks VALUES ('other','t','T','', 'p2','in_progress',NULL,'',1,NULL,'[]',1,1,0)").run();
    db.prepare("INSERT INTO fs_gates VALUES ('b','g','G','[\"in_progress\"]','[\"reviewer\"]',1,1)").run();
    db.prepare("INSERT INTO fs_attempts VALUES ('active','b','t',1,'worker',?, 'active',?,?,NULL,NULL)").run("sha256:" + "c".repeat(64), now, now + 1000);
    db.prepare("INSERT INTO fs_attempts VALUES ('inactive','b','t',2,'worker',?, 'succeeded',?,?,NULL,NULL)").run("sha256:" + "a".repeat(64), now, now + 1000);
    db.prepare("INSERT INTO fs_attempts VALUES ('expired','b','t',3,'worker',?, 'expired',?,?,NULL,NULL)").run("sha256:" + "b".repeat(64), now - 1000, now - 1);
    const insert = db.prepare("INSERT INTO fs_approvals VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)");
    const approval = (id: string, attempt: string, board = "b", task = "t", actor = "reviewer", provenance = actor, gate = "g") =>
        [id, board, attempt, task, gate, actor, "allow", "allow", 1, 1, "[]", provenance, "local-trusted-client", "unsupported", "p", "k", "e", "sha256:"+"a".repeat(64)];
    expect(() => insert.run(...approval("unlisted", "active", "b", "t", "worker"))).toThrow(/approval actor/);
    expect(() => insert.run(...approval("inactive", "inactive"))).toThrow(/approval actor/);
    expect(() => insert.run(...approval("expired", "expired"))).toThrow(/approval actor/);
    expect(() => insert.run(...approval("scope", "inactive", "other", "t"))).toThrow();
    expect(() => insert.run(...approval("provenance", "inactive", "b", "t", "reviewer", "worker"))).toThrow();
    db.close();
  });

  it("enforces runtime expiry, immutability, and audit-chain guards", () => {
    const db = new Database(":memory:"); db.pragma("foreign_keys = ON"); createFreshCoreStore(db);
    db.exec(GOVERNANCE_TABLES_SQL); installRuntime(db);
    db.prepare("INSERT INTO fs_boards VALUES ('b','p','B',1,'{}',1,1)").run();
    db.prepare("INSERT INTO fs_tasks VALUES ('b','t','T','', 'p2','ready',NULL,'',1,NULL,'[]',1,1,0)").run();
    const hash = "sha256:" + "a".repeat(64), now = Math.floor(Date.now() / 1000);
    const attempt = "INSERT INTO fs_attempts VALUES (?,?,?,?,?,?,?,?,?,?,?)";
    expect(() => db.prepare(attempt).run("past", "b", "t", 1, "alice", hash, "active", now - 2, now - 1, null, null)).toThrow(/expiry/);
    db.prepare(attempt).run("a", "b", "t", 1, "alice", hash, "active", now, now + 100, null, null);
    const lease = "INSERT INTO fs_leases VALUES (?,?,?,?,?,?,?,?,?,?,?)";
    expect(() => db.prepare(lease).run("past-lease", "a", "alice", "src/**", "sensitive", "a".repeat(64), "active", 1, now, now - 1, now)).toThrow(/active lease/);
    db.prepare("INSERT INTO fs_idempotency (actor,tool,scope,key_hash,request_digest,response_json,result_code,resulting_revision,created_at) VALUES (?,?,?,?,?,?,?,?,?)")
      .run("alice", "tool", "scope", hash, hash, "{}", "ok", 1, now);
    expect(() => db.prepare("UPDATE fs_idempotency SET scope = 'other'").run()).toThrow(/immutable/);
    const audit = (ordinal: number, prev: string | null, eventHash: string) => db.prepare("INSERT INTO fs_audit_events VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)")
      .run(`e${ordinal}`, "b", "t", "a", "alice", "tool", "event", "task", "t", ordinal, prev, eventHash, "{}", now);
    const first = canonicalAuditEventDigest({ board_id: "b", task_id: "t", attempt_id: "a", actor: "alice", tool: "tool", event_type: "event", resource_type: "task", resource_id: "t", event_ordinal: 1, prev_hash: null, payload_json: {} });
    audit(1, null, first);
    const second = canonicalAuditEventDigest({ board_id: "b", task_id: "t", attempt_id: "a", actor: "alice", tool: "tool", event_type: "event", resource_type: "task", resource_id: "t", event_ordinal: 2, prev_hash: hash, payload_json: {} });
    expect(() => audit(2, hash, second)).toThrow(/chain/);
    db.close();
  });
});
