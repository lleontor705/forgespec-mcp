import type Database from "better-sqlite3";
import {
  hashIdempotencyKey,
  readIdempotentResponse,
  requestDigest,
  storeIdempotentResponse,
} from "../core/idempotency.js";
import { observeServerTime, SystemClock, type Clock } from "../core/clock.js";
import { appendTaskVersion as appendTaskVersionRow } from "../core/events.js";
import { hasHeartbeatAuthority, mayRecover } from "../core/attempt-authority.js";
import { authorityTokenMatches, generateAuthorityToken, hashAuthorityToken } from "../core/tokens.js";
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type ApprovalGateV1,
  type EvidenceRefV1,
  type TaskPriority,
  type TaskStatus,
} from "../types/index.js";
import { generateId } from "../utils/id.js";
import { TaskAuthorityService } from "./task-authority-service.js";
import type {
  AuthorityReference,
  CapabilityContext,
  CommandResult,
  GrantCommand,
  HandoffCommand,
  ResourceRef,
  RevokeCommand,
  TaskOperation,
} from "../types/index.js";

interface DirectContext {
  coordination_mode: "direct-v1";
  api_version: string;
  schema_version: string;
  actor: string;
  idempotency_key: string;
  capability?: CapabilityContext;
}

export interface DirectTaskCreate {
  title: string;
  description?: string;
  priority?: TaskPriority;
  spec_ref?: string;
  acceptance_criteria?: string;
  dependencies?: string[];
  work_unit?: string;
  gates?: ApprovalGateV1[];
}

export interface DirectBoardCreateInput extends DirectContext {
  project: string;
  name: string;
  change_name?: string;
  tasks?: DirectTaskCreate[];
}

export interface DirectTaskAddInput extends DirectContext, DirectTaskCreate {
  board_id: string;
  expected_board_revision: number;
}

export interface DirectTaskUpdateInput extends DirectContext {
  task_id: string;
  expected_revision: number;
  status?: TaskStatus;
  notes?: string;
  attempt_id?: string;
  claim_token?: string;
  evidence_links?: EvidenceRefV1[];
}

export interface DirectApproveInput extends DirectContext {
  task_id: string;
  gate_id: string;
  decision: "allow" | "deny";
  expected_revision: number;
  asserted_provenance?: ApprovalAssertedProvenanceInput;
  evidence_links?: EvidenceRefV1[];
  reason?: string;
}

interface ApprovalAssertedProvenanceInput {
  kind: "asserted";
  source?: "explicit";
  asserted_actor: string;
  boundary: "local-trusted-client";
  mode: "direct-v1";
  approval_ref: EvidenceRefV1;
}

interface ResolvedApprovalAssertedProvenance extends Omit<ApprovalAssertedProvenanceInput, "source"> {
  source: "explicit" | "evidence-link-derived";
}

export interface DirectSetDependenciesInput extends DirectContext {
  board_id: string;
  task_id: string;
  dependency_task_ids: string[];
  expected_board_revision: number;
  expected_task_revision: number;
}

export interface DirectClaimInput {
  coordination_mode: "direct-v1";
  api_version: string;
  schema_version: string;
  task_id: string;
  agent: string;
  expected_revision: number;
  lease_seconds: number;
  idempotency_key: string;
}

export interface DirectHeartbeatInput extends DirectContext {
  task_id: string;
  attempt_id: string;
  claim_token: string;
  expected_revision: number;
  extend_seconds: number;
}

export interface DirectRecoverClaimsInput extends DirectContext {
  board_id: string;
  expected_board_revision: number;
  limit?: number;
  attempt_ids?: string[];
}

export interface DirectRequeueInput extends DirectContext {
  task_id: string;
  expected_revision: number;
  reason: string;
  recover_active_dependents?: Array<{ task_id: string; attempt_id: string; claim_token: string }>;
}

export interface DirectBoardMutationResult {
  ok: true;
  replayed: boolean;
  board_id: string;
  board_revision: number;
  task_ids: string[];
}

export interface DirectTaskMutationResult {
  ok: true;
  replayed: boolean;
  board_id: string;
  board_revision: number;
  task_id: string;
  task_revision: number;
  status: TaskStatus;
  updated_at?: string;
  newly_ready: string[];
  reblocked: string[];
}

export interface DirectApprovalResult extends DirectTaskMutationResult {
  decision_id: string;
  effective_decision: "allow" | "deny";
}

export interface DirectClaimResult {
  ok: true;
  replayed: boolean;
  board_id: string;
  board_revision: number;
  task_id: string;
  task_revision: number;
  attempt_id: string;
  attempt_no: number;
  claim_token: string;
  lease_expires_at: string;
}

export interface DirectHeartbeatResult {
  ok: true;
  replayed: boolean;
  board_id: string;
  board_revision: number;
  task_id: string;
  task_revision: number;
  attempt_id: string;
  lease_expires_at: string;
}

export interface DirectRecoverClaimsResult {
  ok: true;
  replayed: boolean;
  board_id: string;
  board_revision: number;
  recovered: Array<{ task_id: string; attempt_id: string; classification: "expired" | "abandoned" }>;
  newly_ready: string[];
  reblocked: string[];
}

export type GrantResult = CommandResult<{ grantId: string }>;
export type HandoffResult = CommandResult<{ handoffId: string; grantIds: string[] }>;
export type RevokeResult = CommandResult<{ revokeId: string; grantId: string }>;

export class TaskConflictError extends Error {
  constructor(
    message: string,
    readonly category: "cas" | "idempotency" | "validation" | "compatibility" | "state" | "authorization" | "lease" | "dependency" | "approval" = "validation",
    readonly code = "task_invalid",
    readonly currentRevision?: number
  ) {
    super(message);
    this.name = "TaskConflictError";
  }
}

interface DirectBoardRow {
  board_id: string;
  change_name: string | null;
  schema_version: string;
  revision: number;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface DirectTaskRow {
  task_id: string;
  board_id: string;
  revision: number;
  status: TaskStatus;
  current_attempt_id: string | null;
  blocked_reason: string | null;
  metadata_json: string;
  created_at_ms: number;
  updated_at_ms: number;
}

interface BoardMetadata {
  project: string;
  name: string;
  owner_actor: string;
}

interface TaskAttemptRow {
  id: string;
  task_id: string;
  attempt_no: number;
  actor: string;
  token_hash: string;
  state: "active" | "succeeded" | "failed" | "expired" | "abandoned";
  revision: number;
  claimed_at_ms: number;
  expires_at_ms: number;
  closed_at_ms: number | null;
  reason: string | null;
}

interface TaskMetadata {
  title: string;
  description: string;
  priority: TaskPriority;
  spec_ref: string | null;
  acceptance_criteria: string;
  dependencies: string[];
  notes: Array<{ text: string; timestamp: string }>;
  work_unit: string | null;
  gates: ApprovalGateV1[];
}

const validTransitions: Record<TaskStatus, TaskStatus[]> = {
  backlog: ["ready", "blocked"],
  ready: ["backlog", "in_progress", "blocked"],
  in_progress: ["in_review", "done", "blocked"],
  in_review: ["in_progress", "done", "blocked"],
  done: ["in_progress"],
  blocked: ["backlog", "ready"],
};

export class TaskService {
  private readonly clock: Clock;
  private readonly authority: TaskAuthorityService;

  constructor(
    private readonly database: Database.Database,
    options: { now?: () => number; clock?: Clock } = {}
  ) {
    this.clock = options.clock ?? (options.now ? { now: options.now } : new SystemClock());
    this.authority = new TaskAuthorityService(database);
  }

  createDirectBoard(input: DirectBoardCreateInput): DirectBoardMutationResult {
    this.validateContext(input);
    if (!input.project || !input.name) throw new TaskConflictError("Project and board name are required", "validation");
    const taskInputs = input.tasks ?? [];
    this.validateTasks(taskInputs);
    const scope = ["tb_create_board", input.project, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined }));
    return this.runMutation((): DirectBoardMutationResult => {
      const replay = this.readReplay<DirectBoardMutationResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const boardId = generateId("board");
      const taskIds = taskInputs.map(() => generateId("task"));
      const now = this.effectiveNow();
      const timestamp = new Date(now).toISOString();
      const boardMetadata: BoardMetadata = { project: input.project, name: input.name, owner_actor: input.actor };
      this.database.prepare("INSERT INTO boards (id, project, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(boardId, input.project, input.name, timestamp, timestamp);
      this.database.prepare(
        `INSERT INTO direct_boards
           (board_id, change_name, schema_version, revision, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, '1.0.0', 1, ?, ?, ?)`
      ).run(boardId, input.change_name ?? null, JSON.stringify(boardMetadata), now, now);

      for (let index = 0; index < taskInputs.length; index += 1) {
        const task = taskInputs[index];
        const taskId = taskIds[index];
        const dependencies = (task.dependencies ?? []).map((dependency) => {
          const byIndex = Number.parseInt(dependency, 10);
          return Number.isSafeInteger(byIndex) && String(byIndex) === dependency && taskIds[byIndex]
            ? taskIds[byIndex]
            : taskIds[taskInputs.findIndex((candidate) => candidate.title === dependency)] ?? dependency;
        });
        const status: TaskStatus = dependencies.length === 0 ? "ready" : "backlog";
        const metadata = this.taskMetadata(task, dependencies);
        this.insertTaskProjection(taskId, boardId, metadata, status, timestamp);
        this.database.prepare(
          `INSERT INTO direct_tasks
             (task_id, board_id, revision, status, metadata_json, created_at_ms, updated_at_ms)
           VALUES (?, ?, 1, ?, ?, ?, ?)`
        ).run(taskId, boardId, status, JSON.stringify(metadata), now, now);
        this.appendTaskVersion({
          board_id: boardId, task_id: taskId, board_revision: 1, task_revision: 1,
          status, current_attempt_id: null, blocked_reason: null, metadata_json: JSON.stringify(metadata),
          created_at_ms: now, updated_at_ms: now,
        });
        this.insertApprovalGates(taskId, metadata.gates, 1);
      }

      for (let index = 0; index < taskInputs.length; index += 1) {
        const metadata = JSON.parse((this.requireDirectTask(taskIds[index])).metadata_json) as TaskMetadata;
        this.replaceDependencyEdges(boardId, taskIds[index], metadata.dependencies, 1);
      }

      this.appendBoardEvent(boardId, 1, 0, "board_created", input.actor, keyHash, { task_count: taskIds.length }, now);
      taskIds.forEach((taskId, index) =>
        this.appendBoardEvent(boardId, 1, index + 1, "task_created", input.actor, keyHash, { task_id: taskId }, now, taskId)
      );
      const response: DirectBoardMutationResult = {
        ok: true,
        replayed: false,
        board_id: boardId,
        board_revision: 1,
        task_ids: taskIds,
      };
      storeIdempotentResponse(this.database, {
        scope,
        keyHash,
        requestDigest: digest,
        response,
        resourceType: "board",
        resourceId: boardId,
        resultingRevision: 1,
        createdAtMs: now,
      });
      return response;
    });
  }

  addDirectTask(input: DirectTaskAddInput): DirectTaskMutationResult {
    this.validateContext(input);
    this.validateExpectedRevision(input.expected_board_revision, "Expected board revision");
    this.validateTasks([input]);
    const scope = ["tb_add_task", input.board_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined }));
    return this.runMutation((): DirectTaskMutationResult => {
      const replay = this.readReplay<DirectTaskMutationResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const board = this.requireDirectBoard(input.board_id);
      if (board.revision !== input.expected_board_revision) this.stale("board", board.revision);
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "add",
        resource: { kind: "board", boardId: board.board_id },
        nowMs: now,
        expectedRevision: input.expected_board_revision,
        capability: input.capability,
      });
      this.requireAllowedDecision(decision);
      const timestamp = new Date(now).toISOString();
      const taskId = generateId("task");
      const dependencies = input.dependencies ?? [];
      this.validateDependencyBatch(board.board_id, taskId, dependencies);
      const status: TaskStatus = this.dependenciesSatisfied(dependencies) ? "ready" : "backlog";
      const metadata = this.taskMetadata(input, dependencies);
      const boardRevision = board.revision + 1;
      this.insertTaskProjection(taskId, board.board_id, metadata, status, timestamp);
      this.database.prepare(
        `INSERT INTO direct_tasks
           (task_id, board_id, revision, status, metadata_json, created_at_ms, updated_at_ms)
         VALUES (?, ?, 1, ?, ?, ?, ?)`
      ).run(taskId, board.board_id, status, JSON.stringify(metadata), now, now);
      this.appendTaskVersion({
        board_id: board.board_id, task_id: taskId, board_revision: boardRevision, task_revision: 1,
        status, current_attempt_id: null, blocked_reason: null, metadata_json: JSON.stringify(metadata),
        created_at_ms: now, updated_at_ms: now,
      });
      this.insertApprovalGates(taskId, metadata.gates, 1);
      this.replaceDependencyEdges(board.board_id, taskId, dependencies, boardRevision);
      this.updateBoardRevision(board, boardRevision, now);
      this.appendBoardEvent(board.board_id, boardRevision, 0, "task_created", input.actor, keyHash, {}, now, taskId);
      const response: DirectTaskMutationResult = {
        ok: true, replayed: false, board_id: board.board_id, board_revision: boardRevision,
        task_id: taskId, task_revision: 1, status, newly_ready: [], reblocked: [],
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "task", resourceId: taskId,
        resultingRevision: 1, createdAtMs: now,
      });
      return response;
    });
  }

  setDirectDependencies(input: DirectSetDependenciesInput): DirectTaskMutationResult {
    this.validateContext(input);
    this.validateExpectedRevision(input.expected_board_revision, "Expected board revision");
    this.validateExpectedRevision(input.expected_task_revision, "Expected task revision");
    if (input.dependency_task_ids.length > 100) {
      throw new TaskConflictError("A task may have at most 100 dependencies", "dependency", "dependency_limit");
    }
    const scope = ["tb_set_dependencies", input.board_id, input.task_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined }));
    return this.runMutation(() => {
      const replay = this.readReplay<DirectTaskMutationResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const board = this.requireDirectBoard(input.board_id);
      this.requireBoardOwner(board, input.actor);
      if (board.revision !== input.expected_board_revision) this.stale("board", board.revision);
      const task = this.requireDirectTask(input.task_id);
      if (task.board_id !== board.board_id) throw new TaskConflictError("Task is not on the requested board", "dependency", "cross_board_dependency");
      if (task.revision !== input.expected_task_revision) this.stale("task", task.revision);
      const currentMetadata = JSON.parse(task.metadata_json) as TaskMetadata;
      if (JSON.stringify(currentMetadata.dependencies) === JSON.stringify(input.dependency_task_ids)) {
        const response: DirectTaskMutationResult = {
          ok: true, replayed: false, board_id: board.board_id, board_revision: board.revision,
          task_id: task.task_id, task_revision: task.revision, status: task.status, newly_ready: [], reblocked: [],
        };
        storeIdempotentResponse(this.database, {
          scope, keyHash, requestDigest: digest, response, resourceType: "task", resourceId: task.task_id,
          resultingRevision: task.revision, createdAtMs: this.effectiveNow(),
        });
        return response;
      }
      const now = this.effectiveNow();
      const taskRevision = task.revision + 1;
      const boardRevision = board.revision + 1;
      const metadata = currentMetadata;
      metadata.dependencies = [...input.dependency_task_ids];
      this.replaceDependencyEdges(board.board_id, task.task_id, input.dependency_task_ids, boardRevision);
      const status = task.current_attempt_id ? task.status : this.readinessStatus(task, input.dependency_task_ids);
      const newlyReady = status === "ready" && task.status !== "ready" ? [task.task_id] : [];
      const reblocked = status === "backlog" && task.status === "ready" ? [task.task_id] : [];
      this.database.prepare(
        `UPDATE direct_tasks SET revision = ?, status = ?, blocked_reason = NULL, metadata_json = ?, updated_at_ms = ?
         WHERE task_id = ? AND revision = ?`
      ).run(taskRevision, status, JSON.stringify(metadata), now, task.task_id, task.revision);
      this.syncTaskProjection({ ...task, revision: taskRevision, status, blocked_reason: null, metadata_json: JSON.stringify(metadata), updated_at_ms: now });
      this.appendTaskVersion({
        board_id: board.board_id, task_id: task.task_id, board_revision: boardRevision, task_revision: taskRevision,
        status, current_attempt_id: task.current_attempt_id, blocked_reason: null,
        metadata_json: JSON.stringify(metadata), created_at_ms: task.created_at_ms, updated_at_ms: now,
      });
      this.updateBoardRevision(board, boardRevision, now);
      this.appendBoardEvent(board.board_id, boardRevision, 0, "task_dependencies_set", input.actor, keyHash, {
        dependency_task_ids: input.dependency_task_ids,
        newly_ready: newlyReady,
        reblocked,
      }, now, task.task_id, taskRevision);
      const response: DirectTaskMutationResult = {
        ok: true, replayed: false, board_id: board.board_id, board_revision: boardRevision,
        task_id: task.task_id, task_revision: taskRevision, status, newly_ready: newlyReady, reblocked,
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "task", resourceId: task.task_id,
        resultingRevision: taskRevision, createdAtMs: now,
      });
      return response;
    });
  }

  claimDirectTask(input: DirectClaimInput): DirectClaimResult {
    this.validateVersions(input);
    this.validateExpectedRevision(input.expected_revision, "Expected revision");
    this.validateLeaseSeconds(input.lease_seconds);
    if (!input.agent || !input.idempotency_key) throw new TaskConflictError("Agent and idempotency key are required", "validation");
    const scope = ["tb_claim", input.task_id, input.agent].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined }));
    return this.runMutation(() => {
      const replay = this.readReplay<DirectClaimResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const task = this.requireDirectTask(input.task_id);
      if (task.revision !== input.expected_revision) this.stale("task", task.revision);
      if (task.status !== "ready" || task.current_attempt_id) {
        throw new TaskConflictError("Task is not ready for claim", "state", "claim_conflict");
      }
      if (!this.dependenciesSatisfiedForTask(task.task_id)) {
        throw new TaskConflictError("Task has unfinished dependencies", "dependency", "dependencies_incomplete");
      }
      const board = this.requireDirectBoard(task.board_id);
      const now = this.effectiveNow();
      const attemptNo = (this.database.prepare(
        "SELECT COALESCE(MAX(attempt_no), 0) + 1 AS attempt_no FROM task_attempts WHERE task_id = ?"
      ).get(task.task_id) as { attempt_no: number }).attempt_no;
      const attemptId = generateId("attempt");
      const token = generateAuthorityToken();
      const expiresAt = now + input.lease_seconds * 1000;
      this.database.prepare(
        `INSERT INTO task_attempts
           (id, task_id, attempt_no, actor, token_hash, state, revision, claimed_at_ms, expires_at_ms)
         VALUES (?, ?, ?, ?, ?, 'active', 1, ?, ?)`
      ).run(attemptId, task.task_id, attemptNo, input.agent, hashAuthorityToken(token), now, expiresAt);
      const taskRevision = task.revision + 1;
      const boardRevision = board.revision + 1;
      this.updateTaskAuthority(task, taskRevision, "in_progress", attemptId, null, now, boardRevision);
      this.updateBoardRevision(board, boardRevision, now);
      this.appendBoardEvent(board.board_id, boardRevision, 0, "task_claimed", input.agent, keyHash, {
        attempt_no: attemptNo,
        lease_expires_at: new Date(expiresAt).toISOString(),
      }, now, task.task_id, taskRevision, attemptId);
      const response: DirectClaimResult = {
        ok: true,
        replayed: false,
        board_id: board.board_id,
        board_revision: boardRevision,
        task_id: task.task_id,
        task_revision: taskRevision,
        attempt_id: attemptId,
        attempt_no: attemptNo,
        claim_token: token,
        lease_expires_at: new Date(expiresAt).toISOString(),
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "attempt", resourceId: attemptId,
        resultingRevision: taskRevision, createdAtMs: now,
      });
      return response;
    });
  }

  heartbeatDirectTask(input: DirectHeartbeatInput): DirectHeartbeatResult {
    this.validateContext(input);
    this.validateExpectedRevision(input.expected_revision, "Expected revision");
    this.validateLeaseSeconds(input.extend_seconds);
    const scope = ["tb_heartbeat", input.task_id, input.attempt_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined, claim_token: hashAuthorityToken(input.claim_token) }));
    return this.runMutation(() => {
      const replay = this.readReplay<DirectHeartbeatResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const task = this.requireDirectTask(input.task_id);
      if (task.revision !== input.expected_revision) this.stale("task", task.revision);
      const attempt = this.requireAttemptAuthority(task, input.attempt_id, input.actor, input.claim_token);
      const now = this.effectiveNow();
      if (!hasHeartbeatAuthority({ expiresAtMs: attempt.expires_at_ms, nowMs: now })) {
        this.authorityDenied("Attempt lease has expired", "attempt_expired");
      }
      const expiresAt = Math.min(
        Math.max(attempt.expires_at_ms, now) + input.extend_seconds * 1000,
        now + 3_600_000
      );
      this.database.prepare(
        "UPDATE task_attempts SET revision = revision + 1, expires_at_ms = ? WHERE id = ? AND revision = ? AND state = 'active'"
      ).run(expiresAt, attempt.id, attempt.revision);
      const board = this.requireDirectBoard(task.board_id);
      const taskRevision = task.revision + 1;
      const boardRevision = board.revision + 1;
      this.updateTaskAuthority(task, taskRevision, task.status, attempt.id, task.blocked_reason, now, boardRevision);
      this.updateBoardRevision(board, boardRevision, now);
      this.appendBoardEvent(board.board_id, boardRevision, 0, "attempt_heartbeat", input.actor, keyHash, {
        lease_expires_at: new Date(expiresAt).toISOString(),
      }, now, task.task_id, taskRevision, attempt.id);
      const response: DirectHeartbeatResult = {
        ok: true, replayed: false, board_id: board.board_id, board_revision: boardRevision,
        task_id: task.task_id, task_revision: taskRevision, attempt_id: attempt.id,
        lease_expires_at: new Date(expiresAt).toISOString(),
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "attempt", resourceId: attempt.id,
        resultingRevision: taskRevision, createdAtMs: now,
      });
      return response;
    });
  }

  recoverDirectClaims(input: DirectRecoverClaimsInput): DirectRecoverClaimsResult {
    this.validateContext(input);
    this.validateExpectedRevision(input.expected_board_revision, "Expected board revision");
    const limit = input.limit ?? 100;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new TaskConflictError("Recovery limit must be between 1 and 100", "validation");
    const scope = ["tb_recover_claims", input.board_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined }));
    return this.runMutation(() => {
      const replay = this.readReplay<DirectRecoverClaimsResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const board = this.requireDirectBoard(input.board_id);
      if (board.revision !== input.expected_board_revision) this.stale("board", board.revision);
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "recover",
        resource: { kind: "board", boardId: board.board_id },
        nowMs: now,
        expectedRevision: input.expected_board_revision,
        capability: input.capability,
      });
      this.requireAllowedDecision(decision);
      const requested = input.attempt_ids ?? [];
      const attempts = (requested.length > 0
        ? this.database.prepare(
            `SELECT a.* FROM task_attempts a JOIN direct_tasks t ON t.task_id = a.task_id
             WHERE t.board_id = ? AND a.id IN (${requested.map(() => "?").join(",")}) ORDER BY a.attempt_no LIMIT ?`
          ).all(board.board_id, ...requested, limit)
        : this.database.prepare(
            `SELECT a.* FROM task_attempts a JOIN direct_tasks t ON t.task_id = a.task_id
             WHERE t.board_id = ? AND a.state = 'active' ORDER BY a.expires_at_ms, a.id LIMIT ?`
          ).all(board.board_id, limit)) as TaskAttemptRow[];
      if (requested.length > 0 && attempts.length !== new Set(requested).size) {
        throw new TaskConflictError("Recovery attempt is not active on this board", "state", "attempt_not_recoverable");
      }
      for (const attempt of attempts) {
        if (attempt.state !== "active" || !mayRecover({ expiresAtMs: attempt.expires_at_ms, nowMs: now })) {
          throw new TaskConflictError("Attempt recovery is premature", "lease", "recovery_premature");
        }
      }
      if (attempts.length === 0) throw new TaskConflictError("No expired attempts are recoverable", "lease", "recovery_premature");
      const boardRevision = board.revision + 1;
      const recovered: DirectRecoverClaimsResult["recovered"] = [];
      const reblocked = new Set<string>();
      attempts.forEach((attempt, index) => {
        const task = this.requireDirectTask(attempt.task_id);
        this.database.prepare(
          `UPDATE task_attempts SET state = 'expired', revision = revision + 1, closed_at_ms = ?, reason = 'lease_expired'
           WHERE id = ? AND state = 'active' AND revision = ?`
        ).run(now, attempt.id, attempt.revision);
        const taskRevision = task.revision + 1;
        this.updateTaskAuthority(task, taskRevision, "blocked", null, "requeue_required", now, boardRevision);
        this.appendBoardEvent(board.board_id, boardRevision, index, "attempt_recovered", input.actor, keyHash, {
          classification: "expired",
          reason: "lease_expired",
        }, now, task.task_id, taskRevision, attempt.id);
        recovered.push({ task_id: task.task_id, attempt_id: attempt.id, classification: "expired" });
        this.reconcileDependents(task.task_id, now, boardRevision).reblocked.forEach((taskId) => reblocked.add(taskId));
      });
      this.updateBoardRevision(board, boardRevision, now);
      this.appendReadinessEvents(board.board_id, boardRevision, recovered.length, input.actor, keyHash, [], [...reblocked], now);
      const response: DirectRecoverClaimsResult = {
        ok: true, replayed: false, board_id: board.board_id, board_revision: boardRevision, recovered,
        newly_ready: [], reblocked: [...reblocked].sort(),
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "board", resourceId: board.board_id,
        resultingRevision: boardRevision, createdAtMs: now,
      });
      return response;
    });
  }

  requeueDirectTask(input: DirectRequeueInput): DirectTaskMutationResult {
    this.validateContext(input);
    this.validateExpectedRevision(input.expected_revision, "Expected revision");
    if (!input.reason.trim()) throw new TaskConflictError("Requeue reason is required", "validation");
    const scope = ["tb_requeue", input.task_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined }));
    return this.runMutation(() => {
      const replay = this.readReplay<DirectTaskMutationResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const task = this.requireDirectTask(input.task_id);
      const board = this.requireDirectBoard(task.board_id);
      if (task.revision !== input.expected_revision) this.stale("task", task.revision);
      const recoveryRequeue = task.status === "blocked" && task.blocked_reason === "requeue_required" && !task.current_attempt_id;
      const dependencyReopen = task.status === "done" && !task.current_attempt_id;
      if (!recoveryRequeue && !dependencyReopen) {
        throw new TaskConflictError("Task does not require explicit requeue", "state", "requeue_not_required");
      }
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "recover",
        resource: { kind: "task", boardId: board.board_id, taskId: task.task_id },
        nowMs: now,
        capability: input.capability,
      });
      this.requireAllowedDecision(decision);
      const taskRevision = task.revision + 1;
      const boardRevision = board.revision + 1;
      const reblocked = dependencyReopen
        ? this.reblockDependentsForReopen(task.task_id, input.recover_active_dependents ?? [], now, boardRevision)
        : [];
      const status = this.dependenciesSatisfiedForTask(task.task_id) ? "ready" : "backlog";
      this.updateTaskAuthority(task, taskRevision, status, null, null, now, boardRevision);
      this.updateBoardRevision(board, boardRevision, now);
      this.appendBoardEvent(board.board_id, boardRevision, 0, "task_requeued", input.actor, keyHash, {
        reason: input.reason,
      }, now, task.task_id, taskRevision);
      this.appendReadinessEvents(board.board_id, boardRevision, 1, input.actor, keyHash, [], reblocked, now);
      const response: DirectTaskMutationResult = {
        ok: true, replayed: false, board_id: board.board_id, board_revision: boardRevision,
        task_id: task.task_id, task_revision: taskRevision, status, updated_at: new Date(now).toISOString(),
        newly_ready: status === "ready" ? [task.task_id] : [], reblocked,
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "task", resourceId: task.task_id,
        resultingRevision: taskRevision, createdAtMs: now,
      });
      return response;
    });
  }

  updateDirectTask(input: DirectTaskUpdateInput): DirectTaskMutationResult {
    this.validateContext(input);
    this.validateExpectedRevision(input.expected_revision, "Expected revision");
    if (input.status === undefined && input.notes === undefined && input.evidence_links === undefined) {
      throw new TaskConflictError("A status, note, or evidence mutation is required", "validation");
    }
    if (input.status !== undefined && !TASK_STATUSES.includes(input.status)) {
      throw new TaskConflictError("Invalid task status", "validation");
    }
    const scope = ["tb_update", input.task_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    this.validateEvidenceLinks(input.evidence_links ?? []);
    const digest = requestDigest(this.withoutUndefined({
      ...input,
      idempotency_key: undefined,
      claim_token: input.claim_token ? hashAuthorityToken(input.claim_token) : undefined,
    }));
    return this.runMutation((): DirectTaskMutationResult => {
      const replay = this.readReplay<DirectTaskMutationResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const task = this.requireDirectTask(input.task_id);
      if (task.revision !== input.expected_revision) this.stale("task", task.revision);
      const board = this.requireDirectBoard(task.board_id);
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "update",
        resource: { kind: "task", boardId: board.board_id, taskId: task.task_id },
        attempt: input.attempt_id && input.claim_token
          ? { attemptId: input.attempt_id, claimToken: input.claim_token }
          : undefined,
        nowMs: now,
        capability: input.capability,
      });
      this.requireAllowedDecision(decision);
      const attempt = task.current_attempt_id
        ? this.requireAttemptAuthority(task, input.attempt_id, input.actor, input.claim_token)
        : null;
      if (!task.current_attempt_id && (input.attempt_id || input.claim_token)) {
        throw new TaskConflictError("Attempt authority has been superseded", "authorization", "superseded_authority");
      }
      const status = input.status ?? task.status;
      if (input.status !== undefined && input.status !== task.status && !validTransitions[task.status].includes(input.status)) {
        throw new TaskConflictError(`Invalid task transition from ${task.status} to ${input.status}`, "state", "invalid_transition");
      }
      if (status === task.status && input.notes === undefined && (input.evidence_links?.length ?? 0) === 0) {
        const response: DirectTaskMutationResult = {
          ok: true, replayed: false, board_id: board.board_id, board_revision: board.revision,
          task_id: task.task_id, task_revision: task.revision, status: task.status, newly_ready: [], reblocked: [],
        };
        storeIdempotentResponse(this.database, {
          scope, keyHash, requestDigest: digest, response, resourceType: "task", resourceId: task.task_id,
          resultingRevision: task.revision, createdAtMs: now,
        });
        return response;
      }
      this.requireEffectiveApprovals(task.task_id, status);
      const metadata = JSON.parse(task.metadata_json) as TaskMetadata;
      const timestamp = new Date(now).toISOString();
      if (input.notes) metadata.notes.push({ text: input.notes, timestamp });
      const taskRevision = task.revision + 1;
      const boardRevision = board.revision + 1;
      const evidenceIds = this.attachEvidence(task.task_id, task.current_attempt_id, input.evidence_links ?? [], taskRevision);
      const currentAttemptId = status === "done" ? null : task.current_attempt_id;
      if (status === "done" && attempt) {
        this.database.prepare(
          `UPDATE task_attempts SET state = 'succeeded', revision = revision + 1, closed_at_ms = ?, reason = 'task_completed'
           WHERE id = ? AND state = 'active' AND revision = ?`
        ).run(now, attempt.id, attempt.revision);
      }
      const changed = this.database.prepare(
        `UPDATE direct_tasks SET revision = ?, status = ?, current_attempt_id = ?, blocked_reason = NULL, metadata_json = ?, updated_at_ms = ?
         WHERE task_id = ? AND revision = ?`
      ).run(taskRevision, status, currentAttemptId, JSON.stringify(metadata), now, task.task_id, task.revision);
      if (changed.changes !== 1) this.stale("task", task.revision);
      const readiness = status === "done" ? this.reconcileDependents(task.task_id, now, boardRevision) : { newly_ready: [], reblocked: [] };
      this.updateBoardRevision(board, boardRevision, now);
      this.syncTaskProjection({ ...task, revision: taskRevision, status, current_attempt_id: currentAttemptId, blocked_reason: null, metadata_json: JSON.stringify(metadata), updated_at_ms: now });
      this.appendTaskVersion({
        board_id: board.board_id, task_id: task.task_id, board_revision: boardRevision, task_revision: taskRevision,
        status, current_attempt_id: currentAttemptId, blocked_reason: null,
        metadata_json: JSON.stringify(metadata), created_at_ms: task.created_at_ms, updated_at_ms: now,
      });
      this.appendBoardEvent(board.board_id, boardRevision, 0, "task_updated", input.actor, keyHash, {
        from_status: task.status,
        to_status: status,
        evidence_ids: evidenceIds,
      }, now, task.task_id, taskRevision, attempt?.id);
      this.appendReadinessEvents(
        board.board_id,
        boardRevision,
        1,
        input.actor,
        keyHash,
        readiness.newly_ready,
        readiness.reblocked,
        now
      );
      const response: DirectTaskMutationResult = {
        ok: true, replayed: false, board_id: board.board_id, board_revision: boardRevision,
        task_id: task.task_id, task_revision: taskRevision, status,
        newly_ready: readiness.newly_ready, reblocked: readiness.reblocked,
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "task", resourceId: task.task_id,
        resultingRevision: taskRevision, createdAtMs: now,
      });
      return response;
    });
  }

  approveDirectTask(input: DirectApproveInput): DirectApprovalResult {
    this.validateContext(input);
    this.validateExpectedRevision(input.expected_revision, "Expected revision");
    this.validateEvidenceLinks(input.evidence_links ?? []);
    const assertedProvenance = this.requireApprovalAssertedProvenance(input);
    if (!input.gate_id || !["allow", "deny"].includes(input.decision)) {
      throw new TaskConflictError("Gate and decision are required", "approval", "approval_invalid");
    }
    const scope = ["tb_approve", input.task_id, input.gate_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({ ...input, idempotency_key: undefined }));
    return this.runMutation(() => {
      const replay = this.readReplay<DirectApprovalResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const task = this.requireDirectTask(input.task_id);
      if (task.revision !== input.expected_revision) this.stale("task", task.revision);
      const board = this.requireDirectBoard(task.board_id);
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "approve",
        resource: { kind: "task", boardId: board.board_id, taskId: task.task_id },
        nowMs: now,
        gateId: input.gate_id,
        capability: input.capability,
        approval: {
          kind: assertedProvenance.kind,
          source: assertedProvenance.source,
          assertedActor: assertedProvenance.asserted_actor,
          boundary: assertedProvenance.boundary,
          mode: assertedProvenance.mode,
          approvalRef: {
            provider: assertedProvenance.approval_ref.provider,
            kind: assertedProvenance.approval_ref.kind,
            externalId: assertedProvenance.approval_ref.external_id,
            digest: assertedProvenance.approval_ref.digest,
          },
        },
      });
      this.requireAllowedDecision(decision);
      const taskRevision = task.revision + 1;
      const boardRevision = board.revision + 1;
      const decisionNo = (this.database.prepare(
        "SELECT COALESCE(MAX(decision_no), 0) + 1 AS decision_no FROM approval_decisions WHERE task_id = ? AND gate_id = ?"
      ).get(task.task_id, input.gate_id) as { decision_no: number }).decision_no;
      const decisionId = generateId("decision");
      this.database.prepare(
        `INSERT INTO approval_decisions
           (id, task_id, gate_id, decision_no, decision, actor, reason, board_revision, created_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(decisionId, task.task_id, input.gate_id, decisionNo, input.decision, input.actor, input.reason ?? null, boardRevision, now);
      const evidenceIds = this.attachEvidence(task.task_id, task.current_attempt_id, input.evidence_links ?? [], taskRevision);
      const linkDecision = this.database.prepare(
        "INSERT OR IGNORE INTO approval_decision_evidence (decision_id, evidence_id) VALUES (?, ?)"
      );
      evidenceIds.forEach((evidenceId) => linkDecision.run(decisionId, evidenceId));
      this.updateTaskAuthority(task, taskRevision, task.status, task.current_attempt_id, task.blocked_reason, now, boardRevision);
      this.updateBoardRevision(board, boardRevision, now);
      const decisionEventId = this.appendApprovalDecisionEvent({
        boardId: board.board_id,
        boardRevision,
        actor: input.actor,
        correlationHash: keyHash,
        createdAtMs: now,
        taskId: task.task_id,
        taskRevision,
        attemptId: task.current_attempt_id ?? undefined,
        details: {
          gate_id: input.gate_id,
          decision: input.decision,
          decision_id: decisionId,
           evidence_ids: evidenceIds,
           provenance_kind: "asserted",
           provenance_source: assertedProvenance.source,
         },
      });
      this.insertApprovalAssertedProvenance({
        boardId: board.board_id,
        taskId: task.task_id,
        gateId: input.gate_id,
        decisionEventId,
        provenance: assertedProvenance,
        createdAtMs: now,
      });
      const response: DirectApprovalResult = {
        ok: true,
        replayed: false,
        board_id: board.board_id,
        board_revision: boardRevision,
        task_id: task.task_id,
        task_revision: taskRevision,
        status: task.status,
        newly_ready: [],
        reblocked: [],
        decision_id: decisionId,
        effective_decision: input.decision,
      };
      storeIdempotentResponse(this.database, {
        scope, keyHash, requestDigest: digest, response, resourceType: "approval", resourceId: decisionId,
        resultingRevision: taskRevision, createdAtMs: now,
      });
      return response;
    });
  }

  reconcileAllProjections(): number {
    return this.runMutation(() => {
      const boards = this.database.prepare("SELECT * FROM direct_boards ORDER BY board_id").all() as DirectBoardRow[];
      let reconciled = 0;
      for (const board of boards) {
        this.syncBoardProjection(board);
        const tasks = this.database.prepare("SELECT * FROM direct_tasks WHERE board_id = ? ORDER BY task_id").all(board.board_id) as DirectTaskRow[];
        tasks.forEach((task) => this.syncTaskProjection(task));
        reconciled += 1 + tasks.length;
      }
      return reconciled;
    });
  }

  getBoard(boardId: string): { board: Record<string, unknown>; tasks: Record<string, unknown>[] } {
    const direct = this.database.prepare("SELECT * FROM direct_boards WHERE board_id = ?").get(boardId) as DirectBoardRow | undefined;
    if (!direct) {
      const board = this.database.prepare("SELECT * FROM boards WHERE id = ?").get(boardId) as Record<string, unknown> | undefined;
      if (!board) throw new TaskConflictError(`Board ${boardId} not found`, "state", "board_not_found");
      const tasks = this.database.prepare("SELECT * FROM tasks WHERE board_id = ? ORDER BY created_at, id").all(boardId) as Record<string, unknown>[];
      return { board: { ...board, mode: "legacy" }, tasks };
    }
    const reconcile = this.database.transaction(() => {
      this.syncBoardProjection(direct);
      const rows = this.database.prepare("SELECT * FROM direct_tasks WHERE board_id = ? ORDER BY created_at_ms, task_id").all(boardId) as DirectTaskRow[];
      rows.forEach((row) => this.syncTaskProjection(row));
      const metadata = JSON.parse(direct.metadata_json) as BoardMetadata;
      return {
        board: { id: boardId, ...metadata, change_name: direct.change_name, schema_version: direct.schema_version, revision: direct.revision, mode: "direct-v1" },
        tasks: rows.map((row) => ({
          id: row.task_id,
          board_id: row.board_id,
          ...(JSON.parse(row.metadata_json) as TaskMetadata),
          status: row.status,
          revision: row.revision,
          mode: "direct-v1",
          current_attempt: row.current_attempt_id ? this.attemptSummary(row.current_attempt_id) : null,
        })),
      };
    });
    return reconcile.immediate();
  }

  async readLegacyBoard(boardId: string): Promise<{
    board: Record<string, unknown>;
    tasks: Record<string, unknown>[];
  }> {
    if (this.database.prepare("SELECT 1 FROM direct_boards WHERE board_id = ?").get(boardId)) {
      throw new TaskConflictError("Resource is not available", "authorization", "RESOURCE_NOT_AVAILABLE");
    }
    const board = this.database.prepare("SELECT * FROM boards WHERE id = ?").get(boardId) as
      Record<string, unknown> | undefined;
    if (!board) throw new TaskConflictError("Resource is not available", "authorization", "RESOURCE_NOT_AVAILABLE");
    const tasks = this.database.prepare(
      `SELECT t.* FROM tasks t
        WHERE t.board_id = ?
          AND NOT EXISTS (SELECT 1 FROM direct_tasks d WHERE d.task_id = t.id)
        ORDER BY t.created_at, t.id`
    ).all(boardId) as Record<string, unknown>[];
    return { board: { ...board, mode: "legacy" }, tasks };
  }

  async readLegacyTask(taskId: string): Promise<Record<string, unknown>> {
    if (this.database.prepare("SELECT 1 FROM direct_tasks WHERE task_id = ?").get(taskId)) {
      throw new TaskConflictError("Resource is not available", "authorization", "RESOURCE_NOT_AVAILABLE");
    }
    const task = this.database.prepare("SELECT * FROM tasks WHERE id = ?").get(taskId) as
      Record<string, unknown> | undefined;
    if (!task) throw new TaskConflictError("Resource is not available", "authorization", "RESOURCE_NOT_AVAILABLE");
    return task;
  }

  async listLegacyBoards(project?: string): Promise<Record<string, unknown>[]> {
    const projectClause = project ? "b.project = ? AND" : "";
    return this.database.prepare(
      `SELECT b.* FROM boards b
        WHERE ${projectClause}
          NOT EXISTS (SELECT 1 FROM direct_boards d WHERE d.board_id = b.id)
        ORDER BY b.created_at DESC`
    ).all(...(project ? [project] : [])) as Record<string, unknown>[];
  }

  /**
   * Lists legacy boards plus, when a valid direct-v1 actor context is supplied,
   * the direct-v1 boards that actor owns or holds an active read_board grant on.
   *
   * Ordering guarantees:
   * 1. Candidate board IDs are prefiltered by an owner-or-active-grant
   *    relationship, so the canonical decision is only evaluated for related
   *    boards instead of scanning every board in the database.
   * 2. No protected board payload is read before a canonical allow decision.
   * 3. The time observation, every authorization decision, and every payload
   *    read share one immediate transaction (the same mode revoke uses), so the
   *    listing linearizes with concurrent revoke/grant commits.
   *
   * Unrelated actors, expired or revoked grantees, and callers without the full
   * direct-v1 context never see direct-v1 boards (anti-enumeration is preserved).
   */
  async listBoardsForActor(input: {
    project?: string;
    actor?: string;
    coordination_mode?: "legacy" | "direct-v1";
    api_version?: string;
    schema_version?: string;
    capability?: CapabilityContext;
  }): Promise<Record<string, unknown>[]> {
    const legacyBoards = await this.listLegacyBoards(input.project);
    const directActor = input.coordination_mode === "direct-v1"
      && input.api_version === "1.0.0"
      && input.schema_version === "1.0.0"
      ? input.actor
      : undefined;
    if (!directActor) return legacyBoards;
    const listDirectBoards = this.database.transaction((): Record<string, unknown>[] => {
      const now = this.effectiveNow();
      // ID-only prefilter: owner lineage or an unexpired, non-revoked board
      // read_board grant. This reads no boards payload and is not an authority
      // decision; the canonical authorizeTaskOperation below remains the only
      // allow gate and re-validates grant lineage, expiry, and revocation.
      const candidates = this.database.prepare(
        `SELECT board_id FROM direct_boards
          WHERE json_extract(metadata_json, '$.owner_actor') = ?
          UNION
          SELECT g.board_id FROM task_authority_grants g
           WHERE g.grantee_actor = ? AND g.operation = 'read_board' AND g.resource_kind = 'board'
             AND g.expires_at_ms > ?
             AND NOT EXISTS (SELECT 1 FROM task_authority_revocations r WHERE r.grant_id = g.grant_id)
          ORDER BY board_id`
      ).all(directActor, directActor, now) as Array<{ board_id: string }>;
      const allowed: Record<string, unknown>[] = [];
      for (const candidate of candidates) {
        const decision = this.authority.authorizeTaskOperation(this.database, {
          actor: directActor,
          operation: "read_board",
          resource: { kind: "board", boardId: candidate.board_id },
          nowMs: now,
          capability: input.capability,
        });
        if (!decision.allowed) continue;
        // Protected payload is read only after the canonical allow.
        const row = this.database.prepare(
          `SELECT b.id, b.project, b.name, b.created_at, b.updated_at, d.revision
             FROM boards b JOIN direct_boards d ON d.board_id = b.id
            WHERE b.id = ? ${input.project ? "AND b.project = ?" : ""}`
        ).get(...(input.project ? [candidate.board_id, input.project] : [candidate.board_id])) as
          | {
              id: string;
              project: string;
              name: string;
              created_at: string;
              updated_at: string;
              revision: number;
            }
          | undefined;
        if (row) allowed.push({ ...row, mode: "direct-v1" });
      }
      return allowed.sort((left, right) =>
        String(right.created_at).localeCompare(String(left.created_at))
        || String(left.id).localeCompare(String(right.id)));
    });
    return [...legacyBoards, ...listDirectBoards.immediate()];
  }

  assertLegacyTaskMutationAllowed(taskId: string): void {
    if (this.database.prepare("SELECT 1 FROM direct_tasks WHERE task_id = ?").get(taskId)) {
      throw new TaskConflictError("Legacy mutation cannot modify a direct-v1 task", "compatibility", "legacy_direct_bypass");
    }
  }

  assertLegacyBoardMutationAllowed(boardId: string): void {
    if (this.database.prepare("SELECT 1 FROM direct_boards WHERE board_id = ?").get(boardId)) {
      throw new TaskConflictError("Legacy mutation cannot modify a direct-v1 board", "compatibility", "legacy_direct_bypass");
    }
  }

  private validateContext(input: DirectContext): void {
    this.validateVersions(input);
    if (!input.actor || !input.idempotency_key) throw new TaskConflictError("Actor and idempotency key are required", "validation");
    if (input.capability !== undefined) this.validateTaskAuthorityCapability(input.capability);
  }

  private validateTaskAuthorityCapability(capability: CapabilityContext): void {
    const authorityCapabilities = capability?.negotiated.filter((item) => item.startsWith("task-authority@")) ?? [];
    if (capability?.coordinationMode !== "direct-v1" || capability.apiVersion !== "1.0.0"
        || capability.schemaVersion !== "1.0.0" || authorityCapabilities.length !== 1
        || authorityCapabilities[0] !== "task-authority@1.0.0") {
      throw new TaskConflictError(
        "Exact task-authority@1.0.0 negotiation is required",
        "compatibility",
        "AUTH_CAPABILITY_REQUIRED"
      );
    }
  }

  private validateVersions(input: { coordination_mode: string; api_version: string; schema_version: string }): void {
    if (input.coordination_mode !== "direct-v1" || input.api_version !== "1.0.0" || input.schema_version !== "1.0.0") {
      throw new TaskConflictError("Unsupported direct-v1 mode, API, or schema version", "compatibility", "unsupported_version");
    }
  }

  private validateLeaseSeconds(value: number): void {
    if (!Number.isSafeInteger(value) || value < 15 || value > 3_600) {
      throw new TaskConflictError("Lease seconds must be between 15 and 3600", "validation", "lease_bounds");
    }
  }

  private validateTasks(tasks: DirectTaskCreate[]): void {
    for (const task of tasks) {
      if (!task.title || task.title.length < 3) throw new TaskConflictError("Task title is required", "validation");
      if (task.priority !== undefined && !TASK_PRIORITIES.includes(task.priority)) throw new TaskConflictError("Invalid task priority", "validation");
    }
  }

  private validateExpectedRevision(value: number, label: string): void {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TaskConflictError(`${label} is required and must be a positive integer`, "cas", "expected_revision_required");
    }
  }

  private readReplay<T>(scope: string, keyHash: string, digest: string): T | null {
    try {
      return readIdempotentResponse<T>(this.database, scope, keyHash, digest);
    } catch (error) {
      throw new TaskConflictError((error as Error).message, "idempotency", "idempotency_conflict");
    }
  }

  private stale(resource: string, currentRevision: number): never {
    throw new TaskConflictError(`Stale ${resource} revision; current revision is ${currentRevision}`, "cas", "stale_revision", currentRevision);
  }

  private requireDirectBoard(boardId: string): DirectBoardRow {
    const board = this.database.prepare("SELECT * FROM direct_boards WHERE board_id = ?").get(boardId) as DirectBoardRow | undefined;
    if (!board) throw new TaskConflictError(`Direct board ${boardId} not found`, "state", "board_not_found");
    return board;
  }

  private requireDirectTask(taskId: string): DirectTaskRow {
    const task = this.database.prepare("SELECT * FROM direct_tasks WHERE task_id = ?").get(taskId) as DirectTaskRow | undefined;
    if (!task) throw new TaskConflictError(`Direct task ${taskId} not found`, "state", "task_not_found");
    return task;
  }

  private requireAttemptAuthority(
    task: DirectTaskRow,
    attemptId: string | undefined,
    actor: string,
    token: string | undefined
  ): TaskAttemptRow {
    if (!attemptId || !token || task.current_attempt_id !== attemptId) {
      this.authorityDenied("Attempt authority is missing or superseded", "superseded_authority");
    }
    const attempt = this.database.prepare("SELECT * FROM task_attempts WHERE id = ? AND task_id = ?").get(
      attemptId,
      task.task_id
    ) as TaskAttemptRow | undefined;
    if (!attempt || attempt.state !== "active" || attempt.actor !== actor || !authorityTokenMatches(token, attempt.token_hash)) {
      this.authorityDenied("Attempt authority is invalid", "invalid_attempt_authority");
    }
    return attempt;
  }

  private attemptSummary(attemptId: string): Record<string, unknown> | null {
    const attempt = this.database.prepare(
      `SELECT id, attempt_no, actor, state, revision, claimed_at_ms, expires_at_ms, closed_at_ms, reason
       FROM task_attempts WHERE id = ?`
    ).get(attemptId) as Omit<TaskAttemptRow, "task_id" | "token_hash"> | undefined;
    if (!attempt) return null;
    return {
      attempt_id: attempt.id,
      attempt_no: attempt.attempt_no,
      actor: attempt.actor,
      state: attempt.state,
      revision: attempt.revision,
      claimed_at: new Date(attempt.claimed_at_ms).toISOString(),
      lease_expires_at: new Date(attempt.expires_at_ms).toISOString(),
    };
  }

  private authorityDenied(message: string, code: string): never {
    throw new TaskConflictError(message, "authorization", code);
  }

  private requireBoardOwner(board: DirectBoardRow, actor: string): void {
    const metadata = JSON.parse(board.metadata_json) as BoardMetadata;
    if (metadata.owner_actor !== actor) this.authorityDenied("Recovery authority is invalid", "recovery_unauthorized");
  }

  private effectiveNow(): number {
    return observeServerTime(this.database, this.clock);
  }

  private taskMetadata(task: DirectTaskCreate, dependencies: string[]): TaskMetadata {
    return {
      title: task.title,
      description: task.description ?? "",
      priority: task.priority ?? "p2",
      spec_ref: task.spec_ref ?? null,
      acceptance_criteria: task.acceptance_criteria ?? "",
      dependencies,
      notes: [],
      work_unit: task.work_unit ?? null,
      gates: task.gates ?? [],
    };
  }

  private insertApprovalGates(taskId: string, gates: ApprovalGateV1[], revision: number): void {
    const ids = new Set<string>();
    const insert = this.database.prepare(
      "INSERT INTO approval_gates (task_id, gate_id, policy_json, declared_revision) VALUES (?, ?, ?, ?)"
    );
    for (const gate of gates) {
      if (!gate.gate_id || ids.has(gate.gate_id) || gate.required_for.length === 0 || gate.allowed_actors.length === 0 ||
          gate.required_for.some((status) => !TASK_STATUSES.includes(status))) {
        throw new TaskConflictError("Approval gate declaration is invalid", "approval", "approval_gate_invalid");
      }
      ids.add(gate.gate_id);
      insert.run(taskId, gate.gate_id, JSON.stringify(gate), revision);
    }
  }

  private validateEvidenceLinks(evidenceLinks: EvidenceRefV1[]): void {
    if (evidenceLinks.length > 100) throw new TaskConflictError("Evidence reference limit exceeded", "validation", "evidence_limit");
    const allowed = new Set(["provider", "kind", "external_id", "digest"]);
    for (const evidence of evidenceLinks) {
      if (!evidence || Object.keys(evidence).some((key) => !allowed.has(key)) ||
          !evidence.provider || !evidence.kind || !evidence.external_id ||
          !/^sha256:[0-9a-f]{64}$/.test(evidence.digest)) {
        throw new TaskConflictError("Evidence reference is invalid or contains forbidden fields", "validation", "evidence_invalid");
      }
    }
  }

  grantAuthority(input: GrantCommand): GrantResult {
    this.validateDelegationCommand(input.actor, input.idempotencyKey, input.capability);
    if (!input.granteeActor || !this.isTaskOperation(input.operation)) {
      throw new TaskConflictError("Grant intent is invalid", "validation", "AUTH_CONTEXT_REQUIRED");
    }
    return this.runMutation(() => {
      const board = this.requireDirectBoard(input.resource.boardId);
      const digest = this.authorityRequestDigest(input);
      const replay = this.readAuthorityReplay<GrantResult>("grant", board.board_id, input.idempotencyKey, digest);
      if (replay) return { ...replay, replayed: true };
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "grant",
        resource: input.resource,
        capability: input.capability,
        nowMs: now,
        expectedRevision: input.expectedBoardRevision,
        delegation: {
          kind: "grant",
          granteeActor: input.granteeActor,
          operation: input.operation,
          expiresAtMs: input.expiresAtMs,
        },
      });
      this.requireAllowedDecision(decision);
      const parentGrantId = decision.basis.kind === "grant" ? decision.basis.grantId : null;
      const lineageKind = parentGrantId ? "delegated" : "owner_root";
      const boardRevision = board.revision + 1;
      const grantId = generateId("grant");
      const eventId = this.appendAuthorityCommandEvent(
        board, boardRevision, 0, "authority_granted", input.actor, input.resource,
        hashIdempotencyKey(input.idempotencyKey), { grant_id: grantId, grantee_actor: input.granteeActor, operation: input.operation }, now
      );
      this.database.prepare(
         `INSERT INTO task_authority_grants
           (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation, granted_by_actor,
             expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id, parent_grant_id, lineage_kind)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'grant', NULL, ?, ?, ?, ?)`
      ).run(
        grantId, board.board_id, input.resource.kind, this.resourceId(input.resource), input.granteeActor,
        input.operation, input.actor, input.expiresAtMs, now, eventId, parentGrantId, lineageKind
      );
      this.updateBoardRevision(board, boardRevision, now);
      const response: GrantResult = { value: { grantId }, boardRevision, eventId, replayed: false };
      this.storeAuthorityReplay("grant", board.board_id, input.idempotencyKey, digest, "grant", grantId, response, now);
      return response;
    });
  }

  handoffAuthority(input: HandoffCommand): HandoffResult {
    this.validateDelegationCommand(input.actor, input.idempotencyKey, input.capability);
    this.validateAuthorityReferences(input.refs);
    if (!input.toActor || input.operations.length === 0 || new Set(input.operations).size !== input.operations.length
        || input.operations.some((operation) => !this.isTaskOperation(operation))) {
      throw new TaskConflictError("Handoff intent is invalid", "validation", "AUTH_CONTEXT_REQUIRED");
    }
    return this.runMutation(() => {
      const board = this.requireDirectBoard(input.resource.boardId);
      const digest = this.authorityRequestDigest(input);
      const replay = this.readAuthorityReplay<HandoffResult>("handoff", board.board_id, input.idempotencyKey, digest);
      if (replay) return { ...replay, replayed: true };
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "handoff",
        resource: input.resource,
        capability: input.capability,
        nowMs: now,
        expectedRevision: input.expectedBoardRevision,
        delegation: {
          kind: "handoff",
          toActor: input.toActor,
          operations: input.operations,
          expiresAtMs: input.expiresAtMs,
          refs: input.refs,
        },
      });
      this.requireAllowedDecision(decision);
      const boardRevision = board.revision + 1;
      const handoffId = generateId("handoff");
      const correlation = hashIdempotencyKey(input.idempotencyKey);
      const eventId = this.appendAuthorityCommandEvent(
        board, boardRevision, 0, "authority_handoff", input.actor, input.resource, correlation,
        { handoff_id: handoffId, to_actor: input.toActor, operations: input.operations }, now
      );
      this.database.prepare(
        `INSERT INTO task_authority_handoffs
           (handoff_id, board_id, from_actor, to_actor, resource_kind, resource_id, expires_at_ms, created_at_ms, created_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        handoffId, board.board_id, input.actor, input.toActor, input.resource.kind,
        this.resourceId(input.resource), input.expiresAtMs, now, eventId
      );
      const insertRef = this.database.prepare(
        `INSERT INTO task_authority_handoff_refs
           (handoff_id, ordinal, provider, kind, external_id, digest) VALUES (?, ?, ?, ?, ?, ?)`
      );
      input.refs.forEach((ref, ordinal) => insertRef.run(handoffId, ordinal, ref.provider, ref.kind, ref.externalId, ref.digest));
      const grantIds = input.operations.map((operation, index) => {
        const parentGrantId = decision.basis.kind === "owner" ? null
          : this.authority.activeDelegationParent(this.database, {
              actor: input.actor, resource: input.resource, nowMs: now,
            }, operation)?.grantId ?? null;
        if (decision.basis.kind !== "owner" && !parentGrantId) {
          throw new TaskConflictError("Delegation parent is no longer authoritative", "authorization", "AUTH_SCOPE_MISMATCH");
        }
        const lineageKind = parentGrantId ? "delegated" : "owner_root";
        const grantId = generateId("grant");
        const grantEventId = this.appendAuthorityCommandEvent(
          board, boardRevision, index + 1, "authority_handoff_grant", input.actor, input.resource,
          correlation, { handoff_id: handoffId, grant_id: grantId, grantee_actor: input.toActor, operation }, now
        );
        this.database.prepare(
          `INSERT INTO task_authority_grants
             (grant_id, board_id, resource_kind, resource_id, grantee_actor, operation, granted_by_actor,
               expires_at_ms, origin_kind, origin_id, created_at_ms, created_event_id, parent_grant_id, lineage_kind)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'handoff', ?, ?, ?, ?, ?)`
        ).run(
          grantId, board.board_id, input.resource.kind, this.resourceId(input.resource), input.toActor,
          operation, input.actor, input.expiresAtMs, handoffId, now, grantEventId, parentGrantId, lineageKind
        );
        return grantId;
      });
      this.updateBoardRevision(board, boardRevision, now);
      const response: HandoffResult = { value: { handoffId, grantIds }, boardRevision, eventId, replayed: false };
      this.storeAuthorityReplay("handoff", board.board_id, input.idempotencyKey, digest, "handoff", handoffId, response, now);
      return response;
    });
  }

  revokeAuthority(input: RevokeCommand): RevokeResult {
    this.validateDelegationCommand(input.actor, input.idempotencyKey, input.capability);
    if (!input.grantId) throw new TaskConflictError("Grant id is required", "validation", "AUTH_CONTEXT_REQUIRED");
    return this.runMutation(() => {
      const target = this.database.prepare(
        `SELECT grant_id, board_id, resource_kind, resource_id FROM task_authority_grants WHERE grant_id = ?`
      ).get(input.grantId) as { grant_id: string; board_id: string; resource_kind: "board" | "task"; resource_id: string } | undefined;
      if (!target) throw new TaskConflictError("Grant is not available", "authorization", "RESOURCE_NOT_AVAILABLE");
      const board = this.requireDirectBoard(target.board_id);
      const digest = this.authorityRequestDigest(input);
      const replay = this.readAuthorityReplay<RevokeResult>("revoke", board.board_id, input.idempotencyKey, digest);
      if (replay) return { ...replay, replayed: true };
      const resource = this.parentResource(target);
      const now = this.effectiveNow();
      const decision = this.authority.authorizeTaskOperation(this.database, {
        actor: input.actor,
        operation: "revoke",
        resource,
        capability: input.capability,
        nowMs: now,
        expectedRevision: input.expectedBoardRevision,
        delegation: { kind: "revoke", grantId: input.grantId },
      });
      this.requireAllowedDecision(decision);
      const existing = this.database.prepare(
        "SELECT revoke_id, created_event_id FROM task_authority_revocations WHERE grant_id = ?"
      ).get(input.grantId) as { revoke_id: string; created_event_id: string } | undefined;
      if (existing) {
        const response: RevokeResult = {
          value: { revokeId: existing.revoke_id, grantId: input.grantId },
          boardRevision: board.revision,
          eventId: existing.created_event_id,
          replayed: false,
        };
        this.storeAuthorityReplay("revoke", board.board_id, input.idempotencyKey, digest, "revoke", existing.revoke_id, response, now);
        return response;
      }
      const boardRevision = board.revision + 1;
      const revokeId = generateId("revoke");
      const eventId = this.appendAuthorityCommandEvent(
        board, boardRevision, 0, "authority_revoked", input.actor, resource,
        hashIdempotencyKey(input.idempotencyKey), { revoke_id: revokeId, grant_id: input.grantId, reason: input.reason ?? null }, now
      );
      this.database.prepare(
        `INSERT INTO task_authority_revocations
           (revoke_id, grant_id, board_id, revoked_by_actor, reason, created_at_ms, created_event_id)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(revokeId, input.grantId, board.board_id, input.actor, input.reason ?? null, now, eventId);
      this.updateBoardRevision(board, boardRevision, now);
      const response: RevokeResult = { value: { revokeId, grantId: input.grantId }, boardRevision, eventId, replayed: false };
      this.storeAuthorityReplay("revoke", board.board_id, input.idempotencyKey, digest, "revoke", revokeId, response, now);
      return response;
    });
  }

  private requireApprovalAssertedProvenance(input: DirectApproveInput): ResolvedApprovalAssertedProvenance {
    if (input.asserted_provenance && (input.evidence_links?.length ?? 0) > 0) {
      throw new TaskConflictError(
        "Approval asserted provenance must have exactly one canonical source",
        "approval",
        "AUTH_PROVENANCE_REQUIRED"
      );
    }
    const provenance: ResolvedApprovalAssertedProvenance | undefined = input.asserted_provenance
      ? { ...input.asserted_provenance, source: input.asserted_provenance.source ?? "explicit" }
      : this.approvalProvenanceFromEvidence(input);
    const allowed = new Set(["kind", "source", "asserted_actor", "boundary", "mode", "approval_ref"]);
    const reference = provenance?.approval_ref;
    const allowedReference = new Set(["provider", "kind", "external_id", "digest"]);
    if (!provenance || Object.keys(provenance).some((key) => !allowed.has(key)) ||
        provenance.kind !== "asserted" ||
        !["explicit", "evidence-link-derived"].includes(provenance.source) ||
        provenance.asserted_actor !== input.actor ||
        provenance.boundary !== "local-trusted-client" || provenance.mode !== "direct-v1" ||
        !reference || Object.keys(reference).some((key) => !allowedReference.has(key)) ||
        !reference.provider || !reference.kind || !reference.external_id ||
        !/^sha256:[0-9a-f]{64}$/.test(reference.digest)) {
      throw new TaskConflictError(
        "Approval asserted provenance is required and must match the asserted actor",
        "approval",
        "AUTH_PROVENANCE_REQUIRED"
      );
    }
    return provenance;
  }

  private approvalProvenanceFromEvidence(input: DirectApproveInput): ResolvedApprovalAssertedProvenance | undefined {
    if (input.asserted_provenance || input.evidence_links?.length !== 1) return undefined;
    return {
      kind: "asserted",
      source: "evidence-link-derived",
      asserted_actor: input.actor,
      boundary: "local-trusted-client",
      mode: "direct-v1",
      approval_ref: input.evidence_links[0],
    };
  }

  private appendApprovalDecisionEvent(input: {
    boardId: string;
    boardRevision: number;
    actor: string;
    correlationHash: string;
    details: Record<string, unknown>;
    createdAtMs: number;
    taskId: string;
    taskRevision: number;
    attemptId?: string;
  }): string {
    const eventId = generateId("event");
    this.database.prepare(
      `INSERT INTO authority_events
          (event_id, resource_type, resource_id, board_id, board_revision, resource_revision, event_ordinal,
           event_type, actor, attempt_id, outcome, correlation_hash, details_json, created_at_ms)
        VALUES (?, 'task', ?, ?, ?, ?, 0, 'approval_decided', ?, ?, 'success', ?, ?, ?)`
    ).run(
      eventId, input.taskId, input.boardId, input.boardRevision, input.taskRevision, input.actor,
      input.attemptId ?? null, input.correlationHash, JSON.stringify(input.details), input.createdAtMs
    );
    return eventId;
  }

  private insertApprovalAssertedProvenance(input: {
    boardId: string;
    taskId: string;
    gateId: string;
    decisionEventId: string;
    provenance: ResolvedApprovalAssertedProvenance;
    createdAtMs: number;
  }): void {
    const reference = input.provenance.approval_ref;
    this.database.prepare(
      `INSERT INTO task_approval_provenance
         (board_id, task_id, gate_id, decision_event_id, asserted_actor, boundary, mode,
          ref_provider, ref_kind, ref_external_id, ref_digest, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      input.boardId, input.taskId, input.gateId, input.decisionEventId,
      input.provenance.asserted_actor, input.provenance.boundary, input.provenance.mode,
      reference.provider, reference.kind, reference.external_id, reference.digest, input.createdAtMs
    );
  }

  private validateDelegationCommand(actor: string, idempotencyKey: string, capability: CapabilityContext): void {
    if (!actor || !idempotencyKey) {
      throw new TaskConflictError("Actor and idempotency key are required", "validation", "AUTH_CONTEXT_REQUIRED");
    }
    this.validateTaskAuthorityCapability(capability);
  }

  private validateAuthorityReferences(refs: AuthorityReference[]): void {
    if (refs.length === 0 || refs.length > 100 || refs.some((ref) =>
      !["forgespec", "cortex"].includes(ref.provider) || !ref.kind || !ref.externalId
      || !/^sha256:[0-9a-f]{64}$/.test(ref.digest)
    )) throw new TaskConflictError("Handoff references are invalid", "validation", "AUTH_CONTEXT_REQUIRED");
  }

  private isTaskOperation(operation: unknown): operation is TaskOperation {
    return typeof operation === "string" && [
      "read_board", "read_task", "add", "update", "approve", "recover", "grant", "handoff", "revoke",
    ].includes(operation);
  }

  private requireAllowedDecision(
    decision: ReturnType<TaskAuthorityService["authorizeTaskOperation"]>
  ): asserts decision is Extract<ReturnType<TaskAuthorityService["authorizeTaskOperation"]>, { allowed: true }> {
    if (!decision.allowed) {
      throw new TaskConflictError("Task authority: authorization denied the operation", "authorization", decision.code);
    }
  }

  private authorityRequestDigest(input: GrantCommand | HandoffCommand | RevokeCommand): string {
    return requestDigest(this.withoutUndefined({ ...input, idempotencyKey: undefined }));
  }

  private readAuthorityReplay<T>(
    commandKind: "grant" | "handoff" | "revoke",
    boardId: string,
    idempotencyKey: string,
    digest: string
  ): T | null {
    const keyHash = hashIdempotencyKey(idempotencyKey);
    const row = this.database.prepare(
      `SELECT request_hash, canonical_response_json FROM task_authority_idempotency
       WHERE command_kind = ? AND board_id = ?
         AND (idempotency_key_hash = ? OR (idempotency_key_hash IS NULL AND idempotency_key = ?))
       ORDER BY idempotency_key_hash IS NOT NULL DESC LIMIT 1`
    ).get(commandKind, boardId, keyHash, idempotencyKey) as { request_hash: string; canonical_response_json: string } | undefined;
    if (!row) return null;
    if (row.request_hash !== digest) {
      throw new TaskConflictError("Idempotency key was reused with a different payload", "idempotency", "AUTH_IDEMPOTENCY_CONFLICT");
    }
    return JSON.parse(row.canonical_response_json) as T;
  }

  private storeAuthorityReplay<T>(
    commandKind: "grant" | "handoff" | "revoke",
    boardId: string,
    idempotencyKey: string,
    digest: string,
    resultKind: string,
    resultId: string,
    response: T,
    now: number
  ): void {
    const keyHash = hashIdempotencyKey(idempotencyKey);
    this.database.prepare(
      `INSERT INTO task_authority_idempotency
         (command_kind, board_id, idempotency_key, idempotency_key_hash, request_hash,
          result_kind, result_id, canonical_response_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(commandKind, boardId, keyHash, keyHash, digest, resultKind, resultId, JSON.stringify(response), now);
  }

  private resourceId(resource: Exclude<ResourceRef, { kind: "grant" }>): string {
    return resource.kind === "board" ? resource.boardId : resource.taskId;
  }

  private parentResource(target: {
    board_id: string;
    resource_kind: "board" | "task";
    resource_id: string;
  }): Exclude<ResourceRef, { kind: "grant" }> {
    return target.resource_kind === "board"
      ? { kind: "board", boardId: target.board_id }
      : { kind: "task", boardId: target.board_id, taskId: target.resource_id };
  }

  private appendAuthorityCommandEvent(
    board: DirectBoardRow,
    boardRevision: number,
    ordinal: number,
    eventType: string,
    actor: string,
    resource: Exclude<ResourceRef, { kind: "grant" }>,
    correlationHash: string,
    details: Record<string, unknown>,
    now: number
  ): string {
    const eventId = generateId("event");
    this.database.prepare(
      `INSERT INTO authority_events
         (event_id, resource_type, resource_id, board_id, board_revision, resource_revision, event_ordinal,
          event_type, actor, attempt_id, outcome, correlation_hash, details_json, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, 'success', ?, ?, ?)`
    ).run(
      eventId, resource.kind, this.resourceId(resource), board.board_id, boardRevision, boardRevision,
      ordinal, eventType, actor, correlationHash, JSON.stringify(details), now
    );
    return eventId;
  }

  private attachEvidence(
    taskId: string,
    attemptId: string | null,
    evidenceLinks: EvidenceRefV1[],
    revision: number
  ): string[] {
    const evidenceIds: string[] = [];
    for (const evidence of evidenceLinks) {
      const existing = this.database.prepare(
        "SELECT id, digest FROM evidence_objects WHERE provider = ? AND kind = ? AND external_id = ?"
      ).get(evidence.provider, evidence.kind, evidence.external_id) as { id: string; digest: string } | undefined;
      if (existing && existing.digest !== evidence.digest) {
        throw new TaskConflictError("Evidence identity has a conflicting immutable digest", "validation", "evidence_digest_conflict");
      }
      const evidenceId = existing?.id ?? generateId("evidence");
      if (!existing) {
        this.database.prepare(
          "INSERT INTO evidence_objects (id, provider, kind, external_id, digest) VALUES (?, ?, ?, ?, ?)"
        ).run(evidenceId, evidence.provider, evidence.kind, evidence.external_id, evidence.digest);
      }
      this.database.prepare(
        `INSERT OR IGNORE INTO task_evidence_links
           (task_id, attempt_id, evidence_id, attached_revision) VALUES (?, ?, ?, ?)`
      ).run(taskId, attemptId ?? "", evidenceId, revision);
      evidenceIds.push(evidenceId);
    }
    return [...new Set(evidenceIds)];
  }

  private requireEffectiveApprovals(taskId: string, targetStatus: TaskStatus): void {
    const gates = this.database.prepare(
      "SELECT gate_id, policy_json FROM approval_gates WHERE task_id = ? ORDER BY gate_id"
    ).all(taskId) as Array<{ gate_id: string; policy_json: string }>;
    for (const gate of gates) {
      const policy = JSON.parse(gate.policy_json) as ApprovalGateV1;
      if (!policy.required_for.includes(targetStatus)) continue;
      const decision = this.database.prepare(
        `SELECT decision FROM approval_decisions
         WHERE task_id = ? AND gate_id = ? ORDER BY decision_no DESC LIMIT 1`
      ).get(taskId, gate.gate_id) as { decision: "allow" | "deny" } | undefined;
      if (decision?.decision !== "allow") {
        throw new TaskConflictError("Required approval gate is not allowed", "approval", "approval_required");
      }
    }
  }

  private validateDependencyBatch(boardId: string, taskId: string, dependencyTaskIds: string[]): void {
    if (new Set(dependencyTaskIds).size !== dependencyTaskIds.length) {
      throw new TaskConflictError("Duplicate dependency edge", "dependency", "duplicate_dependency");
    }
    for (const dependencyTaskId of dependencyTaskIds) {
      if (dependencyTaskId === taskId) throw new TaskConflictError("Task cannot depend on itself", "dependency", "self_dependency");
      const dependency = this.database.prepare("SELECT board_id FROM direct_tasks WHERE task_id = ?").get(dependencyTaskId) as { board_id: string } | undefined;
      if (!dependency) throw new TaskConflictError("Dependency task does not exist", "dependency", "missing_dependency");
      if (dependency.board_id !== boardId) throw new TaskConflictError("Dependency must be on the same board", "dependency", "cross_board_dependency");
      const cycle = this.database.prepare(
        `WITH RECURSIVE descendants(task_id) AS (
           SELECT task_id FROM task_dependencies WHERE dependency_task_id = ?
           UNION
           SELECT d.task_id FROM task_dependencies d JOIN descendants x ON d.dependency_task_id = x.task_id
         ) SELECT 1 AS found FROM descendants WHERE task_id = ? LIMIT 1`
      ).get(taskId, dependencyTaskId);
      if (cycle) throw new TaskConflictError("Dependency would create a cycle", "dependency", "cyclic_dependency");
    }
  }

  private replaceDependencyEdges(boardId: string, taskId: string, dependencyTaskIds: string[], revision: number): void {
    this.validateDependencyBatch(boardId, taskId, dependencyTaskIds);
    this.database.prepare("DELETE FROM task_dependencies WHERE task_id = ?").run(taskId);
    const insert = this.database.prepare(
      "INSERT INTO task_dependencies (board_id, task_id, dependency_task_id, created_revision) VALUES (?, ?, ?, ?)"
    );
    dependencyTaskIds.forEach((dependencyTaskId) => insert.run(boardId, taskId, dependencyTaskId, revision));
  }

  private dependenciesSatisfied(dependencyTaskIds: string[]): boolean {
    if (dependencyTaskIds.length === 0) return true;
    const row = this.database.prepare(
      `SELECT COUNT(*) AS blockers FROM direct_tasks
       WHERE task_id IN (${dependencyTaskIds.map(() => "?").join(",")}) AND status <> 'done'`
    ).get(...dependencyTaskIds) as { blockers: number };
    return row.blockers === 0;
  }

  private dependenciesSatisfiedForTask(taskId: string): boolean {
    const row = this.database.prepare(
      `SELECT COUNT(*) AS blockers FROM task_dependencies d
       JOIN direct_tasks prerequisite ON prerequisite.task_id = d.dependency_task_id
       WHERE d.task_id = ? AND prerequisite.status <> 'done'`
    ).get(taskId) as { blockers: number };
    return row.blockers === 0;
  }

  private readinessStatus(task: DirectTaskRow, dependencyTaskIds?: string[]): TaskStatus {
    if (task.current_attempt_id) return task.status;
    const satisfied = dependencyTaskIds
      ? this.dependenciesSatisfied(dependencyTaskIds)
      : this.dependenciesSatisfiedForTask(task.task_id);
    return satisfied ? "ready" : "backlog";
  }

  private reconcileDependents(taskId: string, now: number, boardRevision: number): { newly_ready: string[]; reblocked: string[] } {
    const dependents = this.database.prepare(
      `SELECT t.* FROM task_dependencies d JOIN direct_tasks t ON t.task_id = d.task_id
       WHERE d.dependency_task_id = ? ORDER BY t.task_id`
    ).all(taskId) as DirectTaskRow[];
    const newlyReady: string[] = [];
    const reblocked: string[] = [];
    for (const dependent of dependents) {
      if (dependent.current_attempt_id || !["backlog", "ready"].includes(dependent.status)) continue;
      const status = this.readinessStatus(dependent);
      if (status === dependent.status) continue;
      this.updateTaskAuthority(dependent, dependent.revision + 1, status, null, null, now, boardRevision);
      (status === "ready" ? newlyReady : reblocked).push(dependent.task_id);
    }
    return { newly_ready: newlyReady, reblocked };
  }

  private transitiveDependents(taskId: string): DirectTaskRow[] {
    return this.database.prepare(
      `WITH RECURSIVE affected(task_id) AS (
         SELECT task_id FROM task_dependencies WHERE dependency_task_id = ?
         UNION
         SELECT d.task_id FROM task_dependencies d JOIN affected a ON d.dependency_task_id = a.task_id
       ) SELECT t.* FROM affected a JOIN direct_tasks t ON t.task_id = a.task_id ORDER BY t.task_id`
    ).all(taskId) as DirectTaskRow[];
  }

  private reblockDependentsForReopen(
    taskId: string,
    recovery: Array<{ task_id: string; attempt_id: string; claim_token: string }>,
    now: number,
    boardRevision: number
  ): string[] {
    const affected = this.transitiveDependents(taskId);
    const supplied = new Map(recovery.map((item) => [item.task_id, item]));
    for (const dependent of affected) {
      if (!dependent.current_attempt_id) continue;
      const authorization = supplied.get(dependent.task_id);
      const attempt = authorization
        ? this.database.prepare("SELECT * FROM task_attempts WHERE id = ? AND task_id = ?").get(authorization.attempt_id, dependent.task_id) as TaskAttemptRow | undefined
        : undefined;
      if (!authorization || !attempt || attempt.state !== "active" || dependent.current_attempt_id !== attempt.id ||
          !authorityTokenMatches(authorization.claim_token, attempt.token_hash)) {
        throw new TaskConflictError("Active dependent requires authorized recovery", "dependency", "active_dependent_conflict");
      }
    }
    const reblocked: string[] = [];
    for (const dependent of affected) {
      if (dependent.current_attempt_id) {
        const attempt = this.database.prepare("SELECT * FROM task_attempts WHERE id = ?").get(dependent.current_attempt_id) as TaskAttemptRow;
        this.database.prepare(
          `UPDATE task_attempts SET state = 'abandoned', revision = revision + 1, closed_at_ms = ?, reason = 'dependency_reopened'
           WHERE id = ? AND state = 'active' AND revision = ?`
        ).run(now, attempt.id, attempt.revision);
        this.updateTaskAuthority(dependent, dependent.revision + 1, "blocked", null, "requeue_required", now, boardRevision);
        reblocked.push(dependent.task_id);
      } else if (dependent.status === "ready") {
        this.updateTaskAuthority(dependent, dependent.revision + 1, "backlog", null, "dependency_reopened", now, boardRevision);
        reblocked.push(dependent.task_id);
      }
    }
    return reblocked;
  }

  private appendReadinessEvents(
    boardId: string,
    boardRevision: number,
    firstOrdinal: number,
    actor: string,
    correlationHash: string,
    newlyReady: string[],
    reblocked: string[],
    now: number
  ): void {
    const changes = [
      ...newlyReady.map((taskId) => ({ taskId, eventType: "task_became_ready" })),
      ...reblocked.map((taskId) => ({ taskId, eventType: "task_reblocked" })),
    ].sort((left, right) => left.taskId.localeCompare(right.taskId));
    changes.forEach(({ taskId, eventType }, index) => {
      const task = this.requireDirectTask(taskId);
      this.appendBoardEvent(
        boardId,
        boardRevision,
        firstOrdinal + index,
        eventType,
        actor,
        correlationHash,
        {},
        now,
        taskId,
        task.revision,
        task.current_attempt_id ?? undefined
      );
    });
  }

  private insertTaskProjection(
    taskId: string,
    boardId: string,
    metadata: TaskMetadata,
    status: TaskStatus,
    timestamp: string
  ): void {
    this.database.prepare(
      `INSERT INTO tasks
         (id, board_id, title, description, status, priority, spec_ref, acceptance_criteria, dependencies, notes, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      taskId, boardId, metadata.title, metadata.description, status, metadata.priority, metadata.spec_ref,
      metadata.acceptance_criteria, JSON.stringify(metadata.dependencies), JSON.stringify(metadata.notes), timestamp, timestamp
    );
  }

  private updateBoardRevision(board: DirectBoardRow, revision: number, now: number): void {
    const updated = this.database.prepare(
      "UPDATE direct_boards SET revision = ?, updated_at_ms = ? WHERE board_id = ? AND revision = ?"
    ).run(revision, now, board.board_id, board.revision);
    if (updated.changes !== 1) this.stale("board", board.revision);
    this.syncBoardProjection({ ...board, revision, updated_at_ms: now });
  }

  private syncBoardProjection(board: DirectBoardRow): void {
    const metadata = JSON.parse(board.metadata_json) as BoardMetadata;
    this.database.prepare("UPDATE boards SET project = ?, name = ?, updated_at = ? WHERE id = ?")
      .run(metadata.project, metadata.name, new Date(board.updated_at_ms).toISOString(), board.board_id);
  }

  private syncTaskProjection(task: DirectTaskRow): void {
    const metadata = JSON.parse(task.metadata_json) as TaskMetadata;
    this.database.prepare(
      `UPDATE tasks SET title = ?, description = ?, status = ?, priority = ?, spec_ref = ?, acceptance_criteria = ?,
         dependencies = ?, notes = ?, assignee = (SELECT actor FROM task_attempts WHERE id = ?),
         claimed_at = (SELECT datetime(claimed_at_ms / 1000, 'unixepoch') FROM task_attempts WHERE id = ?),
         updated_at = ?, completed_at = CASE WHEN ? = 'done' THEN COALESCE(completed_at, ?) ELSE NULL END
       WHERE id = ?`
    ).run(
      metadata.title, metadata.description, task.status, metadata.priority, metadata.spec_ref, metadata.acceptance_criteria,
      JSON.stringify(metadata.dependencies), JSON.stringify(metadata.notes), task.current_attempt_id, task.current_attempt_id,
      new Date(task.updated_at_ms).toISOString(), task.status,
      new Date(task.updated_at_ms).toISOString(), task.task_id
    );
  }

  private updateTaskAuthority(
    task: DirectTaskRow,
    revision: number,
    status: TaskStatus,
    currentAttemptId: string | null,
    blockedReason: string | null,
    now: number,
    boardRevision?: number
  ): void {
    const changed = this.database.prepare(
      `UPDATE direct_tasks
       SET revision = ?, status = ?, current_attempt_id = ?, blocked_reason = ?, updated_at_ms = ?
       WHERE task_id = ? AND revision = ?`
    ).run(revision, status, currentAttemptId, blockedReason, now, task.task_id, task.revision);
    if (changed.changes !== 1) this.stale("task", task.revision);
    this.syncTaskProjection({
      ...task,
      revision,
      status,
      current_attempt_id: currentAttemptId,
      blocked_reason: blockedReason,
      updated_at_ms: now,
    });
    if (boardRevision !== undefined) {
      this.appendTaskVersion({
        board_id: task.board_id, task_id: task.task_id, board_revision: boardRevision, task_revision: revision,
        status, current_attempt_id: currentAttemptId, blocked_reason: blockedReason,
        metadata_json: task.metadata_json, created_at_ms: task.created_at_ms, updated_at_ms: now,
      });
    }
  }

  private appendTaskVersion(version: Parameters<typeof appendTaskVersionRow>[1]): void {
    appendTaskVersionRow(this.database, version);
  }

  private appendBoardEvent(
    boardId: string,
    boardRevision: number,
    ordinal: number,
    eventType: string,
    actor: string,
    correlationHash: string,
    details: Record<string, unknown>,
    createdAtMs: number,
    taskId?: string,
    taskRevision = 1,
    attemptId?: string
  ): void {
    this.database.prepare(
      `INSERT INTO authority_events
          (event_id, resource_type, resource_id, board_id, board_revision, resource_revision, event_ordinal,
           event_type, actor, attempt_id, outcome, correlation_hash, details_json, created_at_ms)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'success', ?, ?, ?)`
    ).run(
      generateId("event"), taskId ? "task" : "board", taskId ?? boardId, boardId, boardRevision,
      taskId ? taskRevision : boardRevision, ordinal, eventType, actor, attemptId ?? null,
      correlationHash, JSON.stringify(details), createdAtMs
    );
  }

  private withoutUndefined<T>(value: T): unknown {
    return JSON.parse(JSON.stringify(value)) as unknown;
  }

  private runMutation<T>(work: () => T): T {
    return this.database.transaction(work).immediate();
  }
}
