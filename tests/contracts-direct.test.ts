import Database from "better-sqlite3";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { migrateDatabase } from "../src/database/migrations.js";
import {
  ContractConflictError,
  ContractService,
  type DirectContractSaveInput,
} from "../src/services/contract-service.js";
import { registerSddTools } from "../src/tools/sdd-contracts.js";

const directories: string[] = [];

function createDatabase(): { path: string; database: Database.Database } {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "forgespec-contracts-"));
  directories.push(directory);
  const databasePath = path.join(directory, "forgespec.db");
  migrateDatabase(databasePath);
  return { path: databasePath, database: open(databasePath) };
}

function open(databasePath: string): Database.Database {
  const database = new Database(databasePath);
  database.pragma("journal_mode = WAL");
  database.pragma("busy_timeout = 5000");
  database.pragma("foreign_keys = ON");
  return database;
}

function contract(phase: "init" | "explore" = "init") {
  return {
    schema_version: "1.0",
    phase,
    change_name: "canonical-contracts",
    project: "forgespec-tests",
    status: "success" as const,
    confidence: 0.91,
    executive_summary: `Complete ${phase} contract envelope for direct-v1 tests.`,
    artifacts_saved: [{ topic_key: `sdd/canonical-contracts/${phase}`, type: "cortex" as const }],
    next_recommended: phase === "init" ? (["explore"] as const) : (["propose"] as const),
    risks: [{ description: "A retained test risk", level: "low" as const }],
    data: { nested: { z: true, a: [3, 2, 1] } },
  };
}

function directInput(
  value: ReturnType<typeof contract>,
  overrides: Partial<DirectContractSaveInput> = {}
): DirectContractSaveInput {
  return {
    contract: JSON.stringify(value),
    coordination_mode: "direct-v1",
    api_version: "1.0.0",
    schema_version: "1.0.0",
    actor: "test-actor",
    idempotency_key: `save-${value.phase}`,
    expected_head_revision: value.phase === "init" ? 0 : 1,
    parent_contract_id: value.phase === "init" ? undefined : "replace-parent",
    ...overrides,
  };
}

afterEach(() => {
  for (const directory of directories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("direct-v1 contract authority", () => {
  it("exposes direct save/get through MCP with identical structured and JSON responses", async () => {
    const { database } = createDatabase();
    const server = new McpServer({ name: "contract-test-server", version: "1.0.0" });
    registerSddTools(server, () => database);
    const client = new Client({ name: "contract-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const saved = await client.callTool({
      name: "sdd_save",
      arguments: directInput(contract(), { idempotency_key: "handler-save" }),
    });
    const savedText = saved.content[0];
    expect(savedText.type).toBe("text");
    if (savedText.type !== "text") throw new Error("Expected text response");
    expect(JSON.parse(savedText.text)).toEqual(saved.structuredContent);

    const contractId = (saved.structuredContent as { contract_id: string }).contract_id;
    const retrieved = await client.callTool({ name: "sdd_get", arguments: { contract_id: contractId } });
    expect(retrieved.structuredContent).toMatchObject({ mode: "direct-v1", revision: 1, is_head: true });

    const history = await client.callTool({
      name: "sdd_history",
      arguments: {
        project: "forgespec-tests",
        change_name: "canonical-contracts",
        since_revision: 0,
        limit: 10,
      },
    });
    expect(history.structuredContent).toMatchObject({
      items: [{ contract_id: contractId, revision: 1 }],
      next_cursor: null,
      snapshot_revision: 1,
    });

    await client.close();
    await server.close();
    database.close();
  });

  it("round-trips the complete canonical envelope with digest, parent, revision, and head", () => {
    const { database } = createDatabase();
    const service = new ContractService(database, { now: () => 1_800_000_000_000 });
    const envelope = contract();

    const saved = service.saveDirect(directInput(envelope));
    const retrieved = service.get(saved.contract_id);
    const history = service.history({ project: envelope.project, change_name: envelope.change_name, limit: 10 });

    expect(saved).toMatchObject({ ok: true, replayed: false, revision: 1, head_revision: 1, parent_contract_id: null });
    expect(saved.contract_digest).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(retrieved).toMatchObject({
      mode: "direct-v1",
      revision: 1,
      parent_contract_id: null,
      contract_digest: saved.contract_digest,
      is_head: true,
    });
    expect(retrieved.contract).toEqual(envelope);
    expect(history.items).toHaveLength(1);
    expect(history.items[0]).toMatchObject({
      contract_id: saved.contract_id,
      revision: 1,
      contract_digest: saved.contract_digest,
    });
    database.close();
  });

  it("replays only the identical request in the same operation and authority scope", () => {
    const { database } = createDatabase();
    const service = new ContractService(database);
    const input = directInput(contract(), { idempotency_key: "same-text" });

    const first = service.saveDirect(input);
    const replay = service.saveDirect(input);
    const independentScope = service.saveDirect(
      directInput({ ...contract(), change_name: "independent-stream" }, { idempotency_key: "same-text" })
    );

    expect(replay).toEqual({ ...first, replayed: true });
    expect(independentScope.contract_id).not.toBe(first.contract_id);
    expect(database.prepare("SELECT COUNT(*) AS count FROM contract_revisions").get()).toEqual({ count: 2 });
    expect(database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual({ count: 2 });
    database.close();
  });

  it("rejects a changed request bound to an existing scoped key without a new effect", () => {
    const { database } = createDatabase();
    const service = new ContractService(database);
    service.saveDirect(directInput(contract(), { idempotency_key: "bound-key" }));

    const changed = directInput(
      { ...contract(), executive_summary: "A materially different complete contract envelope." },
      { idempotency_key: "bound-key" }
    );
    expect(() => service.saveDirect(changed)).toThrowError(ContractConflictError);
    expect(() => service.saveDirect(changed)).toThrow(/idempotency/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM contract_revisions").get()).toEqual({ count: 1 });
    database.close();
  });

  it("allows exactly one independent connection to append at an expected head", () => {
    const created = createDatabase();
    const secondConnection = open(created.path);
    const first = new ContractService(created.database);
    const second = new ContractService(secondConnection);

    const root = first.saveDirect(directInput(contract()));
    const child = directInput(contract("explore"), { parent_contract_id: root.contract_id, idempotency_key: "child-a" });
    const competing = directInput(
      { ...contract("explore"), executive_summary: "Competing complete explore contract envelope." },
      { parent_contract_id: root.contract_id, idempotency_key: "child-b" }
    );

    const winner = first.saveDirect(child);
    expect(winner.revision).toBe(2);
    expect(() => second.saveDirect(competing)).toThrow(/head.*expected|stale/i);
    expect(created.database.prepare("SELECT head_revision FROM contract_streams").get()).toEqual({ head_revision: 2 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM contract_revisions").get()).toEqual({ count: 2 });
    secondConnection.close();
    created.database.close();
  });

  it("durably replays and returns history after closing and reopening the database", () => {
    const created = createDatabase();
    const input = directInput(contract(), { idempotency_key: "restart-key" });
    const first = new ContractService(created.database).saveDirect(input);
    created.database.close();

    const restarted = open(created.path);
    const service = new ContractService(restarted);
    expect(service.saveDirect(input)).toEqual({ ...first, replayed: true });
    expect(service.get(first.contract_id).contract).toEqual(contract());
    expect(service.history({ project: "forgespec-tests", since_revision: 0, limit: 1 }).items).toHaveLength(1);
    restarted.close();
  });

  it("keeps revisions and audit events immutable and pages them without replay duplicates", () => {
    const { database } = createDatabase();
    const service = new ContractService(database);
    const rootInput = directInput(contract());
    const root = service.saveDirect(rootInput);
    service.saveDirect(rootInput);
    service.saveDirect(directInput(contract("explore"), {
      parent_contract_id: root.contract_id,
      idempotency_key: "next",
    }));

    const pageOne = service.events({ resource_type: "contract", resource_id: root.contract_id, limit: 1 });
    const allEvents = service.events({ resource_type: "contract", limit: 10 });
    expect(pageOne.items).toHaveLength(1);
    expect(allEvents.items.map((event) => event.resource_revision)).toEqual([1, 2]);
    expect(() => database.prepare("UPDATE contract_revisions SET actor = 'tampered'").run()).toThrow(/immutable/i);
    expect(() => database.prepare("DELETE FROM authority_events").run()).toThrow(/immutable/i);
    database.close();
  });

  it("retains the legacy 1.0 save/get behavior without claiming direct durability", () => {
    const { database } = createDatabase();
    const service = new ContractService(database);
    const saved = service.saveLegacy(JSON.stringify(contract()));
    const retrieved = service.get(saved.id);

    expect(saved).toMatchObject({ saved: true, phase: "init", project: "forgespec-tests" });
    expect(retrieved.mode).toBe("legacy");
    expect(retrieved).not.toHaveProperty("revision");
    expect(retrieved.contract).toMatchObject({ id: saved.id, phase: "init", project: "forgespec-tests" });
    database.close();
  });

  it("rejects an unknown major or submitted digest mismatch without appending", () => {
    const { database } = createDatabase();
    const service = new ContractService(database);

    expect(() => service.saveDirect(directInput(contract(), { api_version: "2.0.0" }))).toThrow(/version/i);
    expect(() => service.saveDirect(directInput(contract(), { submitted_digest: `sha256:${"0".repeat(64)}` }))).toThrow(/digest/i);
    expect(database.prepare("SELECT COUNT(*) AS count FROM contract_revisions").get()).toEqual({ count: 0 });
    database.close();
  });
});
