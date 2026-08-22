import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { describe, expect, it } from "vitest";
import plugin from "../../plugins/opencode-forgespec/index.js";

describe("packaged OpenCode plugin to MCP identity path", () => {
  it("probes the clean package entrypoint and accepts signed health/task calls", async () => {
    const dir = mkdtempSync(join(tmpdir(), "forgespec-plugin-e2e-"));
    const previous = { db: process.env.FORGESPEC_DB, sidecar: process.env.FORGESPEC_IDENTITY_SIDECAR_PATH, cursor: process.env.FORGESPEC_CURSOR_SECRET };
    process.env.FORGESPEC_DB = join(dir, "domain.db");
    process.env.FORGESPEC_IDENTITY_SIDECAR_PATH = join(dir, "identity.db");
    process.env.FORGESPEC_CURSOR_SECRET = "e2e-cursor-secret-0123456789012345";
    const hooks = await plugin({ client: { session: { get: async () => ({ data: {} }) } }, mcpPath: resolve("build/index.js"), brokerPath: resolve("build/identity/broker-cli.js") });
    const config = { mcp: {} as Record<string, unknown> };
    let transport: StdioClientTransport | undefined;
    let mcp: Client | undefined;
    try {
      await hooks.config(config);
      const entry = config.mcp.forgespec as { command: string[]; environment: Record<string, string> };
      expect(entry.command[0]).toBe(process.execPath);
      expect(entry.command[1]).toMatch(/[\\/]build[\\/]index\.js$/);
      expect(entry.command[1]).not.toMatch(/broker-cli/);
      transport = new StdioClientTransport({ command: entry.command[0], args: [entry.command[1]], env: { ...process.env, ...entry.environment } });
      mcp = new Client({ name: "plugin-e2e", version: "1" });
      await mcp.connect(transport);
      const listed = await mcp.listTools();
      expect(listed.tools.map((tool) => tool.name)).toContain("task_query");
      const task = { args: { board_id: "missing", limit: 1 } };
      await hooks["tool.execute.before"]({ tool: "forgespec_task_query", sessionID: "session", callID: "task-call" }, task);
      const taskResult = await mcp.callTool({ name: "task_query", arguments: task.args });
      expect(taskResult).toBeDefined();
      const health = { args: {} };
      await hooks["tool.execute.before"]({ tool: "forgespec_forge_health", sessionID: "session", callID: "health-call" }, health);
      const healthResult = await mcp.callTool({ name: "forge_health", arguments: health.args });
      expect(healthResult).toBeDefined();
      expect(healthResult.isError).toBe(false);
      expect(healthResult.structuredContent).toMatchObject({ ok: true, error: null, data: {
        package: { name: expect.any(String), version: expect.stringMatching(/^\d+\.\d+\.\d+$/) },
        runtime: { node: expect.stringMatching(/^v?\d+\.\d+/) },
        sqlite: { version: expect.stringMatching(/^\d+\.\d+\.\d+/) },
        storage: { qualified: true, table_count: expect.any(Number) },
      } });
    } finally {
      await mcp?.close(); await transport?.close(); await hooks.dispose();
      process.env.FORGESPEC_DB = previous.db; process.env.FORGESPEC_IDENTITY_SIDECAR_PATH = previous.sidecar; process.env.FORGESPEC_CURSOR_SECRET = previous.cursor;
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
