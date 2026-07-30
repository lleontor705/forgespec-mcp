import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrateDatabase, qualifyDatabase } from "./migrations.js";
import { TaskService } from "../services/task-service.js";

const DEFAULT_DIR = path.join(os.homedir(), ".forgespec");
const DB_DIR = process.env.FORGESPEC_DIR || DEFAULT_DIR;
const DB_PATH = process.env.FORGESPEC_DB || path.join(DB_DIR, "forgespec.db");

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;

  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  migrateDatabase(DB_PATH);

  db = new Database(DB_PATH);
  db.pragma("journal_mode = WAL");
  db.pragma("synchronous = normal");
  db.pragma("cache_size = -32000");
  db.pragma("temp_store = memory");
  db.pragma("busy_timeout = 5000");
  db.pragma("foreign_keys = ON");
  const qualification = qualifyDatabase(db, { requireWal: true });
  new TaskService(db).reconcileAllProjections();

  console.error(formatQualification(qualification));

  return db;
}

function formatQualification(qualification: ReturnType<typeof qualifyDatabase>): string {
  const capabilities = [
    `STRICT=${qualification.strictTables ? "ok" : "missing"}`,
    `JSON1=${qualification.json1 ? "ok" : "missing"}`,
    `journal_mode=${qualification.journalMode}`,
  ];
  return `ForgeSpec MCP: SQLite ${qualification.sqliteVersion}; ${capabilities.join("; ")}`;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
