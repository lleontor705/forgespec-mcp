# ForgeSpec MCP Protocol 2.0

<p align="center">
  <img src="docs/assets/architecture.svg" alt="ForgeSpec MCP Protocol 2.0 Architecture" width="100%">
</p>

<p align="center">
  <strong>Model Context Protocol (MCP) Server for Auditable, Multi-Agent Spec-Driven Development (SDD)</strong>
</p>

<p align="center">
  <a href="https://github.com/lleontor705/forgespec-mcp/actions"><img src="https://img.shields.io/badge/build-passing-brightgreen.svg?style=flat-square" alt="Build Status"></a>
  <a href="https://nodejs.org"><img src="https://img.shields.io/badge/node-%3E%3D22.0.0-blue.svg?style=flat-square" alt="Node Version"></a>
  <a href="https://modelcontextprotocol.io"><img src="https://img.shields.io/badge/MCP-2.0.0-orange.svg?style=flat-square" alt="MCP Protocol"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/license-MIT-green.svg?style=flat-square" alt="License"></a>
</p>

---

## 📖 Overview

**ForgeSpec MCP** provides a rigorous, fail-closed coordination substrate for autonomous AI agents and pair-programming assistants. Built specifically for **Spec-Driven Development (SDD)**, it replaces chaotic multi-agent file modifications with cryptographic revisions, scoped file locks, deterministic role profiles, and an immutable audit trail.

ForgeSpec exposes a single canonical protocol: **Protocol 2.0** (`forgespec-mcp@2.0.0`).

---

## ⚡ Quick Start

### Installation & Execution

```bash
# Install dependencies and build
npm ci
npm run build

# Launch the stdio MCP server with a secure cursor secret
FORGESPEC_CURSOR_SECRET="at-least-32-bytes-of-secret-material" npx forgespec-mcp
```

The server communicates via standard MCP JSON-RPC over **stdio**. Protocol messages are received on `stdin` and returned on `stdout`; all startup diagnostics and preflight warnings are routed to `stderr`. The entrypoint executable is `build/index.js`.

### Environment Configuration

| Variable | Description | Default |
|---|---|---|
| `FORGESPEC_CURSOR_SECRET` | 32+ byte HMAC secret (or comma-separated key ring for zero-downtime rotation) | Ephemeral random secret |
| `FORGESPEC_DB` | Path to the SQLite database file | `~/.forgespec/forgespec.db` |
| `FORGESPEC_DIR` | Base directory for ForgeSpec data storage | `~/.forgespec/` |
| `FORGESPEC_NODE_PATH` | Explicit Node binary path for the identity broker | `process.execPath` |

---

## 🔄 SDD 2.0 Lifecycle Pipeline

<p align="center">
  <img src="docs/assets/sdd-pipeline.svg" alt="SDD 2.0 Lifecycle Pipeline" width="100%">
</p>

ForgeSpec enforces a strictly sequenced 8-phase contract progression:

```text
init ➔ explore ➔ proposal ➔ spec ➔ design ➔ tasks ➔ apply ➔ verify
```

* **Cryptographic Revisions**: Each contract commit produces a deterministic SHA-256 digest linked to the parent contract and board revision.
* **Attempt Gating**: Execution transitions from `tasks` to `apply` and `verify` require verified attempt claims and file lease grants.

---

## 🛠️ Canonical Tool Catalog (18 Tools)

The server publishes exactly **18 tools** in deterministic order, partitioned into 6 domain modules:

| Domain | Tools | Description |
|---|---|---|
| **Boards & Contracts** | `board_create`<br>`contract_commit`<br>`contract_query`<br>`contract_validate` | Project workspaces, phase progression, schema validation, and immutable SDD specs. |
| **Tasks & Planning** | `task_define`<br>`task_query`<br>`task_transition` | DAG dependency definition, state machine transitions (`ready`, `in_progress`, `in_review`, `done`). |
| **Execution & Attempts** | `attempt_claim`<br>`attempt_recover`<br>`attempt_renew` | Worker assignment, bounded TTL execution attempts, recovery protocol. |
| **File Leases** | `lease_reserve`<br>`lease_renew`<br>`lease_release` | Scoped optimistic file reservations preventing write collisions across agents. |
| **Governance & Events** | `authority_manage`<br>`approval_record`<br>`event_query` | Delegated capability grants, human/reviewer sign-offs, HMAC-paginated audit trail. |
| **Core & Diagnostics** | `forge_health`<br>`forge_negotiate` | Capability handshake, profile negotiation, storage and runtime qualification. |

### Deterministic Profiles

Four deterministic role profiles expose tailored tool subsets:
* **`planner`**: Focuses on contract authoring, task decomposition, and board querying.
* **`worker`**: Focused on attempt claiming, file lease reservation, and execution transitions.
* **`reviewer`**: Evaluates gate decisions and records verified approvals.
* **`orchestrator`**: Full coordination capability across boards, authority delegation, and task pipelines.

---

## 🛡️ Security & Identity Threat Boundary

```text
OpenCode Plugin ──private stdio──> Identity Broker ──> Sidecar Store (5 tables)
       │                                     └──── root handle + worker handles
       └─ Signed Identity Envelopes (_identity); no actor fields in tool arguments
```

1. **Identity Isolation**: The identity sidecar (5 tables) is physically separated from the domain store (16 `fs_*` tables).
2. **No Actor Fields in Model Payload**: Models do not provide caller/actor IDs. The plugin injects cryptographic `_identity` envelopes validated by the server.
3. **Shell-Free Execution**: The broker process launches with `shell: false` to eliminate shell-injection attack surfaces.
4. **Token Security**: Authority and lease tokens are issued once, returned in memory, and stored exclusively as SHA-256 hashes.
5. **HMAC Event Cursors**: Pagination cursors for `event_query` are signed with `FORGESPEC_CURSOR_SECRET` (supports key ring rotation).
6. **Fail-Closed Guarantees**: A malformed store, missing metadata, or schema corruption halts startup cleanly. Database reset is supported for fresh stores only.

---

## 🧩 OpenCode Integration (`opencode-forgespec`)

The official OpenCode integration is exported via `forgespec-mcp/plugin` and packaged as `opencode-forgespec`.

### Configuration in `opencode.json`

```json
{
  "plugin": [
    "opencode-forgespec"
  ]
}
```

> [!IMPORTANT]
> After installing or configuring `opencode-forgespec`, **restart OpenCode** to initialize the private identity broker. Ensure Node 22+ is available on your system path.

---

## 🗄️ Storage Architecture (16 STRICT Tables)

ForgeSpec utilizes an atomic, qualified SQLite schema with 16 strict `fs_*` tables:

```text
fs_schema_meta · fs_boards · fs_tasks · fs_task_dependencies · fs_gates · fs_gate_decisions
fs_attempts · fs_contracts · fs_leases · fs_lease_scopes · fs_authority · fs_authority_revocations
fs_approvals · fs_audit_events · fs_evidence · fs_idempotency
```

* **Prerequisites**: Requires SQLite `STRICT` table support, `JSON1`, foreign keys (`PRAGMA foreign_keys = ON`), and `WAL` journal mode.
* Further architecture details are documented in [docs/architecture.md](docs/architecture.md) and [docs/protocol-2.md](docs/protocol-2.md).

---

## 🧪 Verification & Quality Contract

The complete runtime contract and documentation consistency are verified with:

```bash
# Run unit, domain, security, and integration tests (229+ tests)
npm test

# Check strict TypeScript types
npm run lint

# Compile production bundle
npm run build

# Run runtime smoke preflight
npm run runtime:smoke
```

---

## 📄 License & Threat Model Notice

Distributed under the [MIT](LICENSE) License.

> [!NOTE]
> The private stdio broker boundary prevents language models from tampering with session identity. However, it is not an OS-level user security boundary. Host isolation should be applied when untrusted local users share execution environments.
