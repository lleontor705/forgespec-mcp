import Database from "better-sqlite3";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { recordApproval, queryApprovals, ApprovalDomainError, type ApprovalInput } from "../../src/domain/approvals.js";

describe("approval domain", () => {
  let db: Database.Database;
  const base = (): ApprovalInput => ({ boardId: "b", taskId: "t", gateId: "g", attemptId: "a1", reviewerActor: "reviewer", decision: "allow", notes: ["ok"], expectedTaskRevision: 1, idempotencyKey: "k1", nowMs: 2_000_000_000_000,
    provenance: { kind: "asserted", assertedActor: "reviewer", boundary: "local-trusted-client", mode: "native", approvalRef: { provider: "test", kind: "run", externalId: "x", digest: `sha256:${"a".repeat(64)}` } } });
  beforeEach(() => { db = new Database(":memory:"); createFreshStore(db); db.prepare("INSERT INTO fs_boards VALUES(?,?,?,?,?,?,?)").run("b", "p", "B", 1, "{}", 1, 1); db.prepare("INSERT INTO fs_tasks VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?)").run("b", "t", "T", "", "p2", "in_review", null, "", 1, null, "[]", 1, 1, 0); db.prepare("INSERT INTO fs_gates VALUES(?,?,?,?,?,?,?)").run("b", "g", "G", "[\"in_review\"]", "[\"reviewer\"]", 1, 1); db.prepare("INSERT INTO fs_attempts VALUES(?,?,?,?,?,?,?,?,?,?,?)").run("a1", "b", "t", 1, "worker", "sha256:" + "a".repeat(64), "active", 1, 2_000_000_100, null, null); });
  afterEach(() => db.close());
  it("records immutable gate decisions with worker/reviewer separation", () => { const first = recordApproval(db, base()); expect(first.actor).toBe("reviewer"); expect(first.attemptId).toBe("a1"); expect(recordApproval(db, base())).toEqual(first); expect(db.prepare("SELECT revision FROM fs_tasks WHERE id='t'").get()).toEqual({ revision: 2 }); });
  it("rejects unlisted actors and non-native provenance atomically", () => { const input = base(); input.reviewerActor = "worker"; input.provenance.assertedActor = "worker"; expect(() => recordApproval(db, input)).toThrow(ApprovalDomainError); expect(db.prepare("SELECT count(*) AS n FROM fs_approvals").get()).toEqual({ n: 0 }); });
  it("only exposes own decisions without exact task authority", () => { recordApproval(db, base()); expect(queryApprovals(db, { boardId: "b", actor: "reviewer" })).toHaveLength(1); expect(queryApprovals(db, { boardId: "b", actor: "other" })).toEqual([]); });
});
