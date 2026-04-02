# forgespec-mcp

MCP Server for **Spec-Driven Development (SDD)** — contract validation, task board management, and file reservation for multi-agent AI systems.

Works with any MCP-compatible client: **Claude Code**, **Codex CLI**, **Gemini CLI**, **OpenClaw**, and more.

## Features

- **SDD Contract Validation** — Enforce typed contracts across a 9-phase development pipeline
- **Task Board** — SQLite-backed task management with dependency tracking and auto-unblocking
- **File Reservation** — Advisory file locking to prevent multi-agent conflicts

## Quick Start

### Using npx (no installation required)

```bash
npx -y forgespec-mcp
```

### Install globally

```bash
npm install -g forgespec-mcp
```

## Configuration

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

## Tools

### SDD Contract Tools

| Tool | Description |
|------|-------------|
| `sdd_validate` | Validate an SDD contract against phase schema |
| `sdd_save` | Validate and persist a contract |
| `sdd_get` | Get a single SDD contract by ID |
| `sdd_list` | List all contracts with optional project/phase filters |
| `sdd_history` | Get phase transition history for a project |
| `sdd_phases` | Get all phases with transitions and confidence thresholds |

### Task Board Tools

| Tool | Description |
|------|-------------|
| `tb_create_board` | Create a new task board for a project |
| `tb_add_task` | Add a task with priority, spec ref, acceptance criteria, and dependencies |
| `tb_status` | Get board status with tasks grouped by status |
| `tb_claim` | Claim a task (checks dependencies, auto-moves to in_progress) |
| `tb_update` | Update task status (auto-unblocks dependents on completion) |
| `tb_unblocked` | List tasks ready to work on (no unresolved dependencies) |
| `tb_get` | Get full task details by ID |
| `tb_delete_task` | Delete a task (backlog/done only), cleans up dependencies |
| `tb_add_notes` | Append timestamped notes to a task |
| `tb_list` | List all boards (optionally filtered by project) |

### File Reservation Tools

| Tool | Description |
|------|-------------|
| `file_reserve` | Reserve files/globs with TTL |
| `file_check` | Check for conflicts |
| `file_release` | Release reservations |

## SDD Pipeline

The 9-phase Spec-Driven Development lifecycle:

```
init → explore → propose → spec → design → tasks → apply → verify → archive
```

Each phase has confidence thresholds and allowed transitions enforced by the contract validator.

| Phase | Confidence Threshold | Can Transition To |
|-------|---------------------|-------------------|
| init | 0.5 | explore, propose |
| explore | 0.5 | propose, spec |
| propose | 0.7 | spec, design, init |
| spec | 0.8 | design, tasks |
| design | 0.7 | tasks, spec |
| tasks | 0.8 | apply |
| apply | 0.6 | verify, tasks |
| verify | 0.9 | archive, apply |
| archive | 0.9 | — |

## Environment Variables

| Variable | Default | Description |
|----------|---------|-------------|
| `FORGESPEC_DIR` | `~/.forgespec` | Database directory |
| `FORGESPEC_DB` | `~/.forgespec/forgespec.db` | Full database path |

## Development

```bash
git clone https://github.com/lleontor705/forgespec-mcp.git
cd forgespec-mcp
npm install
npm run dev     # Run with tsx (hot reload)
npm test        # Run tests
npm run build   # Compile TypeScript
npm run inspect # Open MCP Inspector
```

## License

MIT
