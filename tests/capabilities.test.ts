import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import {
  ALL_DIRECT_V1_CAPABILITIES,
  DIRECT_V1_P0_CAPABILITIES,
  TASK_AUTHORITY_CAPABILITY_ID,
  negotiateCapabilities,
} from "../src/core/capabilities.js";
import { registerCapabilitiesTool } from "../src/tools/capabilities.js";

const connected: Array<{ client: Client; server: McpServer }> = [];

afterEach(async () => {
  await Promise.all(connected.splice(0).flatMap(({ client, server }) => [client.close(), server.close()]));
});

describe("direct-v1 capability negotiation", () => {
  it("selects direct-v1 when every required P0 capability supports the requested major", () => {
    const required = DIRECT_V1_P0_CAPABILITIES.map((id) => ({
      id,
      range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
    }));

    const result = negotiateCapabilities({ requested_mode: "direct-v1", required });

    expect(result.compatibility).toEqual({
      compatible: true,
      selected_mode: "direct-v1",
      missing: [],
      incompatible: [],
      unavailable_optional: [],
    });
    expect(result.capabilities.filter(({ id }) => DIRECT_V1_P0_CAPABILITIES.includes(id))).toHaveLength(
      DIRECT_V1_P0_CAPABILITIES.length
    );
    expect(
      result.capabilities
        .filter(({ id }) => ALL_DIRECT_V1_CAPABILITIES.includes(id))
        .every(({ selected }) => selected === "1.0.0")
    ).toBe(true);
    expect(result.limits).toMatchObject({ max_page_size: 200, max_idempotency_key_bytes: 256 });
  });

  it("reports an unavailable optional feature without disabling compatible direct-v1", () => {
    const result = negotiateCapabilities({
      requested_mode: "direct-v1",
      required: [
        {
          id: "forgespec.capabilities",
          range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
        },
        {
          id: "future-unimplemented-feature",
          range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
          optional: true,
        },
      ],
    });

    expect(result.compatibility.compatible).toBe(true);
    expect(result.compatibility.selected_mode).toBe("direct-v1");
    expect(result.compatibility.unavailable_optional).toEqual([
      {
        id: "future-unimplemented-feature",
        range: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
        optional: true,
      },
    ]);
    expect(result.capabilities.some(({ id }) => id === "future-unimplemented-feature")).toBe(false);
  });

  it("keeps direct-v1 compatible when an optional feature has no compatible selected version", () => {
    const optional = {
      id: "task-cas",
      range: { min_inclusive: "2.0.0", max_exclusive: "3.0.0" },
      optional: true,
    } as const;

    const result = negotiateCapabilities({ requested_mode: "direct-v1", required: [optional] });

    expect(result.compatibility.compatible).toBe(true);
    expect(result.compatibility.incompatible).toEqual([]);
    expect(result.compatibility.unavailable_optional).toEqual([optional]);
  });

  it("rejects an unsupported required major without silently selecting direct-v1", () => {
    const result = negotiateCapabilities({
      requested_mode: "direct-v1",
      required: [
        {
          id: "task-cas",
          range: { min_inclusive: "2.0.0", max_exclusive: "3.0.0" },
        },
      ],
    });

    expect(result.compatibility.compatible).toBe(false);
    expect(result.compatibility.selected_mode).toBeUndefined();
    expect(result.compatibility.incompatible).toEqual([
      {
        id: "task-cas",
        required: { min_inclusive: "2.0.0", max_exclusive: "3.0.0" },
        supported: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
      },
    ]);
  });

  it("preserves legacy negotiation when new fields are omitted", () => {
    const result = negotiateCapabilities({});

    expect(result.compatibility).toMatchObject({ compatible: true, selected_mode: "legacy" });
    expect(result.modes).toEqual(["legacy", "direct-v1"]);
    expect(result.security.identity_model).toBe("local-trusted-client");
    expect(result.schemas.sdd_envelope).toEqual({ min_inclusive: "1.0.0", max_exclusive: "2.0.0" });
  });

  it("unnegotiated client keeps existing direct-v1 surface only", () => {
    const result = negotiateCapabilities({ requested_mode: "direct-v1" });
    const taskAuthority = result.capabilities.find(({ id }) => id === TASK_AUTHORITY_CAPABILITY_ID);

    expect(result.compatibility).toMatchObject({ compatible: true, selected_mode: "direct-v1" });
    expect(taskAuthority).toEqual({
      id: "task-authority",
      supported: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
    });
    expect(
      result.capabilities
        .filter(({ id }) => ALL_DIRECT_V1_CAPABILITIES.includes(id))
        .every(({ selected }) => selected === "1.0.0")
    ).toBe(true);
  });

  it("selects task-authority only for an exact supported negotiation", () => {
    const result = negotiateCapabilities({
      requested_mode: "direct-v1",
      required: [{
        id: TASK_AUTHORITY_CAPABILITY_ID,
        range: { min_inclusive: "1.0.0", max_exclusive: "1.0.1" },
        optional: true,
      }],
    });

    expect(result.compatibility).toMatchObject({
      compatible: true,
      selected_mode: "direct-v1",
      unavailable_optional: [],
    });
    expect(result.capabilities.find(({ id }) => id === TASK_AUTHORITY_CAPABILITY_ID)).toEqual({
      id: "task-authority",
      supported: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
      selected: "1.0.0",
    });
  });

  it("unsupported task-authority capability fails without downgrade", () => {
    const result = negotiateCapabilities({
      requested_mode: "direct-v1",
      required: [{
        id: TASK_AUTHORITY_CAPABILITY_ID,
        range: { min_inclusive: "2.0.0", max_exclusive: "3.0.0" },
      }],
    });

    expect(result.modes).toEqual(["legacy", "direct-v1"]);
    expect(result.compatibility.compatible).toBe(false);
    expect(result.compatibility.selected_mode).toBeUndefined();
    expect(result.compatibility.missing).toEqual([]);
    expect(result.compatibility.incompatible).toEqual([{
      id: "task-authority",
      required: { min_inclusive: "2.0.0", max_exclusive: "3.0.0" },
      supported: { min_inclusive: "1.0.0", max_exclusive: "2.0.0" },
    }]);
  });

  it("exposes identical structured and JSON capability responses through MCP", async () => {
    const server = new McpServer({ name: "capability-test", version: "1.2.2" });
    registerCapabilitiesTool(server, { serverVersion: "1.2.2" });
    const client = new Client({ name: "test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    connected.push({ client, server });
    await Promise.all([client.connect(clientTransport), server.server.connect(serverTransport)]);

    const response = await client.callTool({
      name: "forgespec_capabilities",
      arguments: { requested_mode: "direct-v1" },
    });
    const text = response.content[0];

    expect(response.isError).not.toBe(true);
    expect(text.type).toBe("text");
    if (text.type !== "text") throw new Error("Expected text capability response");
    expect(JSON.parse(text.text)).toEqual(response.structuredContent);
    expect(response.structuredContent).toMatchObject({
      server: { name: "forgespec-mcp", version: "1.2.2", api_version: "1.0.0" },
      compatibility: { compatible: true, selected_mode: "direct-v1" },
    });
  });
});
