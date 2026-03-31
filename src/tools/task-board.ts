import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { getDb } from "../database/index.js";
import { TASK_STATUSES, TASK_PRIORITIES } from "../types/index.js";
import { generateId } from "../utils/id.js";

export function registerTaskBoardTools(server: McpServer): void {
  // ── Create Board ───────────────────────────────────
  server.tool(
    "tb_create_board",
    "Create a new task board for a project.",
    {
      project: z.string().max(256).regex(/^[a-zA-Z0-9_.-]+$/).describe("Project identifier (e.g. my-project)"),
      name: z.string().max(256).describe("Board name"),
    },
    async ({ project, name }) => {
      const db = getDb();
      const id = generateId("board");

      db.prepare(
        `INSERT INTO boards (id, project, name) VALUES (?, ?, ?)`
      ).run(id, project, name);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ created: true, board_id: id, project, name }),
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
    "Update a task's status. Moving to 'done' requires the task to be in 'in_progress' or 'in_review'.",
    {
      task_id: z.string().max(256).describe("Task ID"),
      status: z.enum(TASK_STATUSES).describe("New status"),
      notes: z.string().max(65536).optional().describe("Optional notes about the update"),
    },
    async ({ task_id, status, notes }) => {
      const db = getDb();
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id) as Record<string, unknown> | undefined;

      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
      }

      const now = new Date().toISOString();
      const updates: Record<string, unknown> = { status, updated_at: now };

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
                status,
                unblocked_tasks: unblocked,
                notes,
              }),
            },
          ],
        };
      }

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ updated: true, task_id, status, notes }),
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

  // ── Delete Task ────────────────────────────────────
  server.tool(
    "tb_delete_task",
    "Delete a task from the board. Only tasks in 'backlog' or 'done' status can be deleted.",
    {
      task_id: z.string().describe("Task ID to delete"),
    },
    async ({ task_id }) => {
      const db = getDb();
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id) as Record<string, unknown> | undefined;

      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
      }

      if (task.status !== "backlog" && task.status !== "done") {
        return {
          content: [
            {
              type: "text" as const,
              text: JSON.stringify({
                error: `Cannot delete task in '${task.status}' status. Only 'backlog' or 'done' tasks can be deleted.`,
              }),
            },
          ],
        };
      }

      // Remove this task from other tasks' dependencies
      const siblings = db
        .prepare(`SELECT id, dependencies FROM tasks WHERE board_id = ? AND id != ?`)
        .all(task.board_id as string, task_id) as Record<string, unknown>[];

      for (const sibling of siblings) {
        const deps = JSON.parse(sibling.dependencies as string) as string[];
        if (deps.includes(task_id)) {
          const updated = deps.filter((d) => d !== task_id);
          db.prepare(`UPDATE tasks SET dependencies = ? WHERE id = ?`).run(
            JSON.stringify(updated),
            sibling.id
          );
        }
      }

      db.prepare(`DELETE FROM tasks WHERE id = ?`).run(task_id);

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ deleted: true, task_id }),
          },
        ],
      };
    }
  );

  // ── Add Notes ─────────────────────────────────────
  server.tool(
    "tb_add_notes",
    "Append notes to a task without changing its status. Notes are stored as timestamped entries.",
    {
      task_id: z.string().max(256).describe("Task ID"),
      notes: z.string().max(65536).describe("Note text to append"),
    },
    async ({ task_id, notes }) => {
      const db = getDb();
      const task = db.prepare(`SELECT * FROM tasks WHERE id = ?`).get(task_id) as Record<string, unknown> | undefined;

      if (!task) {
        return { content: [{ type: "text" as const, text: JSON.stringify({ error: "Task not found" }) }] };
      }

      const existing = JSON.parse((task.notes as string) || "[]") as Array<{ text: string; timestamp: string }>;
      existing.push({ text: notes, timestamp: new Date().toISOString() });

      db.prepare(`UPDATE tasks SET notes = ?, updated_at = ? WHERE id = ?`).run(
        JSON.stringify(existing),
        new Date().toISOString(),
        task_id
      );

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ added: true, task_id, notes_count: existing.length }),
          },
        ],
      };
    }
  );

  // ── List Boards ────────────────────────────────────
  server.tool(
    "tb_list",
    "List all task boards, optionally filtered by project.",
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
