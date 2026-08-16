import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.js";
import { normalizeFileScopes, scopesOverlap } from "../src/core/file-scopes.js";
import {
  FileLeaseConflictError,
  FileLeaseService,
  type DirectFileReleaseInput,
  type DirectFileRenewInput,
  type DirectFileReserveInput,
} from "../src/services/file-lease-service.js";
import { TaskService, type DirectBoardCreateInput } from "../src/services/task-service.js";
import { registerFileTools } from "../src/tools/file-reservation.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

const context = {
  coordination_mode: "direct-v1" as const,
  api_version: "1.0.0",
  schema_version: "1.0.0",
};

function boardInput(key: string): DirectBoardCreateInput {
  return {
    ...context,
    project: "file-lease-tests",
    name: key,
    actor: "owner",
    idempotency_key: `board-${key}`,
    tasks: [{ title: "Edit files", dependencies: [] }],
  };
}

function createAuthority(database: ReturnType<typeof openTestDatabase>, clock: FakeClock, key: string) {
  const tasks = new TaskService(database, { clock });
  const board = tasks.createDirectBoard(boardInput(key));
  const claim = tasks.claimDirectTask({
    ...context,
    task_id: board.task_ids[0],
    agent: "worker-a",
    expected_revision: 1,
    lease_seconds: 300,
    idempotency_key: `claim-${key}`,
  });
  return { board, claim };
}

function reserveInput(
  claim: ReturnType<TaskService["claimDirectTask"]>,
  overrides: Partial<DirectFileReserveInput> = {}
): DirectFileReserveInput {
  return {
    ...context,
    workspace_id: "workspace-a",
    case_policy: "insensitive",
    patterns: ["src/domain/**", "README.md"],
    agent: "worker-a",
    task_id: claim.task_id,
    attempt_id: claim.attempt_id,
    claim_token: claim.claim_token,
    expected_task_revision: claim.task_revision,
    ttl_minutes: 15,
    idempotency_key: "reserve-a",
    ...overrides,
  };
}

function renewInput(
  claim: ReturnType<TaskService["claimDirectTask"]>,
  lease: ReturnType<FileLeaseService["reserve"]>,
  overrides: Partial<DirectFileRenewInput> = {}
): DirectFileRenewInput {
  return {
    ...context,
    actor: "worker-a",
    lease_id: lease.lease_id,
    lease_token: lease.lease_token,
    task_id: claim.task_id,
    attempt_id: claim.attempt_id,
    claim_token: claim.claim_token,
    expected_revision: lease.revision,
    extend_seconds: 60,
    idempotency_key: "renew-a",
    ...overrides,
  };
}

afterEach(removeTestDatabases);

describe("direct-v1 normalized file leases", () => {
  it("normalizes separators, dot segments, NFC, case policy, and restricted globs deterministically", () => {
    expect(normalizeFileScopes(["SRC\\Domain//./Cafe\u0301.ts", "src/domain/*", "src/domain/**"], "insensitive"))
      .toEqual([
        { normalized_scope: "src/domain/café.ts", base_path: "src/domain/café.ts", scope_kind: "exact" },
        { normalized_scope: "src/domain/*", base_path: "src/domain", scope_kind: "children" },
        { normalized_scope: "src/domain/**", base_path: "src/domain", scope_kind: "tree" },
      ]);
    expect(scopesOverlap(
      { normalized_scope: "src/domain/*", base_path: "src/domain", scope_kind: "children" },
      { normalized_scope: "src/domain/model.ts", base_path: "src/domain/model.ts", scope_kind: "exact" }
    )).toBe(true);
    expect(scopesOverlap(
      { normalized_scope: "src/domain/*", base_path: "src/domain", scope_kind: "children" },
      { normalized_scope: "src/domain/nested/model.ts", base_path: "src/domain/nested/model.ts", scope_kind: "exact" }
    )).toBe(false);
    expect(() => normalizeFileScopes(["C:relative-on-windows.ts"], "sensitive")).toThrow(/relative/i);
  });

  it("gives at most one independent connection an overlapping normalized scope", () => {
    const created = createTestDatabase("forgespec-file-race-");
    const other = openTestDatabase(created.path);
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "race");
    const first = new FileLeaseService(created.database, { clock });
    const second = new FileLeaseService(other, { clock });

    const winner = first.reserve(reserveInput(claim, { patterns: ["SRC\\domain\\**"] }));
    expect(() => second.reserve(reserveInput(claim, {
      patterns: ["src/./domain/model.ts"],
      idempotency_key: "reserve-b",
    }))).toThrowError(FileLeaseConflictError);
    expect(winner.normalized_scopes).toEqual(["src/domain/**"]);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM file_leases WHERE state = 'active'").get())
      .toEqual({ count: 1 });
    other.close();
    created.database.close();
  });

  it("reserves every requested scope or rolls back the whole lease", () => {
    const created = createTestDatabase("forgespec-file-atomic-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "atomic");
    const leases = new FileLeaseService(created.database, { clock });
    leases.reserve(reserveInput(claim, { patterns: ["src/owned/**"] }));

    expect(() => leases.reserve(reserveInput(claim, {
      patterns: ["docs/ok.md", "src/owned/file.ts"],
      idempotency_key: "reserve-conflicting-batch",
    }))).toThrow(/overlap/i);
    expect(() => leases.reserve(reserveInput(claim, {
      patterns: ["docs/ok.md", "../escape.ts"],
      idempotency_key: "reserve-invalid-batch",
    }))).toThrow(/scope|relative|escape/i);
    expect(created.database.prepare("SELECT normalized_scope FROM file_lease_scopes ORDER BY normalized_scope").all())
      .toEqual([{ normalized_scope: "src/owned/**" }]);
    created.database.close();
  });

  it("serializes fake-clock renewal and acquisition at expiry with one owner", () => {
    const created = createTestDatabase("forgespec-file-expiry-");
    const other = openTestDatabase(created.path);
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "expiry");
    const first = new FileLeaseService(created.database, { clock });
    const second = new FileLeaseService(other, { clock });
    const lease = first.reserve(reserveInput(claim, { patterns: ["src/shared/**"], ttl_minutes: 1 }));
    clock.advance(60_000);

    const successor = second.reserve(reserveInput(claim, {
      patterns: ["src/shared/new.ts"],
      idempotency_key: "reserve-after-expiry",
    }));
    expect(() => first.renew(renewInput(claim, lease))).toThrow(/expired|authority/i);
    expect(successor.lease_id).not.toBe(lease.lease_id);
    expect(created.database.prepare("SELECT id FROM file_leases WHERE state = 'active'").all())
      .toEqual([{ id: successor.lease_id }]);
    other.close();
    created.database.close();
  });

  it("replays after restart and persists no raw lease or claim token", () => {
    const created = createTestDatabase("forgespec-file-replay-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "replay");
    const request = reserveInput(claim);
    const original = new FileLeaseService(created.database, { clock }).reserve(request);
    created.database.close();

    const restarted = openTestDatabase(created.path);
    const replay = new FileLeaseService(restarted, { clock }).reserve(request);
    expect(replay).toEqual({ ...original, replayed: true });
    const persisted = JSON.stringify(restarted.prepare("SELECT * FROM file_leases").all())
      + JSON.stringify(restarted.prepare("SELECT * FROM authority_events WHERE resource_type = 'file_lease'").all());
    expect(persisted).not.toContain(original.lease_token);
    expect(persisted).not.toContain(claim.claim_token);
    restarted.close();
  });

  it("renews and releases exactly once with restart-safe replay", () => {
    const created = createTestDatabase("forgespec-file-lifecycle-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "lifecycle");
    const leases = new FileLeaseService(created.database, { clock });
    const lease = leases.reserve(reserveInput(claim, { patterns: ["src/lifecycle/**"] }));
    clock.advance(10_000);
    const renewalRequest = renewInput(claim, lease);
    const renewed = leases.renew(renewalRequest);
    expect(leases.renew(renewalRequest)).toEqual({ ...renewed, replayed: true });
    const releaseRequest: DirectFileReleaseInput = {
      ...context,
      actor: "worker-a",
      lease_id: lease.lease_id,
      lease_token: lease.lease_token,
      task_id: claim.task_id,
      attempt_id: claim.attempt_id,
      claim_token: claim.claim_token,
      expected_revision: renewed.revision,
      idempotency_key: "release-a",
    };
    const released = leases.release(releaseRequest);
    created.database.close();

    const restarted = openTestDatabase(created.path);
    expect(new FileLeaseService(restarted, { clock }).release(releaseRequest))
      .toEqual({ ...released, replayed: true });
    expect(restarted.prepare("SELECT revision, state FROM file_leases WHERE id = ?").get(lease.lease_id))
      .toEqual({ revision: 3, state: "released" });
    expect(restarted.prepare("SELECT event_type FROM authority_events WHERE resource_type = 'file_lease' ORDER BY id").all())
      .toEqual([
        { event_type: "file_lease_reserved" },
        { event_type: "file_lease_renewed" },
        { event_type: "file_lease_released" },
      ]);
    restarted.close();
  });

  it("denies stale token, attempt, actor, and revision without mutating or leaking authority", () => {
    const created = createTestDatabase("forgespec-file-denial-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "denial");
    const leases = new FileLeaseService(created.database, { clock });
    const lease = leases.reserve(reserveInput(claim));
    const denied = [
      renewInput(claim, lease, { lease_token: "wrong-token", idempotency_key: "wrong-token" }),
      renewInput(claim, lease, { actor: "worker-b", idempotency_key: "wrong-actor" }),
      renewInput(claim, lease, { attempt_id: "attempt-stale", idempotency_key: "wrong-attempt" }),
      renewInput(claim, lease, { expected_revision: lease.revision + 1, idempotency_key: "wrong-revision" }),
    ];
    for (const request of denied) expect(() => leases.renew(request)).toThrowError(FileLeaseConflictError);
    const release: DirectFileReleaseInput = {
      ...context,
      actor: "worker-a",
      lease_id: lease.lease_id,
      lease_token: "wrong-token",
      task_id: claim.task_id,
      attempt_id: claim.attempt_id,
      claim_token: claim.claim_token,
      expected_revision: lease.revision,
      idempotency_key: "denied-release",
    };
    expect(() => leases.release(release)).toThrowError(FileLeaseConflictError);
    expect(created.database.prepare("SELECT revision, state FROM file_leases WHERE id = ?").get(lease.lease_id))
      .toEqual({ revision: 1, state: "active" });
    expect(JSON.stringify(created.database.prepare("SELECT * FROM authority_events WHERE resource_type = 'file_lease'").all()))
      .not.toContain(lease.lease_token);
    created.database.close();
  });

  it("keeps one winner when independent connections contend repeatedly for the same scope", async () => {
    const created = createTestDatabase("forgespec-file-contention-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "contention");
    const connections = Array.from({ length: 8 }, () => openTestDatabase(created.path));
    const requests = connections.map((database, index) => ({
      database,
      input: reserveInput(claim, {
        patterns: ["src/shared/**"],
        agent: "worker-a",
        idempotency_key: `contention-${index}`,
      }),
    }));

    try {
      const outcomes = await Promise.all(requests.map(async ({ database, input }) => {
        try {
          return { result: new FileLeaseService(database, { clock }).reserve(input) };
        } catch (error) {
          return { error };
        }
      }));

      expect(outcomes.filter((outcome) => "result" in outcome)).toHaveLength(1);
      expect(outcomes.filter((outcome) => "error" in outcome)).toHaveLength(7);
      expect(outcomes.filter((outcome) => "error" in outcome).every(({ error }) =>
        error instanceof FileLeaseConflictError && error.code === "scope_overlap"
      )).toBe(true);
      expect(created.database.prepare("SELECT COUNT(*) AS count FROM file_leases WHERE state = 'active'").get())
        .toEqual({ count: 1 });
    } finally {
      for (const database of connections) database.close();
      created.database.close();
    }
  });

  it("repeats a request safely after the first connection is closed", () => {
    const created = createTestDatabase("forgespec-file-repeat-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "repeat");
    const request = reserveInput(claim, { patterns: ["src/repeat/**"], idempotency_key: "repeat-reserve" });
    const service = new FileLeaseService(created.database, { clock });
    const original = service.reserve(request);
    created.database.close();

    expect(() => service.reserve(request)).toThrowError(
      expect.objectContaining({ code: "connection_closed", category: "lease" })
    );
    expect(original.lease_id).toBeTruthy();
  });

  it("rolls back and reports an injected audit failure without leaking a partial lease", () => {
    const created = createTestDatabase("forgespec-file-audit-failure-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "audit-failure");
    const service = new FileLeaseService(created.database, { clock });
    const request = reserveInput(claim, { patterns: ["src/audit/**"], idempotency_key: "audit-failure" });
    created.database.exec(`
      CREATE TRIGGER fail_file_lease_audit
      BEFORE INSERT ON authority_events
      WHEN NEW.resource_type = 'file_lease'
      BEGIN
        SELECT RAISE(ABORT, 'injected audit failure');
      END;
    `);

    try {
      expect(() => service.reserve(request)).toThrowError(
        expect.objectContaining({ code: "audit_write_failed", category: "lease" })
      );
      expect(created.database.prepare("SELECT COUNT(*) AS count FROM file_leases").get()).toEqual({ count: 0 });
      expect(created.database.prepare("SELECT COUNT(*) AS count FROM file_lease_scopes").get()).toEqual({ count: 0 });
    } finally {
      created.database.close();
    }
  });

  it("preserves legacy advisory reserve/release handlers beside direct leases", async () => {
    const created = createTestDatabase("forgespec-file-legacy-");
    const server = new McpServer({ name: "file-handler-test", version: "1.0.0" });
    registerFileTools(server, () => created.database);
    const client = new Client({ name: "file-handler-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const reserved = await client.callTool({
      name: "file_reserve",
      arguments: { patterns: ["legacy/path/**"], agent: "legacy-agent", ttl_minutes: 15 },
    });
    const released = await client.callTool({
      name: "file_release",
      arguments: { patterns: ["legacy/path/**"], agent: "legacy-agent" },
    });
    expect(reserved.isError).not.toBe(true);
    expect(reserved.structuredContent ?? JSON.parse((reserved.content as Array<{ text: string }>)[0].text))
      .toMatchObject({ reserved: true, agent: "legacy-agent" });
    expect(released.isError).not.toBe(true);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM file_reservations").get()).toEqual({ count: 0 });
    await client.close();
    await server.close();
    created.database.close();
  });

  it("bridges direct-v1 actor and expected_revision wire fields onto a valid lease", async () => {
    const created = createTestDatabase("forgespec-file-bridge-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "bridge");
    const server = new McpServer({ name: "file-bridge-server", version: "1.0.0" });
    registerFileTools(server, () => created.database, { clock });
    const client = new Client({ name: "file-bridge-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const reserved = await client.callTool({
        name: "file_reserve",
        arguments: {
          coordination_mode: "direct-v1",
          api_version: "1.0.0",
          schema_version: "1.0.0",
          patterns: ["src/bridge/**"],
          actor: "worker-a",
          expected_revision: claim.task_revision,
          workspace_id: "workspace-a",
          case_policy: "insensitive",
          ttl_minutes: 15,
          task_id: claim.task_id,
          attempt_id: claim.attempt_id,
          claim_token: claim.claim_token,
          idempotency_key: "bridge-actor-expected-revision",
        },
      });
      expect(reserved.isError).not.toBe(true);
      const payload = reserved.structuredContent
        ?? JSON.parse((reserved.content as Array<{ text: string }>)[0].text);
      const lease = payload as { ok?: boolean; replayed?: boolean; revision?: number; lease_id?: string };
      expect(lease).toMatchObject({ ok: true, replayed: false, revision: 1 });
      expect(lease.lease_id).toBeTruthy();
      expect(created.database
        .prepare("SELECT actor, state FROM file_leases WHERE id = ?")
        .get(lease.lease_id)).toEqual({ actor: "worker-a", state: "active" });
    } finally {
      await client.close();
      await server.close();
      created.database.close();
    }
  });

  it("keeps direct-v1 legacy agent and expected_task_revision fields accepted", async () => {
    const created = createTestDatabase("forgespec-file-legacy-alias-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "legacy-alias");
    const server = new McpServer({ name: "file-legacy-alias-server", version: "1.0.0" });
    registerFileTools(server, () => created.database, { clock });
    const client = new Client({ name: "file-legacy-alias-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const authority = {
        coordination_mode: "direct-v1",
        api_version: "1.0.0",
        schema_version: "1.0.0",
        workspace_id: "workspace-a",
        case_policy: "insensitive",
        ttl_minutes: 15,
        task_id: claim.task_id,
        attempt_id: claim.attempt_id,
        claim_token: claim.claim_token,
      };
      const legacyOnly = await client.callTool({
        name: "file_reserve",
        arguments: {
          ...authority,
          patterns: ["src/legacy-direct/**"],
          agent: "worker-a",
          expected_task_revision: claim.task_revision,
          idempotency_key: "legacy-agent-task-revision",
        },
      });
      expect(legacyOnly.isError).not.toBe(true);
      const equalAliases = await client.callTool({
        name: "file_reserve",
        arguments: {
          ...authority,
          patterns: ["docs/aliases/**"],
          agent: "worker-a",
          actor: "worker-a",
          expected_task_revision: claim.task_revision,
          expected_revision: claim.task_revision,
          idempotency_key: "equal-aliases",
        },
      });
      expect(equalAliases.isError).not.toBe(true);
      expect(created.database.prepare("SELECT COUNT(*) AS count FROM file_leases WHERE state = 'active'").get())
        .toEqual({ count: 2 });
    } finally {
      await client.close();
      await server.close();
      created.database.close();
    }
  });

  it("rejects divergent identity and revision aliases instead of discarding them silently", async () => {
    const created = createTestDatabase("forgespec-file-divergent-");
    const clock = new FakeClock(1_800_000_000_000);
    const { claim } = createAuthority(created.database, clock, "divergent");
    const server = new McpServer({ name: "file-divergent-server", version: "1.0.0" });
    registerFileTools(server, () => created.database, { clock });
    const client = new Client({ name: "file-divergent-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    try {
      const divergentIdentity = await client.callTool({
        name: "file_reserve",
        arguments: {
          coordination_mode: "direct-v1",
          api_version: "1.0.0",
          schema_version: "1.0.0",
          patterns: ["src/conflict/**"],
          agent: "worker-a",
          actor: "intruder-name",
          expected_task_revision: claim.task_revision,
          expected_revision: claim.task_revision,
          workspace_id: "workspace-a",
          case_policy: "insensitive",
          ttl_minutes: 15,
          task_id: claim.task_id,
          attempt_id: claim.attempt_id,
          claim_token: claim.claim_token,
          idempotency_key: "divergent-identity",
        },
      });
      expect(divergentIdentity.isError).toBe(true);
      const identityError = (divergentIdentity.structuredContent
        ?? JSON.parse((divergentIdentity.content as Array<{ text: string }>)[0].text)) as {
          error?: { code?: string; category?: string };
        };
      expect(identityError.error).toMatchObject({ code: "identity_conflict", category: "validation" });

      const divergentRevision = await client.callTool({
        name: "file_reserve",
        arguments: {
          coordination_mode: "direct-v1",
          api_version: "1.0.0",
          schema_version: "1.0.0",
          patterns: ["src/conflict/**"],
          agent: "worker-a",
          actor: "worker-a",
          expected_task_revision: claim.task_revision,
          expected_revision: claim.task_revision + 1,
          workspace_id: "workspace-a",
          case_policy: "insensitive",
          ttl_minutes: 15,
          task_id: claim.task_id,
          attempt_id: claim.attempt_id,
          claim_token: claim.claim_token,
          idempotency_key: "divergent-revision",
        },
      });
      expect(divergentRevision.isError).toBe(true);
      const revisionError = (divergentRevision.structuredContent
        ?? JSON.parse((divergentRevision.content as Array<{ text: string }>)[0].text)) as {
          error?: { code?: string; category?: string };
        };
      expect(revisionError.error).toMatchObject({ code: "expected_revision_conflict", category: "validation" });

      expect(created.database.prepare("SELECT COUNT(*) AS count FROM file_leases").get()).toEqual({ count: 0 });
    } finally {
      await client.close();
      await server.close();
      created.database.close();
    }
  });
});
