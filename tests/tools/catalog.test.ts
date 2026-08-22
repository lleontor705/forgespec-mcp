import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import Database from "better-sqlite3";
import { createFreshStore } from "../../src/storage/bootstrap.js";
import { SDD_TOOL_CATALOG } from "../../src/protocol/capabilities.js";
import { createServer } from "../../src/server.js";
import { IdentityBroker } from "../../src/identity/broker.js";
import { IdentityVerifier } from "../../src/identity/verifier.js";
import { openIdentityStore } from "../../src/identity/store.js";
import { sha256 } from "../../src/identity/canonical.js";

async function connected() {
  const db = new Database(":memory:");
  createFreshStore(db);
  const identity = openIdentityStore(":memory:");
  const broker = new IdentityBroker();
  const verifier = new IdentityVerifier(identity, { rootPublicKey: broker.rootPublicKey, issuer: `root:${sha256(JSON.stringify(broker.rootPublicKey))}`, audience: "broker" });
  const server = createServer({ database: () => db, cursorSecret: "x".repeat(32), verifier });
  const client = new Client({ name: "catalog-test", version: "1" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { client, db, identity, broker };
}

describe("final tool catalog", () => {
  it("lists the canonical 18 tools in deterministic order and smokes core calls", async () => {
    const { client, db, identity, broker } = await connected();
    const first = (await client.listTools()).tools.map((tool) => tool.name);
    const second = (await client.listTools()).tools.map((tool) => tool.name);
    expect(first).toEqual(SDD_TOOL_CATALOG);
    expect(second).toEqual(first);
    const sign = (tool: string, args: Record<string, unknown>) => ({ ...args, _identity: broker.attest({ tool, args, session: { root: "root", parent: "parent", worker: `${tool}-worker` }, audience: "broker" }) });
    expect((await client.callTool({ name: "forge_negotiate", arguments: sign("forge_negotiate", { profile: "worker" }) })).isError).toBeFalsy();
    expect((await client.callTool({ name: "forge_health", arguments: sign("forge_health", {}) })).isError).toBeFalsy();
    await client.close();
    await db.close();
    await identity.close();
  });

  it("rejects a missing cursor secret", () => {
    const db = new Database(":memory:");
    createFreshStore(db);
    expect(() => createServer({ database: () => db, verifier: { verify: () => { throw new Error(); } } as never, cursorSecret: "" })).toThrow("cursor secret");
    db.close();
  });

  it("publishes structural identity plus business contracts for every tool", async () => {
    const { client, db, identity, broker } = await connected();
    const tools = (await client.listTools()).tools;
    const required: Record<string, string[]> = {
      forge_negotiate: ["profile"], forge_health: [], board_create: ["idempotency_key", "project", "name"],
      task_define: ["idempotency_key", "board_id", "expected_board_revision", "title", "priority"],
      task_query: ["board_id", "limit"], attempt_claim: ["idempotency_key", "board_id", "task_id", "expected_task_revision", "lease_seconds"],
      attempt_renew: ["idempotency_key", "board_id", "task_id", "attempt_id", "claim_token", "extend_seconds", "expected_task_revision"],
      task_transition: ["idempotency_key", "board_id", "task_id", "target", "attempt_id", "claim_token", "expected_revision"],
      attempt_recover: ["idempotency_key", "board_id", "task_id", "action", "expected_task_revision"],
      lease_reserve: ["board_id", "task_id", "attempt_id", "claim_token", "paths", "case_policy", "lease_seconds", "idempotency_key"],
      lease_renew: ["lease_id", "lease_token", "expected_revision", "idempotency_key", "extend_seconds"], lease_release: ["lease_id", "lease_token", "expected_revision", "idempotency_key"],
      contract_validate: ["contract"], contract_commit: ["idempotency_key", "expected_board_revision", "contract"], contract_query: ["board_id"],
      approval_record: ["board_id", "task_id", "gate_id", "attempt_id", "decision", "provenance", "expected_task_revision", "idempotency_key"],
      authority_manage: ["action"], event_query: ["board_id"],
    };
    const expectedDataFields: Record<string, string[]> = {
      forge_negotiate: ["protocol_version", "profile", "tools"], forge_health: ["package", "runtime", "sqlite", "uptime_seconds", "storage"],
      board_create: ["id", "project", "name", "revision"], task_define: ["boardId", "id", "status", "dependencies"],
      task_query: ["total_count", "records", "dependencies"], attempt_claim: ["attemptId", "attemptNo", "claimToken"],
      attempt_renew: ["attemptId", "expiresAt", "taskRevision"], task_transition: ["taskRevision", "status", "promotedTaskIds"],
      attempt_recover: ["taskRevision"], lease_reserve: ["leaseId", "attemptId", "scopes", "leaseToken"],
      lease_renew: ["leaseId", "revision", "state"], lease_release: ["leaseId", "revision", "state"],
      contract_validate: ["ok", "valid"], contract_commit: ["ok", "contract_id", "revision", "digest"],
      contract_query: ["ok", "items", "total_count"], approval_record: ["ok", "approval"],
      authority_manage: ["ok", "revoked", "authorities"], event_query: ["items", "total_count", "next_cursor"],
    };
    const aliases = /^(actor|actor_id|actorId|caller|caller_id|callerId|holder|reviewer)$/i;
    for (const tool of tools) {
      const input = tool.inputSchema as any;
      const output = tool.outputSchema as any;
      const inputBranches = input.anyOf ?? [input];
      for (const branch of inputBranches) {
        expect(branch.type).toBe("object");
        const branchRequired = branch.required ?? [];
        expect(branchRequired).toContain("_identity");
        for (const field of (required[tool.name] ?? [])) expect(branchRequired).toContain(field);
        expect(Object.keys(branch.properties ?? {})).not.toContain(expect.stringMatching(aliases));
      }
      expect(output.additionalProperties).toBe(false);
      expect(Object.keys(output.properties ?? {})).toEqual(expect.arrayContaining(["ok", "data", "error", "_identity_context"]));
      expect(output.required).toEqual(expect.arrayContaining(["ok", "data", "error", "_identity_context"]));
      expect(output.properties.data).toBeDefined();
      const dataContract = output.properties.data.anyOf?.find((schema: any) => schema.type === "object") ?? output.properties.data;
      expect(dataContract.type).toBe("object");
      expect(Object.keys(dataContract.properties ?? {})).toEqual(expect.arrayContaining(expectedDataFields[tool.name] ?? []));
      expect(tool.annotations).toBeDefined();
      expect(tool.annotations?.destructiveHint).toBe(tool.annotations?.readOnlyHint ? false : true);
    }
    await client.close(); await db.close(); await identity.close(); void broker;
  });

  it("publishes four strict authority action branches", async () => {
    const { client, db, identity } = await connected();
    const tool = (await client.listTools()).tools.find((item) => item.name === "authority_manage")! as any;
    const branches = tool.inputSchema.anyOf;
    expect(branches).toHaveLength(4);
    expect(branches.map((branch: any) => branch.properties.action.const).sort()).toEqual(["grant", "handoff", "query", "revoke"]);
    for (const branch of branches) {
      expect(branch.additionalProperties).toBe(false);
      expect(branch.required).toContain("_identity");
      expect(branch.required).toContain("action");
    }
    const byAction = new Map(branches.map((branch: any) => [branch.properties.action.const, branch]));
    expect(byAction.get("grant").required).toEqual(expect.arrayContaining(["resource", "operations", "expires_at", "grantee_handle", "idempotency_key"]));
    expect(byAction.get("handoff").required).toEqual(expect.arrayContaining(["resource", "operations", "expires_at", "to_handle", "idempotency_key"]));
    expect(byAction.get("revoke").required).toEqual(expect.arrayContaining(["board_id", "authority_id", "idempotency_key"]));
    expect(byAction.get("query").required).toEqual(expect.arrayContaining(["_identity", "action"]));
    for (const action of ["grant", "handoff", "query"]) {
      const branch = byAction.get(action);
      const schema = branch.properties.resource;
      expect(schema.anyOf).toHaveLength(2);
      expect(schema.anyOf[0]).toMatchObject({ required: ["kind", "board_id"], additionalProperties: false });
      expect(schema.anyOf[1]).toMatchObject({ required: ["kind", "board_id", "task_id"], additionalProperties: false });
    }
    const operations = byAction.get("grant").properties.operations;
    expect(operations).toMatchObject({ minItems: 1, uniqueItems: true, items: { enum: expect.arrayContaining(["grant", "revoke"]) } });
    await client.close(); await db.close(); await identity.close();
  });
});
