import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import { directErrorResponse } from "../core/errors.js";
import { getDb } from "../database/index.js";
import { TASK_OPERATIONS, TASK_STATUSES, TASK_PRIORITIES } from "../types/index.js";
import type { GrantCommand, HandoffCommand, RevokeCommand } from "../types/index.js";
import { generateId } from "../utils/id.js";
import {
  TaskConflictError,
  TaskService,
  type DirectBoardCreateInput,
  type DirectTaskAddInput,
  type DirectClaimInput,
  type DirectHeartbeatInput,
  type DirectRecoverClaimsInput,
  type DirectRequeueInput,
  type DirectSetDependenciesInput,
  type DirectTaskUpdateInput,
  type DirectApproveInput,
} from "../services/task-service.js";
import { QueryService } from "../services/query-service.js";
import { TaskAuthorityService } from "../services/task-authority-service.js";
import { observeServerTime, SystemClock } from "../core/clock.js";

type ToolResponse = Record<string, unknown>;

function success(response: ToolResponse) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response,
  };
}

function directFailure(error: unknown) {
  const response = directErrorResponse(error);
  return {
    content: [{ type: "text" as const, text: JSON.stringify(response) }],
    structuredContent: response,
    isError: true,
  };
}

export function registerTaskBoardTools(
  server: McpServer,
  databaseProvider: () => Database.Database = getDb,
  options: { cursorSecret?: Buffer } = {}
): void {
  const cursorSecret = options.cursorSecret ?? randomBytes(32);
  const EvidenceRefSchema = z.object({
    provider: z.string().min(1).max(128),
    kind: z.string().min(1).max(128),
    external_id: z.string().min(1).max(1024),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict();
  const ApprovalAssertedProvenanceSchema = z.object({
    kind: z.literal("asserted"),
    source: z.literal("explicit").optional(),
    asserted_actor: z.string().min(1).max(256),
    boundary: z.literal("local-trusted-client"),
    mode: z.literal("direct-v1"),
    approval_ref: EvidenceRefSchema,
  }).strict();
  const ApprovalGateSchema = z.object({
    gate_id: z.string().min(1).max(128),
    required_for: z.array(z.enum(TASK_STATUSES)).min(1).max(TASK_STATUSES.length),
    allowed_actors: z.array(z.string().min(1).max(256)).min(1).max(100),
  }).strict();
  const TaskAuthorityCapabilitySchema = z.object({
    coordinationMode: z.literal("direct-v1"),
    apiVersion: z.literal("1.0.0"),
    schemaVersion: z.literal("1.0.0"),
    negotiated: z.array(z.string().min(1).max(128)).min(1).max(100).refine(
      (items) => items.filter((item) => item.startsWith("task-authority@")).length === 1
        && items.includes("task-authority@1.0.0"),
      "Exact task-authority@1.0.0 negotiation is required"
    ),
  }).strict();
  const AuthorityResourceSchema = z.discriminatedUnion("kind", [
    z.object({ kind: z.literal("board"), boardId: z.string().min(1).max(256) }).strict(),
    z.object({
      kind: z.literal("task"),
      boardId: z.string().min(1).max(256),
      taskId: z.string().min(1).max(256),
    }).strict(),
  ]);
  const AuthorityReferenceSchema = z.object({
    provider: z.enum(["forgespec", "cortex"]),
    kind: z.string().min(1).max(128),
    externalId: z.string().min(1).max(1024),
    digest: z.string().regex(/^sha256:[0-9a-f]{64}$/),
  }).strict();
  // ── Create Board ───────────────────────────────────
  const TaskInputSchema = z.object({
    title: z.string().min(3).max(512),
    description: z.string().max(65536).default(""),
    priority: z.enum(TASK_PRIORITIES).default("p2"),
    spec_ref: z.string().max(512).optional(),
    acceptance_criteria: z.string().max(65536).default(""),
    dependencies: z.array(z.string()).default([]),
    work_unit: z.string().min(1).max(128).optional(),
    gates: z.array(ApprovalGateSchema).max(20).optional(),
  }).strict();

  server.tool(
    "tb_create_board",
    "Create a new task board for a project. Optionally include tasks inline to create board + all tasks in a single atomic call (avoids N separate tb_add_task calls).",
    {
      project: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Project identifier (e.g. my-project)"),
      name: z.string().max(256).describe("Board name"),
      tasks: z.array(TaskInputSchema).max(100).optional().describe("Optional: tasks to create with the board. Each task: {title, description?, priority?, spec_ref?, acceptance_criteria?, dependencies?}. Dependencies reference other task titles or indices."),
      change_name: z.string().max(256).optional(),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
      actor: z.string().min(1).max(256).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
    },
    async (input) => {
      const { project, name, tasks } = input;
      const db = databaseProvider();
      if (input.coordination_mode === "direct-v1") {
        try {
          return success(new TaskService(db).createDirectBoard(input as DirectBoardCreateInput) as unknown as ToolResponse);
        } catch (error) {
          return directFailure(error);
        }
      }
      const boardId = generateId("board");

      if (!tasks || tasks.length === 0) {
        db.prepare(
          `INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`
        ).run(boardId, project, name);

        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({ created: true, board_id: boardId, project, name, task_count: 0 }),
            },
          ],
        };
      }

      // Atomic: create board + all tasks in one transaction
      const insertBoard = db.prepare(
        `INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`
      );
      const insertTask = db.prepare(
        `INSERT INTO tasks (id, board_id, title, description, priority, spec_ref, acceptance_criteria, dependencies, status)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      );

      const taskIds: string[] = [];
      const taskIdMap: Record<string, string> = {};

      // Pre-generate IDs so dependencies can reference them
      for (let i = 0; i < tasks.length; i++) {
        const id = generateId("task");
        taskIds.push(id);
        taskIdMap[tasks[i].title] = id;
        taskIdMap[String(i)] = id;
      }

      const tx = db.transaction(() => {
        insertBoard.run(boardId, project, name);

        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          // Resolve dependency references (by title or index) to generated IDs
          const resolvedDeps = t.dependencies.map((dep) => taskIdMap[dep] || dep);
          // Tasks with no dependencies start as "ready", others as "backlog"
          const status = resolvedDeps.length === 0 ? "ready" : "backlog";

          insertTask.run(
            taskIds[i],
            boardId,
            t.title,
            t.description,
            t.priority,
            t.spec_ref || null,
            t.acceptance_criteria,
            JSON.stringify(resolvedDeps),
            status
          );
        }
      });
      tx();

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              created: true,
              board_id: boardId,
              project,
              name,
              task_count: tasks.length,
              task_ids: taskIds,
            }),
          },
        ],
      };
    }
  );

  // ── Add Task ───────────────────────────────────────
  server.tool(
    "tb_add_task",
    "Add a task to an existing board. Every task should reference a spec and have acceptance criteria.",
    {
      board_id: z.string().max(256).describe("Board ID"),
      title: z.string().min(3).max(512).describe("Task title"),
      description: z.string().max(65536).default("").describe("Task description"),
      priority: z.enum(TASK_PRIORITIES).default("p2").describe("Priority: p0 (critical), p1 (high), p2 (medium), p3 (low)"),
      spec_ref: z.string().max(512).optional().describe("Reference to spec document"),
      acceptance_criteria: z.string().max(65536).default("").describe("Acceptance criteria for completion"),
      dependencies: z.array(z.string()).default([]).describe("Task IDs this task depends on"),
      work_unit: z.string().min(1).max(128).optional(),
      gates: z.array(ApprovalGateSchema).max(20).optional(),
      expected_board_revision: z.number().int().min(1).optional(),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
      actor: z.string().min(1).max(256).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
      capability: TaskAuthorityCapabilitySchema.optional(),
    },
    async (input) => {
      const { board_id, title, description, priority, spec_ref, acceptance_criteria, dependencies } = input;
      const db = databaseProvider();
      const service = new TaskService(db);
      if (input.coordination_mode === "direct-v1") {
        try {
          return success(service.addDirectTask(input as DirectTaskAddInput) as unknown as ToolResponse);
        } catch (error) {
          return directFailure(error);
        }
      }

      const board = db.prepare(`SELECT id FROM boards WHERE id = ?`).get(board_id);
      if (!board) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Board ${board_id} not found` }) }],
        };
      }
      try {
        service.assertLegacyBoardMutationAllowed(board_id);
      } catch (error) {
        return directFailure(error);
      }

      const id = generateId("task");
      db.prepare(
        `INSERT INTO tasks (id, board_id, title, description, priority, spec_ref, acceptance_criteria, dependencies)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(id, board_id, title, description, priority, spec_ref || null, acceptance_criteria, JSON.stringify(dependencies));

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ created: true, task_id: id, board_id, title, priority }),
          },
        ],
      };
    }
  );

  // ── Get Board Status ───────────────────────────────
  server.tool(
    "tb_status",
    "Get the current status of a task board with all tasks grouped by status.",
    {
      board_id: z.string().describe("Board ID"),
    },
    async ({ board_id }) => {
      const db = databaseProvider();
      let snapshot: { board: Record<string, unknown>; tasks: Record<string, unknown>[] };
      try {
        snapshot = await new TaskService(db).readLegacyBoard(board_id);
      } catch {
        // A protected direct-v1 board and a nonexistent board are deliberately
        // indistinguishable here: differentiating them would let an unauthorized
        // caller probe direct-v1 existence. Authorized discovery of owned or
        // granted boards goes through tb_list_boards with direct-v1 context.
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: "Board not found" }) }],
        };
      }
      const { board, tasks } = snapshot;

      const grouped: Record<string, unknown[]> = {};
      for (const status of TASK_STATUSES) {
        grouped[status] = tasks.filter((t) => t.status === status);
      }

      const summary = {
        total: tasks.length,
        by_status: Object.fromEntries(
          TASK_STATUSES.map((s) => [s, grouped[s].length])
        ),
      };

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ board, tasks: grouped, summary }),
          },
        ],
      };
    }
  );

  // ── Claim Task ─────────────────────────────────────
  server.tool(
    "tb_claim",
    "Claim a task for execution. Only claims tasks in 'ready' status with all dependencies resolved.",
    {
      task_id: z.string().max(256).describe("Task ID to claim"),
      agent: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Agent or developer claiming the task"),
      expected_revision: z.number().int().min(1).optional(),
      lease_seconds: z.number().int().min(15).max(3600).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
    },
    async (input) => {
      const { task_id, agent } = input;
      const db = databaseProvider();
      if (input.coordination_mode === "direct-v1") {
        try {
          return success(new TaskService(db).claimDirectTask(input as DirectClaimInput) as unknown as ToolResponse);
        } catch (error) {
          return directFailure(error);
        }
      }
      try {
        new TaskService(db).assertLegacyTaskMutationAllowed(task_id);
      } catch (error) {
        return directFailure(error);
      }
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id) as Record<string, unknown> | undefined;

      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
      }

      if (task.status !== "ready" && task.status !== "backlog") {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Task is in "${task.status}" status, cannot claim` }) }],
        };
      }

      // Check dependencies
      const deps = JSON.parse(task.dependencies as string) as string[];
      if (deps.length > 0) {
        const placeholders = deps.map(() => "?").join(",");
        const blockers = db
          .prepare(`SELECT id, status FROM tasks WHERE id IN (${placeholders}) AND status != 'done'`)
          .all(...deps) as Record<string, unknown>[];

        if (blockers.length > 0) {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  error: "Blocked by unfinished dependencies",
                  blockers: blockers.map((b) => ({ id: b.id, status: b.status })),
                }),
              },
            ],
          };
        }
      }

      const now = new Date().toISOString();
      db.prepare(
        `UPDATE tasks SET status = 'in_progress', assignee = ?, claimed_at = ?, updated_at = ? WHERE id = ?`
      ).run(agent, now, now, task_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ claimed: true, task_id, agent, status: "in_progress" }),
          },
        ],
      };
    }
  );

  server.tool(
    "tb_set_dependencies",
    "Atomically replace a direct-v1 task's normalized same-board dependency set.",
    {
      board_id: z.string().max(256),
      task_id: z.string().max(256),
      dependency_task_ids: z.array(z.string().max(256)).max(100),
      expected_board_revision: z.number().int().min(1),
      expected_task_revision: z.number().int().min(1),
      actor: z.string().min(1).max(256),
      idempotency_key: z.string().min(1).max(256),
      coordination_mode: z.literal("direct-v1"),
      api_version: z.literal("1.0.0"),
      schema_version: z.literal("1.0.0"),
    },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).setDirectDependencies(input as DirectSetDependenciesInput) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_heartbeat",
    "Renew an active direct-v1 task attempt lease.",
    {
      task_id: z.string().max(256),
      attempt_id: z.string().max(256),
      claim_token: z.string().min(1).max(512),
      expected_revision: z.number().int().min(1),
      extend_seconds: z.number().int().min(15).max(3600),
      actor: z.string().min(1).max(256),
      idempotency_key: z.string().min(1).max(256),
      coordination_mode: z.literal("direct-v1"),
      api_version: z.literal("1.0.0"),
      schema_version: z.literal("1.0.0"),
    },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).heartbeatDirectTask(input as DirectHeartbeatInput) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_recover_claims",
    "Recover expired direct-v1 attempts. Tasks require explicit requeue afterward.",
    {
      board_id: z.string().max(256),
      expected_board_revision: z.number().int().min(1),
      limit: z.number().int().min(1).max(100).optional(),
      attempt_ids: z.array(z.string().max(256)).max(100).optional(),
      actor: z.string().min(1).max(256),
      idempotency_key: z.string().min(1).max(256),
      capability: TaskAuthorityCapabilitySchema.optional(),
      coordination_mode: z.literal("direct-v1"),
      api_version: z.literal("1.0.0"),
      schema_version: z.literal("1.0.0"),
    },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).recoverDirectClaims(input as DirectRecoverClaimsInput) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_requeue",
    "Explicitly requeue a recovered direct-v1 task.",
    {
      task_id: z.string().max(256),
      expected_revision: z.number().int().min(1),
      reason: z.string().min(1).max(4096),
      recover_active_dependents: z.array(z.object({
        task_id: z.string().max(256),
        attempt_id: z.string().max(256),
        claim_token: z.string().min(1).max(512),
      })).max(100).optional(),
      actor: z.string().min(1).max(256),
      idempotency_key: z.string().min(1).max(256),
      capability: TaskAuthorityCapabilitySchema.optional(),
      coordination_mode: z.literal("direct-v1"),
      api_version: z.literal("1.0.0"),
      schema_version: z.literal("1.0.0"),
    },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).requeueDirectTask(input as DirectRequeueInput) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_approve",
    "Record an immutable direct-v1 approval decision with asserted provenance for a declared task gate. Asserted provenance is not authentication.",
    {
      task_id: z.string().max(256),
      gate_id: z.string().min(1).max(128),
      decision: z.enum(["allow", "deny"]),
      expected_revision: z.number().int().min(1),
      asserted_provenance: ApprovalAssertedProvenanceSchema.optional(),
      evidence_links: z.array(EvidenceRefSchema).max(100).optional(),
      reason: z.string().max(4096).optional(),
      actor: z.string().min(1).max(256),
      idempotency_key: z.string().min(1).max(256),
      capability: TaskAuthorityCapabilitySchema.optional(),
      coordination_mode: z.literal("direct-v1"),
      api_version: z.literal("1.0.0"),
      schema_version: z.literal("1.0.0"),
    },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).approveDirectTask(input as DirectApproveInput) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_grant",
    "Create an attenuated, expiring task-authority grant. Requires exact task-authority@1.0.0 negotiation.",
    {
      actor: z.string().min(1).max(256),
      resource: AuthorityResourceSchema,
      granteeActor: z.string().min(1).max(256),
      operation: z.enum(TASK_OPERATIONS),
      expiresAtMs: z.number().int().nonnegative(),
      idempotencyKey: z.string().min(1).max(256),
      expectedBoardRevision: z.number().int().min(1),
      capability: TaskAuthorityCapabilitySchema,
    },
    { readOnlyHint: false, idempotentHint: true },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).grantAuthority(input as GrantCommand) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_handoff",
    "Create a reference-only attenuated handoff. Requires exact task-authority@1.0.0 negotiation.",
    {
      actor: z.string().min(1).max(256),
      toActor: z.string().min(1).max(256),
      resource: AuthorityResourceSchema,
      operations: z.array(z.enum(TASK_OPERATIONS)).min(1).max(TASK_OPERATIONS.length),
      expiresAtMs: z.number().int().nonnegative(),
      refs: z.array(AuthorityReferenceSchema).min(1).max(100),
      idempotencyKey: z.string().min(1).max(256),
      expectedBoardRevision: z.number().int().min(1),
      capability: TaskAuthorityCapabilitySchema,
    },
    { readOnlyHint: false, idempotentHint: true },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).handoffAuthority(input as HandoffCommand) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_revoke",
    "Append an authority revocation without changing board ownership. Requires exact task-authority@1.0.0 negotiation.",
    {
      actor: z.string().min(1).max(256),
      grantId: z.string().min(1).max(256),
      reason: z.string().max(4096).optional(),
      idempotencyKey: z.string().min(1).max(256),
      expectedBoardRevision: z.number().int().min(1),
      capability: TaskAuthorityCapabilitySchema,
    },
    { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    async (input) => {
      try {
        return success(new TaskService(databaseProvider()).revokeAuthority(input as RevokeCommand) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  const TaskQuerySchema = {
    board_id: z.string().max(256),
    actor: z.string().min(1).max(256),
    coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
    api_version: z.string().max(32).optional(),
    schema_version: z.string().max(32).optional(),
    capability: TaskAuthorityCapabilitySchema.optional(),
    status: z.array(z.enum(TASK_STATUSES)).max(TASK_STATUSES.length).optional(),
    ready: z.boolean().optional(),
    work_unit: z.string().min(1).max(128).optional(),
    task_ids: z.array(z.string().max(256)).max(100).optional(),
    updated_after_revision: z.number().int().min(0).optional(),
    limit: z.number().int().min(1).max(200).optional(),
    cursor: z.string().max(4096).optional(),
  };

  server.tool(
    "tb_query",
    "Query a stable, bounded, authorized direct-v1 task snapshot.",
    TaskQuerySchema,
    async (input) => {
      try {
        return success(await new QueryService(databaseProvider(), { cursorSecret }).queryTasks(input) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_batch_status",
    "Query bounded direct-v1 task status summaries for recovery without messaging.",
    TaskQuerySchema,
    async (input) => {
      try {
        return success(await new QueryService(databaseProvider(), { cursorSecret }).batchStatus(input) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  server.tool(
    "tb_events",
    "Query authorized immutable direct-v1 event deltas in stable revision order.",
    {
      board_id: z.string().max(256),
      actor: z.string().min(1).max(256),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
      capability: TaskAuthorityCapabilitySchema.optional(),
      task_id: z.string().max(256).optional(),
      since_revision: z.number().int().min(0).optional(),
      event_type: z.array(z.string().min(1).max(128)).max(100).optional(),
      limit: z.number().int().min(1).max(200).optional(),
      cursor: z.string().max(4096).optional(),
    },
    async (input) => {
      try {
        return success(await new QueryService(databaseProvider(), { cursorSecret }).queryEvents(input) as unknown as ToolResponse);
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  // ── Update Task Status ─────────────────────────────
  server.tool(
    "tb_update",
    "Update a task's status and/or append notes. Moving to 'done' requires 'in_progress' or 'in_review'. Notes are stored as timestamped entries.",
    {
      task_id: z.string().max(256).describe("Task ID"),
      status: z.enum(TASK_STATUSES).optional().describe("New status (omit to keep current status and only add notes)"),
      notes: z.string().max(65536).optional().describe("Notes to append (timestamped). Works with or without status change."),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
      actor: z.string().min(1).max(256).optional(),
      idempotency_key: z.string().min(1).max(256).optional(),
      expected_revision: z.number().int().min(1).optional(),
      attempt_id: z.string().max(256).optional(),
      claim_token: z.string().min(1).max(512).optional(),
      evidence_links: z.array(EvidenceRefSchema).max(100).optional(),
      capability: TaskAuthorityCapabilitySchema.optional(),
    },
    async (input) => {
      const { task_id, status, notes } = input;
      const db = databaseProvider();
      const service = new TaskService(db);
      if (input.coordination_mode === "direct-v1") {
        try {
          return success(service.updateDirectTask(input as DirectTaskUpdateInput) as unknown as ToolResponse);
        } catch (error) {
          return directFailure(error);
        }
      }
      try {
        service.assertLegacyTaskMutationAllowed(task_id);
      } catch (error) {
        return directFailure(error);
      }
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id) as Record<string, unknown> | undefined;

      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
      }

      const now = new Date().toISOString();
      const effectiveStatus = status ?? task.status as string;

      // Validate done transition
      if (status === "done") {
        if (task.status !== "in_progress" && task.status !== "in_review") {
          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({ error: `Cannot move to 'done' from '${task.status}'. Must be 'in_progress' or 'in_review' first.` }),
              },
            ],
          };
        }
      }

      // Append notes if provided
      let notesCount: number | undefined;
      if (notes) {
        const existing = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
        existing.push({ text: notes, timestamp: now });
        db.prepare(`UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?`).run(
          JSON.stringify(existing),
          now,
          task_id
        );
        notesCount = existing.length;
      }

      // Update status if provided
      if (status) {
        const updates: Record<string, unknown> = { status, updated_at: now };
        if (status === "done") {
          updates.completed_at = now;
        }

        const setClauses = Object.keys(updates).map((k) => `${k} = ?`).join(", ");
        db.prepare(`UPDATE tasks SET ${setClauses} WHERE id = ?`).run(
          ...Object.values(updates),
          task_id
        );

        // Auto-unblock dependent tasks
        if (status === "done") {
          const dependents = db
            .prepare(`SELECT id, dependencies FROM tasks WHERE board_id = ? AND status = 'backlog'`)
            .all(task.board_id as string) as Record<string, unknown>[];

          const unblocked: string[] = [];
          for (const dep of dependents) {
            const depIds = JSON.parse(dep.dependencies as string) as string[];
            if (depIds.includes(task_id)) {
              const remaining = depIds.filter((d) => d !== task_id);
              if (remaining.length === 0) {
                db.prepare(`UPDATE tasks SET status = 'ready', updated_at = ? WHERE id = ?`).run(now, dep.id);
                unblocked.push(dep.id as string);
              }
            }
          }

          return {
            content: [
              {
                type: "text" as const,
                text: JSON.stringify({
                  updated: true,
                  task_id,
                  status: effectiveStatus,
                  unblocked_tasks: unblocked,
                  notes_count: notesCount,
                }),
              },
            ],
          };
        }
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({
              updated: true,
              task_id,
              status: effectiveStatus,
              notes_count: notesCount,
            }),
          },
        ],
      };
    }
  );

  // ── List Unblocked Tasks ───────────────────────────
  server.tool(
    "tb_unblocked",
    "List all tasks that are ready to be worked on (no unresolved dependencies).",
    {
      board_id: z.string().describe("Board ID"),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
      actor: z.string().min(1).max(256).optional(),
      capability: TaskAuthorityCapabilitySchema.optional(),
    },
    async (input) => {
      const { board_id } = input;
      const db = databaseProvider();
      try {
        const response = db.transaction(() => {
          const isDirectBoard = Boolean(db.prepare(
            "SELECT 1 FROM direct_boards WHERE board_id = ?"
          ).get(board_id));
          if (isDirectBoard) {
        const directActor = input.coordination_mode === "direct-v1"
          && input.api_version === "1.0.0"
          && input.schema_version === "1.0.0"
          ? input.actor
          : undefined;
        const decision = new TaskAuthorityService(db).authorizeTaskOperation(db, {
          actor: directActor ?? "",
          operation: "read_board",
          resource: { kind: "board", boardId: board_id },
          nowMs: observeServerTime(db, new SystemClock()),
          capability: directActor ? input.capability : undefined,
        });
        if (!decision.allowed) {
          throw new TaskConflictError(
            "Resource is not available",
            "authorization",
            "RESOURCE_NOT_AVAILABLE"
          );
        }
          }
          const tasks = db
        .prepare(`SELECT * FROM tasks WHERE board_id = ? AND status IN ('ready', 'backlog') ORDER BY
                  CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 END`)
        .all(board_id) as Record<string, unknown>[];

          const unblocked = tasks.filter((t) => {
        const deps = JSON.parse(t.dependencies as string) as string[];
        if (deps.length === 0) return true;
        const done = db
          .prepare(`SELECT COUNT(*) as c FROM tasks WHERE id IN (${deps.map(() => "?").join(",")}) AND status = 'done'`)
          .get(...deps) as Record<string, number>;
        return done.c === deps.length;
          });

          return { isDirectBoard, board_id, unblocked_count: unblocked.length, tasks: unblocked };
        }).deferred();
        if (response.isDirectBoard) return success(response);
      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ board_id: response.board_id, unblocked_count: response.unblocked_count, tasks: response.tasks }),
          },
        ],
      };
      } catch (error) {
        return directFailure(error);
      }
    }
  );

  // ── Get Single Task ─────────────────────────────────
  server.tool(
    "tb_get",
    "Get full details of a single task by ID.",
    {
      task_id: z.string().describe("Task ID"),
    },
    async ({ task_id }) => {
      const db = databaseProvider();
      try {
        const task = await new TaskService(db).readLegacyTask(task_id);
        return { content: [{ type: "text" as const, text: JSON.stringify({ task }) }] };
      } catch {
        // Same indistinguishability rule as tb_status: no existence oracle for
        // protected direct-v1 tasks on the legacy read path.
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
      }
    }
  );

  // ── List Boards ────────────────────────────────────
  server.tool(
    "tb_list_boards",
    "List task boards, optionally filtered by project. With actor plus direct-v1 context (coordination_mode/api_version/schema_version 1.0.0), also lists direct-v1 boards the actor owns or holds an active grant on. Use this to discover board IDs after context loss.",
    {
      project: z.string().optional().describe("Filter by project"),
      actor: z.string().min(1).max(256).optional().describe("Actor identity; with direct-v1 context, includes owned or actively granted direct-v1 boards"),
      coordination_mode: z.enum(["legacy", "direct-v1"]).optional(),
      api_version: z.string().max(32).optional(),
      schema_version: z.string().max(32).optional(),
      capability: TaskAuthorityCapabilitySchema.optional(),
    },
    async (input) => {
      const db = databaseProvider();
      const boards = await new TaskService(db).listBoardsForActor(input);

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ boards }) }],
      };
    }
  );
}
