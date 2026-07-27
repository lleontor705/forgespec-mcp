import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDatabase } from "../../src/database/migrations.js";

const directories: string[] = [];

export function openTestDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  return database;
}

export function createTestDatabase(prefix = "forgespec-direct-"): {
  path: string;
  database: Database.Database;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  const databasePath = path.join(directory, "forgespec.db");
  migrateDatabase(databasePath);
  return { path: databasePath, database: openTestDatabase(databasePath) };
}

export function removeTestDatabases(): void {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
  }
}
