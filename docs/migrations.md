# ForgeSpec migrations and rollback

**Package:** `forgespec-mcp@1.4.0` | **Current schema:** 3 | **Primary Node:** 24.18.1 | **Supported Node:** 22.x and 24.x

## Schema versions

| user_version | Meaning |
|---:|---|
| 0 | Fresh database |
| 1 | Legacy ForgeSpec 1.2.2 tables and migration control |
| 2 | direct-v1 P0 core |
| 3 | Append-only `direct_task_versions` history and indexes |

Migration 3 creates one historical base row per existing direct task when its unique `task_created` authority event supplies a valid board revision. It preserves visible values, records logical deletion, and does not fabricate rows for legacy-only tasks. A future or ambiguous revision aborts the transaction.

Every visible direct-task change writes the projection and exactly one history row in the same transaction. No-op and idempotent replays do not add versions. History is append-only: this change does **not** prune or TTL-delete it.

## Startup preflight

Runtime qualification is isolated per supported line: six jobs cover Node 22.x and 24.x on Ubuntu, Windows, and macOS. Node 22 uses ABI 127 and Node 24.18.1 uses ABI 137. Each CI job starts from a clean checkout, runs `npm ci`, loads `better-sqlite3`, and exercises migration and temporary-DB MCP handshake paths. Only npm download caches are permitted; native bindings and `node_modules` are not shared. The lockfile is consumed as-is: runtime changes must not regenerate dependency entries or introduce lockfile churn.

Before MCP `initialize`, startup:

1. Verifies every applied migration's immutable name and SHA-256 checksum against the in-code definition.
2. Applies pending migrations atomically and records their checksum.
3. Probes `STRICT`, JSON1 (`json_valid`), and effective WAL; WAL is requested and read back.
4. Emits human diagnostics only on stderr and accepts no MCP traffic on failure.

`MIGRATION_CHECKSUM_MISMATCH` and `SQLITE_CAPABILITY_MISSING` are safe startup failures. They include the actionable version/capability facts without silently rewriting migration history or schema.

## Rollout

1. Stop competing writers and keep a verified pre-migration backup.
2. Run the server once so checksum and SQLite preflight complete.
3. Verify `tools/list` and a temporary-DB `initialize` handshake before enabling clients.
4. Roll out P0 consumers, then P1 snapshot/history/lease consumers.

For the runtime rollout, record the current Volta pin/default, Node/npm versions, and direct global ForgeSpec wrapper path before selecting the exact Node 24.18.1 project pin. Do not reinstall the working wrapper or change the direct OpenCode command. The exact Node 24.18.1 release lane is eligible only after the independent Node 22 compatibility gate passes; both lanes use `npm ci`.

The runtime inventory is **25 MCP tools**. The benchmark fixture is 10,000 tasks × 20 versions, page 100, and 30 warmed pages; reference targets are median `<250 ms` and p95 `<500 ms`.

## Rollback and interruption recovery

- Migration transactions are atomic: interruption leaves the complete old or new state.
- **Schema rollback is backup-only:** with the **server stopped**, restore the verified pre-migration SQLite backup, and restart. Never delete the active history table, decrement `user_version`, or edit a recorded checksum.
- Keep the backup and diagnostics until post-restore checks pass.
- For OpenCode activation, restore the byte-for-byte configuration backup and previous global package version/path, then perform another full restart. A changed configuration without restart is not a completed rollout.
- If Node 24.18.1, its native ABI, or the handshake fails, restore the prior Volta pin/default and rebuild the affected isolated dependency tree with `npm ci`; never reuse bindings from another runtime.
