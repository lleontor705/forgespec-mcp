# OpenCode ForgeSpec Plugin

Official OpenCode integration plugin for [ForgeSpec MCP](https://github.com/lleontor705/forgespec-mcp).
Install this package as `opencode-forgespec`. It has one default function export
(`.`) and depends on the pinned compatible `forgespec-mcp` root package.

## Features

The plugin starts the packaged identity broker with private stdio, resolves a bounded
session lineage, and injects a signed `_identity` envelope only into `forgespec_*`
tool calls. Unrelated tools are untouched and broker failures fail closed.
Root and enrolled worker handles form the identity threat boundary; tool
arguments have no actor fields. The sidecar contains 5 tables, while the domain
store contains 16 `fs_*` tables.

Private child stdio isolates the broker from model-level MCP calls, but it is not
protection against arbitrary same-user OS/process compromise. A hostile local
process can interfere with the child or its files; use OS-level isolation for
that threat.

## Installation & Setup

### 1. Install the Plugin

Install the plugin in your project workspace or global OpenCode configuration:

```bash
# Per-project installation
npm install --save-dev opencode-forgespec

# Global installation (for all projects)
npm install -g opencode-forgespec

# Or directly in OpenCode configuration directory on Windows:
npm --prefix "%USERPROFILE%\.config\opencode" install opencode-forgespec
```

### 2. Configure `opencode.json` (or `opencode.jsonc`)

Add the package to the `"plugin"` array in your project or global `opencode.json`:

```json
{
  "$schema": "https://opencode.ai/config.json",
  "plugin": [
    "opencode-forgespec"
  ]
}
```

> [!WARNING]
> Do **not** manually configure a `"forgespec"` entry in the `"mcp"` section of `opencode.json`. The plugin automatically initializes the identity broker and registers the MCP server with the appropriate security environment. Manually running `npx -y forgespec-mcp` without the broker fails closed with `TRUST_BOOTSTRAP_INVALID`.

### 3. Restart OpenCode

Use a supported Node command (`node` must be available; Node 22+), and **manually restart OpenCode** after installing/enabling the plugin. Do not configure a deep `node_modules` path. The plugin resolves the stable `forgespec-mcp/mcp` and `forgespec-mcp/broker` exports.

Existing unrelated `mcp` settings are preserved; the dynamically generated entry is equivalent to:

```json
"forgespec": {
  "type": "local",
  "command": ["/path/to/node", "/absolute/path/build/index.js"],
  "enabled": true,
  "environment": {
    "FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY": "...",
    "FORGESPEC_IDENTITY_ISSUER": "...",
    "FORGESPEC_IDENTITY_AUDIENCE": "broker",
    "FORGESPEC_IDENTITY_SIDECAR_PATH": "..."
  }
}
```

The broker lifecycle is start → ready → request/correlation → dispose. Its child uses `shell: false`; malformed output or early exit fails closed. Reset warnings apply only to fresh stores, never to an existing store containing data.

For tests only, the plugin accepts explicit `nodePath`, `mcpPath`, `brokerPath`, and `broker` options; production configuration should use package resolution above.

## Exposed Tools in OpenCode

The plugin exposes all 18 ForgeSpec tools prefixed with `forgespec_`:

| Category | OpenCode Tool Name | Description |
|---|---|---|
| **Boards & Contracts** | `forgespec_board_create`<br>`forgespec_contract_commit`<br>`forgespec_contract_query`<br>`forgespec_contract_validate` | Project boards, phase progression, schema validation, and immutable SDD specs. |
| **Tasks & Planning** | `forgespec_task_define`<br>`forgespec_task_query`<br>`forgespec_task_transition` | DAG dependency definition, state machine transitions (`ready`, `in_progress`, `in_review`, `done`). |
| **Execution & Attempts** | `forgespec_attempt_claim`<br>`forgespec_attempt_recover`<br>`forgespec_attempt_renew` | Worker assignment, bounded TTL execution attempts, recovery protocol. |
| **File Leases** | `forgespec_lease_reserve`<br>`forgespec_lease_renew`<br>`forgespec_lease_release` | Scoped optimistic file reservations preventing write collisions across agents. |
| **Governance & Events** | `forgespec_authority_manage`<br>`forgespec_approval_record`<br>`forgespec_event_query` | Delegated capability grants, human/reviewer sign-offs, HMAC-paginated audit trail. |
| **Core & Diagnostics** | `forgespec_forge_health`<br>`forgespec_forge_negotiate` | Capability handshake, profile negotiation, storage and runtime qualification. |

