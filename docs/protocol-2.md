# Protocol 2.0 Reference

Protocol 2.0 is the ForgeSpec MCP contract: a fail-closed runtime for SDD coordination over MCP stdio.

## Catalog

`attempt_claim`, `attempt_recover`, `attempt_renew`, `authority_manage`,
`approval_record`, `board_create`, `contract_commit`, `contract_query`,
`contract_validate`, `event_query`, `forge_health`, `forge_negotiate`,
`lease_release`, `lease_renew`, `lease_reserve`, `task_define`, `task_query`,
`task_transition`.

Profiles are `planner`, `worker`, `orchestrator`, and `reviewer`; each receives
a deterministic subset of the 18 names.

## Fresh stores

The schema has 16 tables: `fs_schema_meta`, `fs_boards`, `fs_tasks`,
`fs_task_dependencies`, `fs_gates`, `fs_gate_decisions`, `fs_attempts`,
`fs_contracts`, `fs_leases`, `fs_lease_scopes`, `fs_authority`,
`fs_authority_revocations`, `fs_approvals`, `fs_audit_events`, `fs_evidence`,
and `fs_idempotency`. Bootstrap and qualification require STRICT, JSON1,
foreign keys, and WAL. A fresh store is created atomically; corruption or an
incomplete bootstrap stops startup and leaves the protocol channel clean.

## Tokens and event cursors

Issued authority, attempt, and lease tokens are shown once. Persistent records
contain hashes, never raw tokens. Audit events redact token material. Event
query cursors are opaque HMAC-authenticated values bound to actor and query
parameters. Set `FORGESPEC_CURSOR_SECRET` to a secret of at least 32 bytes;
the stdio process generates an ephemeral secret when absent. Embedders pass
`cursorSecret` to `createServer`.

## Transport and phases

The entrypoint is `build/index.js`. JSON-RPC travels on stdin/stdout and
startup errors go to stderr. SDD phases are `init`, `explore`, `proposal`,
`spec`, `design`, `tasks`, `apply`, and `verify`.

The identity sidecar is separate and contains 5 `fsi_*` tables. It issues root
and enrolled worker handles; the domain protocol carries no actor fields. Reset
is a fresh-store operation only and MUST NOT repair an existing store. The
OpenCode plugin starts a shell-free broker child, waits for readiness,
correlates calls, and closes it during disposal; manually restart OpenCode after
plugin or broker changes.
