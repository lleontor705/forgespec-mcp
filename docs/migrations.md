# ForgeSpec Database Migrations — Versioning, Rollback, and Interruption Recovery

**Applies to:** ForgeSpec 1.3.0+ | **Schema versions:** 1.0.0 (legacy), 2 (P0 direct core), 3 (P1 evidence/approval/file)

---

## Migration Path

ForgeSpec uses SQLite `user_version` to track schema state:

| user_version | Description |
|-------------|-------------|
| 0 | Fresh/uninitialized database |
| 1 | ForgeSpec 1.2.2 baseline (legacy contracts, boards, tasks, file_reservations) |
| 2 | P0 direct core (direct_boards, direct_tasks, task_dependencies, task_attempts, contract_streams, contract_revisions, authority_events, idempotency_records, schema_migrations, migration_findings) |
| 3 | P1 additions (evidence_objects, task_evidence_links, approval_gates, approval_decisions, file_leases, file_lease_scopes) |

---

## Startup Procedure

On startup, ForgeSpec:

1. **Acquires an exclusive lock** (`BEGIN EXCLUSIVE`) to prevent concurrent migration.
2. **Detects database state:** fresh vs. legacy vs. already-migrated.
3. **Runs integrity checks:** `quick_check` and `foreign_key_check`.
4. **Creates a verified backup** before modifying an existing database.
5. **Applies checksum-pinned migrations** atomically — each migration is a single transaction.
6. **Records the migration** in `schema_migrations` with version, name, checksum, and timestamp.
7. **Stamps `user_version`** to the new version.
8. **Reconciles projections** — ensures legacy tables mirror direct authority state.

---

## Interruption Recovery

If startup is interrupted before migration completes:

- SQLite transactions are atomic: the database is in either the **complete old state** or the **complete new state**.
- No partially upgraded writable state is ever exposed.
- On restart, the server detects the current `user_version` and resumes from there.
- If the backup was created but the migration transaction did not commit, the backup is retained and the database remains at the previous version.

**Safe restart:** simply restart the server. It will detect the current state and complete any remaining migration steps or refuse writable startup if the database is corrupt.

---

## Rollback and Restore

### Pre-upgrade Backup

Before modifying an existing database, ForgeSpec creates a verified SQLite backup. The backup is a consistent snapshot of the pre-migration state.

### Restoration

- **Before direct writes:** backup restoration is safe and returns the database to its pre-migration state.
- **After direct writes:** no down-conversion or deletion is permitted. Direct history is retained. A server lacking direct-v1 authority can still read supported legacy data but treats direct-v1 resources as read-only or explicitly unsupported.

### Disabling direct-v1

Disabling direct-v1 (e.g., rolling back to ForgeSpec 1.2.2):

1. Legacy data remains fully usable through legacy tools.
2. Direct-v1 tables are retained (not deleted or rewritten).
3. Direct-v1 history is preserved for future re-enablement.
4. A 1.2.2 binary opening the database ignores unknown tables and operates on legacy data only.

---

## Legacy Coexistence

- Legacy and direct-v1 resources coexist throughout 1.x.
- Legacy boards/tasks remain usable through legacy tool calls (no `coordination_mode` field).
- Direct-v1 boards/tasks require `coordination_mode: "direct-v1"` and enforce CAS/idempotency/audit.
- A legacy-shaped mutation against a direct-v1 board is rejected with `category: "compatibility"`.
- Projection reconciliation on startup ensures legacy tables mirror direct authority state.

---

## Invalid Legacy Data

Migration never silently promotes legacy boards. If legacy data contains invalid dependencies (missing, duplicate, self, cross-board, or cyclic):

- The board remains readable.
- A structured finding is recorded in `migration_findings`.
- The invalid edge is NOT reported as a satisfied direct-v1 dependency.
- No attempts, evidence, or approvals are invented.

---

## Checksum Verification

Each migration script is checksum-pinned. The `schema_migrations` table records the applied checksum. On startup, if a migration's checksum does not match the expected value, the server refuses to start and reports a structured error.

---

## SQLite Feature Qualification

Startup qualifies SQLite features before proceeding:

- `STRICT` table mode availability.
- JSON1 extension availability (`json_valid`).
- `foreign_key_check` enforcement.
- WAL mode support.

If required features are unavailable, the server reports a structured startup error and does not open for writable operations.
