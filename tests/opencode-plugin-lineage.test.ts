import { describe, expect, it, vi } from "vitest";
import plugin from "../plugins/opencode-forgespec/index.js";

describe("OpenCode ForgeSpec lineage and correlation", () => {
  it("resolves parent chains and strips caller aliases", async () => {
    const request = vi.fn(async (input) => ({ signed: true, session: input.session }));
    const client = { app: { log: vi.fn() }, session: { get: vi.fn(async ({ path: { id } }) => ({ data: id === "worker" ? { parentID: "parent" } : id === "parent" ? { parentID: "root" } : {} })) } };
    const hooks = await plugin({ client, broker: { request } });
    const output = { args: { value: 1, actor: "forged", nested: { _identity: "old" } } };
    await hooks["tool.execute.before"]({ tool: "forgespec_task_query", sessionID: "worker", callID: "call" }, output);
    expect(request).toHaveBeenCalledWith(expect.objectContaining({ tool: "task_query", session: { root: "root", parent: "parent", worker: "worker" } }));
    expect(output.args).toEqual({ value: 1, nested: {}, _identity: { signed: true, session: { root: "root", parent: "parent", worker: "worker" } } });
  });

  it("keeps concurrent call correlation independent", async () => {
    const requests: unknown[] = []; const broker = { request: vi.fn((input) => new Promise((resolve) => setTimeout(() => { requests.push(input); resolve({ call: input.call }); }, input.call === "a" ? 10 : 1))) };
    const client = { session: { get: vi.fn(async () => ({ data: {} })) } };
    const hooks = await plugin({ client, broker });
    const a = { args: {} }; const b = { args: {} };
    await Promise.all([hooks["tool.execute.before"]({ tool: "forgespec_task_query", sessionID: "s", callID: "a" }, a), hooks["tool.execute.before"]({ tool: "forgespec_forge_health", sessionID: "s", callID: "b" }, b)]);
    expect(a.args._identity.call).toBe("a"); expect(b.args._identity.call).toBe("b"); expect(requests).toHaveLength(2);
  });

  it("caches exact sibling prefixes and invalidates deleted descendants", async () => {
    const calls: string[] = [];
    const client = { session: { get: vi.fn(async ({ path: { id } }) => { calls.push(id); return { data: id === "root" ? {} : { parentID: "root" } }; }) } };
    const broker = { request: vi.fn(async (input) => ({ session: input.session })) };
    const hooks = await plugin({ client, broker });
    await hooks["tool.execute.before"]({ tool: "forgespec_task_query", sessionID: "a", callID: "a" }, { args: {} });
    await hooks["tool.execute.before"]({ tool: "forgespec_task_query", sessionID: "b", callID: "b" }, { args: {} });
    expect(broker.request.mock.calls[1][0].session).toEqual({ root: "root", parent: "root", worker: "b" });
    await hooks.event({ event: { type: "session.deleted", properties: { info: { id: "root" } } } });
    await hooks["tool.execute.before"]({ tool: "forgespec_task_query", sessionID: "b", callID: "c" }, { args: {} });
    expect(calls.filter((id) => id === "root")).toHaveLength(2);
  });
});
