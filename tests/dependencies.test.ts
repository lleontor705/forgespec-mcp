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
} from "../src/services/task-service.js";
import { registerTaskBoardTools } from "../src/tools/task-board.js";
import { createTestDatabase, openTestDatabase, removeTestDatabases } from "./helpers/database.js";

const context = {
  coordination_mode: "direct-v1" as const,
  api_version: "1.0.0",
  schema_version: "1.0.0",
};

function boardInput(project: string, tasks: DirectBoardCreateInput["tasks"]): DirectBoardCreateInput {
  return {
    ...context,
    project,
    name: `${project} dependency board`,
    actor: "owner",
    idempotency_key: `create-${project}`,
    tasks,
  };
}

function claimInput(taskId: string, revision: number, key: string, agent = "worker"): DirectClaimInput {
  return {
    ...context,
    task_id: taskId,
    agent,
    expected_revision: revision,
    lease_seconds: 30,
    idempotency_key: key,
  };
}

afterEach(removeTestDatabases);

describe("direct-v1 normalized dependency authority", () => {
  it("persists one normalized same-board DAG and rejects invalid edge batches atomically", () => {
    const created = createTestDatabase("forgespec-dependency-validation-");
    const service = new TaskService(created.database);
    const board = service.createDirectBoard(boardInput("dag-validation", [
      { title: "Root task" },
      { title: "Middle task", dependencies: ["Root task"] },
      { title: "Leaf task", dependencies: ["Middle task"] },
    ]));
    const [root, middle, leaf] = board.task_ids;

    expect(created.database.prepare(
      "SELECT task_id, dependency_task_id FROM task_dependencies ORDER BY task_id, dependency_task_id"
    ).all()).toEqual(expect.arrayContaining([
      { task_id: leaf, dependency_task_id: middle },
      { task_id: middle, dependency_task_id: root },
    ]));

    const other = service.createDirectBoard(boardInput("other-board", [{ title: "Foreign task" }]));
    const before = created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?").get(board.board_id);
    const invalidBatches = [
      [root, root],
      [root, "missing-task"],
      [root, other.task_ids[0]],
      [root, leaf],
      [root, middle, middle],
    ];

    for (const [index, dependencyTaskIds] of invalidBatches.entries()) {
      expect(() => service.setDirectDependencies({
        ...context,
        board_id: board.board_id,
        task_id: root,
        dependency_task_ids: dependencyTaskIds,
        expected_board_revision: (before as { revision: number }).revision,
        expected_task_revision: 1,
        actor: "owner",
        idempotency_key: `invalid-${index}`,
      })).toThrowError(TaskConflictError);
    }

    expect(created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?").get(board.board_id)).toEqual(before);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_dependencies").get()).toEqual({ count: 2 });
    expect(() => service.createDirectBoard(boardInput("cyclic-create", [
      { title: "Cycle task A", dependencies: ["Cycle task B"] },
      { title: "Cycle task B", dependencies: ["Cycle task A"] },
    ]))).toThrow(/cycle/i);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM boards WHERE project = 'cyclic-create'").get())
      .toEqual({ count: 0 });
    created.database.close();
  });

  it("requires all prerequisites and atomically returns newly-ready dependents", () => {
    const created = createTestDatabase("forgespec-dependency-all-of-");
    const service = new TaskService(created.database);
    const board = service.createDirectBoard(boardInput("all-of", [
      { title: "First prerequisite" },
      { title: "Second prerequisite" },
      { title: "Dependent task", dependencies: ["First prerequisite", "Second prerequisite"] },
    ]));
    const [first, second, dependent] = board.task_ids;
    const firstClaim = service.claimDirectTask(claimInput(first, 1, "claim-first", "first-worker"));
    const firstDone = service.updateDirectTask({
      ...context,
      task_id: first,
      expected_revision: firstClaim.task_revision,
      status: "done",
      attempt_id: firstClaim.attempt_id,
      claim_token: firstClaim.claim_token,
      actor: "first-worker",
      idempotency_key: "done-first",
    });

    expect(firstDone.newly_ready).toEqual([]);
    expect(() => service.claimDirectTask(claimInput(dependent, 1, "claim-too-early"))).toThrow(/ready/i);

    const secondClaim = service.claimDirectTask(claimInput(second, 1, "claim-second", "second-worker"));
    const secondDone = service.updateDirectTask({
      ...context,
      task_id: second,
      expected_revision: secondClaim.task_revision,
      status: "done",
      attempt_id: secondClaim.attempt_id,
      claim_token: secondClaim.claim_token,
      actor: "second-worker",
      idempotency_key: "done-second",
    });

    expect(secondDone.newly_ready).toEqual([dependent]);
    expect(service.getBoard(board.board_id).tasks.find((task) => task.id === dependent)).toMatchObject({ status: "ready" });
    created.database.close();
  });

  it("serializes final completion and claim across independent connections", () => {
    const created = createTestDatabase("forgespec-dependency-complete-claim-");
    const other = openTestDatabase(created.path);
    const clock = new FakeClock(1_800_000_000_000);
    const first = new TaskService(created.database, { clock });
    const second = new TaskService(other, { clock });
    const board = first.createDirectBoard(boardInput("completion-race", [
      { title: "Prerequisite task" },
      { title: "Dependent task", dependencies: ["Prerequisite task"] },
    ]));
    const claim = first.claimDirectTask(claimInput(board.task_ids[0], 1, "claim-prerequisite", "prerequisite-worker"));
    const completed = first.updateDirectTask({
      ...context,
      task_id: claim.task_id,
      expected_revision: claim.task_revision,
      status: "done",
      attempt_id: claim.attempt_id,
      claim_token: claim.claim_token,
      actor: "prerequisite-worker",
      idempotency_key: "complete-prerequisite",
    });
    expect(completed.newly_ready).toEqual([board.task_ids[1]]);
    expect(second.claimDirectTask(claimInput(board.task_ids[1], 2, "claim-dependent")).attempt_no).toBe(1);
    expect(created.database.prepare("SELECT COUNT(*) AS count FROM task_attempts WHERE task_id = ? AND state = 'active'")
      .get(board.task_ids[1])).toEqual({ count: 1 });
    other.close();
    created.database.close();
  });

  it("reblocks an unclaimed dependent atomically when a prerequisite is reopened", () => {
    const created = createTestDatabase("forgespec-dependency-reopen-");
    const other = openTestDatabase(created.path);
    const service = new TaskService(created.database);
    const contender = new TaskService(other);
    const board = service.createDirectBoard(boardInput("reopen", [
      { title: "Prerequisite task" },
      { title: "Dependent task", dependencies: ["Prerequisite task"] },
    ]));
    const prerequisiteClaim = service.claimDirectTask(claimInput(board.task_ids[0], 1, "claim-prerequisite", "worker-a"));
    const completed = service.updateDirectTask({
      ...context,
      task_id: prerequisiteClaim.task_id,
      expected_revision: prerequisiteClaim.task_revision,
      status: "done",
      attempt_id: prerequisiteClaim.attempt_id,
      claim_token: prerequisiteClaim.claim_token,
      actor: "worker-a",
      idempotency_key: "complete-prerequisite",
    });
    const reopened = service.requeueDirectTask({
      ...context,
      task_id: prerequisiteClaim.task_id,
      expected_revision: completed.task_revision,
      reason: "requirements changed",
      actor: "owner",
      idempotency_key: "reopen-prerequisite",
    });

    expect(reopened.reblocked).toEqual([board.task_ids[1]]);
    expect(() => contender.claimDirectTask(claimInput(board.task_ids[1], 3, "claim-after-reopen"))).toThrow(/ready/i);
    expect(service.getBoard(board.board_id).tasks.find((task) => task.id === board.task_ids[1])).toMatchObject({ status: "backlog" });
    other.close();
    created.database.close();
  });

  it("rolls back reopen with an active dependent unless recovery authority is supplied", () => {
    const created = createTestDatabase("forgespec-dependency-active-recovery-");
    const service = new TaskService(created.database);
    const board = service.createDirectBoard(boardInput("active-recovery", [
      { title: "Prerequisite task" },
      { title: "Dependent task", dependencies: ["Prerequisite task"] },
    ]));
    const prerequisiteClaim = service.claimDirectTask(claimInput(board.task_ids[0], 1, "claim-prerequisite", "worker-a"));
    const completed = service.updateDirectTask({
      ...context,
      task_id: prerequisiteClaim.task_id,
      expected_revision: prerequisiteClaim.task_revision,
      status: "done",
      attempt_id: prerequisiteClaim.attempt_id,
      claim_token: prerequisiteClaim.claim_token,
      actor: "worker-a",
      idempotency_key: "complete-prerequisite",
    });
    const dependentClaim = service.claimDirectTask(claimInput(board.task_ids[1], 2, "claim-dependent", "worker-b"));
    const before = created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?").get(board.board_id);

    expect(() => service.requeueDirectTask({
      ...context,
      task_id: prerequisiteClaim.task_id,
      expected_revision: completed.task_revision,
      reason: "unsafe normal reopen",
      actor: "owner",
      idempotency_key: "reopen-with-active-dependent",
    })).toThrow(/active dependent/i);
    expect(created.database.prepare("SELECT revision FROM direct_boards WHERE board_id = ?").get(board.board_id)).toEqual(before);
    expect(created.database.prepare("SELECT state FROM task_attempts WHERE id = ?").get(dependentClaim.attempt_id)).toEqual({ state: "active" });

    const recovered = service.requeueDirectTask({
      ...context,
      task_id: prerequisiteClaim.task_id,
      expected_revision: completed.task_revision,
      reason: "authorized dependency recovery",
      actor: "owner",
      idempotency_key: "reopen-with-authorized-recovery",
      recover_active_dependents: [{
        task_id: dependentClaim.task_id,
        attempt_id: dependentClaim.attempt_id,
        claim_token: dependentClaim.claim_token,
      }],
    });
    expect(recovered.reblocked).toEqual([dependentClaim.task_id]);
    expect(created.database.prepare("SELECT state, reason FROM task_attempts WHERE id = ?").get(dependentClaim.attempt_id))
      .toEqual({ state: "abandoned", reason: "dependency_reopened" });
    expect(service.getBoard(board.board_id).tasks.find((task) => task.id === dependentClaim.task_id))
      .toMatchObject({ status: "blocked", current_attempt: null });
    created.database.close();
  });

  it("restores normalized readiness after restart and never treats legacy findings as direct edges", () => {
    const created = createTestDatabase("forgespec-dependency-restart-");
    const service = new TaskService(created.database);
    const board = service.createDirectBoard(boardInput("restart", [
      { title: "Prerequisite task" },
      { title: "Dependent task", dependencies: ["Prerequisite task"] },
    ]));
    created.database.prepare(
      "INSERT INTO migration_findings (migration_version, board_id, task_id, category, details_json, created_at_ms) VALUES (2, ?, ?, 'missing_dependency', ?, ?)"
    ).run(board.board_id, board.task_ids[1], JSON.stringify({ dependency_task_id: "legacy-missing" }), Date.now());
    created.database.prepare("UPDATE tasks SET dependencies = ? WHERE id = ?")
      .run(JSON.stringify(["legacy-missing"]), board.task_ids[1]);
    created.database.close();

    const restarted = openTestDatabase(created.path);
    const restartedService = new TaskService(restarted);
    restartedService.reconcileAllProjections();
    const dependent = restartedService.getBoard(board.board_id).tasks.find((task) => task.id === board.task_ids[1]);
    expect(dependent).toMatchObject({ status: "backlog", dependencies: [board.task_ids[0]] });
    expect(restarted.prepare("SELECT COUNT(*) AS count FROM task_dependencies WHERE task_id = ?").get(board.task_ids[1]))
      .toEqual({ count: 1 });
    restarted.close();
  });

  it("exposes normalized dependency mutation through the strict MCP handler", async () => {
    const created = createTestDatabase("forgespec-dependency-handler-");
    const service = new TaskService(created.database);
    const board = service.createDirectBoard(boardInput("handler", [
      { title: "Handler prerequisite" },
      { title: "Handler dependent" },
    ]));
    const server = new McpServer({ name: "dependency-handler-test", version: "1.0.0" });
    registerTaskBoardTools(server, () => created.database);
    const client = new Client({ name: "dependency-handler-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

    const response = await client.callTool({
      name: "tb_set_dependencies",
      arguments: {
        ...context,
        board_id: board.board_id,
        task_id: board.task_ids[1],
        dependency_task_ids: [board.task_ids[0]],
        expected_board_revision: board.board_revision,
        expected_task_revision: 1,
        actor: "owner",
        idempotency_key: "handler-set-dependencies",
      },
    });

    expect(response.isError).not.toBe(true);
    expect(response.structuredContent).toMatchObject({
      ok: true,
      status: "backlog",
      newly_ready: [],
      reblocked: [board.task_ids[1]],
    });
    expect(JSON.parse(response.content[0].type === "text" ? response.content[0].text : "{}")).toEqual(response.structuredContent);
    await client.close();
    await server.close();
    created.database.close();
  });
});
