import { describe, expect, it, vi } from "vitest";
import path from "node:path";
import plugin from "../plugins/opencode-forgespec/index.js";

const host = { client: { app: { log: vi.fn() } }, mcpPath: path.resolve("build/index.js"), brokerPath: path.resolve("missing-broker.js") };

describe("OpenCode ForgeSpec plugin", () => {
  it("is a single function export with official hook names", async () => {
    expect(typeof plugin).toBe("function");
    const hooks = await plugin(host);
    expect(Object.keys(hooks).sort()).toEqual(["config", "dispose", "event", "tool.execute.after", "tool.execute.before"]);
    expect(typeof hooks.config).toBe("function");
    const config = { tools: {}, mcp: { other: { enabled: true } } };
    await expect(hooks.config(config)).resolves.toBeUndefined();
    expect(config.mcp.other).toEqual({ enabled: true });
    expect(config.mcp.forgespec).toMatchObject({ type: "local", enabled: true, command: [process.execPath, expect.stringMatching(/[\\/]build[\\/]index\.js$/)] });
    expect(config.mcp.forgespec.environment).toEqual(expect.objectContaining({
      FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY: expect.any(String),
      FORGESPEC_IDENTITY_ISSUER: expect.any(String),
      FORGESPEC_IDENTITY_AUDIENCE: expect.any(String),
      FORGESPEC_IDENTITY_SIDECAR_PATH: expect.any(String),
    }));
  });

  it("uses official tool hook input/output signatures", async () => {
    const hooks = await plugin(host);
    const output = { args: { path: "src/a.ts" } };
    await expect(hooks["tool.execute.before"](
      { tool: "read", sessionID: "session", callID: "call" }, output,
    )).resolves.toBeUndefined();
    expect(output).toEqual({ args: { path: "src/a.ts" } });
    await expect(hooks["tool.execute.after"](
      { tool: "read", sessionID: "session", callID: "call" },
      { title: "read", output: "ok", metadata: {} },
    )).resolves.toBeUndefined();
  });

  it("fails closed for ForgeSpec calls when the broker is unavailable", async () => {
    const hooks = await plugin(host);
    await expect(hooks["tool.execute.before"](
      { tool: "forgespec_task_query", sessionID: "s", callID: "c" }, { args: {} },
    )).rejects.toThrow("FORGESPEC_IDENTITY_UNAVAILABLE");
    expect(host.client.app.log).toHaveBeenCalledWith({ body: expect.objectContaining({ level: "warn", extra: expect.objectContaining({ tool: "forgespec_task_query" }) }) });
  });

  it("leaves unrelated tools untouched", async () => {
    const broker = { before: vi.fn(), after: vi.fn() };
    const hooks = await plugin({ ...host, broker });
    await hooks["tool.execute.before"]({ tool: "bash", sessionID: "s", callID: "c" }, { args: {} });
    await hooks["tool.execute.after"]({ tool: "bash", sessionID: "s", callID: "c" }, {});
    expect(broker.before).not.toHaveBeenCalled();
    expect(broker.after).not.toHaveBeenCalled();
  });

  it("mutates the original args object in place with sanitized signed args", async () => {
    const broker = { request: vi.fn().mockResolvedValue({ session: "signed" }) };
    const hooks = await plugin({ ...host, broker, client: { session: { get: vi.fn().mockResolvedValue({ data: {} }) }, app: { log: vi.fn() } } });
    const args = { caller: "spoofed", stale: true };
    const output = { args };
    await hooks["tool.execute.before"]({ tool: "forgespec_task_query", sessionID: "s", callID: "c" }, output);
    expect(output.args).toBe(args);
    expect(args).toEqual({ stale: true, _identity: { session: "signed" } });
    expect(broker.request).toHaveBeenCalledWith(expect.objectContaining({ args: { stale: true } }));
  });
});
