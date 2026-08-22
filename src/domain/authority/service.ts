import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { AUTHORITY_OPERATIONS, type AuthorityOperation } from "./types.js";
import { executeMutation, TransactionDomainError } from "../transaction.js";

export type AuthorityResource = { kind: "board" | "task"; boardId: string; resourceId?: string };
export type AuthorityRow = {
  authorityId: string; parentAuthorityId: string | null; resource: AuthorityResource;
  actor: string; granteeActor: string; operation: AuthorityOperation; grantedByActor: string;
  lineageKind: "owner_root" | "delegated"; status: string; grantedAt: number; expiresAt: number;
};

export class AuthorityDomainError extends Error {
  constructor(readonly code: "REQUEST_INVALID" | "RESOURCE_NOT_AVAILABLE" | "AUTH_DENIED" | "IDEMPOTENCY_CONFLICT") {
    super(code); this.name = "AuthorityDomainError";
  }
}

const OPERATIONS = new Set<string>(AUTHORITY_OPERATIONS);
const text = (v: unknown): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= 256;
const digest = (v: string): string => createHash("sha256").update(v).digest("hex");

function resource(input: AuthorityResource): { kind: "board" | "task"; boardId: string; id: string } {
  if (!input || !text(input.boardId) || (input.kind !== "board" && input.kind !== "task")) throw new AuthorityDomainError("REQUEST_INVALID");
  const id = input.kind === "board" ? input.boardId : input.resourceId;
  if (!text(id) || (input.kind === "board" && input.resourceId !== undefined)) throw new AuthorityDomainError("REQUEST_INVALID");
  return { kind: input.kind, boardId: input.boardId, id };
}

function exists(db: Database.Database, r: ReturnType<typeof resource>): boolean {
  return r.kind === "board"
    ? Boolean(db.prepare("SELECT 1 FROM fs_boards WHERE id = ?").get(r.id))
    : Boolean(db.prepare("SELECT 1 FROM fs_tasks WHERE board_id = ? AND id = ?").get(r.boardId, r.id));
}

function checkOps(operations: readonly string[]): asserts operations is readonly AuthorityOperation[] {
  if (!Array.isArray(operations) || operations.length < 1 || operations.length > AUTHORITY_OPERATIONS.length ||
      new Set(operations).size !== operations.length || operations.some((op) => !OPERATIONS.has(op))) throw new AuthorityDomainError("REQUEST_INVALID");
}

function effective(db: Database.Database, actor: string, r: ReturnType<typeof resource>, op: string, now: number): any[] {
  return db.prepare(`WITH RECURSIVE chain(authority_id, parent_authority_id, status, expires_at, grantee_actor, granted_by_actor) AS (
      SELECT authority_id, parent_authority_id, status, expires_at, grantee_actor, granted_by_actor FROM fs_authority
       WHERE board_id = ? AND resource_kind = ? AND resource_id = ? AND operation = ? AND grantee_actor = ?
      UNION ALL SELECT p.authority_id, p.parent_authority_id, p.status, p.expires_at, p.grantee_actor, p.granted_by_actor
        FROM fs_authority p JOIN chain c ON p.authority_id = c.parent_authority_id)
     SELECT a.* FROM fs_authority a JOIN chain c ON c.authority_id = a.authority_id
      WHERE a.status = 'active' AND a.expires_at > ?
        AND NOT EXISTS (SELECT 1 FROM fs_authority_revocations x JOIN chain z ON z.authority_id = x.authority_id WHERE x.authority_id = z.authority_id)
        AND NOT EXISTS (SELECT 1 FROM chain z WHERE z.status <> 'active' OR z.expires_at <= ?)`)
      .all(r.boardId, r.kind, r.id, op, actor, now, now) as any[];
}

export function hasEffectiveAuthority(db: Database.Database, input: { actor: string; boardId: string; resourceKind: "board" | "task"; resourceId: string; operation: AuthorityOperation; now: number }): boolean {
  if (!text(input.actor) || !text(input.boardId) || !text(input.resourceId) || !OPERATIONS.has(input.operation)) return false;
  const r = resource({ kind: input.resourceKind, boardId: input.boardId, ...(input.resourceKind === "task" ? { resourceId: input.resourceId } : {}) });
  return parentEffective(db, input.actor, r, input.operation, input.now).length > 0;
}

const TASK_ROW_OPERATIONS = ["read_task", "update", "approve", "recover", "grant", "handoff", "revoke"] as const;
export function createTaskAuthorityRows(db: Database.Database, input: { boardId: string; taskId: string; actor: string; expiresAt: number; now?: number }): AuthorityRow[] {
  const now = input.now ?? Date.now();
  if (!text(input.actor) || !text(input.boardId) || !text(input.taskId) || !Number.isFinite(input.expiresAt) || input.expiresAt <= now) throw new AuthorityDomainError("REQUEST_INVALID");
  const r = resource({ kind: "task", boardId: input.boardId, resourceId: input.taskId });
  if (!exists(db, r)) throw new AuthorityDomainError("RESOURCE_NOT_AVAILABLE");
  const work = () => TASK_ROW_OPERATIONS.map((op) => {
    const parent = effective(db, input.actor, { kind: "board", boardId: input.boardId, id: input.boardId }, op, now)
      .find((p) => p.grantee_actor === input.actor && p.expires_at >= input.expiresAt);
    if (!parent) throw new AuthorityDomainError("AUTH_DENIED");
    const id = `task-${digest(`${input.boardId}\0${input.taskId}\0${input.actor}\0${op}`)}`;
    db.prepare(`INSERT INTO fs_authority(authority_id,parent_authority_id,board_id,resource_kind,resource_id,actor,grantee_actor,operation,granted_by_actor,lineage_kind,status,token_hash,revision,granted_at,expires_at)
      VALUES(?,?,?,?,?,?,?,?,?,'delegated','active',?,1,?,?) ON CONFLICT(authority_id) DO NOTHING`).run(id, parent.authority_id, input.boardId, "task", input.taskId, input.actor, input.actor, op, input.actor, digest(id), now, input.expiresAt);
    return row(db.prepare("SELECT * FROM fs_authority WHERE authority_id = ?").get(id));
  });
  return work();
}

// A task grant may be attenuated from the board root.  The parent lookup is
// deliberately board-qualified; task ids are only unique within a board.
function parentEffective(db: Database.Database, actor: string, r: ReturnType<typeof resource>, op: string, now: number): any[] {
  const exact = effective(db, actor, r, op, now);
  if (r.kind === "board") return exact;
  return exact.concat(effective(db, actor, { kind: "board", boardId: r.boardId, id: r.boardId }, op, now));
}

function row(r: any): AuthorityRow {
  return { authorityId: r.authority_id, parentAuthorityId: r.parent_authority_id, resource: { kind: r.resource_kind, boardId: r.board_id, ...(r.resource_kind === "task" ? { resourceId: r.resource_id } : {}) }, actor: r.actor,
    granteeActor: r.grantee_actor, operation: r.operation, grantedByActor: r.granted_by_actor, lineageKind: r.lineage_kind,
    status: r.status, grantedAt: r.granted_at, expiresAt: r.expires_at };
}

/** @internal Transaction helper used only while creating a fresh board. */
export function createRootAuthorityRows(db: Database.Database, input: { boardId: string; ownerActor: string; expiresAt: number; now?: number; transactional?: boolean }): AuthorityRow[] {
  const now = input.now ?? Date.now();
  if (!text(input.boardId) || !text(input.ownerActor) || !Number.isFinite(input.expiresAt) || input.expiresAt <= now) throw new AuthorityDomainError("REQUEST_INVALID");
  const r = resource({ kind: "board", boardId: input.boardId });
  if (!exists(db, r)) throw new AuthorityDomainError("RESOURCE_NOT_AVAILABLE");
  if (db.prepare("SELECT 1 FROM fs_authority WHERE board_id = ? LIMIT 1").get(input.boardId))
    throw new AuthorityDomainError("RESOURCE_NOT_AVAILABLE");
  const work = () => {
    const out: AuthorityRow[] = [];
    for (const op of AUTHORITY_OPERATIONS) {
      const id = `root-${digest(`${input.boardId}\0${input.ownerActor}\0${op}`)}`;
      db.prepare(`INSERT INTO fs_authority(authority_id,parent_authority_id,board_id,resource_kind,resource_id,actor,grantee_actor,operation,granted_by_actor,lineage_kind,status,token_hash,revision,granted_at,expires_at)
        VALUES(?,NULL,?,'board',?,?,?,?,?,'owner_root','active',?,1,?,?) ON CONFLICT(authority_id) DO NOTHING`)
        .run(id, input.boardId, input.boardId, input.ownerActor, input.ownerActor, op, input.ownerActor, digest(id), now, input.expiresAt);
      const value = db.prepare("SELECT * FROM fs_authority WHERE authority_id = ?").get(id) as any;
      out.push(row(value));
    }
    return out;
  };
  return input.transactional === false ? work() : db.transaction(work)();
}

export type GrantAuthorityInput = { actor: string; granteeActor: string; resource: AuthorityResource; operations: readonly AuthorityOperation[]; expiresAt: number; now?: number; idempotencyKey?: string };
export function grantAuthority(db: Database.Database, input: GrantAuthorityInput): AuthorityRow[] {
  const now = input.now ?? Date.now(); const r = resource(input.resource); checkOps(input.operations);
  if (!text(input.actor) || !text(input.granteeActor) || !Number.isFinite(input.expiresAt) || input.expiresAt <= now || (input.idempotencyKey !== undefined && !text(input.idempotencyKey))) throw new AuthorityDomainError("REQUEST_INVALID");
  if (!exists(db, r)) throw new AuthorityDomainError("RESOURCE_NOT_AVAILABLE");
  const idempotencyKey = input.idempotencyKey ?? `implicit-${digest(JSON.stringify({ actor: input.actor, granteeActor: input.granteeActor, resource: r, operations: input.operations, expiresAt: input.expiresAt }))}`;
  try {
    return executeMutation(db, { actor: input.actor, tool: "authority.grant", idempotencyKey, request: { ...input, idempotencyKey }, work: (database) => {
    const parents = new Map<string, any>();
    for (const op of input.operations) {
      const p = parentEffective(database, input.actor, r, op, now)
        .find((candidate) => candidate.grantee_actor === input.actor && candidate.expires_at >= input.expiresAt);
      if (!p) throw new AuthorityDomainError("AUTH_DENIED");
      parents.set(op, p);
    }
    if ([...parents.values()].some((p) => input.expiresAt > p.expires_at)) throw new AuthorityDomainError("AUTH_DENIED");
    const out: AuthorityRow[] = [];
    for (const op of input.operations) {
      const id = `grant-${digest(`${input.idempotencyKey ?? ""}\0${input.actor}\0${input.granteeActor}\0${r.kind}\0${r.id}\0${op}`)}`;
      const existing = database.prepare("SELECT * FROM fs_authority WHERE authority_id = ?").get(id) as any;
      if (existing && (existing.expires_at !== input.expiresAt || existing.granted_by_actor !== input.actor)) throw new AuthorityDomainError("IDEMPOTENCY_CONFLICT");
      if (!existing) database.prepare(`INSERT INTO fs_authority(authority_id,parent_authority_id,board_id,resource_kind,resource_id,actor,grantee_actor,operation,granted_by_actor,lineage_kind,status,token_hash,revision,granted_at,expires_at)
        VALUES(?,?,?,?,?,?,?,?,?,'delegated','active',?,1,?,?)`).run(id, parents.get(op).authority_id, r.boardId, r.kind, r.id, input.actor, input.granteeActor, op, input.actor, digest(id), now, input.expiresAt);
      out.push(row(database.prepare("SELECT * FROM fs_authority WHERE authority_id = ?").get(id)));
    }
    return out;
    }}).response;
  } catch (error) {
    if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new AuthorityDomainError("IDEMPOTENCY_CONFLICT");
    throw error;
  }
}

export function revokeAuthority(db: Database.Database, input: { actor: string; boardId: string; authorityId: string; reason?: string; now?: number; idempotencyKey?: string }): void {
  const now = input.now ?? Date.now();
  if (!text(input.actor) || !text(input.boardId) || !text(input.authorityId) || (input.reason !== undefined && input.reason.length > 1024)) throw new AuthorityDomainError("REQUEST_INVALID");
  const idempotencyKey = input.idempotencyKey ?? `implicit-${digest(input.authorityId)}`;
  try { executeMutation(db, { actor: input.actor, tool: "authority.revoke", idempotencyKey, request: { ...input, idempotencyKey }, work: (database) => {
    const target = database.prepare("SELECT * FROM fs_authority WHERE authority_id = ? AND board_id = ?").get(input.authorityId, input.boardId) as any;
    if (!target) throw new AuthorityDomainError("RESOURCE_NOT_AVAILABLE");
    const r = { kind: target.resource_kind, boardId: target.board_id, id: target.resource_id } as ReturnType<typeof resource>;
    const allowed = input.actor === target.granted_by_actor || input.actor === target.actor || effective(database, input.actor, r, "revoke", now).length > 0;
    if (!allowed) throw new AuthorityDomainError("AUTH_DENIED");
    database.prepare("INSERT INTO fs_authority_revocations(revocation_id,authority_id,actor,reason,revoked_at) VALUES(?,?,?,?,?) ON CONFLICT(authority_id) DO NOTHING")
      .run(`revoke-${digest(input.authorityId)}`, input.authorityId, input.actor, input.reason ?? "revoked", now);
    return null;
  }}); } catch (error) {
    if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT") throw new AuthorityDomainError("IDEMPOTENCY_CONFLICT");
    throw error;
  }
}

export function queryAuthority(db: Database.Database, input: { actor: string; resource?: AuthorityResource; operation?: AuthorityOperation; now?: number }): AuthorityRow[] {
  if (!text(input.actor)) throw new AuthorityDomainError("REQUEST_INVALID");
  if (!input.resource) return [];
  const r = resource(input.resource); if (!exists(db, r)) return [];
  if (input.operation !== undefined && !OPERATIONS.has(input.operation)) throw new AuthorityDomainError("REQUEST_INVALID");
  const ops = input.operation ? [input.operation] : AUTHORITY_OPERATIONS;
  return ops.flatMap((op) => effective(db, input.actor, r, op, input.now ?? Date.now())
    .filter((grant) => grant.grantee_actor === input.actor || grant.granted_by_actor === input.actor).map(row));
}
