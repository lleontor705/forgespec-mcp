# ForgeSpec MCP Protocol 2.0 Specification

**Status:** final · **Version:** 2.0 · **Package:** `forgespec-mcp@2.0.0`

The OpenCode integration is exported as `forgespec-mcp/plugin` and launches a
shell-free identity broker. Root and enrolled worker handles define the identity
boundary; protocol inputs contain no actor fields. The sidecar has 5 tables and
the domain store has 16; reset is fresh-store-only.

## Scope

The server implements a single MCP protocol contract for coordinated SDD.
It MUST fail closed before accepting MCP traffic when storage qualification,
bootstrap, or capability checks fail. It MUST use stdio JSON-RPC: stdout is
reserved for protocol messages and diagnostics use stderr.

## Lifecycle

The allowed contract phases, in order, are:

`init`, `explore`, `proposal`, `spec`, `design`, `tasks`, `apply`, `verify`.

Each saved contract has a project, change name, phase, status, confidence,
revision, digest, structured JSON, and immutable audit lineage.

## Tools and profiles

The catalog is exactly 18 names:

| Domain | Tools |
|---|---|
| attempts | `attempt_claim`, `attempt_recover`, `attempt_renew` |
| authority and approvals | `authority_manage`, `approval_record` |
| boards and contracts | `board_create`, `contract_commit`, `contract_query`, `contract_validate` |
| events and health | `event_query`, `forge_health`, `forge_negotiate` |
| leases | `lease_release`, `lease_renew`, `lease_reserve` |
| tasks | `task_define`, `task_query`, `task_transition` |

Profiles are `planner`, `worker`, `orchestrator`, and `reviewer`. Each profile
is deterministic and contains only catalog tools; negotiation returns the
profile-specific set and a maximum of 18 tools.

## Storage

The fresh-store schema contains exactly these 16 STRICT tables:

`fs_schema_meta`, `fs_boards`, `fs_tasks`, `fs_task_dependencies`, `fs_gates`,
`fs_gate_decisions`, `fs_attempts`, `fs_contracts`, `fs_leases`,
`fs_lease_scopes`, `fs_authority`, `fs_authority_revocations`, `fs_approvals`,
`fs_audit_events`, `fs_evidence`, `fs_idempotency`.

Bootstrap records schema `2.0.0`, validates JSON metadata, and records whether
recovery mode is active. STRICT, JSON1, foreign keys, and effective WAL are
required. Any missing metadata, invalid JSON, unsupported schema, failed
integrity check, or unavailable SQLite capability aborts startup.

## Concurrency and security

Mutations use optimistic revisions and scoped idempotency records. Attempts
and file leases have bounded expiry; lease conflicts are explicit. Authority
and attempt tokens are generated for issuance, returned once, hashed at rest,
and redacted from event payloads and errors thereafter.

`event_query` returns actor-authorized audit events. Its opaque cursor contains
the query binding and position authenticated with HMAC using
`FORGESPEC_CURSOR_SECRET`. A cursor with altered parameters, invalid HMAC, or
the wrong secret is rejected. The secret must be at least 32 bytes; an
embedding caller must pass `cursorSecret`, while the stdio entrypoint reads
the environment variable and otherwise creates an ephemeral random secret.

## Verification contract

Consumers can verify the final runtime with `npm test`, `npm run lint`, and
`npm run build`. Tests must supply a cursor secret when constructing a server.
