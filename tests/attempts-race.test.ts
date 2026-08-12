import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { pathToFileURL } from "node:url";
import { Worker } from "node:worker_threads";
import { afterEach, describe, expect, it, vi } from "vitest";
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
import { TaskAuthorityService } from "../src/services/task-authority-service.js";
import type { CapabilityContext, GrantCommand } from "../src/types/index.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

const context = {
  coordination_mode: "direct-v1" as const,
  api_version: "1.0.0",
  schema_version: "1.0.0",
};

const authorityCapability: CapabilityContext = {
  coordinationMode: "direct-v1",
  apiVersion: "1.0.0",
  schemaVersion: "1.0.0",
  negotiated: ["task-authority@1.0.0"],
};

type WorkerCommand =
  | { kind: "grant"; input: GrantCommand }
  | { kind: "handoff"; input: Parameters<TaskService["handoffAuthority"]>[0] }
  | { kind: "revoke"; input: Parameters<TaskService["revokeAuthority"]>[0] }
  | { kind: "authorize"; input: Parameters<TaskAuthorityService["authorizeTaskOperation"]>[1] };

type WorkerOutcome =
  | { ok: true; value: unknown }
  | { ok: false; code?: string; message: string };

const raceWorkerSource = String.raw`
  const { parentPort, workerData } = require("node:worker_threads");
  const Database = require("better-sqlite3");
  const { register } = require("tsx/esm/api");
  register();
  (async () => {
    const [{ TaskService }, { TaskAuthorityService }, { FakeClock }] = await Promise.all([
      import(workerData.serviceUrl), import(workerData.authorityUrl), import(workerData.clockUrl),
    ]);
    const database = new Database(workerData.databasePath);
    database.pragma("journal_mode = WAL");
    database.pragma("busy_timeout = 5000");
    database.pragma("foreign_keys = ON");
    const service = new TaskService(database, { clock: new FakeClock(workerData.nowMs) });
    parentPort.postMessage({ type: "ready" });
    Atomics.wait(workerData.barrier, 0, 0);
    try {
      const command = workerData.command;
      let value;
      if (command.kind === "grant") value = service.grantAuthority(command.input);
      else if (command.kind === "handoff") value = service.handoffAuthority(command.input);
      else if (command.kind === "revoke") value = service.revokeAuthority(command.input);
      else value = new TaskAuthorityService(database).authorizeTaskOperation(database, command.input);
      parentPort.postMessage({ type: "result", outcome: { ok: true, value } });
    } catch (error) {
      parentPort.postMessage({ type: "result", outcome: {
        ok: false, code: error && error.code, message: error instanceof Error ? error.message : String(error),
      } });
    } finally {
      database.close();
    }
  })().catch((error) => parentPort.postMessage({ type: "fatal", message: String(error?.stack ?? error) }));
`;

async function runIndependentWorkerRace(
  databasePath: string,
  nowMs: number,
  commands: WorkerCommand[]
): Promise<WorkerOutcome[]> {
  const barrier = new Int32Array(new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT));
  const moduleUrls = {
    serviceUrl: pathToFileURL(`${process.cwd()}/src/services/task-service.ts`).href,
    authorityUrl: pathToFileURL(`${process.cwd()}/src/services/task-authority-service.ts`).href,
    clockUrl: pathToFileURL(`${process.cwd()}/src/core/clock.ts`).href,
  };
  const workers = commands.map((command) => new Worker(raceWorkerSource, {
    eval: true,
    workerData: { databasePath, nowMs, command, barrier, ...moduleUrls },
  }));

  try {
    const channels = workers.map((worker) => {
      let markReady!: () => void;
      let resolveResult!: (outcome: WorkerOutcome) => void;
      let rejectResult!: (error: Error) => void;
      const ready = new Promise<void>((resolve) => { markReady = resolve; });
      const result = new Promise<WorkerOutcome>((resolve, reject) => {
        resolveResult = resolve;
        rejectResult = reject;
      });
      worker.on("message", (message: { type: string; outcome?: WorkerOutcome; message?: string }) => {
        if (message.type === "ready") markReady();
        else if (message.type === "result" && message.outcome) resolveResult(message.outcome);
        else if (message.type === "fatal") rejectResult(new Error(message.message));
      });
      worker.once("error", rejectResult);
      worker.once("exit", (code) => {
        if (code !== 0) rejectResult(new Error(`Race worker exited with code ${code}`));
      });
      return { ready, result };
    });
    await Promise.all(channels.map((channel) => channel.ready));
    Atomics.store(barrier, 0, 1);
    Atomics.notify(barrier, 0, workers.length);
    return await Promise.all(channels.map((channel) => channel.result));
  } finally {
    await Promise.all(workers.map((worker) => worker.terminate()));
  }
}

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
  it("routes the declared add operation through exactly one authority decision", () => {
    const created = createTestDatabase("forgespec-add-authority-decision-");
    const service = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const board = service.createDirectBoard(boardInput());
    const decision = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");

    try {
      service.addDirectTask({
        ...context,
        board_id: board.board_id,
        expected_board_revision: board.board_revision,
        actor: "owner",
        idempotency_key: "add-authority-decision",
        title: "Added under one decision",
      });

      expect(decision).toHaveBeenCalledTimes(1);
      expect(decision.mock.calls[0]?.[1]).toMatchObject({
        actor: "owner",
        operation: "add",
        resource: { kind: "board", boardId: board.board_id },
      });
    } finally {
      decision.mockRestore();
      created.database.close();
    }
  });

  it("routes the declared update operation through exactly one authority decision", () => {
    const created = createTestDatabase("forgespec-update-authority-decision-");
    const service = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const board = service.createDirectBoard(boardInput());
    const decision = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");

    try {
      service.updateDirectTask({
        ...context,
        task_id: board.task_ids[0],
        expected_revision: 1,
        actor: "owner",
        idempotency_key: "update-authority-decision",
        status: "blocked",
      });

      expect(decision).toHaveBeenCalledTimes(1);
      expect(decision.mock.calls[0]?.[1]).toMatchObject({
        actor: "owner",
        operation: "update",
        resource: { kind: "task", boardId: board.board_id, taskId: board.task_ids[0] },
      });
    } finally {
      decision.mockRestore();
      created.database.close();
    }
  });

  it("routes the declared approve operation through exactly one authority decision", () => {
    const created = createTestDatabase("forgespec-approve-authority-decision-");
    const service = new TaskService(created.database, { clock: new FakeClock(1_800_000_000_000) });
    const board = service.createDirectBoard({
      ...boardInput(),
      tasks: [{
        title: "Approval work",
        gates: [{ gate_id: "security", required_for: ["done"], allowed_actors: ["owner"] }],
      }],
    });
    const decision = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");

    try {
      service.approveDirectTask({
        ...context,
        task_id: board.task_ids[0],
        gate_id: "security",
        decision: "allow",
        expected_revision: 1,
        actor: "owner",
        idempotency_key: "approve-authority-decision",
        asserted_provenance: {
          kind: "asserted",
          asserted_actor: "owner",
          boundary: "local-trusted-client",
          mode: "direct-v1",
          approval_ref: {
            provider: "forgespec",
            kind: "approval",
            external_id: "approve-authority-decision",
            digest: `sha256:${"a".repeat(64)}`,
          },
        },
      });

      expect(decision).toHaveBeenCalledTimes(1);
      expect(decision.mock.calls[0]?.[1]).toMatchObject({
        actor: "owner",
        operation: "approve",
        resource: { kind: "task", boardId: board.board_id, taskId: board.task_ids[0] },
      });
    } finally {
      decision.mockRestore();
      created.database.close();
    }
  });

  it("routes the declared recover operation through exactly one authority decision", () => {
    const created = createTestDatabase("forgespec-recover-authority-decision-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const claim = service.claimDirectTask(claimInput(board.task_ids[0], { lease_seconds: 15 }));
    clock.advance(20_000);
    const decision = vi.spyOn(TaskAuthorityService.prototype, "authorizeTaskOperation");

    try {
      service.recoverDirectClaims({
        ...context,
        board_id: board.board_id,
        actor: "owner",
        idempotency_key: "recover-authority-decision",
        expected_board_revision: claim.board_revision,
        attempt_ids: [claim.attempt_id],
      });

      expect(decision).toHaveBeenCalledTimes(1);
      expect(decision.mock.calls[0]?.[1]).toMatchObject({
        actor: "owner",
        operation: "recover",
        resource: { kind: "board", boardId: board.board_id },
      });
    } finally {
      decision.mockRestore();
      created.database.close();
    }
  });

  describe.each([
    { label: "E-1", offset: 14_999, ordinary: true, heartbeat: true, recovery: false },
    { label: "E", offset: 15_000, ordinary: false, heartbeat: true, recovery: false },
    { label: "E+4999", offset: 19_999, ordinary: false, heartbeat: true, recovery: false },
    { label: "E+5000", offset: 20_000, ordinary: false, heartbeat: false, recovery: true },
  ])("enforces the temporal authority matrix at $label", ({ offset, ordinary, heartbeat, recovery }) => {
    it("applies one decision to ordinary claim, heartbeat, and recovery", () => {
      const created = createTestDatabase(`forgespec-authority-${offset}-`);
      const clock = new FakeClock(1_800_000_000_000);
      const service = new TaskService(created.database, { clock });
      const board = service.createDirectBoard(boardInput());
      const taskId = board.task_ids[0];

      clock.advance(offset);

      // A ready task has no active attempt yet, so claim authority is not
      // bounded by the lease created by a later claim. The temporal matrix
      // applies to the active-attempt operations below.
      expect(service.claimDirectTask(claimInput(taskId))).toMatchObject({ task_id: taskId });

      const claimCreated = createTestDatabase(`forgespec-authority-heartbeat-${offset}-`);
      const heartbeatClock = new FakeClock(1_800_000_000_000);
      const heartbeatService = new TaskService(claimCreated.database, { clock: heartbeatClock });
      const heartbeatBoard = heartbeatService.createDirectBoard(boardInput());
      const claim = heartbeatService.claimDirectTask(claimInput(heartbeatBoard.task_ids[0], { lease_seconds: 15 }));
      heartbeatClock.advance(offset);
      if (heartbeat) {
        expect(heartbeatService.heartbeatDirectTask(heartbeatInput(claim))).toMatchObject({ task_id: claim.task_id });
      } else {
        expect(() => heartbeatService.heartbeatDirectTask(heartbeatInput(claim))).toThrowError(
          expect.objectContaining({ code: "attempt_expired" })
        );
      }

      const recoveryCreated = createTestDatabase(`forgespec-authority-recovery-${offset}-`);
      const recoveryClock = new FakeClock(1_800_000_000_000);
      const recoveryService = new TaskService(recoveryCreated.database, { clock: recoveryClock });
      const recoveryBoard = recoveryService.createDirectBoard(boardInput());
      const recoveryClaim = recoveryService.claimDirectTask(claimInput(recoveryBoard.task_ids[0], { lease_seconds: 15 }));
      recoveryClock.advance(offset);
      const recoveryInput: DirectRecoverClaimsInput = {
        ...context,
        board_id: recoveryBoard.board_id,
        actor: "owner",
        idempotency_key: `recover-${offset}`,
        expected_board_revision: recoveryClaim.board_revision,
        attempt_ids: [recoveryClaim.attempt_id],
      };
      try {
        if (recovery) {
          expect(recoveryService.recoverDirectClaims(recoveryInput).recovered).toHaveLength(1);
        } else {
          expect(() => recoveryService.recoverDirectClaims(recoveryInput)).toThrowError(
            expect.objectContaining({ code: "recovery_premature" })
          );
        }
      } finally {
        created.database.close();
        claimCreated.database.close();
        recoveryCreated.database.close();
      }
    });
  });

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

  it("persists exact grant ancestry and hashed delegation replay keys across restart", () => {
    const created = createTestDatabase("forgespec-lineage-restart-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const rootInput: GrantCommand = {
      actor: "owner", resource, granteeActor: "delegate", operation: "update",
      expiresAtMs: clock.now() + 60_000, idempotencyKey: "raw-root-key",
      expectedBoardRevision: board.board_revision, capability: authorityCapability,
    };
    const root = service.grantAuthority(rootInput);
    const childInput: GrantCommand = {
      actor: "delegate", resource, granteeActor: "worker", operation: "update",
      expiresAtMs: clock.now() + 30_000, idempotencyKey: "raw-child-key",
      expectedBoardRevision: root.boardRevision, capability: authorityCapability,
    };
    const child = service.grantAuthority(childInput);
    const handoff = service.handoffAuthority({
      actor: "delegate", toActor: "handoff-worker", resource, operations: ["update"],
      expiresAtMs: clock.now() + 20_000,
      refs: [{ provider: "forgespec", kind: "task", externalId: resource.taskId, digest: `sha256:${"a".repeat(64)}` }],
      idempotencyKey: "raw-handoff-key", expectedBoardRevision: child.boardRevision,
      capability: authorityCapability,
    });

    expect(created.database.prepare(
      "SELECT grant_id, parent_grant_id, lineage_kind FROM task_authority_grants ORDER BY created_at_ms, grant_id"
    ).all()).toEqual(expect.arrayContaining([
      { grant_id: root.value.grantId, parent_grant_id: null, lineage_kind: "owner_root" },
      { grant_id: child.value.grantId, parent_grant_id: root.value.grantId, lineage_kind: "delegated" },
      { grant_id: handoff.value.grantIds[0], parent_grant_id: root.value.grantId, lineage_kind: "delegated" },
    ]));
    const replayRows = created.database.prepare(
      "SELECT idempotency_key, idempotency_key_hash FROM task_authority_idempotency ORDER BY command_kind"
    ).all() as Array<{ idempotency_key: string; idempotency_key_hash: string }>;
    expect(replayRows).toHaveLength(3);
    expect(replayRows.every((row) => /^sha256:[0-9a-f]{64}$/.test(row.idempotency_key_hash))).toBe(true);
    expect(JSON.stringify(replayRows)).not.toContain("raw-");
    created.database.close();

    const restarted = openTestDatabase(created.path);
    const restartedService = new TaskService(restarted, { clock });
    expect(restartedService.grantAuthority(childInput)).toEqual({ ...child, replayed: true });
    const revoked = restartedService.revokeAuthority({
      actor: "owner", grantId: root.value.grantId, idempotencyKey: "raw-revoke-key",
      expectedBoardRevision: handoff.boardRevision, capability: authorityCapability,
    });
    expect(revoked.value.grantId).toBe(root.value.grantId);
    expect(new TaskAuthorityService(restarted).authorizeTaskOperation(restarted, {
      actor: "worker", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    expect(new TaskAuthorityService(restarted).authorizeTaskOperation(restarted, {
      actor: "handoff-worker", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    restarted.close();
  });

  it.each(["legacy_unknown", "missing_parent", "cycle", "expired_ancestor", "scope_amplification"] as const)(
    "fails closed without effects for %s lineage",
    (corruption) => {
      const created = createTestDatabase(`forgespec-lineage-${corruption}-`);
      const clock = new FakeClock(1_800_000_000_000);
      const service = new TaskService(created.database, { clock });
      const board = service.createDirectBoard(boardInput());
      const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
      const root = service.grantAuthority({
        actor: "owner", resource, granteeActor: "delegate", operation: "update",
        expiresAtMs: clock.now() + 60_000, idempotencyKey: `root-${corruption}`,
        expectedBoardRevision: board.board_revision, capability: authorityCapability,
      });
      const child = service.grantAuthority({
        actor: "delegate", resource, granteeActor: "worker", operation: "update",
        expiresAtMs: clock.now() + 30_000, idempotencyKey: `child-${corruption}`,
        expectedBoardRevision: root.boardRevision, capability: authorityCapability,
      });
      created.database.exec("DROP TRIGGER immutable_task_authority_grants_update");
      if (corruption === "legacy_unknown") {
        created.database.prepare(
          "UPDATE task_authority_grants SET parent_grant_id = NULL, lineage_kind = 'legacy_unknown' WHERE grant_id = ?"
        ).run(child.value.grantId);
      } else if (corruption === "missing_parent") {
        created.database.pragma("foreign_keys = OFF");
        created.database.prepare("UPDATE task_authority_grants SET parent_grant_id = 'grant-missing' WHERE grant_id = ?")
          .run(child.value.grantId);
      } else if (corruption === "cycle") {
        created.database.prepare(
          "UPDATE task_authority_grants SET parent_grant_id = ?, lineage_kind = 'delegated' WHERE grant_id = ?"
        ).run(child.value.grantId, root.value.grantId);
      } else if (corruption === "expired_ancestor") {
        created.database.prepare("UPDATE task_authority_grants SET expires_at_ms = ? WHERE grant_id = ?")
          .run(clock.now() + 5_000, root.value.grantId);
        clock.advance(5_000);
      } else {
        created.database.prepare("UPDATE task_authority_grants SET resource_id = 'task-other' WHERE grant_id = ?")
          .run(root.value.grantId);
      }
      const before = created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get();
      expect(new TaskAuthorityService(created.database).authorizeTaskOperation(created.database, {
        actor: "worker", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
      })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
      expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events").get()).toEqual(before);
      created.database.close();
    }
  );

  it("linearizes same-key grant workers and rejects a different payload without extra effects", async () => {
    const created = createTestDatabase("forgespec-worker-grant-race-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const input: GrantCommand = {
      actor: "owner", resource, granteeActor: "worker", operation: "update",
      expiresAtMs: clock.now() + 60_000, idempotencyKey: "worker-grant-same-key",
      expectedBoardRevision: board.board_revision, capability: authorityCapability,
    };

    const same = await runIndependentWorkerRace(created.path, clock.now(), [
      { kind: "grant", input }, { kind: "grant", input },
    ]);
    expect(same.every((outcome) => outcome.ok)).toBe(true);
    const responses = same.map((outcome) => (outcome as Extract<WorkerOutcome, { ok: true }>).value) as Array<ReturnType<TaskService["grantAuthority"]>>;
    expect(new Set(responses.map((response) => response.value.grantId)).size).toBe(1);
    expect(new Set(responses.map((response) => response.eventId)).size).toBe(1);
    expect(responses.map((response) => response.replayed).sort()).toEqual([false, true]);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_grants").get()).toEqual({ count: 1 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events WHERE event_type = 'authority_granted'").get())
      .toEqual({ count: 1 });

    const conflictKey = "worker-grant-conflict-key";
    const conflict = await runIndependentWorkerRace(created.path, clock.now(), [
      { kind: "grant", input: { ...input, idempotencyKey: conflictKey, expectedBoardRevision: responses[0].boardRevision, granteeActor: "worker-a" } },
      { kind: "grant", input: { ...input, idempotencyKey: conflictKey, expectedBoardRevision: responses[0].boardRevision, granteeActor: "worker-b" } },
    ]);
    expect(conflict.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(conflict.filter((outcome) => !outcome.ok)).toEqual([
      expect.objectContaining({ ok: false, code: "AUTH_IDEMPOTENCY_CONFLICT" }),
    ]);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_grants").get()).toEqual({ count: 2 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events WHERE event_type = 'authority_granted'").get())
      .toEqual({ count: 2 });
    created.database.close();
  });

  it("linearizes same-key handoff and revoke workers with canonical durable responses", async () => {
    const created = createTestDatabase("forgespec-worker-handoff-revoke-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const handoffInput: Parameters<TaskService["handoffAuthority"]>[0] = {
      actor: "owner", toActor: "delegate", resource, operations: ["update"],
      expiresAtMs: clock.now() + 60_000,
      refs: [{ provider: "forgespec", kind: "task", externalId: resource.taskId, digest: `sha256:${"b".repeat(64)}` }],
      idempotencyKey: "worker-handoff-same-key", expectedBoardRevision: board.board_revision,
      capability: authorityCapability,
    };
    const handoffs = await runIndependentWorkerRace(created.path, clock.now(), [
      { kind: "handoff", input: handoffInput }, { kind: "handoff", input: handoffInput },
    ]);
    expect(handoffs.every((outcome) => outcome.ok)).toBe(true);
    const handoffResponses = handoffs.map((outcome) => (outcome as Extract<WorkerOutcome, { ok: true }>).value) as
      Array<ReturnType<TaskService["handoffAuthority"]>>;
    expect(new Set(handoffResponses.map((response) => response.value.handoffId)).size).toBe(1);
    expect(new Set(handoffResponses.map((response) => response.eventId)).size).toBe(1);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_handoffs").get()).toEqual({ count: 1 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_handoff_refs").get()).toEqual({ count: 1 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_grants").get()).toEqual({ count: 1 });

    const grantId = handoffResponses[0].value.grantIds[0];
    clock.advance(60_000);
    const revokeInput: Parameters<TaskService["revokeAuthority"]>[0] = {
      actor: "owner", grantId, idempotencyKey: "worker-revoke-same-key",
      expectedBoardRevision: handoffResponses[0].boardRevision, capability: authorityCapability,
    };
    const revokes = await runIndependentWorkerRace(created.path, clock.now(), [
      { kind: "revoke", input: revokeInput }, { kind: "revoke", input: revokeInput },
    ]);
    expect(revokes.every((outcome) => outcome.ok)).toBe(true);
    const revokeResponses = revokes.map((outcome) => (outcome as Extract<WorkerOutcome, { ok: true }>).value) as
      Array<ReturnType<TaskService["revokeAuthority"]>>;
    expect(new Set(revokeResponses.map((response) => response.value.revokeId)).size).toBe(1);
    expect(new Set(revokeResponses.map((response) => response.eventId)).size).toBe(1);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_revocations").get()).toEqual({ count: 1 });
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM authority_events WHERE event_type = 'authority_revoked'").get())
      .toEqual({ count: 1 });
    expect(new TaskAuthorityService(created.database).authorizeTaskOperation(created.database, {
      actor: "delegate", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    created.database.close();

    const restarted = openTestDatabase(created.path);
    expect(new TaskAuthorityService(restarted).authorizeTaskOperation(restarted, {
      actor: "delegate", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    expect(new TaskService(restarted, { clock }).revokeAuthority(revokeInput)).toEqual({ ...revokeResponses[0], replayed: true });
    restarted.close();
  });

  it("waits through SQLITE_BUSY and then enforces board CAS on independent connections", async () => {
    const created = createTestDatabase("forgespec-worker-busy-cas-");
    const clock = new FakeClock(1_800_000_000_000);
    const service = new TaskService(created.database, { clock });
    const board = service.createDirectBoard(boardInput());
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const blocker = openTestDatabase(created.path);
    blocker.exec("BEGIN IMMEDIATE");
    const race = runIndependentWorkerRace(created.path, clock.now(), [{
      kind: "grant",
      input: {
        actor: "owner", resource, granteeActor: "busy-worker", operation: "update",
        expiresAtMs: clock.now() + 60_000, idempotencyKey: "busy-worker-grant",
        expectedBoardRevision: board.board_revision, capability: authorityCapability,
      },
    }]);
    await new Promise<void>((resolve) => setTimeout(() => {
      blocker.exec("ROLLBACK");
      resolve();
    }, 100));
    const [outcome] = await race;
    expect(outcome).toMatchObject({ ok: true });

    const stale = await runIndependentWorkerRace(created.path, clock.now(), [{
      kind: "grant",
      input: {
        actor: "owner", resource, granteeActor: "stale-worker", operation: "update",
        expiresAtMs: clock.now() + 60_000, idempotencyKey: "stale-worker-grant",
        expectedBoardRevision: board.board_revision, capability: authorityCapability,
      },
    }]);
    expect(stale).toEqual([expect.objectContaining({ ok: false, code: "AUTH_REVISION_CONFLICT" })]);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_authority_grants").get()).toEqual({ count: 1 });
    blocker.close();
    created.database.close();
  });

  it("serializes ancestor revoke against descendant delegation with real workers and no post-revoke allow", async () => {
    const created = createTestDatabase("forgespec-lineage-revoke-race-");
    const clock = new FakeClock(1_800_000_000_000);
    const first = new TaskService(created.database, { clock });
    const board = first.createDirectBoard(boardInput());
    const resource = { kind: "task" as const, boardId: board.board_id, taskId: board.task_ids[0] };
    const root = first.grantAuthority({
      actor: "owner", resource, granteeActor: "delegate", operation: "update",
      expiresAtMs: clock.now() + 60_000, idempotencyKey: "race-root",
      expectedBoardRevision: board.board_revision, capability: authorityCapability,
    });
    const child = first.grantAuthority({
      actor: "delegate", resource, granteeActor: "worker", operation: "update",
      expiresAtMs: clock.now() + 30_000, idempotencyKey: "race-child",
      expectedBoardRevision: root.boardRevision, capability: authorityCapability,
    });

    const outcomes = await runIndependentWorkerRace(created.path, clock.now(), [
      { kind: "revoke", input: {
        actor: "owner", grantId: root.value.grantId, idempotencyKey: "race-revoke",
        expectedBoardRevision: child.boardRevision, capability: authorityCapability,
      } },
      { kind: "grant", input: {
        actor: "worker", resource, granteeActor: "grandchild", operation: "update",
        expiresAtMs: clock.now() + 10_000, idempotencyKey: "race-grandchild",
        expectedBoardRevision: child.boardRevision, capability: authorityCapability,
      } },
    ]);
    expect(outcomes.filter((outcome) => outcome.ok)).toHaveLength(1);
    expect(outcomes.filter((outcome) => !outcome.ok)[0]).toMatchObject({
      ok: false,
      code: expect.stringMatching(/AUTH_REVISION_CONFLICT|AUTH_OWNER_OR_GRANT_REQUIRED/),
    });
    const revokeWon = outcomes[0].ok;
    expect(new TaskAuthorityService(created.database).authorizeTaskOperation(created.database, {
      actor: "worker", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    }).allowed).toBe(!revokeWon);
    expect(new TaskAuthorityService(created.database).authorizeTaskOperation(created.database, {
      actor: "grandchild", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    }).allowed).toBe(!revokeWon);
    if (!revokeWon) {
      const currentRevision = (created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?")
        .get(board.board_id) as { revision: number }).revision;
      first.revokeAuthority({
        actor: "owner", grantId: root.value.grantId, idempotencyKey: "race-revoke-after-delegation",
        expectedBoardRevision: currentRevision, capability: authorityCapability,
      });
    }
    expect(new TaskAuthorityService(created.database).authorizeTaskOperation(created.database, {
      actor: "worker", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    expect(new TaskAuthorityService(created.database).authorizeTaskOperation(created.database, {
      actor: "grandchild", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    created.database.close();

    const restarted = openTestDatabase(created.path);
    expect(new TaskAuthorityService(restarted).authorizeTaskOperation(restarted, {
      actor: "worker", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    expect(new TaskAuthorityService(restarted).authorizeTaskOperation(restarted, {
      actor: "grandchild", operation: "update", resource, capability: authorityCapability, nowMs: clock.now(),
    })).toMatchObject({ allowed: false, code: "AUTH_OWNER_OR_GRANT_REQUIRED" });
    restarted.close();
  });
});
