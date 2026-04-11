import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../database/index.js";
import { TASK_STATUSES, TASK_PRIORITIES } from "../types/index.js";
import { generateId } from "../utils/id.js";

export function registerTaskBoardTools(server: McpServer): void {
  // ── Create Board ───────────────────────────────────
  const TaskInputSchema = z.object({
    title: z.string().min(3).max(512),
    description: z.string().max(65536).default(""),
    priority: z.enum(TASK_PRIORITIES).default("p2"),
    spec_ref: z.string().max(512).optional(),
    acceptance_criteria: z.string().max(65536).default(""),
    dependencies: z.array(z.string()).default([]),
  });

  server.tool(
    "tb_create_board",
    "Create a new task board for a project. Optionally include tasks inline to create board + all tasks in a single atomic call (avoids N separate tb_add_task calls).",
    {
      project: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Project identifier (e.g. my-project)"),
      name: z.string().max(256).describe("Board name"),
      tasks: z.array(TaskInputSchema).max(100).optional().describe("Optional: tasks to create with the board. Each task: {title, description?, priority?, spec_ref?, acceptance_criteria?, dependencies?}. Dependencies reference other task titles or indices."),
    },
    async ({ project, name, tasks }) => {
      const db = getDb();
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
    },
    async ({ board_id, title, description, priority, spec_ref, acceptance_criteria, dependencies }) => {
      const db = getDb();

      const board = db.prepare(`SELECT id FROM boards WHERE id = ?`).get(board_id);
      if (!board) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Board ${board_id} not found` }) }],
        };
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
      const db = getDb();
      const board = db.prepare(`SELECT * FROM boards WHERE id = ?`).get(board_id) as Record<string, unknown> | undefined;
      if (!board) {
        return {
          content: [{ type: "text" as const, text: JSON.stringify({ error: `Board ${board_id} not found` }) }],
        };
      }

      const tasks = db.prepare(
        `SELECT * FROM tasks WHERE board_id = ? ORDER BY
         CASE priority WHEN 'p0' THEN 0 WHEN 'p1' THEN 1 WHEN 'p2' THEN 2 WHEN 'p3' THEN 3 END,
         created_at ASC`
      ).all(board_id) as Record<string, unknown>[];

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
    },
    async ({ task_id, agent }) => {
      const db = getDb();
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

  // ── Update Task Status ─────────────────────────────
  server.tool(
    "tb_update",
    "Update a task's status and/or append notes. Moving to 'done' requires 'in_progress' or 'in_review'. Notes are stored as timestamped entries.",
    {
      task_id: z.string().max(256).describe("Task ID"),
      status: z.enum(TASK_STATUSES).optional().describe("New status (omit to keep current status and only add notes)"),
      notes: z.string().max(65536).optional().describe("Notes to append (timestamped). Works with or without status change."),
    },
    async ({ task_id, status, notes }) => {
      const db = getDb();
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
    },
    async ({ board_id }) => {
      const db = getDb();
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

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ board_id, unblocked_count: unblocked.length, tasks: unblocked }),
          },
        ],
      };
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
      const db = getDb();
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id);
      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
      }
      return { content: [{ type: "text" as const, text: JSON.stringify({ task }) }] };
    }
  );

  // ── List Boards ────────────────────────────────────
  server.tool(
    "tb_list_boards",
    "List all task boards, optionally filtered by project. Use this to discover board IDs after context loss.",
    {
      project: z.string().optional().describe("Filter by project"),
    },
    async ({ project }) => {
      const db = getDb();
      const boards = project
        ? db.prepare(`SELECT * FROM boards WHERE project = ? ORDER BY created_at DESC`).all(project)
        : db.prepare(`SELECT * FROM boards ORDER BY created_at DESC`).all();

      return {
        content: [{ type: "text" as const, text: JSON.stringify({ boards }) }],
      };
    }
  );
}
