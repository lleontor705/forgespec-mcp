import type Database from "better-sqlite3";

export const IDENTITY_TABLE_NAMES = ["fsi_meta", "fsi_keys", "fsi_revocations", "fsi_sessions", "fsi_replay"] as const;

export const IDENTITY_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS fsi_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
) STRICT;
CREATE TABLE IF NOT EXISTS fsi_keys (
  issuer TEXT NOT NULL, key_id TEXT NOT NULL, public_key TEXT NOT NULL,
  not_before INTEGER NOT NULL, not_after INTEGER NOT NULL, revoked_at INTEGER,
  PRIMARY KEY (issuer, key_id), CHECK (not_after > not_before)
) STRICT;
CREATE TABLE IF NOT EXISTS fsi_revocations (
  issuer TEXT NOT NULL, jti TEXT NOT NULL DEFAULT '', key_id TEXT NOT NULL DEFAULT '',
  revoked_at INTEGER NOT NULL, signature TEXT NOT NULL DEFAULT '',
  PRIMARY KEY (issuer, jti, key_id), CHECK ((jti <> '') <> (key_id <> ''))
) STRICT;
CREATE TABLE IF NOT EXISTS fsi_sessions (
  issuer TEXT NOT NULL, session_id TEXT NOT NULL, root TEXT NOT NULL,
  parent TEXT NOT NULL, worker TEXT NOT NULL, depth INTEGER NOT NULL,
  lineage_json TEXT NOT NULL, created_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  PRIMARY KEY (issuer, session_id), CHECK (expires_at > created_at)
) STRICT;
CREATE TABLE IF NOT EXISTS fsi_replay (
  issuer TEXT NOT NULL, jti TEXT NOT NULL, call_id TEXT NOT NULL,
  seen_at INTEGER NOT NULL, expires_at INTEGER NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'pending', outcome_code TEXT,
  key_id TEXT NOT NULL DEFAULT '', root TEXT NOT NULL DEFAULT '', parent TEXT NOT NULL DEFAULT '', worker TEXT NOT NULL DEFAULT '',
  tool TEXT NOT NULL DEFAULT '', args_digest TEXT NOT NULL DEFAULT '', pending_at INTEGER NOT NULL DEFAULT 0, completed_at INTEGER,
  PRIMARY KEY (issuer, jti), UNIQUE (issuer, call_id), CHECK (expires_at >= seen_at),
  CHECK (outcome IN ('pending','success','error'))
) STRICT;
`;

export function identityTableInventory(database: Database.Database): string[] {
  return (database.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

export function qualifyIdentitySchema(database: Database.Database): void {
  const names = identityTableInventory(database);
  const expected = [...IDENTITY_TABLE_NAMES].sort();
  if (names.join("\0") !== expected.join("\0")) throw new Error(`DATABASE_INCOMPATIBLE: identity table inventory (${names.join(", ") || "empty"})`);
  const rows = database.prepare("PRAGMA table_list").all() as { name: string; strict?: number }[];
  const tables = rows.filter((r) => expected.includes(r.name as typeof IDENTITY_TABLE_NAMES[number]));
  if (tables.length !== expected.length || tables.some((r) => r.strict !== 1)) throw new Error("DATABASE_INCOMPATIBLE: identity tables must be STRICT");
}
