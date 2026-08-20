# OpenCode ForgeSpec Plugin

Official OpenCode integration plugin for [ForgeSpec MCP](https://github.com/lleontor705/forgespec-mcp).

## Features

- **Automatic Board Connection**: Discovers or initializes the project task board on session start.
- **Pre-Execution Advisory File Locking**: Hooks into file editing tools (`write_file`, `edit_file`, etc.) to reserve file patterns and prevent concurrent overwrite conflicts.
- **Auto-Release & Auto-Unblock**: Releases reservations when tasks complete.
- **System Prompt Injection**: Provides dynamic guidance to the LLM agent about available tasks and SDD workflow stages.

## Installation & Setup

1. In your OpenCode configuration (`openclaw.json` or `opencode.json`):

```json
{
  "mcp": {
    "servers": {
      "forgespec": {
        "command": "forgespec-mcp",
        "args": []
      }
    }
  },
  "plugins": [
    "./plugins/opencode-forgespec/index.js"
  ]
}
```

2. Restart OpenCode to initialize the plugin.
