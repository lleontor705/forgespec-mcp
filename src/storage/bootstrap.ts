import type Database from "better-sqlite3";
import { CORE_TABLES_SQL } from "./schema/core-tables.js";
import { CORE_TRIGGERS_SQL } from "./schema/core-triggers.js";
import { CORE_TABLE_NAMES } from "./schema/core-tables.js";
import { GOVERNANCE_TABLE_NAMES, GOVERNANCE_TABLES_SQL } from "./schema/governance-tables.js";
import { AUTHORITY_TRIGGERS_SQL } from "./schema/authority-triggers.js";
import { FS_CANONICAL_AUDIT_EVENT_HASH, FS_NORMALIZE_ACTOR_SET, RUNTIME_TRIGGERS_SQL } from "./schema/runtime-triggers.js";
import { canonicalAuditEventDigest } from "./audit-integrity.js";
import { normalizeActorSet } from "./actor-set.js";
import { qualifyExistingCore, qualifySQLite } from "./qualify.js";

export const CORE_SCHEMA_SQL = `${CORE_TABLES_SQL}\n${CORE_TRIGGERS_SQL}`;
export const FULL_SCHEMA_SQL = `${CORE_SCHEMA_SQL}\n${GOVERNANCE_TABLES_SQL}\n${AUTHORITY_TRIGGERS_SQL}\n${RUNTIME_TRIGGERS_SQL}`;

function registerRuntimeFunctions(database: Database.Database): void {
  database.function(FS_NORMALIZE_ACTOR_SET, (value: string) => normalizeActorSet(value));
  database.function(FS_CANONICAL_AUDIT_EVENT_HASH, (boardId: string, taskId: string, attemptId: string, actor: string, tool: string,
    eventType: string, resourceType: string, resourceId: string, ordinal: number, prevHash: string | null, payload: string) =>
    canonicalAuditEventDigest({ board_id: boardId, task_id: taskId, attempt_id: attemptId, actor, tool, event_type: eventType,
      resource_type: resourceType, resource_id: resourceId, event_ordinal: Number(ordinal), prev_hash: prevHash,
      payload_json: JSON.parse(payload) }));
}

function fullInventory(database: Database.Database): "empty" | "core" | "full" {
  const names = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(({ name }) => name).filter((name) => name && !name.startsWith("sqlite_")).sort();
  const core = [...CORE_TABLE_NAMES].sort();
  const full = [...CORE_TABLE_NAMES, ...GOVERNANCE_TABLE_NAMES].sort();
  if (names.length === 0) return "empty";
  if (names.join("\0") === core.join("\0")) return "core";
  if (names.join("\0") === full.join("\0")) return "full";
  throw new Error(`DATABASE_INCOMPATIBLE: unsupported existing tables: ${names.join(", ")}`);
}

function qualifyExistingFull(database: Database.Database): void {
  const expected = new Set<string>([...CORE_TABLE_NAMES, ...GOVERNANCE_TABLE_NAMES]);
  const rows = database.prepare("PRAGMA table_list").all() as Array<{ name?: string; strict?: number }>;
  if (rows.some((row) => !Object.prototype.hasOwnProperty.call(row, "strict")))
    throw new Error("DATABASE_INCOMPATIBLE: PRAGMA table_list strict metadata unavailable");
  const tables = rows.filter((row) => row.name && !row.name.startsWith("sqlite_") && expected.has(row.name));
  if (tables.length !== expected.size || tables.some((row) => row.strict !== 1))
    throw new Error("DATABASE_INCOMPATIBLE: expected STRICT tables");
}

export function createFreshCoreStore(database: Database.Database): void {
  const now = Date.now();
  const inventory = qualifyExistingCore(database);
  qualifySQLite(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(CORE_SCHEMA_SQL);
    if (inventory === "core") {
      database.prepare("UPDATE fs_schema_meta SET updated_at = ? WHERE key = 'core'").run(now);
    } else {
      database.prepare("INSERT INTO fs_schema_meta (key, schema_version, bootstrapped_at, updated_at, bootstrap_metadata_json, recovery_mode) VALUES (?, ?, ?, ?, ?, ?)")
        .run("core", "2.0.0", now, now, JSON.stringify({ source: "storage/bootstrap.ts", builtAt: now }), 0);
    }
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}

/** Bootstrap the complete modular store, accepting only empty, core, or full inventories. */
export function createFreshStore(database: Database.Database): void {
  qualifySQLite(database);
  const inventory = fullInventory(database);
  if (inventory === "core") qualifyExistingCore(database);
  if (inventory === "full") {
    qualifyExistingFull(database);
    const metadata = database.prepare("SELECT schema_version, bootstrapped_at, updated_at, bootstrap_metadata_json, recovery_mode FROM fs_schema_meta WHERE key = 'core'").get() as {
      schema_version: string; bootstrapped_at: number; updated_at: number; bootstrap_metadata_json: string; recovery_mode: number;
    } | undefined;
    if (!metadata || metadata.schema_version !== "2.0.0" || !Number.isInteger(metadata.bootstrapped_at) ||
      !Number.isInteger(metadata.updated_at) || ![0, 1].includes(metadata.recovery_mode) ||
      (database.prepare("SELECT json_valid(?) AS valid").get(metadata.bootstrap_metadata_json) as { valid: number }).valid !== 1)
      throw new Error("DATABASE_INCOMPATIBLE: fs_schema_meta core Protocol 2.0 metadata is invalid");
  }
  registerRuntimeFunctions(database);
  const now = Date.now();
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(FULL_SCHEMA_SQL);
    const metadata = database.prepare("SELECT 1 FROM fs_schema_meta WHERE key = 'core'").get();
    if (metadata) database.prepare("UPDATE fs_schema_meta SET updated_at = ? WHERE key = 'core'").run(now);
    else database.prepare("INSERT INTO fs_schema_meta (key, schema_version, bootstrapped_at, updated_at, bootstrap_metadata_json, recovery_mode) VALUES (?, ?, ?, ?, ?, ?)")
      .run("core", "2.0.0", now, now, JSON.stringify({ source: "storage/bootstrap.ts", builtAt: now }), 0);
    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
