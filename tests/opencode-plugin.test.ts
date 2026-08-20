import { describe, expect, it, vi } from "vitest";
import { createForgeSpecPlugin } from "../plugins/opencode-forgespec/index.js";

describe("OpenCode ForgeSpec Plugin v2.0", () => {
  it("initializes plugin metadata and default state", () => {
    const plugin = createForgeSpecPlugin({ projectName: "test-proj", agentName: "agent-1" });
    expect(plugin.name).toBe("opencode-forgespec");
    expect(plugin.getState().projectName).toBe("test-proj");
    expect(plugin.getState().agentName).toBe("agent-1");
  });

  it("calls task_board_create on session start", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ text: JSON.stringify({ board_id: "board_123" }) }] });
    const plugin = createForgeSpecPlugin({ client: { callTool } as any, projectName: "test-proj" });

    await plugin.onSessionStart();
    expect(callTool).toHaveBeenCalledWith("task_board_create", expect.objectContaining({
      project: "test-proj",
    }));
    expect(plugin.getState().activeBoardId).toBe("board_123");
  });

  it("intercepts file mutations and requests file reservations", async () => {
    const callTool = vi.fn().mockResolvedValue({ content: [{ text: JSON.stringify({ ok: true, leases: [{ id: "l1" }] }) }] });
    const plugin = createForgeSpecPlugin({ client: { callTool } as any, projectName: "test-proj", agentName: "agent-1" });

    await plugin.beforeToolExecute({
      toolName: "write_to_file",
      params: { TargetFile: "src/utils.ts" },
    });

    expect(callTool).toHaveBeenCalledWith("file_reserve", expect.objectContaining({
      project: "test-proj",
      paths: ["src/utils.ts"],
      holder: "agent-1",
    }));
  });

  it("injects system prompt instructions", () => {
    const plugin = createForgeSpecPlugin({ projectName: "test-proj", agentName: "agent-1" });
    const prompt = plugin.getSystemPromptAdditions();
    expect(prompt).toContain("FORGESPEC V2 COORDINATION ACTIVE");
    expect(prompt).toContain("14 Semantic Tools");
  });
});
