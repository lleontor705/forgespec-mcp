# ForgeSpec direct-v1

**Version:** 1.6.0 | **API version:** 1.0.0 | **Schema:** 6 | **Entrypoint:** `build/index.js` | **Primary Node:** 24.18.1 | **Supported Node:** 22.x, 24.x, and 26.x

direct-v1 is the transactional coordination mode for boards, tasks, contracts, and file leases. The runtime currently exposes **30 MCP tools**; the inventory below is generated from `tools/list` and is the compatibility checklist.

## Runtime inventory

`forgespec_capabilities`, `forgespec_health`, `tb_audit_log`, `sdd_validate`, `sdd_save`, `sdd_history`, `sdd_get`, `sdd_list`, `tb_create_board`, `tb_add_task`, `tb_status`, `tb_claim`, `tb_set_dependencies`, `tb_heartbeat`, `tb_recover_claims`, `tb_requeue`, `tb_approve`, `tb_grant`, `tb_handoff`, `tb_revoke`, `tb_query`, `tb_batch_status`, `tb_events`, `tb_update`, `tb_unblocked`, `tb_get`, `tb_list_boards`, `file_reserve`, `file_release`, `file_renew`.

Clients should call `forgespec_capabilities` before using direct-v1. The server reports package version, API/schema versions, limits, capabilities, and the `local-trusted-client` boundary.

`task-authority@1.0.0` is an optional, additive capability. Advertisement alone does not select it: a client must request `task-authority` with a range containing `1.0.0` and must observe `selected: "1.0.0"` before constructing the exact negotiated token `task-authority@1.0.0`. Clients that omit it retain the existing direct-v1 surface, and genuinely legacy resources retain the existing legacy tools and schemas. An absent or unsupported version does not enable authority extensions and never falls back or down-migrates a direct-v1 resource to legacy.

The `cortex-ia` orchestration layer should persist the selected manifest and re-check it after restart; ForgeSpec owns persisted coordination state while cortex-ia owns scheduling and runtime context.

## Guarantees

- **Runtime:** CI has nine isolated jobs for Node 22.x, 24.x, and 26.x on Ubuntu, Windows, and macOS. Native `better-sqlite3` uses ABI 127 on Node 22, ABI 137 on Node 24, and ABI 147 on Node 26. Each job starts clean and runs `npm ci --ignore-scripts`; only npm download caches are allowed.
- **Lockfile:** Runtime changes consume the existing lockfile with `npm ci`; dependency versions, URLs, integrity hashes, and transitive entries are not regenerated or changed.

- **Authority:** ordinary task, query, and lease mutations require `now < expires_at_ms`. Heartbeats are allowed only before `expires_at_ms + 5,000 ms`; recovery starts at that boundary. The grace interval never authorizes ordinary reads or writes.
- **Snapshots:** strong task pages use one `snapshot_revision`; membership and visible values are resolved from that revision. Strong cursors are signed, context-bound, and expire at `expires_at_ms` (default TTL: 24 hours; equality is expired).
- **Errors:** stable normative codes are returned in `error.data.code`, including `ATTEMPT_EXPIRED`, `BOARD_QUERY_FORBIDDEN`, `CURSOR_INVALID`, `CURSOR_EXPIRED`, `CURSOR_VERSION_UNSUPPORTED`, `CURSOR_CONTEXT_MISMATCH`, `SNAPSHOT_INTEGRITY_ERROR`, `MIGRATION_CHECKSUM_MISMATCH`, and `SQLITE_CAPABILITY_MISSING`.
- **History:** task history is append-only and is not pruned. The indexed benchmark fixture is 10,000 tasks × 20 versions, page 100, with 30 warmed pages; acceptance targets are median `<250 ms` and p95 `<500 ms` in the reference CI run.
- **Compatibility:** strong mode is the default. Legacy/best-effort behavior requires explicit opt-in and cannot continue into a strong cursor.

## Security boundary

The process uses `local-trusted-client`: local process and database access are trusted; actor strings are policy identity, not remote authentication. Tokens are returned once and stored as SHA-256 hashes. Cursors are HMAC-signed. Errors do not expose SQL, secrets, signatures, or hidden board existence.

## Optional task authority

The server remains the authority for resource classification and authorization. For each protected `read_board`, `read_task`, `add`, `update`, `approve`, `recover`, `grant`, `handoff`, or `revoke`, it evaluates actor, operation, exact resource, active attempt or grant, and expiry using one server time. Equality at `expires_at_ms` is expired. A denied decision occurs before protected data or domain mutation.

The extension APIs `tb_grant`, `tb_handoff`, and `tb_revoke` require the exact negotiated token `task-authority@1.0.0`; omission or any unsupported version returns stable `AUTH_CAPABILITY_REQUIRED` and does not retry through legacy. Grants are actor-, operation-, resource-, and expiry-scoped. Revocation is append-only and makes the grant unusable for subsequent decisions. A handoff preserves `owner_actor`, stores only auditable ForgeSpec/Cortex references, and never stores a conversation transcript or its content.

### Delegation before dispatch

A dispatcher must run `tb_grant` (or `tb_handoff`) **before** dispatching a worker to a direct-v1 board. Grants and handoffs are the only way a non-owner actor passes `read_board`/`read_task`, so dispatching first produces a worker that can neither authorize `tb_query`/`tb_batch_status`/`tb_events` reads nor discover the board. The order is: negotiate `task-authority@1.0.0`, create the expiring grant or handoff for the exact actor, operation, resource, and expiry, then dispatch with references (never transcripts).

Anti-enumeration and discovery never substitute for that authority. `tb_status` and `tb_get` answer a protected direct-v1 board or task ID exactly as they answer a nonexistent one — there is no orientation on legacy routes and no existence oracle for unauthorized callers. Recovery after context loss uses authorized discovery instead: `tb_list_boards`, called with the full direct-v1 actor context, lists the direct-v1 boards that actor owns or holds an active `read_board` grant on. Candidate IDs are prefiltered by owner-or-grant relationship before any canonical decision, no board payload is read before an allow, and the decision plus payload read share one immediate transaction and one observed server time, so a listing linearizes with `tb_revoke`. Every other caller sees legacy boards only, so unrelated actors cannot enumerate direct-v1 boards.

Approval records contain **asserted provenance**, not authenticated identity. They retain `allowed_actors` enforcement and record the asserted actor, `local-trusted-client` boundary, direct-v1 mode, and an approval reference. Documentation, API responses, and audit consumers must not describe this provenance as authentication.

Schema 4 is the original additive task-authority schema. It introduced grant, revocation, and handoff persistence, authority-command idempotency, asserted approval provenance, and links to the existing immutable authority event log. Schema 5 is a separate additive migration that hardened the persisted state with explicit grant lineage, canonical SHA-256 digest constraints, and hashed idempotency-key storage without reinterpreting schema 4 authority records. The latest schema is 6. Migration 6 additively requires every delegated grant to preserve its parent grant's exact operation and to name the parent grantee as the delegating actor. Existing authority rows and schema 5 constraints remain unchanged; the phrase "latest schema is 5" is retained here only to identify that claim as stale. Rollback disables capability advertisement and use while preserving schemas 4, 5, and 6 durable data; it does not down-migrate or delete that data.

Authority denials use stable codes in `error.data.code`:

- `AUTH_UNKNOWN_OPERATION`, `AUTH_CONTEXT_REQUIRED`: unknown operation or incomplete direct-v1 context.
- `AUTH_ATTEMPT_MISMATCH`, `AUTH_ATTEMPT_INACTIVE`, `AUTH_ATTEMPT_EXPIRED`: the supplied attempt cannot authorize the operation.
- `AUTH_OWNER_OR_GRANT_REQUIRED`, `AUTH_GRANT_INACTIVE`, `AUTH_SCOPE_MISMATCH`: no effective owner/grant authority exists for the exact actor, operation, and resource.
- `AUTH_ACTOR_NOT_ALLOWED`, `AUTH_PROVENANCE_REQUIRED`: approval policy or asserted provenance is missing.
- `AUTH_CAPABILITY_REQUIRED`: `task-authority@1.0.0` was not selected exactly; there is no legacy fallback.
- `AUTH_IDEMPOTENCY_CONFLICT`, `AUTH_REVISION_CONFLICT`: the request conflicts with its prior idempotent payload or expected revision.
- `RESOURCE_NOT_AVAILABLE`, `AUTH_STATE_UNAVAILABLE`: a protected resource cannot be exposed or durable authority cannot be reconstructed. Both fail closed.

## P0/P1 rollout

- **P0:** capability negotiation, CAS task/board transitions, idempotency, attempts, recovery, dependencies, audit events, and contract revisions.
- **P1:** evidence and approvals, bounded snapshot queries, event history cursors, and normalized file leases.

Deploy P0 first, then enable P1 consumers after `tools/list`, migration preflight, and temporary-DB handshake pass. The process accepts MCP traffic only after migration checksums and SQLite capabilities are qualified.

## Startup and operational checks

Before `initialize`, startup verifies applied migration checksums, then qualifies `STRICT`, JSON1 (`json_valid`), and effective WAL. Human diagnostics go to stderr; stdout remains protocol-only. A checksum or capability failure exits non-zero without accepting MCP traffic.

Use the package bin directly after installing the exact package version:

```bash
npm install -g forgespec-mcp@1.5.0
forgespec-mcp --version
```

For OpenCode, preserve and invoke the existing direct global `forgespec-mcp` wrapper. Verify its resolved executable, temporary-DB `initialize`/`tools/list` handshake, clean close, and a full client restart before declaring rollout complete; do not substitute `npx`. If validation fails, restore the byte-for-byte configuration backup and previous runtime/package state, then restart again.

## Release and runtime procedure

The release workflow builds, tests, and packages only on exact Node 24.18.1. Its independent Node 22 compatibility gate must pass before packaging or publish can proceed. Volta must pin the project to `24.18.1`; record `volta list`, `volta which node`, and the direct wrapper path before activation. If activation or the handshake fails, restore the prior Volta pin/default and wrapper/configuration state, rebuild dependencies with `npm ci`, and repeat the temporary-DB handshake. Do not regenerate or churn the lockfile during this procedure.

### Rollback

Rollback preserves the existing direct global ForgeSpec wrapper and direct OpenCode command. Restore the byte-for-byte configuration backup and prior runtime state, restart the client, and repeat the direct temporary-DB handshake; do not substitute `npx`.

For task-authority rollback, first disable capability advertisement and use. Existing grant, handoff, revocation, provenance, and audit rows remain intact but inert; do not delete additive tables, rename legacy tools, or down-migrate the database. Genuine legacy resources and the base direct-v1 surface remain available under their existing contracts. Re-enable advertisement only after focused negotiation, authority, restart, and legacy compatibility checks pass.
