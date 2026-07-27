# ForgeSpec direct-v1 — Coordination Mode, Capabilities, and cortex-ia Contract

**Version:** 1.3.0 | **API version:** 1.0.0 | **Schema versions:** 1.0.0

direct-v1 is an additive, backward-compatible coordination mode that introduces transactional CAS, idempotency, immutable audit, attempt-based claim leases, normalized dependency DAGs, structured evidence references, approval gates, bounded queries, and normalized file reservation leases. Legacy 1.2.2 behavior remains fully available throughout 1.x.

---

## Capability Negotiation

Clients probe the server via `forgespec_capabilities` before using direct-v1 tools. The response reports:

- **Server identity:** `name: "forgespec-mcp"`, `version` (package semver), `api_version: "1.0.0"`.
- **Security model:** `identity_model: "local-trusted-client"`.
- **Modes:** `["legacy", "direct-v1"]`.
- **Schemas:** independently versioned intervals for `sdd_envelope`, `task_metadata`, and `evidence_ref` (all `[1.0.0, 2.0.0)`).
- **Capabilities:** independently versioned feature IDs with supported intervals and selected versions.
- **Limits:** page/batch/dependency/lease/clock/scope/idempotency bounds.
- **Compatibility:** `compatible`, `selected_mode`, `missing`, `incompatible`, and `unavailable_optional`.

### P0 Capabilities (required)

| ID | Description |
|----|-------------|
| `forgespec.capabilities` | Capability advertisement and negotiation |
| `task-cas` | Atomic task/board CAS transitions |
| `idempotency` | Scoped durable idempotency for all writes |
| `task-attempt-lease` | Exclusive renewable numbered attempt leases |
| `claim-recovery` | Expiry classification, audited recovery, explicit requeue |
| `dependency-transitions` | Normalized same-board DAG and all-of readiness |
| `audit-events` | Immutable ordered queryable authority events |
| `sdd-contract-revisions` | Canonical full-contract revisions with CAS |

All P0 capabilities are versioned `[1.0.0, 2.0.0)` with `selected: "1.0.0"`.

### P1 Capabilities (additive)

| ID | Description |
|----|-------------|
| `structured-evidence-links` | Provider-neutral typed digest references (no payload) |
| `approval-gates` | Immutable deterministic allow/deny gate decisions |
| `batch-status` | Bounded board/work-unit status snapshots |
| `query-cursors` | Signed snapshot/delta cursor pagination |
| `file-lease` | Normalized atomic renewable file reservation leases |

P1 capabilities follow the same version interval. Missing optional P1 blocks a specific feature rather than weakening direct-v1.

### Negotiation Rules

- Direct mode is never inferred: omitted negotiation remains legacy only on legacy resources.
- A legacy-shaped write against a direct-v1 board is rejected with `category: "compatibility"`.
- Unsupported required major returns `compatible: false` and direct-v1 is not selected.
- Unavailable optional capabilities are listed in `unavailable_optional` without breaking compatibility.

---

## Security Boundary

**`local-trusted-client`** — ForgeSpec operates under stdio and assumes the local process and database file are trusted. Tokens provide bounded authority for task/lease mutations; actor strings provide policy identity, not cryptographic authentication. ForgeSpec prevents races and stale authority between concurrent agents, not malicious local DB or process access.

- Tokens (claim, file lease) are 256-bit random, returned once, stored as SHA-256 hashes.
- Errors, audit events, and logs never store raw tokens, secrets, credentials, or evidence payloads.
- SQL is bounded; Zod schemas are strict; cursors are HMAC-signed and reauthorize each page.

---

## cortex-ia Contract

cortex-ia (the orchestration layer) MUST:

1. **Probe capabilities** before using direct-v1 — require every P0 interval, optionally require P1.
2. **Create direct boards** with work units, file scopes, strict-TDD metadata, and gate declarations.
3. **Query ready work** via `tb_query` or `tb_batch_status`, then **claim exactly one task** per active attempt.
4. **Retain attempt tokens** only in runtime secret context; pass `claim_token` + `expected_revision` on every mutation.
5. **Heartbeat** active claims within the lease TTL.
6. **Own evidence payload and provenance** — only typed digest references go to ForgeSpec via `evidence_links`.
7. **Recover via deltas** — use `tb_events` or `tb_batch_status` with `since_revision` after restart. No broadcasts or messaging are used.
8. **Missing required P1 blocks** instead of weakening guarantees.

### Ownership Boundary

| ForgeSpec owns | cortex-ia owns |
|----------------|----------------|
| Persisted task/board/attempt/readiness/history | Orchestration, invocation, prompts |
| Contract revisions, idempotency, immutable events | Runtime context, Git/worktrees |
| File lease authority, capability negotiation | External CI/deploy coordination |
| Migration, schema, backup/restore | Agent lifecycle, scheduling |

### Generated Manifest

cortex-ia should record the selected versions, capabilities, schemas, and `local-trusted-client` boundary from the `forgespec_capabilities` response. A doctor/diagnostic check can compare the recorded manifest against the live server to detect version drift.

---

## MCP Tool Inventory (direct-v1 additions)

All tools preserve legacy behavior when `coordination_mode` is omitted. Direct-v1 responses include `structuredContent` identical to JSON text.

| Tool | P0/P1 | Purpose |
|------|-------|---------|
| `forgespec_capabilities` | P0 | Negotiate mode, capabilities, limits |
| `sdd_save` | P0 | Canonical full-contract revision with CAS |
| `sdd_get` | P0 | Retrieve contract by ID |
| `sdd_history` | P0 | Paged contract history with deltas |
| `tb_create_board` | P0 | Atomic board creation with inline tasks |
| `tb_add_task` | P0 | Add task with CAS |
| `tb_set_dependencies` | P0 | Normalized DAG edges with readiness recomputation |
| `tb_claim` | P0 | Exclusive numbered attempt lease |
| `tb_heartbeat` | P0 | Renew claim within TTL |
| `tb_update` | P0 | CAS task transition with evidence |
| `tb_recover_claims` | P0 | Audited expiry/abandonment recovery |
| `tb_requeue` | P0 | Explicit requeue with readiness recomputation |
| `tb_approve` | P1 | Immutable gate decision |
| `tb_query` | P1 | Bounded filtered cursor query |
| `tb_batch_status` | P1 | Board/work-unit snapshot with counts |
| `tb_events` | P1 | Authority event delta query |
| `file_reserve` | P1 | Normalized atomic file lease |
| `file_renew` | P1 | Renew file lease |
| `file_release` | P1 | Release file lease |

---

## Explicitly Excluded Features

direct-v1 does NOT include: messaging, inbox/thread/search/broadcast, notifications, dead-letter queue, debate, Agent Cards, A2A task delegation, remote invocation, or deploy/CI/API/database/infrastructure/general external-resource leases. File leases are the only external-resource lease type.

---

## Versioning

Versioning is additive throughout 1.x. The rollout sequence:

- **1.3.x:** migrations v2, capabilities, errors, hashing, idempotency, full contract revisions.
- **1.4.x:** P0 direct boards/tasks/CAS/events/DAG/attempts/recovery/deltas.
- **1.5.x:** schema v3 evidence/approvals/cursors/file leases.

Disabling direct-v1 makes direct resources read-only and retains all history. No down-conversion or deletion is permitted after direct writes.
