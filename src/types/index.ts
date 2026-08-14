import { z } from "zod";

// ── SDD Phases ──────────────────────────────────────────
export const SDD_PHASES = [
  "init",
  "explore",
  "propose",
  "spec",
  "design",
  "tasks",
  "apply",
  "verify",
  "archive",
] as const;

export type SddPhase = (typeof SDD_PHASES)[number];

export const PHASE_TRANSITIONS: Record<SddPhase, SddPhase[]> = {
  init: ["explore", "propose"],
  explore: ["propose", "spec"],
  propose: ["spec", "design", "init"],
  spec: ["design", "tasks"],
  design: ["tasks", "spec"],
  tasks: ["apply"],
  apply: ["verify", "tasks"],
  verify: ["archive", "apply"],
  archive: [],
};

export const CONFIDENCE_THRESHOLDS: Record<SddPhase, number> = {
  init: 0.5,
  explore: 0.5,
  propose: 0.7,
  spec: 0.8,
  design: 0.7,
  tasks: 0.8,
  apply: 0.6,
  verify: 0.9,
  archive: 0.9,
};

// ── Contract Schema ─────────────────────────────────────
export const RiskSchema = z.object({
  description: z.string().max(4096),
  level: z.enum(["low", "medium", "high", "critical"]),
}).strict();

export const ArtifactSchema = z.object({
  topic_key: z.string().max(512),
  type: z.enum(["cortex", "openspec", "inline"]),
  path: z.string().max(1024).optional(),
}).strict();

export const SddContractSchema = z.object({
  schema_version: z.string().max(32).default("1.0"),
  phase: z.enum(SDD_PHASES),
  change_name: z.string().min(1).max(256),
  project: z.string().min(1).max(256),
  status: z.enum(["success", "partial", "failed", "blocked"]),
  confidence: z.number().min(0).max(1),
  executive_summary: z.string().min(10).max(65536),
  artifacts_saved: z.array(ArtifactSchema).max(50).default([]),
  next_recommended: z.array(z.enum(SDD_PHASES)).max(9).default([]),
  risks: z.array(RiskSchema).max(50).default([]),
  data: z.record(z.unknown()).default({}),
});

export type SddContract = z.infer<typeof SddContractSchema>;

// ── Task Board Types ────────────────────────────────────
export const TASK_STATUSES = [
  "backlog",
  "ready",
  "in_progress",
  "in_review",
  "done",
  "blocked",
] as const;

export type TaskStatus = (typeof TASK_STATUSES)[number];

export const TASK_PRIORITIES = ["p0", "p1", "p2", "p3"] as const;
export type TaskPriority = (typeof TASK_PRIORITIES)[number];

export interface EvidenceRefV1 {
  provider: string;
  kind: string;
  external_id: string;
  digest: `sha256:${string}`;
}

export interface ApprovalGateV1 {
  gate_id: string;
  required_for: TaskStatus[];
  allowed_actors: string[];
}

export interface Task {
  id: string;
  board_id: string;
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string | null;
  spec_ref: string | null;
  acceptance_criteria: string;
  dependencies: string;
  notes: string;
  created_at: string;
  updated_at: string;
  claimed_at: string | null;
  completed_at: string | null;
}

export interface Board {
  id: string;
  project: string;
  name: string;
  created_at: string;
  updated_at: string;
}

// ── File Reservation Types ──────────────────────────────
export interface FileReservation {
  id: string;
  pattern: string;
  agent: string;
  expires_at: string;
  created_at: string;
}

export interface FileLeaseScope {
  normalized_scope: string;
  base_path: string;
  scope_kind: "exact" | "children" | "tree";
}

export interface FileLease {
  id: string;
  workspace_id: string;
  case_policy: "sensitive" | "insensitive";
  actor: string;
  task_id: string;
  attempt_id: string;
  revision: number;
  state: "active" | "released" | "expired";
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  released_at_ms: number | null;
}

// ── Task Authority Types ────────────────────────────────
export const TASK_OPERATIONS = [
  "read_board",
  "read_task",
  "add",
  "update",
  "approve",
  "recover",
  "grant",
  "handoff",
  "revoke",
] as const;

export type TaskOperation = (typeof TASK_OPERATIONS)[number];

export const AUTHORITY_DENY_CODES = [
  "AUTH_UNKNOWN_OPERATION",
  "AUTH_CONTEXT_REQUIRED",
  "AUTH_ATTEMPT_MISMATCH",
  "AUTH_ATTEMPT_INACTIVE",
  "AUTH_ATTEMPT_EXPIRED",
  "AUTH_OWNER_OR_GRANT_REQUIRED",
  "AUTH_GRANT_INACTIVE",
  "AUTH_SCOPE_MISMATCH",
  "AUTH_ACTOR_NOT_ALLOWED",
  "AUTH_CAPABILITY_REQUIRED",
  "AUTH_PROVENANCE_REQUIRED",
  "AUTH_IDEMPOTENCY_CONFLICT",
  "AUTH_REVISION_CONFLICT",
  "RESOURCE_NOT_AVAILABLE",
  "AUTH_STATE_UNAVAILABLE",
] as const;

export type AuthorityDenyCode = (typeof AUTHORITY_DENY_CODES)[number];

export type ResourceRef =
  | { kind: "board"; boardId: string }
  | { kind: "task"; boardId: string; taskId: string }
  | { kind: "grant"; boardId: string; grantId: string };

export interface AttemptCredential {
  attemptId: string;
  claimToken: string;
}

export interface CapabilityContext {
  coordinationMode: "direct-v1";
  apiVersion: "1.0.0";
  schemaVersion: "1.0.0";
  negotiated: string[];
}

export interface ApprovalAssertedProvenance {
  kind: "asserted";
  source: "explicit" | "evidence-link-derived";
  assertedActor: string;
  boundary: "local-trusted-client";
  mode: "direct-v1";
  approvalRef: {
    provider: string;
    kind: string;
    externalId: string;
    digest: `sha256:${string}`;
  };
}

export type DelegationIntent =
  | {
      kind: "grant";
      granteeActor: string;
      operation: TaskOperation;
      expiresAtMs: number;
    }
  | {
      kind: "handoff";
      toActor: string;
      operations: TaskOperation[];
      expiresAtMs: number;
      refs: Array<{ provider: "forgespec" | "cortex"; kind: string; externalId: string; digest: `sha256:${string}` }>;
    }
  | { kind: "revoke"; grantId: string };

export interface AuthorizeTaskOperationInput {
  actor: string;
  operation: TaskOperation;
  resource: ResourceRef;
  attempt?: AttemptCredential;
  capability?: CapabilityContext;
  nowMs: number;
  expectedRevision?: number;
  gateId?: string;
  approval?: ApprovalAssertedProvenance;
  delegation?: DelegationIntent;
}

export type AuthorityBasis =
  | { kind: "owner" }
  | { kind: "attempt"; attemptId: string; expiresAtMs: number }
  | { kind: "grant"; grantId: string; expiresAtMs: number }
  | { kind: "allowed_actor"; gateId: string };

interface AuthorityDecisionBase {
  decisionId: string;
  operation: TaskOperation;
  resource: ResourceRef;
  actor: string;
  evaluatedAtMs: number;
}

export type AuthorityDecision =
  | (AuthorityDecisionBase & { allowed: true; basis: AuthorityBasis })
  | (AuthorityDecisionBase & { allowed: false; code: AuthorityDenyCode });

export interface AuthorityReference {
  provider: "forgespec" | "cortex";
  kind: string;
  externalId: string;
  digest: `sha256:${string}`;
}

export interface GrantCommand {
  actor: string;
  resource: Exclude<ResourceRef, { kind: "grant" }>;
  granteeActor: string;
  operation: TaskOperation;
  expiresAtMs: number;
  idempotencyKey: string;
  expectedBoardRevision: number;
  capability: CapabilityContext;
}

export interface HandoffCommand {
  actor: string;
  toActor: string;
  resource: Exclude<ResourceRef, { kind: "grant" }>;
  operations: TaskOperation[];
  expiresAtMs: number;
  refs: AuthorityReference[];
  idempotencyKey: string;
  expectedBoardRevision: number;
  capability: CapabilityContext;
}

export interface RevokeCommand {
  actor: string;
  grantId: string;
  reason?: string;
  idempotencyKey: string;
  expectedBoardRevision: number;
  capability: CapabilityContext;
}

export interface CommandResult<T> {
  value: T;
  boardRevision: number;
  eventId: string;
  replayed: boolean;
}
