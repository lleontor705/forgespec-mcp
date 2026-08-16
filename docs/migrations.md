# ForgeSpec migrations and rollback

**Package:** `forgespec-mcp@1.6.0` | **Current schema:** 6 | **Primary Node:** 24.18.1 | **Supported Node:** 22.x, 24.x, and 26.x

## Schema versions

| user_version | Meaning |
|---:|---|
| 0 | Fresh database |
| 1 | Legacy ForgeSpec 1.2.2 tables and migration control |
| 2 | direct-v1 P0 core |
| 3 | Append-only `direct_task_versions` history and indexes |
| 4 | Additive, append-only direct-v1 authority persistence |
| 5 | Grant-lineage, canonical-digest, and hashed idempotency-storage hardening |
| 6 | Exact delegated grant lineage operation and actor-identity hardening |

Migration 3 creates one historical base row per existing direct task when its unique `task_created` authority event supplies a valid board revision. It preserves visible values, records logical deletion, and does not fabricate rows for legacy-only tasks. A future or ambiguous revision aborts the transaction.

Every visible direct-task change writes the projection and exactly one history row in the same transaction. No-op and idempotent replays do not add versions. History is append-only: this change does **not** prune or TTL-delete it.

Migration 4 advances schema 3 to schema 4 additively. It creates six durable authority tables for grants, revocations, handoffs, handoff references, canonical command idempotency, and asserted approval provenance, together with their indexes, constraints, and append-only protections. It does not remove or rename schema 3 objects, rewrite `owner_actor`, or alter genuine legacy tables or data; legacy resources therefore remain operable.

Authority rows, asserted provenance, references, expirations, revocations, idempotent responses, and their event links survive restart. When the optional authority capability is disabled or not negotiated, this durable schema 4 data remains intact but inert: it does not enable grant, handoff, or revoke behavior and is not backfilled into legacy authority. If required durable authority tables are unavailable, startup fails closed with `AUTH_STATE_UNAVAILABLE` instead of inferring authority.

Migration 5 hardens that schema 4 authority persistence additively. It records grant ancestry, enforces canonical SHA-256 digests for durable references, and stores idempotency-key hashes without changing schema 4's original authority tables or meaning. Existing schema 4 rows remain durable; unknown historical lineage is represented explicitly rather than invented. Rollback remains code/configuration-only: do not down-migrate or discard persisted schema 4 or 5 data.

Migration 6 additively requires every delegated grant to preserve its parent grant's exact operation and to name the parent grantee as the delegating actor. Existing authority rows and schema 5 constraints remain unchanged; rollback disables the capability or restores prior code while retaining schema 6 data and migration history.

## Startup preflight

Runtime qualification is isolated per supported line: nine jobs cover Node 22.x, 24.x, and 26.x on Ubuntu, Windows, and macOS. Node 22 uses ABI 127, Node 24.18.1 uses ABI 137, and Node 26 uses ABI 147. Each CI job starts from a clean checkout, runs `npm ci --ignore-scripts`, loads `better-sqlite3`, and exercises migration and temporary-DB MCP handshake paths. Only npm download caches are permitted; native bindings and `node_modules` are not shared. The lockfile is consumed as-is: runtime changes must not regenerate dependency entries or introduce lockfile churn.

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

The runtime inventory is **28 MCP tools**. The benchmark fixture is 10,000 tasks × 20 versions, page 100, and 30 warmed pages; reference targets are median `<250 ms` and p95 `<500 ms`.

## Rollback and interruption recovery

- Migration transactions are atomic: interruption leaves the complete old or new state.
- **Schema 6 rollback is code/documentation/configuration-only:** with the **server stopped**, disable the optional authority capability or restore the prior binary and documentation, then restart. Keep schema 4 authority persistence and schema 5/6 lineage hardening intact and inert; never down-migrate, decrement `user_version`, delete additive tables or data, rewrite `owner_actor`, or edit a recorded checksum.
- Keep the backup and diagnostics until post-restore checks pass.
- For OpenCode activation, restore the byte-for-byte configuration backup and previous global package version/path, then perform another full restart. A changed configuration without restart is not a completed rollout.
- If Node 24.18.1, its native ABI, or the handshake fails, restore the prior Volta pin/default and rebuild the affected isolated dependency tree with `npm ci`; never reuse bindings from another runtime.
