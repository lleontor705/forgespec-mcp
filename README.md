<p align="center">
  <img src="docs/assets/logo.svg" alt="ForgeSpec MCP" width="450" />
</p>

<p align="center">
  <img src="https://img.shields.io/npm/v/forgespec-mcp?style=flat-square&color=blue" alt="npm version" />
  <img src="https://img.shields.io/github/actions/workflow/status/lleontor705/forgespec-mcp/ci.yml?style=flat-square&label=CI" alt="CI" />
  <img src="https://img.shields.io/npm/l/forgespec-mcp?style=flat-square" alt="license" />
  <img src="https://img.shields.io/node/v/forgespec-mcp?style=flat-square" alt="node" />
  <img src="https://img.shields.io/npm/dm/forgespec-mcp?style=flat-square" alt="downloads" />
</p>

# ForgeSpec MCP

**The coordination backbone for multi-agent AI development.** ForgeSpec MCP is a [Model Context Protocol](https://modelcontextprotocol.io/) server that brings structured, auditable workflows to AI-powered software engineering through Spec-Driven Development (SDD).

---

## Why ForgeSpec?

Building software with multiple AI agents (Claude, Codex, Gemini, etc.) introduces coordination challenges that don't exist in single-agent workflows:

| Problem | Without ForgeSpec | With ForgeSpec |
|---------|-------------------|----------------|
| **Conflicting edits** | Two agents modify the same file simultaneously, causing merge conflicts and lost work | File reservation system with TTL prevents conflicts before they happen |
| **No shared context** | Each agent works in isolation; one agent's decisions are invisible to others | Contract validation creates a shared audit trail across all phases |
| **Unstructured work** | Agents jump straight to code without specs, producing inconsistent results | 9-phase pipeline enforces propose -> spec -> design -> implement flow |
| **Lost progress** | If an agent fails mid-task, there's no way to resume from where it left off | SQLite-backed task board persists state; any agent can pick up where another stopped |
| **No quality gates** | Code ships without validation against original requirements | Confidence thresholds block phase transitions until quality criteria are met |

### Verified runtime facts

- **Zero infrastructure** -- Embedded SQLite database, no external services required
- **Universal compatibility** -- Works with any MCP client: Claude Code, Codex CLI, Gemini CLI, OpenClaw, and more
- **Package:** `forgespec-mcp@1.6.0`; runtime schema 6; Node `24.18.1` is the primary runtime and Node `22.x`, `24.x`, and `26.x` are supported.
- **Runtime policy:** CI runs nine isolated jobs for Node `22.x`, `24.x`, and `26.x` on Ubuntu, Windows, and macOS. Node 22 uses native ABI 127; Node 24 uses ABI 137; Node 26 uses ABI 147.
- **Entrypoint:** the package bin is `build/index.js`, exposed as `forgespec-mcp`.
- **Runtime inventory:** **30 MCP tools**, listed in [docs/direct-v1.md](docs/direct-v1.md) and checked against `tools/list`.
- **SQLite preflight:** startup verifies immutable migration checksums and effective `STRICT`, JSON1, and WAL capabilities before MCP traffic.
- **Performance fixture:** 10,000 tasks × 20 versions, page 100, 30 warmed pages; reference targets are median `<250 ms` and p95 `<500 ms`.
- **Retention:** task history is append-only and is not pruned by this release.
- **Cortex-ready** -- Native integration with [Cortex](https://github.com/lleontor705/cortex) for persistent memory and knowledge graph across sessions
- **direct-v1 mode** -- Additive transactional coordination with CAS, idempotency, immutable audit, attempt leases, and capability negotiation for race-safe multi-agent work

---

## direct-v1 Coordination Mode

ForgeSpec 1.5.0 provides **direct-v1**, an additive coordination mode that provides transactional CAS, scoped idempotency, immutable audit history, exclusive attempt-based claim leases, normalized dependency DAGs, structured evidence references, approval gates, bounded snapshot queries, compound cursors, and atomic file reservation leases.

Clients negotiate via `forgespec_capabilities` before using direct-v1 tools. See [docs/direct-v1.md](docs/direct-v1.md) for authority, snapshots, errors, rollout, and the complete inventory. See [docs/migrations.md](docs/migrations.md) for checksum preflight, migration, rollback, and interruption recovery.

The advertised `task-authority@1.0.0` extension is optional and additive. A client must explicitly negotiate `task-authority` and observe exact selection of `1.0.0` before using grant, reference-only handoff, or revoke APIs; omission or an unsupported version leaves those APIs disabled without legacy fallback. Existing direct-v1 contracts and genuine legacy tools/schemas remain compatible. Approval identity is recorded as **asserted provenance** within `local-trusted-client`, not as authenticated identity. To roll back, disable advertisement/use and leave additive authority and audit data intact and inert; never down-migrate it.

---

## Recommended: Pair with Cortex

ForgeSpec manages the **workflow** (contracts, tasks, file locks). [**Cortex**](https://github.com/lleontor705/cortex) manages the **memory** (observations, knowledge graph, session continuity). Together they form a complete multi-agent coordination stack:

```
┌─────────────────────────────────────────────────────┐
│                   MCP Clients                       │
│   Claude Code  ·  Codex CLI  ·  Gemini CLI  · ...  │
└──────────┬──────────────────────────┬───────────────┘
           │                          │
     ┌─────▼─────┐            ┌──────▼──────┐
     │ ForgeSpec  │            │   Cortex    │
     │  MCP       │◄──────────►│   MCP       │
     │            │  artifact  │             │
     │ Contracts  │  type:     │ Observations│
     │ Task Board │  "cortex"  │ Knowledge   │
     │ File Locks │            │ Graph       │
     └────────────┘            └─────────────┘
```

- **ForgeSpec** validates and persists SDD contracts, manages task dependencies, prevents file conflicts
- **Cortex** stores artifacts as observations, connects them via knowledge graph, enables session recovery
- Artifacts saved with `type: "cortex"` are persisted to Cortex via `mem_save` and linked with `mem_relate`

Install both for the full experience:

```bash
claude mcp add forgespec --transport stdio -- npx -y forgespec-mcp
claude mcp add cortex --transport stdio -- npx -y @anthropic/cortex-mcp
```

> ForgeSpec works standalone without Cortex -- artifacts can also use `type: "openspec"` (filesystem) or `type: "inline"` (returned in response).

---

## Quick Start

### Using npx (no installation required)

```bash
npx -y forgespec-mcp
```

### Install globally

```bash
npm install -g forgespec-mcp@1.5.0
```

### Verify installation

```bash
forgespec-mcp --help
forgespec-mcp --version
```

The verified package bin/entrypoint is `build/index.js`. For OpenCode, preserve the existing direct global `forgespec-mcp` wrapper: verify its resolved executable and a temporary-DB `initialize`/`tools/list` handshake before editing configuration, and restart OpenCode completely after activation. Do not replace this direct wrapper with `npx`.

### P0/P1 rollout and rollback

Deploy P0 direct-v1 consumers first, then P1 snapshot/history/lease consumers after migration preflight and handshake checks pass. Keep a verified configuration/database backup. On failure, restore the byte-for-byte backup, restore the previous package version, and restart the client; a configuration edit without restart is not a completed rollout.

### Runtime rollout policy

Node `24.18.1` is the primary runtime; Node `22.x`, `24.x`, and `26.x` are supported through nine isolated jobs on Ubuntu, Windows, and macOS. Node 22 uses ABI 127, Node 24 uses ABI 137, and Node 26 uses ABI 147. Each job starts from a clean checkout and runs `npm ci --ignore-scripts`; only segmented npm download caches are permitted, and runtime changes must not regenerate or churn the lockfile. The release lane uses exact Node `24.18.1` and is blocked by the independent Node 22 compatibility gate.

For local activation, record `volta list`, `volta which node`, and `volta which forgespec-mcp`, then pin the project with `volta pin node@24.18.1` and verify the temporary-DB handshake. If activation fails, restore the prior Volta pin/default and rebuild dependencies with `npm ci`. Rollback preserves the existing direct global ForgeSpec wrapper and direct OpenCode command; restore the byte-for-byte configuration backup and restart the client before rechecking `initialize` and `tools/list`.

---

## Client Configuration

### Claude Code

```bash
claude mcp add forgespec --transport stdio -- npx -y forgespec-mcp
```

### Codex CLI (`~/.codex/config.toml`)

```toml
[mcp_servers.forgespec]
command = "npx"
args = ["-y", "forgespec-mcp"]
```

### Gemini CLI (`settings.json`)

```json
{
  "mcpServers": {
    "forgespec": {
      "command": "npx",
      "args": ["-y", "forgespec-mcp"]
    }
  }
}
```

### OpenClaw (`openclaw.json`)

```json5
mcp: {
  servers: {
    forgespec: { command: "npx", args: ["-y", "forgespec-mcp"] }
  }
}
```

---

## The SDD Pipeline

ForgeSpec enforces the **Spec-Driven Development** lifecycle -- a 9-phase pipeline that ensures AI agents work methodically rather than jumping straight to code.

<p align="center">
  <img src="docs/assets/sdd-pipeline.svg" alt="SDD Pipeline" width="100%" />
</p>

Each phase has a **confidence threshold** that must be met before transitioning to the next:

| Phase | Threshold | Purpose |
|-------|-----------|---------|
| `init` | 0.5 | Bootstrap project context and conventions |
| `explore` | 0.5 | Investigate codebase, diagnose issues |
| `propose` | 0.7 | Draft change proposal with scope and risks |
| `spec` | 0.8 | Write detailed specifications with Given/When/Then |
| `design` | 0.7 | Define architecture, data flows, file changes |
| `tasks` | 0.8 | Decompose into dependency-ordered implementation tasks |
| `apply` | 0.6 | Execute implementation (partial completion allowed) |
| `verify` | 0.9 | Validate implementation against specs |
| `archive` | 0.9 | Merge specs, generate retrospective |

---

## Tools Reference

ForgeSpec exposes **30 MCP tools**. The authoritative runtime inventory is maintained in [docs/direct-v1.md](docs/direct-v1.md) and tested against `tools/list`.

### Capability & Diagnostic Tools (3)

| Tool | Description |
|------|-------------|
| `forgespec_capabilities` | Negotiate API/schema versions, capabilities, limits, and mode |
| `forgespec_health` | Get server health diagnostics, database status, system time, and version telemetry |
| `tb_audit_log` | Query historical audit trail of authority grants, revocations, and approval decisions |

### SDD Contract Tools (5)

Manage the development lifecycle with typed, validated contracts.

| Tool | Description |
|------|-------------|
| `sdd_validate` | Validate a contract against phase schema with confidence check |
| `sdd_save` | Validate and persist a contract to the database |
| `sdd_get` | Retrieve a single contract by ID |
| `sdd_list` | List contracts with optional project/phase filters |
| `sdd_history` | Get phase transition history for a project |

### Task Board Tools (19)

SQLite-backed task management with dependency tracking and auto-unblocking.

| Tool | Description |
|------|-------------|
| `tb_create_board` | Create a board with optional inline tasks (atomic, avoids N separate calls) |
| `tb_add_task` | Add a task with priority, spec ref, criteria, and dependencies |
| `tb_status` | Get board status with tasks grouped by status |
| `tb_claim` | Claim a task (validates dependencies before assignment) |
| `tb_update` | Update status and/or append timestamped notes (auto-unblocks dependents on done) |
| `tb_unblocked` | List tasks ready to work on (all dependencies resolved) |
| `tb_get` | Get full task details by ID |
| `tb_list_boards` | List all boards (for discovery after context loss) |
| `tb_set_dependencies` | Set normalized dependency edges |
| `tb_heartbeat` | Renew an active attempt |
| `tb_recover_claims` | Recover expired claims |
| `tb_requeue` | Requeue a task |
| `tb_approve` | Record an approval decision |
| `tb_grant` | Create an attenuated, expiring task-authority grant |
| `tb_handoff` | Create a reference-only attenuated handoff |
| `tb_revoke` | Append an authority revocation without changing board ownership |
| `tb_query` | Query snapshot task pages |
| `tb_batch_status` | Read bounded board/work-unit status |
| `tb_events` | Read authority-event deltas |

### File Reservation Tools (3)

Advisory file locking to prevent multi-agent edit conflicts.

| Tool | Description |
|------|-------------|
| `file_reserve` | Reserve files/globs with TTL. Use `check_only: true` to check conflicts without reserving |
| `file_release` | Release reservations (specific patterns or all) |
| `file_renew` | Renew a file lease |

---

## Usage Examples

### Example 1: Validate and save an SDD contract

An AI agent completing the "propose" phase saves its work as a validated contract:

```jsonc
// Tool: sdd_validate
{
  "contract": "{\"phase\":\"propose\",\"change_name\":\"add-auth-service\",\"project\":\"my-app\",\"status\":\"success\",\"confidence\":0.85,\"executive_summary\":\"Add JWT-based authentication service with login, logout, and token refresh endpoints. Affects 4 files in src/auth/.\",\"artifacts_saved\":[{\"topic_key\":\"sdd/add-auth-service/proposal\",\"type\":\"cortex\"}],\"next_recommended\":[\"spec\",\"design\"],\"risks\":[{\"description\":\"Token storage strategy needs security review\",\"level\":\"medium\"}]}"
}

// Response:
{
  "valid": true,
  "phase": "propose",
  "confidence": 0.85,
  "threshold": 0.7,
  "meets_confidence": true,
  "allowed_next_phases": ["spec", "design", "init"],
  "warnings": []
}
```

```jsonc
// Tool: sdd_save (after validation)
{
  "contract": "{\"phase\":\"propose\",\"change_name\":\"add-auth-service\",\"project\":\"my-app\",\"status\":\"success\",\"confidence\":0.85,\"executive_summary\":\"Add JWT-based authentication service...\",\"next_recommended\":[\"spec\",\"design\"],\"risks\":[]}"
}

// Response:
{
  "saved": true,
  "id": "sdd_a1b2c3d4-...",
  "phase": "propose",
  "project": "my-app"
}
```

### Example 2: Create a task board and manage tasks

Set up a board, add tasks with dependencies, and let agents claim work:

```jsonc
// Step 1: Create a board
// Tool: tb_create_board
{ "project": "my-app", "name": "add-auth-service" }
// -> { "created": true, "board_id": "board_x7k9m2...", "project": "my-app" }

// Step 2: Add tasks with dependencies
// Tool: tb_add_task
{
  "board_id": "board_x7k9m2...",
  "title": "Create JWT utility module",
  "description": "Implement sign, verify, and refresh token functions",
  "priority": "p0",
  "spec_ref": "sdd/add-auth-service/spec",
  "acceptance_criteria": "All token operations pass unit tests",
  "dependencies": []
}
// -> { "created": true, "task_id": "task_abc123...", "priority": "p0" }

// Tool: tb_add_task
{
  "board_id": "board_x7k9m2...",
  "title": "Build auth middleware",
  "priority": "p1",
  "acceptance_criteria": "Middleware validates tokens on protected routes",
  "dependencies": ["task_abc123..."]  // depends on JWT module
}
// -> { "created": true, "task_id": "task_def456..." }

// Step 3: Agent claims a task
// Tool: tb_claim
{ "task_id": "task_abc123...", "agent": "implement-agent-1" }
// -> { "claimed": true, "task_id": "task_abc123...", "status": "in_progress" }

// Step 4: Mark task done (auto-unblocks dependents)
// Tool: tb_update
{ "task_id": "task_abc123...", "status": "done", "notes": "JWT module complete with RS256 support" }
// -> { "updated": true, "unblocked_tasks": ["task_def456..."] }
// task_def456 automatically moves from "backlog" to "ready"
```

### Example 3: Prevent file conflicts between agents

Two agents working in parallel use file reservations to avoid conflicts:

```jsonc
// Agent 1 checks then reserves auth files (two-phase pattern)
// Tool: file_reserve (check_only)
{
  "patterns": ["src/auth/**", "src/middleware/auth.ts"],
  "agent": "implement-agent-1",
  "check_only": true
}
// -> { "reserved": false, "has_conflicts": false, "conflicts": [] }

// No conflicts — proceed to reserve
// Tool: file_reserve
{
  "patterns": ["src/auth/**", "src/middleware/auth.ts"],
  "agent": "implement-agent-1",
  "ttl_minutes": 30
}
// -> { "reserved": true, "has_conflicts": false, "expires_at": "2025-01-15T10:30:00.000Z" }

// Agent 2 checks before editing
// Tool: file_reserve (check_only)
{
  "patterns": ["src/auth/jwt.ts"],
  "agent": "implement-agent-2",
  "check_only": true
}
// -> { "reserved": false, "has_conflicts": true, "conflicts": [{ "pattern": "src/auth/**", "held_by": "implement-agent-1" }] }
// Agent 2 knows to work on something else

// Agent 1 finishes and releases
// Tool: file_release
{ "agent": "implement-agent-1" }
// -> { "released": true, "count": 2 }
```

### Example 4: Track project phase history

Review how a change progressed through the pipeline:

```jsonc
// Tool: sdd_history
{ "project": "my-app", "limit": 5 }

// Response:
{
  "project": "my-app",
  "history": [
    { "id": "sdd_...", "phase": "verify", "change_name": "add-auth-service", "status": "success", "confidence": 0.92, "created_at": "2025-01-15T10:45:00Z" },
    { "id": "sdd_...", "phase": "apply",  "change_name": "add-auth-service", "status": "success", "confidence": 0.78, "created_at": "2025-01-15T10:30:00Z" },
    { "id": "sdd_...", "phase": "tasks",  "change_name": "add-auth-service", "status": "success", "confidence": 0.88, "created_at": "2025-01-15T09:15:00Z" },
    { "id": "sdd_...", "phase": "spec",   "change_name": "add-auth-service", "status": "success", "confidence": 0.85, "created_at": "2025-01-15T09:00:00Z" },
    { "id": "sdd_...", "phase": "propose","change_name": "add-auth-service", "status": "success", "confidence": 0.85, "created_at": "2025-01-15T08:30:00Z" }
  ]
}
```

---

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGESPEC_DIR` | `~/.forgespec` | Directory for database storage |
| `FORGESPEC_DB` | `~/.forgespec/forgespec.db` | Full path to SQLite database |

---

## Architecture

<p align="center">
  <img src="docs/assets/architecture.svg" alt="Architecture" width="700" />
</p>

```
forgespec-mcp
├── src/
│   ├── index.ts              # Entry point: stdio transport
│   ├── server.ts             # MCP server setup and tool registration
│   ├── types/index.ts        # Zod schemas, phase config, type definitions
│   ├── database/index.ts     # SQLite init, WAL mode, schema creation
│   ├── tools/
│   │   ├── sdd-contracts.ts  # 5 contract lifecycle tools
│   │   ├── task-board.ts     # 8 task management tools
│   │   └── file-reservation.ts # 2 file locking tools
│   └── utils/id.ts           # Prefixed UUID generation
└── tests/
    ├── sdd-contracts.test.ts # Schema and phase transition tests
    └── tools.test.ts         # Integration tests for all CRUD operations
```

**Tech stack:**
- [Model Context Protocol SDK](https://github.com/modelcontextprotocol/typescript-sdk) -- MCP server framework
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) -- Embedded database with WAL mode
- [Zod](https://github.com/colinhacks/zod) -- Runtime schema validation
- [Vitest](https://vitest.dev/) -- Testing framework with v8 coverage

---

## Development

```bash
# Clone the repository
git clone https://github.com/lleontor705/forgespec-mcp.git
cd forgespec-mcp

# Install the locked dependency tree
npm ci

# Run in development mode (hot reload)
npm run dev

# Run tests
npm test

# Run tests in watch mode
npm run test:watch

# Build for production
npm run build

# Open MCP Inspector for debugging
npm run inspect
```

### Releasing a New Version

ForgeSpec uses [standard-version](https://github.com/conventional-changelog/standard-version) for automatic semantic versioning based on [Conventional Commits](https://www.conventionalcommits.org/).

```bash
# Commits determine the version bump automatically:
#   fix: ...    -> patch (1.2.0 -> 1.2.1)
#   feat: ...   -> minor (1.2.0 -> 1.3.0)
#   feat!: ...  -> major (1.2.0 -> 2.0.0)

# Create a release (bumps version, updates CHANGELOG, creates git tag)
npm run release

# Or specify the bump type manually
npm run release -- --release-as minor
npm run release -- --release-as major

# First release from current version
npm run release -- --first-release

# Push with tags to trigger CI/CD
git push --follow-tags origin master
```

The CI/CD pipeline then:
1. Runs nine isolated compatibility jobs across Ubuntu/Windows/macOS for Node 22.x, 24.x, and 26.x
2. Runs the primary quality and release lane on exact Node 24.18.1
3. Requires the Node 22 compatibility gate before release packaging or publish
4. Waits for production environment approval
5. Publishes to npm with provenance
6. Creates a GitHub release with auto-generated notes

Each job starts from a clean checkout and runs `npm ci`. Only npm download caches are used; `node_modules` and native bindings are never shared. The lockfile is not regenerated or upgraded as part of a runtime change.

---

## Contributing

1. Fork the repository
2. Create a feature branch: `git checkout -b feature/my-feature`
3. Use [Conventional Commits](https://www.conventionalcommits.org/) for your messages:
   - `feat: add new tool for X`
   - `fix: resolve race condition in file reservation`
   - `docs: update usage examples`
4. Run tests: `npm test`
5. Push and open a Pull Request

---

## License

[MIT](LICENSE) -- built by [lleontor705](https://github.com/lleontor705)
