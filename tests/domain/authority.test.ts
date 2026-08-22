import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { createTestDatabase, removeTestDatabases } from "../helpers/database.js";
import { createRootAuthorityRows, grantAuthority, queryAuthority, revokeAuthority, AuthorityDomainError } from "../../src/domain/authority/service.js";

describe("exact-resource authority", () => {
  let db: ReturnType<typeof createTestDatabase>["database"];
  beforeEach(() => { db = createTestDatabase().database; db.exec(`CREATE TABLE fs_boards(id TEXT PRIMARY KEY, project TEXT, name TEXT, created_at INTEGER, updated_at INTEGER);
    CREATE TABLE fs_authority(authority_id TEXT PRIMARY KEY,parent_authority_id TEXT,board_id TEXT NOT NULL,resource_kind TEXT,resource_id TEXT,actor TEXT,grantee_actor TEXT,operation TEXT,granted_by_actor TEXT,lineage_kind TEXT,status TEXT,token_hash TEXT,revision INTEGER,granted_at INTEGER,expires_at INTEGER);
    CREATE TABLE fs_authority_revocations(revocation_id TEXT PRIMARY KEY,authority_id TEXT UNIQUE,actor TEXT,reason TEXT,revoked_at INTEGER);
    CREATE TABLE fs_idempotency(actor TEXT,tool TEXT,scope TEXT,key_hash TEXT,request_digest TEXT,response_json TEXT,result_code TEXT,resulting_revision INTEGER,created_at INTEGER,PRIMARY KEY(actor,tool,key_hash));
    CREATE TRIGGER revoke_desc AFTER INSERT ON fs_authority_revocations BEGIN INSERT OR IGNORE INTO fs_authority_revocations VALUES('p:'||NEW.authority_id,(SELECT authority_id FROM fs_authority WHERE parent_authority_id=NEW.authority_id),NEW.actor,'ancestor',NEW.revoked_at); END;`); db.prepare("INSERT INTO fs_boards(id,project,name,created_at,updated_at) VALUES('b','p','B',1,1)").run(); });
  afterAll(removeTestDatabases);
  const board = { kind: "board" as const, boardId: "b" };
  it("creates exact roots and attenuated grants", () => {
    const roots = createRootAuthorityRows(db, { boardId: "b", ownerActor: "owner", expiresAt: 100, now: 1 });
    expect(roots).toHaveLength(9);
    const grants = grantAuthority(db, { actor: "owner", granteeActor: "alice", resource: board, operations: ["read_board"], expiresAt: 50, now: 2, idempotencyKey: "x" });
    expect(grants[0].parentAuthorityId).toBe(roots[0].authorityId);
    expect(queryAuthority(db, { actor: "alice", resource: board, operation: "read_board", now: 3 })).toHaveLength(1);
  });
  it("is atomic for multi-operation requests and rejects forged grantors", () => {
    createRootAuthorityRows(db, { boardId: "b", ownerActor: "owner", expiresAt: 100, now: 1 });
    expect(() => grantAuthority(db, { actor: "mallory", granteeActor: "alice", resource: board, operations: ["read_board", "update"], expiresAt: 50, now: 2 })).toThrow(AuthorityDomainError);
    expect(db.prepare("SELECT count(*) n FROM fs_authority WHERE lineage_kind='delegated'").get()).toEqual({ n: 0 });
  });
  it("rejects root initialization on an already-authorized board", () => {
    createRootAuthorityRows(db, { boardId: "b", ownerActor: "owner", expiresAt: 100, now: 1 });
    expect(() => createRootAuthorityRows(db, { boardId: "b", ownerActor: "mallory", expiresAt: 100, now: 2 }))
      .toThrowError(new AuthorityDomainError("RESOURCE_NOT_AVAILABLE"));
    expect(queryAuthority(db, { actor: "mallory", resource: board, operation: "read_board", now: 3 })).toHaveLength(0);
  });
  it("selects each acting delegate as parent and revokes the delegation chain", () => {
    createRootAuthorityRows(db, { boardId: "b", ownerActor: "owner", expiresAt: 100, now: 1 });
    const alice = grantAuthority(db, { actor: "owner", granteeActor: "alice", resource: board, operations: ["read_board"], expiresAt: 90, now: 2 });
    const bob = grantAuthority(db, { actor: "alice", granteeActor: "bob", resource: board, operations: ["read_board"], expiresAt: 80, now: 3 });
    expect(bob[0].parentAuthorityId).toBe(alice[0].authorityId);
    revokeAuthority(db, { actor: "owner", boardId: "b", authorityId: alice[0].authorityId, now: 4 });
    expect(queryAuthority(db, { actor: "bob", resource: board, operation: "read_board", now: 5 })).toHaveLength(0);
  });
  it("replays and revokes descendants", () => {
    const root = createRootAuthorityRows(db, { boardId: "b", ownerActor: "owner", expiresAt: 100, now: 1 });
    const a = grantAuthority(db, { actor: "owner", granteeActor: "alice", resource: board, operations: ["revoke"], expiresAt: 50, now: 2, idempotencyKey: "r" });
    expect(grantAuthority(db, { actor: "owner", granteeActor: "alice", resource: board, operations: ["revoke"], expiresAt: 50, now: 2, idempotencyKey: "r" })[0].authorityId).toBe(a[0].authorityId);
    revokeAuthority(db, { actor: "owner", boardId: "b", authorityId: a[0].authorityId, now: 3 });
    expect(queryAuthority(db, { actor: "alice", resource: board, operation: "revoke", now: 4 })).toHaveLength(0);
    expect(root).toHaveLength(9);
  });
  it("does not reveal unknown resources and rejects wildcard operations", () => {
    expect(queryAuthority(db, { actor: "mallory", resource: { kind: "board", boardId: "missing" } })).toEqual([]);
    expect(() => createRootAuthorityRows(db, { boardId: "b", ownerActor: "o", expiresAt: 2, now: 2 })).toThrow(AuthorityDomainError);
    expect(() => grantAuthority(db, { actor: "o", granteeActor: "a", resource: board, operations: ["*"] as never, expiresAt: 4, now: 1 })).toThrow(AuthorityDomainError);
  });
});
