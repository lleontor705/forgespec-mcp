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

1. Install and enable the package, then register its package name in `opencode.json`:

```json
{
  "plugin": [
    "opencode-forgespec"
  ]
}
```

2. Use a supported Node command (`node` must be available; Node 22+), and **manually restart
   OpenCode** after installing/enabling the plugin. Do not configure a deep `node_modules`
   path. The plugin resolves the stable `forgespec-mcp/mcp` and `forgespec-mcp/broker` exports.
   Existing unrelated `mcp` settings are preserved; the generated entry is equivalent to:

```json
"forgespec": { "type": "local", "command": ["/path/to/node", "/absolute/path/build/index.js"], "enabled": true,
  "environment": { "FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY": "...", "FORGESPEC_IDENTITY_ISSUER": "...", "FORGESPEC_IDENTITY_AUDIENCE": "broker", "FORGESPEC_IDENTITY_SIDECAR_PATH": "..." } }
```

The broker lifecycle is start → ready → request/correlation → dispose. Its child
uses `shell: false`; malformed output or early exit fails closed. Reset warnings
apply only to fresh stores, never to an existing store containing data.

For tests only, the plugin accepts explicit `nodePath`, `mcpPath`, `brokerPath`, and
`broker` options; production configuration should use package resolution above.
