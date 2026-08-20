import type Database from "better-sqlite3";

export const SCHEMA_CORE_TABLES = [
  "fs_schema_meta",
  "fs_boards",
  "fs_tasks",
  "fs_task_dependencies",
  "fs_gates",
  "fs_gate_decisions",
  "fs_attempts",
  "fs_contracts",
] as const;

const KNOWN_USER_TABLES = new Set<string>(SCHEMA_CORE_TABLES);

export const SCHEMA_CORE_SQL = `
  CREATE TABLE IF NOT EXISTS fs_schema_meta (
    key TEXT PRIMARY KEY CHECK (key = 'core'),
    schema_version TEXT NOT NULL CHECK (schema_version = '2.0.0'),
    bootstrapped_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    bootstrap_metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(bootstrap_metadata_json)),
    recovery_mode INTEGER NOT NULL DEFAULT 0 CHECK (recovery_mode IN (0, 1))
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_boards (
    id TEXT PRIMARY KEY,
    project TEXT NOT NULL,
    name TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    metadata_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(metadata_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_tasks (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    priority TEXT NOT NULL CHECK (priority IN ('p0', 'p1', 'p2', 'p3')),
    status TEXT NOT NULL CHECK (status IN ('backlog', 'ready', 'in_progress', 'in_review', 'blocked', 'done')),
    spec_ref TEXT,
    acceptance_criteria TEXT NOT NULL DEFAULT '',
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    blocked_reason TEXT,
    notes_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(notes_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    recovery_pending INTEGER NOT NULL DEFAULT 0 CHECK (recovery_pending IN (0, 1)),
    PRIMARY KEY (board_id, id),
    FOREIGN KEY (board_id) REFERENCES fs_boards(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_task_dependencies (
    task_board_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    dependency_board_id TEXT NOT NULL,
    dependency_task_id TEXT NOT NULL,
    PRIMARY KEY (task_board_id, task_id, dependency_task_id),
    CHECK (task_id <> dependency_task_id),
    CHECK (task_board_id = dependency_board_id),
    FOREIGN KEY (task_board_id, task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE,
    FOREIGN KEY (dependency_board_id, dependency_task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_gates (
    board_id TEXT NOT NULL,
    id TEXT NOT NULL,
    name TEXT NOT NULL,
    required_for_json TEXT NOT NULL DEFAULT '["ready"]' CHECK (json_valid(required_for_json)),
    allowed_actors_json TEXT NOT NULL DEFAULT '[]' CHECK (json_valid(allowed_actors_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, id),
    FOREIGN KEY (board_id) REFERENCES fs_boards(id) ON DELETE CASCADE
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_gate_decisions (
    board_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    gate_id TEXT NOT NULL,
    decision_no INTEGER NOT NULL DEFAULT 1 CHECK (decision_no >= 1),
    attempt_id TEXT,
    status TEXT NOT NULL CHECK (status IN ('pending', 'allow', 'deny')),
    actor TEXT,
    decided_at INTEGER NOT NULL,
    PRIMARY KEY (board_id, task_id, gate_id, decision_no),
    FOREIGN KEY (board_id, task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE,
    FOREIGN KEY (board_id, gate_id) REFERENCES fs_gates(board_id, id) ON DELETE CASCADE,
    CHECK (
      (status = 'pending' AND attempt_id IS NULL AND actor IS NULL)
      OR (status IN ('allow', 'deny') AND attempt_id IS NOT NULL AND actor IS NOT NULL)
    )
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_attempts (
    id TEXT PRIMARY KEY,
    board_id TEXT NOT NULL,
    task_id TEXT NOT NULL,
    attempt_no INTEGER NOT NULL CHECK (attempt_no > 0),
    actor TEXT NOT NULL,
    token_hash TEXT NOT NULL CHECK (
      length(token_hash) = 71
      AND substr(token_hash, 1, 7) = 'sha256:'
      AND substr(token_hash, 8) GLOB '[0-9a-f]*'
      AND substr(token_hash, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    state TEXT NOT NULL CHECK (state IN ('active', 'succeeded', 'failed', 'expired', 'abandoned')),
    claimed_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    closed_at INTEGER,
    reason TEXT,
    UNIQUE (board_id, task_id, attempt_no),
    FOREIGN KEY (board_id, task_id) REFERENCES fs_tasks(board_id, id) ON DELETE CASCADE,
    CHECK (claimed_at <= expires_at)
  ) STRICT;

  CREATE TABLE IF NOT EXISTS fs_contracts (
    id TEXT NOT NULL,
    board_id TEXT,
    project TEXT NOT NULL,
    parent_contract_id TEXT,
    digest TEXT NOT NULL CHECK (
      length(digest) = 71
      AND substr(digest, 1, 7) = 'sha256:'
      AND substr(digest, 8) GLOB '[0-9a-f]*'
      AND substr(digest, 8) NOT GLOB '*[^0-9a-f]*'
    ),
    change_name TEXT NOT NULL,
    planning_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(planning_json)),
    phase TEXT NOT NULL CHECK (
      phase IN ('init', 'explore', 'propose', 'spec', 'design', 'tasks', 'apply', 'verify', 'archive')
    ),
    status TEXT NOT NULL CHECK (status IN ('success', 'partial', 'failed', 'blocked')),
    confidence REAL NOT NULL CHECK (confidence >= 0.0 AND confidence <= 1.0),
    executive_summary TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1 CHECK (revision > 0),
    contract_json TEXT NOT NULL DEFAULT '{}' CHECK (json_valid(contract_json)),
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (id),
    FOREIGN KEY (parent_contract_id) REFERENCES fs_contracts(id) ON DELETE RESTRICT,
    CHECK (json_valid(contract_json)),
    UNIQUE (project, change_name, revision)
  ) STRICT;

  CREATE INDEX IF NOT EXISTS idx_fs_tasks_board ON fs_tasks(board_id);
  CREATE INDEX IF NOT EXISTS idx_fs_tasks_board_status ON fs_tasks(board_id, status);
  CREATE INDEX IF NOT EXISTS idx_fs_task_dependencies_task ON fs_task_dependencies(task_board_id, task_id);
  CREATE INDEX IF NOT EXISTS idx_fs_gates_board ON fs_gates(board_id);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_parent ON fs_contracts(parent_contract_id);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_digests ON fs_contracts(digest);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_attempts_one_active
    ON fs_attempts(board_id, task_id) WHERE state = 'active';
  CREATE INDEX IF NOT EXISTS idx_fs_gate_decisions_board_status ON fs_gate_decisions(board_id, status);
  CREATE INDEX IF NOT EXISTS idx_fs_attempts_board_task ON fs_attempts(board_id, task_id, state);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_board_phase ON fs_contracts(board_id, phase, status);
  CREATE INDEX IF NOT EXISTS idx_fs_contracts_project_phase_status ON fs_contracts(project, phase, status, revision);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fs_gate_decisions_one_pending
    ON fs_gate_decisions(board_id, task_id, gate_id)
    WHERE status = 'pending';

  CREATE TRIGGER IF NOT EXISTS trg_fs_gates_required_for_json_validate
  BEFORE INSERT ON fs_gates
  BEGIN
    SELECT CASE
      WHEN json_type(NEW.required_for_json) != 'array' THEN RAISE(ABORT, 'fs_gates.required_for_json must be an array')
    END;

    SELECT CASE
      WHEN json_array_length(NEW.required_for_json) = 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not be empty')
    END;

    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.required_for_json)
        WHERE typeof(value) != 'text'
          OR lower(value) NOT IN ('ready', 'in_progress', 'in_review', 'done', 'blocked')
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json contains unsupported status')
    END;

    SELECT CASE
      WHEN (
        SELECT COUNT(*) - COUNT(DISTINCT lower(value))
        FROM json_each(NEW.required_for_json)
      ) > 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not contain duplicates')
    END;

    SELECT CASE
      WHEN json(NEW.required_for_json) != (
        SELECT json_group_array(value)
        FROM (
          SELECT DISTINCT lower(value) AS value
          FROM json_each(NEW.required_for_json)
          ORDER BY CASE lower(value)
            WHEN 'ready' THEN 1
            WHEN 'in_progress' THEN 2
            WHEN 'in_review' THEN 3
            WHEN 'done' THEN 4
            WHEN 'blocked' THEN 5
          END
        )
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json must be normalized')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_gates_required_for_json_validate_update
  BEFORE UPDATE OF required_for_json ON fs_gates
  BEGIN
    SELECT CASE
      WHEN json_type(NEW.required_for_json) != 'array' THEN RAISE(ABORT, 'fs_gates.required_for_json must be an array')
    END;

    SELECT CASE
      WHEN json_array_length(NEW.required_for_json) = 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not be empty')
    END;

    SELECT CASE
      WHEN EXISTS (
        SELECT 1
        FROM json_each(NEW.required_for_json)
        WHERE typeof(value) != 'text'
          OR lower(value) NOT IN ('ready', 'in_progress', 'in_review', 'done', 'blocked')
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json contains unsupported status')
    END;

    SELECT CASE
      WHEN (
        SELECT COUNT(*) - COUNT(DISTINCT lower(value))
        FROM json_each(NEW.required_for_json)
      ) > 0 THEN RAISE(ABORT, 'fs_gates.required_for_json must not contain duplicates')
    END;

    SELECT CASE
      WHEN json(NEW.required_for_json) != (
        SELECT json_group_array(value)
        FROM (
          SELECT DISTINCT lower(value) AS value
          FROM json_each(NEW.required_for_json)
          ORDER BY CASE lower(value)
            WHEN 'ready' THEN 1
            WHEN 'in_progress' THEN 2
            WHEN 'in_review' THEN 3
            WHEN 'done' THEN 4
            WHEN 'blocked' THEN 5
          END
        )
      ) THEN RAISE(ABORT, 'fs_gates.required_for_json must be normalized')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_gate_decisions_immutable_update
  BEFORE UPDATE ON fs_gate_decisions
  BEGIN
    SELECT RAISE(ABORT, 'fs_gate_decisions are immutable');
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_tasks_status_transition_guard
  BEFORE UPDATE OF status ON fs_tasks
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN NEW.status = OLD.status THEN NULL

      WHEN NEW.status = 'done' AND NOT EXISTS (
        SELECT 1
        FROM fs_attempts
        WHERE board_id = NEW.board_id AND task_id = NEW.id AND state = 'active'
      )
      THEN RAISE(ABORT, 'done transition requires an active attempt')

      WHEN OLD.status = 'backlog' AND NEW.status NOT IN ('ready', 'blocked')
      THEN RAISE(ABORT, 'invalid backlog transition')

      WHEN OLD.status = 'ready' AND NEW.status NOT IN ('backlog', 'in_progress', 'blocked')
      THEN RAISE(ABORT, 'invalid ready transition')

      WHEN OLD.status = 'in_progress' AND NEW.status NOT IN ('in_review', 'done', 'blocked')
      THEN RAISE(ABORT, 'invalid in_progress transition')

      WHEN OLD.status = 'in_review' AND NEW.status NOT IN ('in_progress', 'done', 'blocked')
      THEN RAISE(ABORT, 'invalid in_review transition')

      WHEN OLD.status = 'blocked' AND NEW.status NOT IN ('backlog', 'ready')
      THEN RAISE(ABORT, 'invalid blocked transition')

      WHEN OLD.status = 'done'
      THEN RAISE(ABORT, 'done is terminal')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_contracts_parent_phase_guard
  BEFORE INSERT ON fs_contracts
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN NEW.parent_contract_id IS NULL THEN NULL

      WHEN NOT EXISTS (
        SELECT 1
        FROM fs_contracts
        WHERE id = NEW.parent_contract_id
      )
      THEN RAISE(ABORT, 'parent contract does not exist')

      WHEN COALESCE((SELECT project FROM fs_contracts WHERE id = NEW.parent_contract_id), '') != COALESCE(NEW.project, '')
        OR COALESCE((SELECT change_name FROM fs_contracts WHERE id = NEW.parent_contract_id), '') != COALESCE(NEW.change_name, '')
      THEN RAISE(ABORT, 'child contract project and change_name must match parent')

      WHEN COALESCE((SELECT revision FROM fs_contracts WHERE id = NEW.parent_contract_id), 0) + 1 != NEW.revision
      THEN RAISE(ABORT, 'contract revision must be parent revision + 1')

      WHEN NOT (
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'init' AND NEW.phase IN ('explore', 'propose')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'explore' AND NEW.phase IN ('propose', 'spec')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'propose' AND NEW.phase IN ('spec', 'design', 'init')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'spec' AND NEW.phase IN ('design', 'tasks')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'design' AND NEW.phase IN ('tasks', 'spec')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'tasks' AND NEW.phase IN ('apply')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'apply' AND NEW.phase IN ('verify', 'tasks')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'verify' AND NEW.phase IN ('archive', 'apply')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'archive' AND NEW.phase IN ('done'))
      )
      THEN RAISE(ABORT, 'invalid contract phase transition')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_contracts_parent_digest_immutable_update
  BEFORE UPDATE ON fs_contracts
  FOR EACH ROW
  BEGIN
    SELECT CASE
      WHEN COALESCE(NEW.parent_contract_id, '') != COALESCE(OLD.parent_contract_id, '')
      THEN RAISE(ABORT, 'parent_contract_id is immutable')

      WHEN NEW.digest != OLD.digest
      THEN RAISE(ABORT, 'contract digest is immutable')

      WHEN NEW.parent_contract_id IS NOT NULL AND COALESCE(NEW.project, '') != COALESCE(
        (SELECT project FROM fs_contracts WHERE id = NEW.parent_contract_id), ''
      )
      THEN RAISE(ABORT, 'child contract project must match parent')

      WHEN NEW.parent_contract_id IS NOT NULL AND COALESCE(NEW.change_name, '') != COALESCE(
        (SELECT change_name FROM fs_contracts WHERE id = NEW.parent_contract_id), ''
      )
      THEN RAISE(ABORT, 'child contract change_name must match parent')

      WHEN NEW.parent_contract_id IS NOT NULL AND COALESCE((SELECT revision FROM fs_contracts WHERE id = NEW.parent_contract_id), 0) + 1 != NEW.revision
      THEN RAISE(ABORT, 'contract revision must remain parent revision + 1')

      WHEN NEW.parent_contract_id IS NOT NULL AND NOT (
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'init' AND NEW.phase IN ('explore', 'propose')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'explore' AND NEW.phase IN ('propose', 'spec')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'propose' AND NEW.phase IN ('spec', 'design', 'init')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'spec' AND NEW.phase IN ('design', 'tasks')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'design' AND NEW.phase IN ('tasks', 'spec')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'tasks' AND NEW.phase IN ('apply')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'apply' AND NEW.phase IN ('verify', 'tasks')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'verify' AND NEW.phase IN ('archive', 'apply')) OR
        ((SELECT phase FROM fs_contracts WHERE id = NEW.parent_contract_id) = 'archive' AND NEW.phase IN ('done'))
      )
      THEN RAISE(ABORT, 'invalid contract phase transition')
    END;
  END;

  CREATE TRIGGER IF NOT EXISTS trg_fs_gate_decisions_immutable_delete
  BEFORE DELETE ON fs_gate_decisions
  BEGIN
    SELECT RAISE(ABORT, 'fs_gate_decisions are immutable');
  END;
`;

function failIfIncompatibleStore(database: Database.Database): void {
  const userTables = database
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;

  const normalizedTables = userTables
    .map(({ name }) => name)
    .filter((name) => name && !name.startsWith("sqlite_"));

  if (normalizedTables.length === 0) {
    return;
  }

  const missingTables = SCHEMA_CORE_TABLES.filter((name) => !normalizedTables.includes(name));
  const extraTables = normalizedTables.filter((name) => !KNOWN_USER_TABLES.has(name));

  if (missingTables.length > 0 || extraTables.length > 0) {
    const conflictList = [
      ...extraTables,
      ...missingTables.map((name) => `missing:${name}`),
    ]
      .sort()
      .join(", ");
    throw new Error(`DATABASE_INCOMPATIBLE: unsupported existing tables: ${conflictList}`);
  }
}

function assertSqliteCompatibility(database: Database.Database): void {
  const foreignKeys = String(database.pragma("foreign_keys", { simple: true })).toLowerCase();
  if (foreignKeys !== "on" && foreignKeys !== "1") {
    throw new Error("DATABASE_INCOMPATIBLE: foreign_keys pragma must be ON");
  }

  const journalMode = String(database.pragma("journal_mode", { simple: true })).toLowerCase();
  if (journalMode !== "memory" && journalMode !== "wal") {
    throw new Error(`DATABASE_INCOMPATIBLE: journal_mode must be WAL (currently ${journalMode})`);
  }

  try {
    const jsonTest = database.prepare("SELECT json_valid(?) AS valid").get('{"forgespec":true}') as { valid: number };
    if (jsonTest?.valid !== 1) {
      throw new Error("json1-disabled");
    }
  } catch {
    throw new Error("DATABASE_INCOMPATIBLE: json1 extension (json_valid) is not available");
  }
}

export function createFreshCoreStore(database: Database.Database): void {
  const now = Date.now();
  failIfIncompatibleStore(database);
  assertSqliteCompatibility(database);
  database.exec("BEGIN IMMEDIATE");
  try {
    database.exec(SCHEMA_CORE_SQL);
    const metadata = database
      .prepare("SELECT schema_version FROM fs_schema_meta WHERE key = 'core'")
      .get() as { schema_version: string } | undefined;

    if (metadata?.schema_version !== "2.0.0") {
      const initialMeta = {
        key: "core",
        schema_version: "2.0.0",
        bootstrapped_at: now,
        updated_at: now,
        bootstrap_metadata_json: JSON.stringify({
          source: "schema-core.ts",
          builtAt: now,
        }),
        recovery_mode: 0,
      };

      if (metadata === undefined) {
        database
          .prepare(
            `INSERT INTO fs_schema_meta (
              key,
              schema_version,
              bootstrapped_at,
              updated_at,
              bootstrap_metadata_json,
              recovery_mode
            ) VALUES (@key, @schema_version, @bootstrapped_at, @updated_at, @bootstrap_metadata_json, @recovery_mode)`
          )
          .run(initialMeta);
      } else {
        throw new Error(`DATABASE_INCOMPATIBLE: Unexpected core schema version: ${metadata.schema_version}`);
      }
    } else {
      database.prepare("UPDATE fs_schema_meta SET updated_at = ? WHERE key = 'core'").run(now);
    }

    database.exec("COMMIT");
  } catch (error) {
    database.exec("ROLLBACK");
    throw error;
  }
}
