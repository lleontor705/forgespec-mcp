# Changelog

All notable changes to ForgeSpec MCP are documented here.

## [2.1.0](https://github.com/lleontor705/forgespec-mcp/compare/v1.6.0...v2.1.0) (2026-08-22)


### Features

* implement core protocol, storage, identity, and tooling infrastructure for the ForgeSpec MCP system ([71f40eb](https://github.com/lleontor705/forgespec-mcp/commit/71f40eb514c39fab42adaa4c221a7cb99bf18de1))

# Changelog

## Protocol 2.0

- Final MCP contract with 18 canonical tools.
- Strict SQLite storage with 16 `fs_*` tables.
- Fail-closed startup, signed event cursors, bounded leases, and auditable SDD workflow.
