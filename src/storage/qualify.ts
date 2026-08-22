import type Database from "better-sqlite3";
import { CORE_TABLE_NAMES } from "./schema/core-tables.js";

export type CoreInventory = "empty" | "core";
const CORE_TABLES = new Set<string>(CORE_TABLE_NAMES);

/** Inspect user tables without changing the database. */
export function inventoryCoreStore(database: Database.Database): CoreInventory {
  const names = (database.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>)
    .map(({ name }) => name).filter((name: string) => name && !name.startsWith("sqlite_")).sort();
  if (names.length === 0) return "empty";
  const actual = new Set(names);
  if (names.length === CORE_TABLE_NAMES.length && CORE_TABLE_NAMES.every((name) => actual.has(name))) return "core";
  const unexpected = names.filter((name) => !CORE_TABLES.has(name)).join(", ");
  throw new Error(`DATABASE_INCOMPATIBLE: unsupported existing tables: ${unexpected || names.join(", ")}`);
}

/** Validate connection features before any schema statement can mutate it. */
export function qualifySQLite(database: Database.Database): void {
  const foreignKeys = String(database.pragma("foreign_keys", { simple: true })).toLowerCase();
  if (foreignKeys !== "on" && foreignKeys !== "1") throw new Error("DATABASE_INCOMPATIBLE: foreign_keys pragma must be ON");
  const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
  if (journalMode !== "wal" && journalMode !== "memory") throw new Error(`DATABASE_INCOMPATIBLE: journal_mode must be WAL (currently ${journalMode})`);
  try {
    const result = database.prepare("SELECT json_valid(?) AS valid").get('{"core":true}') as { valid: number };
    if (result.valid !== 1) throw new Error("json1-disabled");
  } catch {
    throw new Error("DATABASE_INCOMPATIBLE: json1 extension (json_valid) is not available");
  }
}

export function qualifyExistingCore(database: Database.Database): CoreInventory {
  const inventory = inventoryCoreStore(database);
  if (inventory === "empty") return inventory;
  const metadata = database.prepare("SELECT schema_version, bootstrapped_at, updated_at, bootstrap_metadata_json, recovery_mode FROM fs_schema_meta WHERE key = 'core'").get() as {
    schema_version: string; bootstrapped_at: number; updated_at: number; bootstrap_metadata_json: string; recovery_mode: number;
  } | undefined;
  if (!metadata || metadata.schema_version !== "2.0.0" || !Number.isInteger(metadata.bootstrapped_at) || !Number.isInteger(metadata.updated_at) || ![0, 1].includes(metadata.recovery_mode))
    throw new Error("DATABASE_INCOMPATIBLE: fs_schema_meta core Protocol 2.0 metadata is invalid");
  try {
    if ((database.prepare("SELECT json_valid(?) AS valid").get(metadata.bootstrap_metadata_json) as { valid: number }).valid !== 1) throw new Error();
  } catch { throw new Error("DATABASE_INCOMPATIBLE: fs_schema_meta bootstrap metadata is invalid"); }
  return inventory;
}
