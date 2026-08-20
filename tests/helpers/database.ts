import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { migrateDatabase } from "../../src/database/migrations.js";

const directories: string[] = [];
const openDatabases: Database.Database[] = [];

/**
 * Allocates a database path without opening a native SQLite binding. Runtime
 * compatibility tests use this before attempting a conditional native load,
 * so unavailable runtimes can be skipped without leaving artifacts behind.
 */
export function createTemporaryDatabasePath(prefix = "forgespec-runtime-"): string {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  return path.join(directory, "forgespec.db");
}

import { SCHEMA_V2_SQL } from "../../src/database/schema-v2.js";

export function openTestDatabase(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  database.exec(SCHEMA_V2_SQL);
  openDatabases.push(database);
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

/**
 * Creates a temporary database at the last released schema boundary.
 * Migration RED tests use this fixture so they exercise v2 -> v3 rather
 * than accidentally starting from a newly-created database.
 */
export function createV2Database(prefix = "forgespec-v2-"): {
  path: string;
  database: Database.Database;
} {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  directories.push(directory);
  const databasePath = path.join(directory, "forgespec.db");
  migrateDatabase(databasePath);
  const database = openTestDatabase(databasePath);
  database.transaction(() => {
    database.exec("DROP INDEX IF EXISTS idx_task_versions_board_snapshot");
    database.exec("DROP INDEX IF EXISTS idx_task_versions_task_history");
    database.exec("DROP TABLE IF EXISTS direct_task_versions");
    database.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
    database.pragma("user_version = 2");
  })();
  return { path: databasePath, database };
}

export function seedDirectBoard(
  database: Database.Database,
  boardId: string,
  revision: number,
  metadata: Record<string, unknown> = {}
): void {
  database
    .prepare(
      `INSERT INTO boards (id, project, name) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(boardId, "migration-test", boardId);
  database
    .prepare(
      `INSERT INTO direct_boards
         (board_id, change_name, schema_version, revision, metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, '1.0.0', ?, ?, 1000, 1000)`
    )
    .run(boardId, null, revision, JSON.stringify(metadata));
}

export function seedDirectTask(
  database: Database.Database,
  taskId: string,
  boardId: string,
  revision: number,
  metadata: Record<string, unknown> = {},
  status = "backlog"
): void {
  database
    .prepare(
      `INSERT INTO tasks (id, board_id, title) VALUES (?, ?, ?)
       ON CONFLICT(id) DO NOTHING`
    )
    .run(taskId, boardId, taskId);
  database
    .prepare(
      `INSERT INTO direct_tasks
         (task_id, board_id, revision, status, current_attempt_id, blocked_reason,
          metadata_json, created_at_ms, updated_at_ms)
       VALUES (?, ?, ?, ?, NULL, NULL, ?, 1000, 1000)`
    )
    .run(taskId, boardId, revision, status, JSON.stringify(metadata));
}

export function seedTaskCreatedEvent(
  database: Database.Database,
  eventId: string,
  taskId: string,
  boardId: string,
  boardRevision: number,
  eventOrdinal = 0
): void {
  database
    .prepare(
      `INSERT INTO authority_events
         (event_id, resource_type, resource_id, board_id, board_revision,
          resource_revision, event_ordinal, event_type, actor, outcome,
          details_json, created_at_ms)
       VALUES (?, 'task', ?, ?, ?, 1, ?, 'task_created', 'migration-test', 'success', '{}', 1000)`
    )
    .run(eventId, taskId, boardId, boardRevision, eventOrdinal);
}

/**
 * Transient Windows error codes observed when removing a temp SQLite directory
 * whose WAL/SHM files are still being released by the OS or antivirus scanners
 * after better-sqlite3 reports the handle closed. Recursion can surface EBUSY,
 * EPERM, or ENOTEMPTY briefly before the directory becomes removable.
 */
const RETRYABLE_TEMPDIR_ERRORS = new Set(["EBUSY", "EPERM", "ENOTEMPTY"]);

/**
 * Synchronously blocks the caller for `ms` milliseconds. Test teardown is
 * synchronous, so we cannot await a timer; Atomics.wait provides a precise
 * blocking sleep without spinning the event loop or busy-waiting.
 */
function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT)), 0, 0, ms);
}

/**
 * Removes a temp directory with bounded exponential backoff against transient
 * Windows file locks (EBUSY/EPERM/ENOTEMPTY). The extended retry is
 * Windows-only: on every other platform, and for any non-transient error, the
 * failure is re-thrown immediately so cleanup problems stay visible. After the
 * final attempt the error is re-thrown without a trailing sleep.
 */
function removeTempDirectory(directory: string): void {
  const isWindows = process.platform === "win32";
  const maxAttempts = 6;
  const baseDelayMs = 25;
  let lastError: NodeJS.ErrnoException | undefined;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      fs.rmSync(directory, { recursive: true, force: true });
      return;
    } catch (error) {
      lastError = error as NodeJS.ErrnoException;
      const code = lastError.code;
      const retryable = isWindows && code !== undefined && RETRYABLE_TEMPDIR_ERRORS.has(code);
      if (!retryable) {
        throw lastError;
      }
      // Sleep only when another attempt remains; the final attempt must
      // rethrow immediately without a trailing sleep. Delays are bounded and
      // fully reachable: 25, 50, 100, 200, 400 ms (total 775 ms).
      if (attempt < maxAttempts - 1) {
        sleepSync(baseDelayMs * 2 ** attempt);
      }
    }
  }
  throw lastError ?? new Error(`removeTempDirectory failed to remove ${directory}`);
}

export function removeTestDatabases(): void {
  for (const database of openDatabases.splice(0)) {
    if (database.open) database.close();
  }
  for (const directory of directories.splice(0)) {
    removeTempDirectory(directory);
  }
}
