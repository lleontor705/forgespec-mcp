import type Database from "better-sqlite3";
import { createHash, randomBytes } from "node:crypto";
import { generateId } from "../utils/id.js";
import { AuditService } from "./audit-service.js";
import { FileLeaseServiceV2 } from "./file-lease-service-v2.js";
import { TASK_PRIORITIES, TASK_STATUSES, TaskPriority, TaskStatus } from "../types/index.js";

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export interface CreateBoardTaskInput {
  title: string;
  description?: string;
  priority?: TaskPriority;
  spec_ref?: string;
  acceptance_criteria?: string;
  dependencies?: string[];
}

export interface TaskRecord {
  id: string;
  board_id: string;
  title: string;
  description: string;
  priority: TaskPriority;
  status: TaskStatus;
  spec_ref: string | null;
  acceptance_criteria: string;
  dependencies: string[];
  revision: number;
  assignee: string | null;
  current_attempt_id: string | null;
  blocked_reason: string | null;
  notes: Array<{ text: string; timestamp: string; actor: string }>;
  created_at: number;
  updated_at: number;
}

export class TaskServiceV2 {
  private audit: AuditService;
  private fileLeases: FileLeaseServiceV2;

  constructor(private db: Database.Database) {
    this.audit = new AuditService(db);
    this.fileLeases = new FileLeaseServiceV2(db);
  }

  createBoard(project: string, name: string, ownerActor = "default-agent", tasks?: CreateBoardTaskInput[]): {
    ok: true;
    board_id: string;
    project: string;
    name: string;
    task_count: number;
    task_ids: string[];
  } {
    const boardId = generateId("board");
    const now = Date.now();

    const taskIds: string[] = [];
    const taskTitleMap: Record<string, string> = {};

    if (tasks && tasks.length > 0) {
      for (let i = 0; i < tasks.length; i++) {
        const id = generateId("task");
        taskIds.push(id);
        taskTitleMap[tasks[i].title] = id;
        taskTitleMap[String(i)] = id;
      }
    }

    const tx = this.db.transaction(() => {
      this.db.prepare(
        `INSERT INTO v2_boards (id, project, name, revision, owner_actor, metadata_json, created_at, updated_at)
         VALUES (?, ?, ?, 1, ?, '{}', ?, ?)`
      ).run(boardId, project, name, ownerActor, now, now);

      if (tasks && tasks.length > 0) {
        const insertTask = this.db.prepare(
          `INSERT INTO v2_tasks
             (id, board_id, title, description, priority, status, spec_ref, acceptance_criteria, dependencies_json, revision, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
        );

        for (let i = 0; i < tasks.length; i++) {
          const t = tasks[i];
          const resolvedDeps = (t.dependencies ?? []).map((dep) => taskTitleMap[dep] || dep);
          const initialStatus: TaskStatus = resolvedDeps.length === 0 ? "ready" : "backlog";

          insertTask.run(
            taskIds[i],
            boardId,
            t.title,
            t.description || "",
            t.priority || "p2",
            initialStatus,
            t.spec_ref || null,
            t.acceptance_criteria || "",
            JSON.stringify(resolvedDeps),
            now,
            now
          );
        }
      }
    });
    tx();

    this.audit.record("board", boardId, "board_created", ownerActor, { project, name, task_count: taskIds.length });
    return { ok: true, board_id: boardId, project, name, task_count: taskIds.length, task_ids: taskIds };
  }

  getBoard(boardId: string): {
    ok: true;
    board: Record<string, unknown>;
    tasks: Record<TaskStatus, TaskRecord[]>;
    summary: { total: number; by_status: Record<TaskStatus, number> };
  } {
    const board = this.db.prepare("SELECT * FROM v2_boards WHERE id = ?").get(boardId) as any;
    if (!board) {
      throw new Error(`Board "${boardId}" not found`);
    }

    const rawTasks = this.db.prepare("SELECT * FROM v2_tasks WHERE board_id = ? ORDER BY created_at ASC").all(boardId) as any[];

    const tasks: Record<TaskStatus, TaskRecord[]> = {
      backlog: [],
      ready: [],
      in_progress: [],
      in_review: [],
      done: [],
      blocked: [],
    };

    for (const r of rawTasks) {
      const item: TaskRecord = {
        id: r.id,
        board_id: r.board_id,
        title: r.title,
        description: r.description,
        priority: r.priority,
        status: r.status,
        spec_ref: r.spec_ref,
        acceptance_criteria: r.acceptance_criteria,
        dependencies: JSON.parse(r.dependencies_json || "[]"),
        revision: r.revision,
        assignee: r.assignee,
        current_attempt_id: r.current_attempt_id,
        blocked_reason: r.blocked_reason,
        notes: JSON.parse(r.notes_json || "[]"),
        created_at: r.created_at,
        updated_at: r.updated_at,
      };
      if (tasks[item.status]) {
        tasks[item.status].push(item);
      }
    }

    const summary = {
      total: rawTasks.length,
      by_status: {
        backlog: tasks.backlog.length,
        ready: tasks.ready.length,
        in_progress: tasks.in_progress.length,
        in_review: tasks.in_review.length,
        done: tasks.done.length,
        blocked: tasks.blocked.length,
      },
    };

    return { ok: true, board, tasks, summary };
  }

  addTask(input: {
    board_id: string;
    title: string;
    description?: string;
    priority?: TaskPriority;
    spec_ref?: string;
    acceptance_criteria?: string;
    dependencies?: string[];
    actor?: string;
  }): { ok: true; task_id: string; board_id: string; status: TaskStatus; revision: number } {
    const board = this.db.prepare("SELECT id FROM v2_boards WHERE id = ?").get(input.board_id) as any;
    if (!board) throw new Error(`Board "${input.board_id}" not found`);

    const taskId = generateId("task");
    const now = Date.now();
    const deps = input.dependencies ?? [];

    let status: TaskStatus = "ready";
    if (deps.length > 0) {
      const placeholders = deps.map(() => "?").join(",");
      const doneCount = this.db.prepare(
        `SELECT COUNT(*) as count FROM v2_tasks WHERE id IN (${placeholders}) AND status = 'done'`
      ).get(...deps) as { count: number };
      if (doneCount.count < deps.length) {
        status = "backlog";
      }
    }

    this.db.prepare(
      `INSERT INTO v2_tasks
         (id, board_id, title, description, priority, status, spec_ref, acceptance_criteria, dependencies_json, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`
    ).run(
      taskId,
      input.board_id,
      input.title,
      input.description || "",
      input.priority || "p2",
      status,
      input.spec_ref || null,
      input.acceptance_criteria || "",
      JSON.stringify(deps),
      now,
      now
    );

    this.audit.record("task", taskId, "task_added", input.actor || "default-agent", {
      board_id: input.board_id,
      title: input.title,
      status,
    });

    return { ok: true, task_id: taskId, board_id: input.board_id, status, revision: 1 };
  }

  claimTask(taskId: string, actor: string, leaseSeconds = 300, reservePaths?: string[], project?: string): {
    ok: true;
    task_id: string;
    attempt_id: string;
    claim_token: string;
    lease_expires_at: string;
    reserved_files?: string[];
  } {
    const now = Date.now();
    const task = this.db.prepare("SELECT * FROM v2_tasks WHERE id = ?").get(taskId) as any;
    if (!task) throw new Error(`Task "${taskId}" not found`);

    if (task.status !== "ready") {
      throw new Error(`Task "${taskId}" is in "${task.status}" status (must be "ready" to claim)`);
    }

    // Verify dependencies
    const deps = JSON.parse(task.dependencies_json || "[]") as string[];
    if (deps.length > 0) {
      const placeholders = deps.map(() => "?").join(",");
      const blockers = this.db.prepare(
        `SELECT id, status FROM v2_tasks WHERE id IN (${placeholders}) AND status != 'done'`
      ).all(...deps) as any[];
      if (blockers.length > 0) {
        throw new Error(`Task is blocked by unfinished dependencies: ${blockers.map((b) => b.id).join(", ")}`);
      }
    }

    const leaseDuration = Math.min(Math.max(leaseSeconds, 15), 3600);
    const expiresAt = now + leaseDuration * 1000;

    const attemptNo = ((this.db.prepare(
      "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS next_no FROM v2_task_attempts WHERE task_id = ?"
    ).get(taskId) as any).next_no) || 1;

    const attemptId = generateId("attempt");
    const claimToken = randomBytes(24).toString("hex");
    const tokenHash = hashToken(claimToken);

    let reservedFiles: string[] | undefined;

    const tx = this.db.transaction(() => {
      // 1. Insert attempt
      this.db.prepare(
        `INSERT INTO v2_task_attempts
           (id, task_id, attempt_no, actor, token_hash, state, claimed_at, expires_at)
         VALUES (?, ?, ?, ?, ?, 'active', ?, ?)`
      ).run(attemptId, taskId, attemptNo, actor, tokenHash, now, expiresAt);

      // 2. Update task
      this.db.prepare(
        `UPDATE v2_tasks
            SET status = 'in_progress', assignee = ?, current_attempt_id = ?, revision = revision + 1, updated_at = ?
          WHERE id = ?`
      ).run(actor, attemptId, now, taskId);

      // 3. Optional file reservations
      if (reservePaths && reservePaths.length > 0 && project) {
        const leaseRes = this.fileLeases.reserve(project, reservePaths, actor, taskId, leaseDuration);
        reservedFiles = leaseRes.leases.map((l) => l.path_pattern);
      }
    });
    tx();

    this.audit.record("task", taskId, "task_claimed", actor, { attempt_id: attemptId, expires_at: expiresAt });

    return {
      ok: true,
      task_id: taskId,
      attempt_id: attemptId,
      claim_token: claimToken,
      lease_expires_at: new Date(expiresAt).toISOString(),
      reserved_files: reservedFiles,
    };
  }

  heartbeatTask(taskId: string, attemptId: string, claimToken: string, extendSeconds = 300, actor?: string): {
    ok: true;
    task_id: string;
    attempt_id: string;
    lease_expires_at: string;
  } {
    const now = Date.now();
    const attempt = this.db.prepare(
      "SELECT * FROM v2_task_attempts WHERE id = ? AND task_id = ? AND state = 'active'"
    ).get(attemptId, taskId) as any;

    if (!attempt) throw new Error(`Active attempt "${attemptId}" not found for task "${taskId}"`);
    if (attempt.token_hash !== hashToken(claimToken)) {
      throw new Error("Invalid claim token");
    }

    const extendDuration = Math.min(Math.max(extendSeconds, 15), 3600);
    const newExpiresAt = Math.min(Math.max(attempt.expires_at, now) + extendDuration * 1000, now + 3600000);

    this.db.prepare(
      "UPDATE v2_task_attempts SET expires_at = ? WHERE id = ?"
    ).run(newExpiresAt, attemptId);

    this.audit.record("task", taskId, "task_heartbeat", actor || attempt.actor, { attempt_id: attemptId, new_expires_at: newExpiresAt });

    return {
      ok: true,
      task_id: taskId,
      attempt_id: attemptId,
      lease_expires_at: new Date(newExpiresAt).toISOString(),
    };
  }

  completeTask(input: {
    task_id: string;
    attempt_id?: string;
    claim_token?: string;
    notes?: string;
    actor?: string;
  }): {
    ok: true;
    task_id: string;
    status: "done";
    unblocked_tasks: string[];
    released_files_count: number;
  } {
    const now = Date.now();
    const task = this.db.prepare("SELECT * FROM v2_tasks WHERE id = ?").get(input.task_id) as any;
    if (!task) throw new Error(`Task "${input.task_id}" not found`);

    if (input.attempt_id && input.claim_token) {
      const attempt = this.db.prepare(
        "SELECT * FROM v2_task_attempts WHERE id = ? AND task_id = ? AND state = 'active'"
      ).get(input.attempt_id, input.task_id) as any;
      if (!attempt || attempt.token_hash !== hashToken(input.claim_token)) {
        throw new Error("Attempt authorization invalid or expired");
      }
    }

    const existingNotes = JSON.parse(task.notes_json || "[]") as Array<{ text: string; timestamp: string; actor: string }>;
    if (input.notes) {
      existingNotes.push({
        text: input.notes,
        timestamp: new Date(now).toISOString(),
        actor: input.actor || task.assignee || "default-agent",
      });
    }

    const unblocked: string[] = [];
    let releasedFilesCount = 0;

    const tx = this.db.transaction(() => {
      // 1. Close attempt
      if (task.current_attempt_id) {
        this.db.prepare(
          "UPDATE v2_task_attempts SET state = 'succeeded', closed_at = ?, reason = 'task_completed' WHERE id = ?"
        ).run(now, task.current_attempt_id);
      }

      // 2. Update task to done
      this.db.prepare(
        `UPDATE v2_tasks
            SET status = 'done', current_attempt_id = NULL, notes_json = ?, revision = revision + 1, updated_at = ?
          WHERE id = ?`
      ).run(JSON.stringify(existingNotes), now, input.task_id);

      // 3. Release file leases
      releasedFilesCount = this.fileLeases.releaseByTaskId(input.task_id);

      // 4. DAG Auto-unblock: Find dependent tasks in backlog
      const candidates = this.db.prepare(
        "SELECT id, dependencies_json FROM v2_tasks WHERE board_id = ? AND status = 'backlog'"
      ).all(task.board_id) as any[];

      for (const c of candidates) {
        const deps = JSON.parse(c.dependencies_json || "[]") as string[];
        if (deps.includes(input.task_id)) {
          // Check if all deps for this candidate are now done
          const placeholders = deps.map(() => "?").join(",");
          const doneCheck = this.db.prepare(
            `SELECT COUNT(*) as done_count FROM v2_tasks WHERE id IN (${placeholders}) AND status = 'done'`
          ).get(...deps) as { done_count: number };

          if (doneCheck.done_count === deps.length) {
            this.db.prepare("UPDATE v2_tasks SET status = 'ready', updated_at = ? WHERE id = ?").run(now, c.id);
            unblocked.push(c.id);
          }
        }
      }
    });
    tx();

    this.audit.record("task", input.task_id, "task_completed", input.actor || task.assignee || "default-agent", {
      unblocked_tasks: unblocked,
      released_files: releasedFilesCount,
    });

    return {
      ok: true,
      task_id: input.task_id,
      status: "done",
      unblocked_tasks: unblocked,
      released_files_count: releasedFilesCount,
    };
  }

  blockTask(input: {
    task_id: string;
    reason: string;
    attempt_id?: string;
    claim_token?: string;
    actor?: string;
  }): { ok: true; task_id: string; status: "blocked"; reason: string } {
    const now = Date.now();
    const task = this.db.prepare("SELECT * FROM v2_tasks WHERE id = ?").get(input.task_id) as any;
    if (!task) throw new Error(`Task "${input.task_id}" not found`);

    const tx = this.db.transaction(() => {
      if (task.current_attempt_id) {
        this.db.prepare(
          "UPDATE v2_task_attempts SET state = 'failed', closed_at = ?, reason = ? WHERE id = ?"
        ).run(now, input.reason, task.current_attempt_id);
      }
      this.db.prepare(
        `UPDATE v2_tasks
            SET status = 'blocked', blocked_reason = ?, current_attempt_id = NULL, revision = revision + 1, updated_at = ?
          WHERE id = ?`
      ).run(input.reason, now, input.task_id);
    });
    tx();

    this.audit.record("task", input.task_id, "task_blocked", input.actor || task.assignee || "default-agent", {
      reason: input.reason,
    });

    return { ok: true, task_id: input.task_id, status: "blocked", reason: input.reason };
  }
}
