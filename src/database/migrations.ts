import Database from "better-sqlite3";
import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  DIRECT_CORE_SCHEMA_SQL,
  LEGACY_SCHEMA_SQL,
  MIGRATION_CONTROL_SCHEMA_SQL,
  DIRECT_TASK_HISTORY_SCHEMA_SQL,
  DIRECT_AUTHORITY_PERSISTENCE_SCHEMA_SQL,
  DIRECT_AUTHORITY_LINEAGE_SCHEMA_SQL,
  DIRECT_AUTHORITY_LINEAGE_PARENT_COLUMN_SQL,
  DIRECT_AUTHORITY_LINEAGE_KIND_COLUMN_SQL,
  DIRECT_AUTHORITY_IDEMPOTENCY_HASH_COLUMN_SQL,
  DIRECT_AUTHORITY_LINEAGE_CONSTRAINTS_SQL,
  DIRECT_AUTHORITY_LINEAGE_IDENTITY_SCHEMA_SQL,
} from "./schema.js";

export const LATEST_SCHEMA_VERSION = 6;

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

export interface DatabaseQualification {
  sqliteVersion: string;
  strictTables: true;
  json1: true;
  journalMode: string;
  wal: boolean;
}

const CAPABILITY_REMEDY = "Use a supported SQLite build or restore the runtime before retrying.";

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
  {
    version: 3,
    name: "direct-v1-p1-task-history",
    sql: DIRECT_TASK_HISTORY_SCHEMA_SQL,
  },
  {
    version: 4,
    name: "direct-v1-additive-authority-persistence",
    sql: DIRECT_AUTHORITY_PERSISTENCE_SCHEMA_SQL,
  },
  {
    version: 5,
    name: "direct-v1-grant-ancestry-storage-hardening",
    sql: DIRECT_AUTHORITY_LINEAGE_SCHEMA_SQL,
  },
  {
    version: 6,
    name: "direct-v1-grant-lineage-identity-hardening",
    sql: DIRECT_AUTHORITY_LINEAGE_IDENTITY_SCHEMA_SQL,
  },
] as const;

const AUTHORITY_TABLES = [
  "task_authority_grants",
  "task_authority_revocations",
  "task_authority_handoffs",
  "task_authority_handoff_refs",
  "task_authority_idempotency",
  "task_approval_provenance",
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
    verifyAppliedMigrationChecksums(database, fromVersion);
    if (fromVersion >= 4) assertAuthoritySchemaAvailable(database);
    if (fromVersion >= 5) assertAuthorityLineageAvailable(database);
    if (fromVersion >= 6) assertAuthorityLineageIdentityAvailable(database);

    // Set WAL only after checksum verification. A tampered database must not
    // be modified before the startup gate reports the mismatch.
    database.pragma("journal_mode = WAL");
    qualifyDatabase(database, { requireWal: true });

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
        if (migration.version === 5) applyAuthorityLineageMigration(database);
        else database.exec(migration.sql);
        if (migration.version === 2) {
          recordLegacyDependencyFindings(database, now(), migration.version);
        }
        if (migration.version === 3) {
          backfillDirectTaskVersions(database);
        }
        recordAppliedMigration(database, migration, now());
        database.pragma(`user_version = ${migration.version}`);
        appliedVersions.push(migration.version);
        options.beforeCommit?.({ version: migration.version, name: migration.name });
      }
    });

    apply.exclusive();
    assertAuthoritySchemaAvailable(database);
    assertAuthorityLineageAvailable(database);
    assertAuthorityLineageIdentityAvailable(database);
    qualifyDatabase(database, { requireWal: true });
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

function recordAppliedMigration(
  database: Database.Database,
  migration: (typeof migrations)[number],
  appliedAtMs: number
): void {
  const existing = database
    .prepare("SELECT name, checksum FROM schema_migrations WHERE version = ?")
    .get(migration.version) as { name: string; checksum: string } | undefined;
  const expectedChecksum = checksum(migration.sql);
  if (existing) {
    if (existing.name !== migration.name || existing.checksum !== expectedChecksum) {
      throw new Error(
        `MIGRATION_CHECKSUM_MISMATCH: version ${migration.version} (${migration.name}); ` +
          `expected ${expectedChecksum}; observed ${existing.checksum}. ` +
          "Restore the last verified backup or repair the migration history before retrying."
      );
    }
    return;
  }
  database
    .prepare(
      `INSERT INTO schema_migrations (version, name, checksum, applied_at_ms)
       VALUES (?, ?, ?, ?)`
    )
    .run(migration.version, migration.name, expectedChecksum, appliedAtMs);
}

function assertAuthoritySchemaAvailable(database: Database.Database): void {
  const rows = database
    .prepare(
      `SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN (${AUTHORITY_TABLES.map(() => "?").join(", ")})`
    )
    .all(...AUTHORITY_TABLES) as Array<{ name: string }>;
  const available = new Set(rows.map(({ name }) => name));
  const missing = AUTHORITY_TABLES.filter((table) => !available.has(table));
  if (missing.length > 0) {
    throw new Error(`AUTH_STATE_UNAVAILABLE: missing durable authority table(s): ${missing.join(", ")}`);
  }
}

function applyAuthorityLineageMigration(database: Database.Database): void {
  const grantColumns = new Set(
    (database.prepare("PRAGMA table_info(task_authority_grants)").all() as Array<{ name: string }>).map(
      ({ name }) => name
    )
  );
  if (!grantColumns.has("parent_grant_id")) database.exec(DIRECT_AUTHORITY_LINEAGE_PARENT_COLUMN_SQL);
  if (!grantColumns.has("lineage_kind")) database.exec(DIRECT_AUTHORITY_LINEAGE_KIND_COLUMN_SQL);

  const idempotencyColumns = new Set(
    (database.prepare("PRAGMA table_info(task_authority_idempotency)").all() as Array<{ name: string }>).map(
      ({ name }) => name
    )
  );
  if (!idempotencyColumns.has("idempotency_key_hash")) {
    database.exec(DIRECT_AUTHORITY_IDEMPOTENCY_HASH_COLUMN_SQL);
  }
  database.exec(DIRECT_AUTHORITY_LINEAGE_CONSTRAINTS_SQL);
}

function assertAuthorityLineageAvailable(database: Database.Database): void {
  const grantColumns = new Set(
    (database.prepare("PRAGMA table_info(task_authority_grants)").all() as Array<{ name: string }>).map(
      ({ name }) => name
    )
  );
  const idempotencyColumns = new Set(
    (database.prepare("PRAGMA table_info(task_authority_idempotency)").all() as Array<{ name: string }>).map(
      ({ name }) => name
    )
  );
  if (!grantColumns.has("parent_grant_id") || !grantColumns.has("lineage_kind")) {
    throw new Error("AUTH_STATE_UNAVAILABLE: grant lineage columns are unavailable");
  }
  if (!idempotencyColumns.has("idempotency_key_hash")) {
    throw new Error("AUTH_STATE_UNAVAILABLE: idempotency key hash storage is unavailable");
  }

  const corrupt = database
    .prepare(
      `WITH RECURSIVE ancestors(grant_id, ancestor_id) AS (
         SELECT grant_id, parent_grant_id
           FROM task_authority_grants
          WHERE parent_grant_id IS NOT NULL
         UNION
         SELECT ancestors.grant_id, parent.parent_grant_id
           FROM ancestors
           JOIN task_authority_grants AS parent ON parent.grant_id = ancestors.ancestor_id
          WHERE parent.parent_grant_id IS NOT NULL
       )
       SELECT 1
         FROM ancestors
        WHERE grant_id = ancestor_id
        LIMIT 1`
    )
    .get();
  if (corrupt) throw new Error("AUTH_STATE_UNAVAILABLE: corrupt grant lineage detected");
}

function assertAuthorityLineageIdentityAvailable(database: Database.Database): void {
  const trigger = database
    .prepare(
      `SELECT sql FROM sqlite_master
        WHERE type = 'trigger' AND name = 'task_authority_grants_lineage_identity_insert'`
    )
    .get() as { sql: string } | undefined;
  if (
    !trigger ||
    !trigger.sql.includes("parent.operation = NEW.operation") ||
    !trigger.sql.includes("parent.grantee_actor = NEW.granted_by_actor")
  ) {
    throw new Error("AUTH_STATE_UNAVAILABLE: grant lineage identity constraint is unavailable");
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

export function qualifyDatabase(
  database: Database.Database,
  options: { requireWal?: boolean } = {}
): DatabaseQualification {
  const quickCheck = database.pragma("quick_check", { simple: true });
  if (quickCheck !== "ok") throw new Error(`SQLite quick_check failed: ${String(quickCheck)}`);
  const foreignKeyErrors = database.pragma("foreign_key_check") as unknown[];
  if (foreignKeyErrors.length > 0) {
    throw new Error(`SQLite foreign_key_check failed with ${foreignKeyErrors.length} finding(s)`);
  }

  const sqliteVersion = String(
    (database.prepare("SELECT sqlite_version() AS version").get() as { version: string }).version
  );
  try {
    database.exec("CREATE TEMP TABLE __forgespec_strict_probe (value TEXT) STRICT");
    database.exec("DROP TABLE __forgespec_strict_probe");
  } catch {
      throw new Error(
        `SQLITE_CAPABILITY_MISSING: STRICT tables are required (SQLite ${sqliteVersion}). ${CAPABILITY_REMEDY}`
      );
  }

  try {
    const jsonValid = database.prepare("SELECT json_valid(?) AS valid").get('{"forgespec":true}') as { valid: number };
    if (jsonValid.valid !== 1) throw new Error("json_valid returned false");
  } catch {
      throw new Error(
        `SQLITE_CAPABILITY_MISSING: JSON1/json_valid is required (SQLite ${sqliteVersion}). ${CAPABILITY_REMEDY}`
      );
  }

  const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
  const wal = journalMode === "wal";
  if (options.requireWal && !wal) {
    throw new Error(
      `SQLITE_CAPABILITY_MISSING: effective WAL is required (journal_mode=${journalMode}). ${CAPABILITY_REMEDY}`
    );
  }

  return { sqliteVersion, strictTables: true, json1: true, journalMode, wal };
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

function verifyAppliedMigrationChecksums(database: Database.Database, fromVersion: number): void {
  const table = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
    .get();
  if (!table) return;

  const applied = database
    .prepare("SELECT version, name, checksum FROM schema_migrations WHERE version <= ? ORDER BY version")
    .all(fromVersion) as Array<{ version: number; name: string; checksum: string }>;
  for (const migration of migrations) {
    if (migration.version > fromVersion) break;
    const row = applied.find(({ version }) => version === migration.version);
    if (!row || row.name !== migration.name || row.checksum !== checksum(migration.sql)) {
      const observed = row?.checksum ?? "missing";
      throw new Error(
        `MIGRATION_CHECKSUM_MISMATCH: version ${migration.version} (${migration.name}); ` +
          `expected ${checksum(migration.sql)}; observed ${observed}. ` +
          "Restore the last verified backup or repair the migration history before retrying."
      );
    }
  }
}

interface DirectTaskBackfillRow {
  task_id: string;
  board_id: string;
  revision: number;
  status: string;
  current_attempt_id: string | null;
  blocked_reason: string | null;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface TaskCreatedEventRow {
  board_revision: number;
  created_at_ms: number;
}

function backfillDirectTaskVersions(database: Database.Database): void {
  const tasks = database
    .prepare("SELECT task_id, board_id, revision, status, current_attempt_id, blocked_reason, metadata_json, created_at_ms, updated_at_ms FROM direct_tasks ORDER BY task_id")
    .all() as DirectTaskBackfillRow[];
  const events = database.prepare(
    `SELECT board_revision, created_at_ms
       FROM authority_events
      WHERE resource_type = 'task' AND resource_id = ? AND event_type = 'task_created'
      ORDER BY board_revision, event_ordinal, event_id`
  );
  const insert = database.prepare(
    `INSERT INTO direct_task_versions
       (version_id, board_id, task_id, board_revision, task_revision, status, current_attempt_id,
        blocked_reason, metadata_json, created_at_ms, updated_at_ms, is_deleted)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );

  for (const task of tasks) {
    const createdEvents = events.all(task.task_id) as TaskCreatedEventRow[];
    if (createdEvents.length === 0) continue;
    if (createdEvents.length !== 1) {
      throw new Error(`Cannot backfill task history: task ${task.task_id} has multiple task_created events`);
    }
    const [created] = createdEvents;
    if (created.board_revision > task.revision) {
      throw new Error(`Cannot backfill task history: task ${task.task_id} points into the future`);
    }
    const versionId = `task-version:${task.board_id}:${task.task_id}:${created.board_revision}`;
    const metadata = JSON.parse(task.metadata_json) as Record<string, unknown>;
    const isDeleted = task.status === "deleted" || metadata.is_deleted === true ? 1 : 0;
    insert.run(
      versionId,
      task.board_id,
      task.task_id,
      created.board_revision,
      task.revision,
      task.status,
      task.current_attempt_id,
      task.blocked_reason,
      task.metadata_json,
      created.created_at_ms,
      task.updated_at_ms,
      isDeleted
    );
  }
}

function recordLegacyDependencyFindings(database: Database.Database, createdAtMs: number, migrationVersion: number): void {
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
      migrationVersion,
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
