import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DIRECT_CORE_SCHEMA_SQL,
  LEGACY_SCHEMA_SQL,
  MIGRATION_CONTROL_SCHEMA_SQL,
} from "./schema.js";

export const LATEST_SCHEMA_VERSION = 2;

interface MigrationHookContext {
  version: number;
  name: string;
}

export interface MigrationOptions {
  beforeCommit?: (context: MigrationHookContext) => void;
  now?: () => number;
}

export interface MigrationResult {
  fromVersion: number;
  toVersion: number;
  appliedVersions: number[];
  backupPath: string | null;
  findingCount: number;
}

interface LegacyTaskRow {
  id: string;
  board_id: string;
  dependencies: string;
}

interface Finding {
  boardId: string;
  taskId: string;
  category: string;
  details: Record<string, unknown>;
}

const migrations = [
  {
    version: 1,
    name: "stamp-forgespec-1.2.2-baseline",
    sql: `${LEGACY_SCHEMA_SQL}\n${MIGRATION_CONTROL_SCHEMA_SQL}`,
  },
  {
    version: 2,
    name: "direct-v1-p0-core",
    sql: DIRECT_CORE_SCHEMA_SQL,
  },
] as const;

export function migrateDatabase(databasePath: string, options: MigrationOptions = {}): MigrationResult {
  fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  const existed = fs.existsSync(databasePath) && fs.statSync(databasePath).size > 0;
  const database = new Database(databasePath);
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");

  try {
    qualifyDatabase(database);
    const fromVersion = database.pragma("user_version", { simple: true }) as number;
    if (fromVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(`Unsupported database user_version ${fromVersion}`);
    }

    if (fromVersion === LATEST_SCHEMA_VERSION) {
      return {
        fromVersion,
        toVersion: fromVersion,
        appliedVersions: [],
        backupPath: null,
        findingCount: countFindings(database),
      };
    }

    const backupPath = existed ? createVerifiedBackup(database, databasePath) : null;
    const appliedVersions: number[] = [];
    const now = options.now ?? Date.now;

    const apply = database.transaction(() => {
      for (const migration of migrations) {
        if (migration.version <= fromVersion) continue;
        database.exec(migration.sql);
        if (migration.version === LATEST_SCHEMA_VERSION) {
          recordLegacyDependencyFindings(database, now());
        }
        database
          .prepare(
            `INSERT INTO schema_migrations (version, name, checksum, applied_at_ms)
             VALUES (?, ?, ?, ?)`
          )
          .run(migration.version, migration.name, checksum(migration.sql), now());
        database.pragma(`user_version = ${migration.version}`);
        appliedVersions.push(migration.version);
        options.beforeCommit?.({ version: migration.version, name: migration.name });
      }
    });

    apply.exclusive();
    qualifyDatabase(database);
    return {
      fromVersion,
      toVersion: LATEST_SCHEMA_VERSION,
      appliedVersions,
      backupPath,
      findingCount: countFindings(database),
    };
  } finally {
    database.close();
  }
}

export function restoreDatabaseBackup(databasePath: string, backupPath: string): void {
  if (!fs.existsSync(backupPath)) throw new Error(`Migration backup not found: ${backupPath}`);
  const backup = new Database(backupPath, { readonly: true });
  try {
    qualifyDatabase(backup);
  } finally {
    backup.close();
  }
  fs.copyFileSync(backupPath, databasePath);
}

function createVerifiedBackup(database: Database.Database, databasePath: string): string {
  const backupPath = `${databasePath}.pre-direct-v1.bak`;
  fs.rmSync(backupPath, { force: true });
  database.prepare("VACUUM main INTO ?").run(backupPath);
  const backup = new Database(backupPath, { readonly: true });
  try {
    qualifyDatabase(backup);
  } finally {
    backup.close();
  }
  return backupPath;
}

function qualifyDatabase(database: Database.Database): void {
  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed: ${String(quickCheck)}`);
  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error(`SQLite foreign_key_check failed with ${foreignKeyErrors.length} finding(s)`);
  }
}

function checksum(sql: string): string {
  return `sha256:${createHash("sha256").update(sql).digest("hex")}`;
}

function countFindings(database: Database.Database): number {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'migration_findings'")
    .get();
  if (!table) return 0;
  return (database.prepare("SELECT COUNT(*) AS count FROM migration_findings").get() as { count: number }).count;
}

function recordLegacyDependencyFindings(database: Database.Database, createdAtMs: number): void {
  const tasks = database.prepare("SELECT id, board_id, dependencies FROM tasks ORDER BY id").all() as LegacyTaskRow[];
  const tasksById = new Map(tasks.map((task) => [task.id, task]));
  const validEdges = new Map<string, string[]>();
  const findings: Finding[] = [];

  for (const task of tasks) {
    const dependencies = parseDependencies(task, findings);
    const seen = new Set<string>();
    for (const dependencyId of dependencies) {
      if (seen.has(dependencyId)) {
        findings.push(finding(task, "duplicate_dependency", { dependency_task_id: dependencyId }));
        continue;
      }
      seen.add(dependencyId);
      if (dependencyId === task.id) {
        findings.push(finding(task, "self_dependency", { dependency_task_id: dependencyId }));
        continue;
      }
      const dependency = tasksById.get(dependencyId);
      if (!dependency) {
        findings.push(finding(task, "missing_dependency", { dependency_task_id: dependencyId }));
        continue;
      }
      if (dependency.board_id !== task.board_id) {
        findings.push(
          finding(task, "cross_board_dependency", {
            dependency_task_id: dependencyId,
            dependency_board_id: dependency.board_id,
          })
        );
        continue;
      }
      const edges = validEdges.get(task.id) ?? [];
      edges.push(dependencyId);
      validEdges.set(task.id, edges);
    }
  }

  for (const [taskId, dependencies] of validEdges) {
    const task = tasksById.get(taskId)!;
    for (const dependencyId of dependencies) {
      if (hasPath(validEdges, dependencyId, taskId, new Set())) {
        findings.push(finding(task, "cyclic_dependency", { dependency_task_id: dependencyId }));
      }
    }
  }

  const insert = database.prepare(
    `INSERT INTO migration_findings
       (migration_version, board_id, task_id, category, details_json, created_at_ms)
     VALUES (?, ?, ?, ?, ?, ?)`
  );
  for (const item of findings) {
    insert.run(
      LATEST_SCHEMA_VERSION,
      item.boardId,
      item.taskId,
      item.category,
      JSON.stringify(item.details),
      createdAtMs
    );
  }
}

function parseDependencies(task: LegacyTaskRow, findings: Finding[]): string[] {
  try {
    const parsed: unknown = JSON.parse(task.dependencies);
    if (Array.isArray(parsed) && parsed.every((value) => typeof value === "string")) return parsed;
  } catch {
    // The structured finding below is the authoritative migration result.
  }
  findings.push(finding(task, "malformed_dependencies", { stored_value: task.dependencies }));
  return [];
}

function finding(task: LegacyTaskRow, category: string, details: Record<string, unknown>): Finding {
  return { boardId: task.board_id, taskId: task.id, category, details };
}

function hasPath(edges: Map<string, string[]>, current: string, target: string, visited: Set<string>): boolean {
  if (current === target) return true;
  if (visited.has(current)) return false;
  visited.add(current);
  return (edges.get(current) ?? []).some((next) => hasPath(edges, next, target, visited));
}
