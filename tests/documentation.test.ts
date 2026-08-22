import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createServer } from "../src/server.js";
import { PROFILE_TOOLSETS, SDD_TOOL_CATALOG } from "../src/protocol/capabilities.js";
import { IdentityBroker } from "../src/identity/broker.js";
import { IdentityVerifier } from "../src/identity/verifier.js";
import { openIdentityStore } from "../src/identity/store.js";
import { sha256 } from "../src/identity/canonical.js";

const root = path.resolve(__dirname, "..");
const read = (file: string) => fs.readFileSync(path.join(root, file), "utf8");
const documents = [read("README.md"), read("spec.md"), read("docs/protocol-2.md"), read("docs/architecture.md"), read("plugins/opencode-forgespec/README.md")];
const catalogDocuments = documents.slice(0, 3);
const cursorSecret = "documentation-test-cursor-secret-32-bytes-minimum";

describe("protocol 2.0 documentation truth", () => {
  it("documents the exact catalog, profiles, phases, tables, and security facts", () => {
    for (const document of catalogDocuments) {
      expect(document).toMatch(/(?:Protocol 2\.0|MCP 2\.0)/);
      for (const tool of SDD_TOOL_CATALOG) expect(document).toContain(`\`${tool}\``);
    }
    expect(SDD_TOOL_CATALOG).toHaveLength(18);
    expect(Object.keys(PROFILE_TOOLSETS).sort()).toEqual(["orchestrator", "planner", "reviewer", "worker"]);
    expect(documents.join("\n")).toMatch(/init.*explore.*proposal.*spec.*design.*tasks.*apply.*verify/s);
    expect(documents.join("\n")).toMatch(/16.*fs_\*|16 STRICT `fs_\*`/);
    expect(documents.join("\n")).toMatch(/clean.*store|fresh store/i);
    expect(documents.join("\n")).toMatch(/fail closed/i);
    expect(documents.join("\n")).toMatch(/HMAC/i);
    expect(documents.join("\n")).toMatch(/once|one-time/i);
    expect(documents.join("\n")).toMatch(/stdio/i);
    expect(documents.join("\n")).toContain("FORGESPEC_CURSOR_SECRET");
    expect(documents.join("\n")).toMatch(/sidecar.*5.*domain.*16/is);
    expect(documents.join("\n")).toMatch(/root.*worker.*handle/is);
    expect(documents.join("\n")).toMatch(/no actor fields|actor fields.*not/i);
    expect(documents.join("\n")).toMatch(/fresh.*only.*reset|reset.*fresh/i);
    expect(documents.join("\n")).toMatch(/restart OpenCode/i);
  });

  it("keeps the final protocol documents available", () => {
    expect(fs.existsSync(path.join(root, "docs/protocol-2.md"))).toBe(true);
    expect(fs.existsSync(path.join(root, "docs/architecture.md"))).toBe(true);
  });

  it("keeps the runtime catalog aligned with the documentation contract", async () => {
    const broker = new IdentityBroker();
    const identity = openIdentityStore(":memory:");
    const verifier = new IdentityVerifier(identity, { rootPublicKey: broker.rootPublicKey, issuer: `root:${sha256(JSON.stringify(broker.rootPublicKey))}`, audience: "broker" });
    const server = createServer({ database: () => { throw new Error("database not expected"); }, cursorSecret, verifier });
    const client = new Client({ name: "documentation-facts", version: "2.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();
    expect(names).toEqual([...SDD_TOOL_CATALOG]);
    await client.close();
    await server.close();
    identity.close();
  });
});
