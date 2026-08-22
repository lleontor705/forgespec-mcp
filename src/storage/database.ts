import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createFreshStore } from "./bootstrap.js";

const DEFAULT_DIR = path.join(os.homedir(), ".forgespec");
let current: Database.Database | null = null;

export function databasePath(): string {
  const configured = process.env.FORGESPEC_DB?.trim();
  if (configured === ":memory:") return configured;
  const directory = process.env.FORGESPEC_DIR?.trim() || DEFAULT_DIR;
  return path.resolve(configured || path.join(directory, "forgespec.db"));
}

export function open(file = databasePath()): Database.Database {
  if (current) return current;
  const resolved = file === ":memory:" ? file : path.resolve(file);
  if (resolved !== ":memory:") fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const database = new Database(resolved);
  try {
    database.pragma("busy_timeout = 10000");
    database.pragma("foreign_keys = ON");
    database.pragma("journal_mode = WAL");
    createFreshStore(database);
    current = database;
    return database;
  } catch (error) {
    database.close();
    throw error;
  }
}

export function get(): Database.Database {
  return current ?? open();
}

export function close(): void {
  if (current) {
    current.close();
    current = null;
  }
}

export function withImmediate<T>(database: Database.Database, work: () => T): T {
  return database.transaction(work).immediate();
}

export function withDeferred<T>(database: Database.Database, work: () => T): T {
  return database.transaction(work).deferred();
}
