import Database from "better-sqlite3";
import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { migrateDatabase } from "./migrations.js";
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
  new TaskService(db).reconcileAllProjections();

  const versionInfo = db.prepare("SELECT sqlite_version() as version").get() as { version: string };
  console.error(`ForgeSpec MCP: SQLite ${versionInfo.version}, WAL mode enabled`);

  return db;
}

export function closeDb(): void {
  if (db) {
    db.close();
    db = null;
  }
}
