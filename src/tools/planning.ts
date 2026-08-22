import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { get as getDb } from "../storage/database.js";
import { createBoard, BoardDomainError } from "../domain/boards.js";
import { defineTask, queryTasks, TaskDomainError } from "../domain/tasks.js";
import { getIdentityRuntime, registerIdentityTool } from "../identity/dispatcher.js";
import { boardCreateResult, taskDefineResult, taskQueryResult } from "./schemas.js";

const text = (max: number) => z.string().min(1).max(max);
const metadata = z.record(z.string().max(128), z.unknown()).refine((v) => Object.keys(v).length <= 100);
const priorities = ["p0", "p1", "p2", "p3"] as const;
const statuses = ["backlog", "ready", "in_progress", "in_review", "blocked", "done"] as const;

const boardInput = z.object({ idempotency_key: text(256), project: text(128), name: text(128), metadata: metadata.optional() }).strict();
const taskInput = z.object({
  idempotency_key: text(256), board_id: text(128), expected_board_revision: z.number().int().min(1),
  title: text(128), description: z.string().max(65536).optional(), priority: z.enum(priorities), spec_ref: z.string().max(128).optional(),
  acceptance_criteria: z.string().max(65536).optional(), dependencies: z.array(text(128)).max(100).optional(),
}).strict();
const queryInput = z.object({ board_id: text(128), limit: z.number().int().min(1).max(200), statuses: z.array(z.enum(statuses)).max(6).optional(), task_ids: z.array(text(128)).max(100).optional() }).strict();
const mutationAnnotations = { idempotentHint: true, destructiveHint: true, openWorldHint: false } as const;
const readAnnotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false } as const;

export function registerPlanningTools(server: McpServer, databaseProvider: () => Database.Database = getDb): void {
  const verifier = getIdentityRuntime(server)?.verifier; if (!verifier) throw new Error("identity runtime is not installed");
  registerIdentityTool<any, any>(server, { verifier, toolName: "board_create", description: "Create a planning board.", businessSchema: boardInput, outputSchema: boardCreateResult, annotations: mutationAnnotations, handler: async (input, principal) => ({ ...createBoard(databaseProvider(), { actor: principal.session.worker, idempotencyKey: input.idempotency_key, project: input.project, name: input.name, metadata: input.metadata }) }) });
  registerIdentityTool<any, any>(server, { verifier, toolName: "task_define", description: "Define a task on a planning board using board CAS.", businessSchema: taskInput, outputSchema: taskDefineResult, annotations: mutationAnnotations, handler: async (input, principal) => ({ ...defineTask(databaseProvider(), { actor: principal.session.worker, idempotencyKey: input.idempotency_key, boardId: input.board_id, expectedBoardRevision: input.expected_board_revision, title: input.title, description: input.description, priority: input.priority, specRef: input.spec_ref, acceptanceCriteria: input.acceptance_criteria, dependencies: input.dependencies }) }) });
  registerIdentityTool<any, any>(server, { verifier, toolName: "task_query", description: "Query tasks visible to the authenticated worker.", businessSchema: queryInput, outputSchema: taskQueryResult, annotations: readAnnotations, handler: async (input, principal) => ({ ...queryTasks(databaseProvider(), { actor: principal.session.worker, boardId: input.board_id, limit: input.limit, statuses: input.statuses, taskIds: input.task_ids }) }) });
}
