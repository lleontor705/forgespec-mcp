import Database from "better-sqlite3";
import fs from "node:fs";
import path from "node:path";
import type { IdentitySession } from "./types.js";
import { IDENTITY_SCHEMA_SQL, identityTableInventory, qualifyIdentitySchema } from "./schema.js";

export type IdentityStore = Database.Database;
export type ReplayAudit = { issuer: string; jti: string; callId: string };
export type ReplayOutcome = { outcome: "success" | "error"; code: string; completedAt?: number };
const names = ["fsi_meta", "fsi_keys", "fsi_revocations", "fsi_sessions", "fsi_replay"];

export function createFreshIdentityStore(database: IdentityStore): void {
  database.pragma("busy_timeout = 10000"); database.pragma("foreign_keys = ON"); database.pragma("journal_mode = WAL");
  const inventory = identityTableInventory(database);
  if (inventory.length && (inventory.length !== names.length || inventory.some((n) => !names.includes(n)))) throw new Error("DATABASE_INCOMPATIBLE: identity sidecar inventory");
  if (inventory.length) qualifyIdentitySchema(database);
  database.exec("BEGIN IMMEDIATE");
  try { database.exec(IDENTITY_SCHEMA_SQL); database.prepare("INSERT OR IGNORE INTO fsi_meta (key, value) VALUES ('schema_version', '1.0.0')").run(); database.exec("COMMIT"); }
  catch (error) { database.exec("ROLLBACK"); throw error; }
  qualifyIdentitySchema(database);
}

export function openIdentityStore(file: string): IdentityStore {
  if (file !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  const database = new Database(file);
  try {
    createFreshIdentityStore(database);
    return database;
  } catch (error) { database.close(); throw error; }
}

export function keyUsable(database: IdentityStore, issuer: string, keyId: string, at = Date.now()): boolean {
  const row = database.prepare("SELECT not_before, not_after, revoked_at FROM fsi_keys WHERE issuer=? AND key_id=?").get(issuer, keyId) as { not_before: number; not_after: number; revoked_at: number | null } | undefined;
  return !!row && row.revoked_at === null && at >= row.not_before && at <= row.not_after;
}

export function jtiRevoked(database: IdentityStore, issuer: string, jti: string): boolean {
  return !!database.prepare("SELECT 1 FROM fsi_revocations WHERE issuer=? AND jti=?").get(issuer, jti);
}

export function rememberReplay(database: IdentityStore, issuer: string, jti: string, callId: string, seenAt = Date.now(), ttlMs = 300_000): boolean {
  try { database.prepare("INSERT INTO fsi_replay (issuer,jti,call_id,seen_at,expires_at) VALUES (?,?,?,?,?)").run(issuer, jti, callId, seenAt, seenAt + ttlMs); return true; }
  catch (error) { if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) return false; throw error; }
}

export function beginReplay(database: IdentityStore, input: { issuer: string; jti: string; callId: string; keyId: string; root: string; parent: string; worker: string; tool: string; argsDigest: string; pendingAt: number; expiresAt: number }): boolean {
  try {
    database.prepare("INSERT INTO fsi_replay (issuer,jti,call_id,seen_at,expires_at,outcome,key_id,root,parent,worker,tool,args_digest,pending_at) VALUES (?,?,?,?,?,'pending',?,?,?,?,?,?,?)").run(input.issuer, input.jti, input.callId, input.pendingAt, input.expiresAt, input.keyId, input.root, input.parent, input.worker, input.tool, input.argsDigest, input.pendingAt);
    return true;
  } catch (error) { if (error instanceof Error && /UNIQUE|constraint/i.test(error.message)) return false; throw error; }
}

export function finalizeReplay(database: IdentityStore, audit: ReplayAudit, result: ReplayOutcome): void {
  const changes = database.prepare("UPDATE fsi_replay SET outcome=?, outcome_code=?, completed_at=? WHERE issuer=? AND jti=? AND outcome='pending'").run(result.outcome, result.code, result.completedAt ?? Date.now(), audit.issuer, audit.jti).changes;
  if (changes !== 1) throw new Error("IDENTITY_AUDIT_FAILED");
}

export function cleanupReplay(database: IdentityStore, now = Date.now(), limit = 1000): number {
  if (!Number.isSafeInteger(limit) || limit < 1) return 0;
  return database.prepare("DELETE FROM fsi_replay WHERE rowid IN (SELECT rowid FROM fsi_replay WHERE expires_at < ? ORDER BY expires_at LIMIT ?)").run(now, limit).changes;
}

export function saveSession(database: IdentityStore, issuer: string, sessionId: string, session: IdentitySession, createdAt: number, expiresAt: number): void {
  database.prepare("INSERT INTO fsi_sessions (issuer,session_id,root,parent,worker,depth,lineage_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)").run(issuer, sessionId, session.root, session.parent, session.worker, session.depth, JSON.stringify(session.lineage), createdAt, expiresAt);
}

/** Resolve only worker handles that the identity sidecar has enrolled. */
export function resolveWorkerHandle(database: IdentityStore, handle: string): string | undefined {
  if (typeof handle !== "string" || handle.length === 0 || handle.length > 1024) return undefined;
  const row = database.prepare("SELECT worker FROM fsi_sessions WHERE worker=? LIMIT 1").get(handle) as { worker: string } | undefined;
  return row?.worker;
}
