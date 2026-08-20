import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { getDb } from "../database/index.js";
import { TaskServiceV2 } from "../services/task-service-v2.js";
import { compactJson } from "../utils/compact-json.js";
import { TASK_PRIORITIES } from "../types/index.js";

function response(data: unknown, isError = false) {
  return {
    content: [{ type: "text" as const, text: JSON.stringify(compactJson(data)) }],
    structuredContent: compactJson(data) as Record<string, unknown>,
    isError,
  };
}

export function registerTaskTools(
  server: McpServer,
  databaseProvider: () => Database.Database = getDb
): void {
  const TaskItemSchema = z.object({
    title: z.string().min(3).max(512).describe("Task title"),
    description: z.string().max(65536).optional().describe("Detailed task description"),
    priority: z.enum(TASK_PRIORITIES).optional().describe("Task priority: p0 (critical), p1 (high), p2 (medium), p3 (low)"),
    spec_ref: z.string().max(512).optional().describe("Reference to spec contract or document"),
    acceptance_criteria: z.string().max(65536).optional().describe("Acceptance criteria for task completion"),
    dependencies: z.array(z.string()).optional().describe("Task titles or IDs this task depends on"),
  }).strict();

  // 1. task_board_create
  server.tool(
    "task_board_create",
    "Create a project task board, optionally initializing tasks in a single atomic call.",
    {
      project: z.string().min(1).max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Project identifier"),
      name: z.string().min(1).max(256).describe("Board name"),
      owner_actor: z.string().max(256).optional().describe("Owner agent or user identity"),
      tasks: z.array(TaskItemSchema).max(100).optional().describe("Inline tasks to create with the board"),
    },
    async (input) => {
      try {
        const service = new TaskServiceV2(databaseProvider());
        return response(service.createBoard(input.project, input.name, input.owner_actor, input.tasks));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 2. task_board_get
  server.tool(
    "task_board_get",
    "Get full task board status, metrics, and tasks grouped by status.",
    {
      board_id: z.string().min(1).max(256).describe("Board ID"),
    },
    async ({ board_id }) => {
      try {
        const service = new TaskServiceV2(databaseProvider());
        return response(service.getBoard(board_id));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 3. task_add
  server.tool(
    "task_add",
    "Add a new task to an existing board with dependencies and acceptance criteria.",
    {
      board_id: z.string().min(1).max(256).describe("Board ID"),
      title: z.string().min(3).max(512).describe("Task title"),
      description: z.string().max(65536).optional().describe("Task description"),
      priority: z.enum(TASK_PRIORITIES).optional().describe("Priority: p0, p1, p2, p3"),
      spec_ref: z.string().max(512).optional().describe("Reference to spec contract"),
      acceptance_criteria: z.string().max(65536).optional().describe("Acceptance criteria"),
      dependencies: z.array(z.string().max(256)).max(100).optional().describe("Task IDs this task depends on"),
      actor: z.string().max(256).optional().describe("Agent identity adding the task"),
    },
    async (input) => {
      try {
        const service = new TaskServiceV2(databaseProvider());
        return response(service.addTask(input));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 4. task_claim
  server.tool(
    "task_claim",
    "Claim a 'ready' task for execution. Acquires an execution lease and optionally reserves working files.",
    {
      task_id: z.string().min(1).max(256).describe("Task ID to claim"),
      actor: z.string().min(1).max(256).describe("Agent or developer claiming the task"),
      lease_seconds: z.number().int().min(15).max(3600).optional().describe("Lease duration in seconds (default 300)"),
      reserve_files: z.array(z.string()).max(50).optional().describe("File paths or glob patterns to exclusively reserve"),
      project: z.string().max(256).optional().describe("Project name (required if reserving files)"),
    },
    async (input) => {
      try {
        const service = new TaskServiceV2(databaseProvider());
        return response(service.claimTask(input.task_id, input.actor, input.lease_seconds, input.reserve_files, input.project));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 5. task_heartbeat
  server.tool(
    "task_heartbeat",
    "Extend the lease duration of an active task claim.",
    {
      task_id: z.string().min(1).max(256).describe("Task ID"),
      attempt_id: z.string().min(1).max(256).describe("Claim attempt ID"),
      claim_token: z.string().min(1).max(512).describe("Secret claim token received upon claiming"),
      extend_seconds: z.number().int().min(15).max(3600).optional().describe("Seconds to extend (default 300)"),
      actor: z.string().max(256).optional().describe("Agent identity"),
    },
    async (input) => {
      try {
        const service = new TaskServiceV2(databaseProvider());
        return response(service.heartbeatTask(input.task_id, input.attempt_id, input.claim_token, input.extend_seconds, input.actor));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 6. task_complete
  server.tool(
    "task_complete",
    "Mark a task as completed ('done'). Records completion notes, releases file leases, and automatically unblocks dependent tasks.",
    {
      task_id: z.string().min(1).max(256).describe("Task ID"),
      attempt_id: z.string().max(256).optional().describe("Claim attempt ID"),
      claim_token: z.string().max(512).optional().describe("Claim token"),
      notes: z.string().max(65536).optional().describe("Completion summary, evidence links, or notes"),
      actor: z.string().max(256).optional().describe("Agent identity"),
    },
    async (input) => {
      try {
        const service = new TaskServiceV2(databaseProvider());
        return response(service.completeTask(input));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );

  // 7. task_block
  server.tool(
    "task_block",
    "Mark a task as blocked with an explicit reason.",
    {
      task_id: z.string().min(1).max(256).describe("Task ID"),
      reason: z.string().min(1).max(4096).describe("Reason why the task is blocked"),
      attempt_id: z.string().max(256).optional().describe("Claim attempt ID"),
      claim_token: z.string().max(512).optional().describe("Claim token"),
      actor: z.string().max(256).optional().describe("Agent identity"),
    },
    async (input) => {
      try {
        const service = new TaskServiceV2(databaseProvider());
        return response(service.blockTask(input));
      } catch (error) {
        return response({ ok: false, error: (error as Error).message }, true);
      }
    }
  );
}
