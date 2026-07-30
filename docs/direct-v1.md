# ForgeSpec direct-v1

**Version:** 1.4.0 | **API version:** 1.0.0 | **Schema:** 3 | **Entrypoint:** `build/index.js` | **Primary Node:** 24.18.1 | **Supported Node:** >=22

direct-v1 is the transactional coordination mode for boards, tasks, contracts, and file leases. The runtime currently exposes **25 MCP tools**; the inventory below is generated from `tools/list` and is the compatibility checklist.

## Runtime inventory

`forgespec_capabilities`, `sdd_validate`, `sdd_save`, `sdd_history`, `sdd_get`, `sdd_list`, `tb_create_board`, `tb_add_task`, `tb_status`, `tb_claim`, `tb_set_dependencies`, `tb_heartbeat`, `tb_recover_claims`, `tb_requeue`, `tb_approve`, `tb_query`, `tb_batch_status`, `tb_events`, `tb_update`, `tb_unblocked`, `tb_get`, `tb_list_boards`, `file_reserve`, `file_release`, `file_renew`.

Clients should call `forgespec_capabilities` before using direct-v1. The server reports package version, API/schema versions, limits, capabilities, and the `local-trusted-client` boundary.

The `cortex-ia` orchestration layer should persist the selected manifest and re-check it after restart; ForgeSpec owns persisted coordination state while cortex-ia owns scheduling and runtime context.

## Guarantees

- **Runtime:** CI has six isolated jobs for Node 22.x and 24.x on Ubuntu, Windows, and macOS. Native `better-sqlite3` uses ABI 127 on Node 22 and ABI 137 on Node 24. Each job starts clean and runs `npm ci`; only npm download caches are allowed.
- **Lockfile:** Runtime changes consume the existing lockfile with `npm ci`; dependency versions, URLs, integrity hashes, and transitive entries are not regenerated or changed.

- **Authority:** ordinary task, query, and lease mutations require `now < expires_at_ms`. Heartbeats are allowed only before `expires_at_ms + 5,000 ms`; recovery starts at that boundary. The grace interval never authorizes ordinary reads or writes.
- **Snapshots:** strong task pages use one `snapshot_revision`; membership and visible values are resolved from that revision. Strong cursors are signed, context-bound, and expire at `expires_at_ms` (default TTL: 24 hours; equality is expired).
- **Errors:** stable normative codes are returned in `error.data.code`, including `ATTEMPT_EXPIRED`, `BOARD_QUERY_FORBIDDEN`, `CURSOR_INVALID`, `CURSOR_EXPIRED`, `CURSOR_VERSION_UNSUPPORTED`, `CURSOR_CONTEXT_MISMATCH`, `SNAPSHOT_INTEGRITY_ERROR`, `MIGRATION_CHECKSUM_MISMATCH`, and `SQLITE_CAPABILITY_MISSING`.
- **History:** task history is append-only and is not pruned. The indexed benchmark fixture is 10,000 tasks × 20 versions, page 100, with 30 warmed pages; acceptance targets are median `<250 ms` and p95 `<500 ms` in the reference CI run.
- **Compatibility:** strong mode is the default. Legacy/best-effort behavior requires explicit opt-in and cannot continue into a strong cursor.

## Security boundary

The process uses `local-trusted-client`: local process and database access are trusted; actor strings are policy identity, not remote authentication. Tokens are returned once and stored as SHA-256 hashes. Cursors are HMAC-signed. Errors do not expose SQL, secrets, signatures, or hidden board existence.

## P0/P1 rollout

- **P0:** capability negotiation, CAS task/board transitions, idempotency, attempts, recovery, dependencies, audit events, and contract revisions.
- **P1:** evidence and approvals, bounded snapshot queries, event history cursors, and normalized file leases.

Deploy P0 first, then enable P1 consumers after `tools/list`, migration preflight, and temporary-DB handshake pass. The process accepts MCP traffic only after migration checksums and SQLite capabilities are qualified.

## Startup and operational checks

Before `initialize`, startup verifies applied migration checksums, then qualifies `STRICT`, JSON1 (`json_valid`), and effective WAL. Human diagnostics go to stderr; stdout remains protocol-only. A checksum or capability failure exits non-zero without accepting MCP traffic.

Use the package bin directly after installing the exact package version:

```bash
npm install -g forgespec-mcp@1.4.0
forgespec-mcp --version
```

For OpenCode, preserve and invoke the existing direct global `forgespec-mcp` wrapper. Verify its resolved executable, temporary-DB `initialize`/`tools/list` handshake, clean close, and a full client restart before declaring rollout complete; do not substitute `npx`. If validation fails, restore the byte-for-byte configuration backup and previous runtime/package state, then restart again.

## Release and runtime procedure

The release workflow builds, tests, and packages only on exact Node 24.18.1. Its independent Node 22 compatibility gate must pass before packaging or publish can proceed. Volta must pin the project to `24.18.1`; record `volta list`, `volta which node`, and the direct wrapper path before activation. If activation or the handshake fails, restore the prior Volta pin/default and wrapper/configuration state, rebuild dependencies with `npm ci`, and repeat the temporary-DB handshake. Do not regenerate or churn the lockfile during this procedure.

### Rollback

Rollback preserves the existing direct global ForgeSpec wrapper and direct OpenCode command. Restore the byte-for-byte configuration backup and prior runtime state, restart the client, and repeat the direct temporary-DB handshake; do not substitute `npx`.
