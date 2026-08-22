# Protocol 2.0 Architecture

```text
src/index
   │
   ▼
storage / database / bootstrap
   │ qualified 16-table fs_* store
   ▼
server
   ├─ contracts
   ├─ core
   ├─ planning
   ├─ leases
   ├─ governance
   └─ execution
   │
    ▼
domain / storage

OpenCode plugin ──private stdio──> identity broker ──> identity sidecar (5 tables)
       │                                      └──── root handle + worker handles
       └─ signed identity envelopes; tool arguments contain no actor fields
```

The entrypoint initializes and qualifies SQLite before the MCP server accepts
stdio JSON-RPC. The server exposes exactly 18 Protocol 2.0 tools through six
final tool modules. Domain services enforce revisions, authority, approvals,
attempts, leases, event cursors, and idempotency; storage owns the 16 strict
`fs_*` tables, bootstrap, integrity, and persistence.

The broker lifecycle is start → ready → request/correlation → dispose. It uses
`shell: false`, fails closed on malformed output, and is distinct from the
16-table domain database. Reset warnings apply only to fresh stores.
