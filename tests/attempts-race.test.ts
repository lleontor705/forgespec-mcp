import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { afterEach, describe, expect, it } from "vitest";
import { FakeClock } from "../src/core/clock.js";
import {
  TaskConflictError,
  TaskService,
  type DirectBoardCreateInput,
  type DirectClaimInput,
  type DirectHeartbeatInput,
  type DirectRecoverClaimsInput,
  type DirectRequeueInput,
  type DirectTaskUpdateInput,
} from "../src/services/task-service.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

const context = {
  coordination_mode: "direct-v1" as const,
  api_version: "1.0.0",
  schema_version: "1.0.0",
};

function boardInput(): DirectBoardCreateInput {
  return {
    ...context,
    project: "attempt-tests",
    name: "Attempt authority",
    actor: "owner",
    idempotency_key: "create-attempt-board",
    tasks: [{ title: "Lease work", priority: "p0", dependencies: [] }],
  };
}

function claimInput(taskId: string, overrides: Partial<DirectClaimInput> = {}): DirectClaimInput {
  return {
    ...context,
    task_id: taskId,
    agent: "worker-a",
    expected_revision: 1,
    lease_seconds: 30,
    idempotency_key: "claim-a",
    ...overrides,
  };
}

function heartbeatInput(
  claim: ReturnType<TaskService["claimDirectTask"]>,
  overrides: Partial<DirectHeartbeatInput> = {}
): DirectHeartbeatInput {
  return {
    ...context,
    task_id: claim.task_id,
    attempt_id: claim.attempt_id,
    claim_token: claim.claim_token,
    actor: "worker-a",
    expected_revision: claim.task_revision,
    extend_seconds: 30,
    idempotency_key: "heartbeat-a",
    ...overrides,
  };
}

afterEach(removeTestDatabases);

describe("direct-v1 attempt leases", () => {
  it("allows exactly one independent connection to claim a ready revision", () => {
    const created = createTestDatabase("forgespec-claim-race-");
    const other = openTestDatabase(created.path);
    const first = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const second = new TaskService(other, { clock: new FakeClock(1_800_000_000_000) });
    const taskId = first.createDirectBoard(boardInput()).task_ids[0];

    const winner = first.claimDirectTask(claimInput(taskId));
    expect(() => second.claimDirectTask(claimInput(taskId, {
      agent: "worker-b",
      idempotency_key: "claim-b",
    }))).toThrowError(TaskConflictError);

    expect(winner).toMatchObject({ attempt_no: 1, task_revision: 2, replayed: false });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE state = 'active'").get())
      .toEqual({ count: 1 });
    other.close();
    created.database.close();
  });

  it("serializes heartbeat and recovery at the expiry-grace boundary", () => {
    const created = createTestDatabase("forgespec-heartbeat-race-");
    const other = openTestDatabase(created.path);
    const clock = new FakeClock(1_800_000_000_000);
    const first = new TaskService(created.database, { clock });
    const second = new TaskService(other, { clock });
    const board = first.createDirectBoard(boardInput());
    const claim = first.claimDirectTask(claimInput(board.task_ids[0], { lease_seconds: 15 }));
    clock.advance(19_999);

    const heartbeat = first.heartbeatDirectTask(heartbeatInput(claim, { extend_seconds: 60 }));
    expect(heartbeat.task_revision).toBe(3);
    expect(() => second.recoverDirectClaims({
      ...context,
      board_id: board.board_id,
      actor: "owner",
      idempotency_key: "recover-race",
      expected_board_revision: heartbeat.board_revision,
      attempt_ids: [claim.attempt_id],
    })).toThrow(/premature|expired/i);
    expect(created.database.prepare("SELECT state FROM task_attempts WHERE id = ?").get(claim.attempt_id))
      .toEqual({ state: "active" });
    other.close();
    created.database.close();
  });

  it("uses a persisted conservative server clock across rollback and restart", () => {
    const created = createTestDatabase("forgespec-clock-restart-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const claim = service.claimDirectTask(claimInput(board.task_ids[0], { lease_seconds: 15 }));
    clock.advance(25_000);
    expect(service.recoverDirectClaims({
      ...context,
      board_id: board.board_id,
      actor: "owner",
      idempotency_key: "recover-before-rollback",
      expected_board_revision: claim.board_revision,
      attempt_ids: [claim.attempt_id],
    }).recovered).toHaveLength(1);
    created.database.close();

    const restarted = openTestDatabase(created.path);
    const rolledBackClock = new FakeClock(1_799_999_000_000);
    const restartedService = new TaskService(restarted, { clock: rolledBackClock });
    const requeued = restartedService.requeueDirectTask({
      ...context,
      task_id: claim.task_id,
      actor: "owner",
      idempotency_key: "requeue-after-rollback",
      expected_revision: 3,
      reason: "worker crashed",
    });
    expect(Date.parse(requeued.updated_at)).toBeGreaterThanOrEqual(1_800_000_025_000);
    restarted.close();
  });

  it("replays an interrupted claim response after restart without duplicating the attempt", () => {
    const created = createTestDatabase("forgespec-claim-replay-");
    const clock = new FakeClock(1_800_000_000_000);
    const first = new TaskService(created.database, { clock });
    const board = first.createDirectBoard(boardInput());
    const claimRequest = claimInput(board.task_ids[0]);
    const original = first.claimDirectTask(claimRequest);
    created.database.close();

    const restarted = openTestDatabase(created.path);
    const replay = new TaskService(restarted, { clock }).claimDirectTask(claimRequest);
    expect(replay).toEqual({ ...original, replayed: true });
    expect(restarted.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE task_id = ?").get(original.task_id))
      .toEqual({ count: 1 });
    expect(restarted.prepare("SELECT token_hash FROM task_attempts WHERE id = ?").get(original.attempt_id))
      .not.toEqual({ token_hash: original.claim_token });
    const persisted = JSON.stringify(restarted.prepare("SELECT * FROM task_attempts WHERE id = ?").get(original.attempt_id));
    expect(persisted).not.toContain(original.claim_token);
    restarted.close();
  });

  it("requires audited recovery and explicit requeue before a new immutable attempt", () => {
    const created = createTestDatabase("forgespec-requeue-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const firstClaim = service.claimDirectTask(claimInput(board.task_ids[0], { lease_seconds: 15 }));
    clock.advance(20_000);
    const recovery = service.recoverDirectClaims({
      ...context,
      board_id: board.board_id,
      actor: "owner",
      idempotency_key: "recover-expired",
      expected_board_revision: firstClaim.board_revision,
      attempt_ids: [firstClaim.attempt_id],
    });
    expect(recovery.recovered).toEqual([{ task_id: firstClaim.task_id, attempt_id: firstClaim.attempt_id, classification: "expired" }]);
    expect(() => service.claimDirectTask(claimInput(firstClaim.task_id, {
      expected_revision: 3,
      idempotency_key: "claim-before-requeue",
    }))).toThrow(/requeue|ready/i);

    const requeued = service.requeueDirectTask({
      ...context,
      task_id: firstClaim.task_id,
      actor: "owner",
      idempotency_key: "explicit-requeue",
      expected_revision: 3,
      reason: "expired worker",
    });
    const secondClaim = service.claimDirectTask(claimInput(firstClaim.task_id, {
      expected_revision: requeued.task_revision,
      idempotency_key: "claim-second-attempt",
    }));
    expect(secondClaim.attempt_no).toBe(2);
    expect(secondClaim.claim_token).not.toBe(firstClaim.claim_token);
    expect(created.database.prepare("SELECT attempt_no, state FROM task_attempts WHERE task_id = ? ORDER BY attempt_no").all(firstClaim.task_id))
      .toEqual([{ attempt_no: 1, state: "expired" }, { attempt_no: 2, state: "active" }]);
    created.database.close();
  });

  it("rejects premature, unauthorized, and stale-worker mutations without token disclosure", () => {
    const created = createTestDatabase("forgespec-attempt-denial-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const claim = service.claimDirectTask(claimInput(board.task_ids[0], { lease_seconds: 15 }));
    const premature: DirectRecoverClaimsInput = {
      ...context,
      board_id: board.board_id,
      actor: "owner",
      idempotency_key: "premature-recovery",
      expected_board_revision: claim.board_revision,
      attempt_ids: [claim.attempt_id],
    };
    expect(() => service.recoverDirectClaims(premature)).toThrow(/premature|expired/i);
    expect(() => service.recoverDirectClaims({
      ...premature,
      actor: "intruder",
      idempotency_key: "unauthorized-recovery",
    })).toThrow(/authority/i);
    expect(() => service.heartbeatDirectTask(heartbeatInput(claim, {
      actor: "worker-b",
      claim_token: "wrong-token",
      idempotency_key: "unauthorized-heartbeat",
    }))).toThrowError(TaskConflictError);

    clock.advance(20_000);
    const recovered = service.recoverDirectClaims({ ...premature, idempotency_key: "authorized-recovery" });
    const replay = service.recoverDirectClaims({ ...premature, idempotency_key: "authorized-recovery" });
    expect(replay).toEqual({ ...recovered, replayed: true });
    const requeue: DirectRequeueInput = {
      ...context,
      task_id: claim.task_id,
      actor: "owner",
      idempotency_key: "requeue-stale-worker",
      expected_revision: 3,
      reason: "expired",
    };
    service.requeueDirectTask(requeue);
    const staleCompletion: DirectTaskUpdateInput = {
      ...context,
      task_id: claim.task_id,
      actor: "worker-a",
      idempotency_key: "stale-completion",
      expected_revision: 4,
      status: "done",
      attempt_id: claim.attempt_id,
      claim_token: claim.claim_token,
    };
    let message = "";
    try {
      service.updateDirectTask(staleCompletion);
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/superseded|authority/i);
    expect(message).not.toContain(claim.claim_token);
    expect(JSON.stringify(created.database.prepare("SELECT * FROM authority_events").all())).not.toContain(claim.claim_token);
    created.database.close();
  });

  it("exposes claim and heartbeat handlers without disclosing the valid token on denial", async () => {
    const created = createTestDatabase("forgespec-attempt-handler-");
    const service = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const board = service.createDirectBoard(boardInput());
    const server = new McpServer({ name: "attempt-handler-test", version: "1.0.0" });
    registerTaskBoardTools(server, () => created.database);
    const client = new Client({ name: "attempt-handler-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const claimed = await client.callTool({
      name: "tb_claim",
      arguments: {
        ...context,
        task_id: board.task_ids[0],
        agent: "handler-worker",
        expected_revision: 1,
        lease_seconds: 30,
        idempotency_key: "handler-claim",
      },
    });
    const claim = claimed.structuredContent as unknown as ReturnType<TaskService["claimDirectTask"]>;
    const denied = await client.callTool({
      name: "tb_heartbeat",
      arguments: {
        ...context,
        task_id: claim.task_id,
        attempt_id: claim.attempt_id,
        claim_token: "wrong-token",
        actor: "handler-worker",
        expected_revision: claim.task_revision,
        extend_seconds: 30,
        idempotency_key: "handler-denied-heartbeat",
      },
    });

    expect(claimed.isError).not.toBe(true);
    expect(denied.isError).toBe(true);
    expect(denied.structuredContent).toMatchObject({
      ok: false,
      error: { category: "authorization", code: "invalid_attempt_authority" },
    });
    expect(JSON.stringify(denied.structuredContent)).not.toContain(claim.claim_token);
    await client.close();
    await server.close();
    created.database.close();
  });
});
