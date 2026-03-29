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
  description: z.string(),
  level: z.enum(["low", "medium", "high", "critical"]),
});

export const ArtifactSchema = z.object({
  topic_key: z.string(),
  type: z.enum(["engram", "openspec", "inline"]),
  path: z.string().optional(),
});

export const SddContractSchema = z.object({
  schema_version: z.string().default("1.0"),
  phase: z.enum(SDD_PHASES),
  change_name: z.string().min(1),
  project: z.string().min(1),
  status: z.enum(["success", "partial", "failed", "blocked"]),
  confidence: z.number().min(0).max(1),
  executive_summary: z.string().min(10),
  artifacts_saved: z.array(ArtifactSchema).default([]),
  next_recommended: z.array(z.enum(SDD_PHASES)).default([]),
  risks: z.array(RiskSchema).default([]),
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
