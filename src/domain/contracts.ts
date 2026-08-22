import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalJson, canonicalSha256 } from "../core/canonical-json.js";
import { executeMutation, TransactionDomainError } from "./transaction.js";
import { hasEffectiveAuthority } from "./authority/service.js";
import { withImmediate } from "../storage/database.js";

export const CONTRACT_PHASES = ["init", "explore", "proposal", "spec", "design", "tasks", "apply", "verify"] as const;
export const CONTRACT_STATUSES = ["success", "partial", "failed", "blocked"] as const;
export type ContractPhase = typeof CONTRACT_PHASES[number];
export type ContractStatus = typeof CONTRACT_STATUSES[number];
export type Contract = { board_id: string; project: string; change_name: string; phase: ContractPhase; status: ContractStatus; confidence: number; executive_summary: string; data: Record<string, unknown> };
export type ContractValidation = { valid: boolean; digest?: `sha256:${string}`; normalized?: Contract; errors: string[] };

const MAX_SUMMARY = 4096, MAX_JSON = 64 * 1024, MAX_TEXT = 256;
const transitions: Record<ContractPhase, readonly ContractPhase[]> = { init: ["explore"], explore: ["proposal"], proposal: ["spec"], spec: ["design"], design: ["tasks"], tasks: ["apply"], apply: ["verify"], verify: [] };
const fail = (message: string): never => { throw new ContractDomainError("REQUEST_INVALID", message); };

export class ContractDomainError extends Error {
  constructor(readonly code: "REQUEST_INVALID" | "RESOURCE_NOT_AVAILABLE" | "AUTH_DENIED" | "CONFLICT" | "IDEMPOTENCY_CONFLICT", message: string = code) { super(message); this.name = "ContractDomainError"; }
}
const text = (v: unknown, max = MAX_TEXT): v is string => typeof v === "string" && v.trim().length > 0 && v.length <= max;

function validatePhaseData(phase: ContractPhase, data: Record<string, unknown>, errors: string[]): void {
  if (phase === "spec") {
    if ("user_stories" in data && !Array.isArray(data.user_stories) && typeof data.user_stories !== "string") {
      errors.push("spec user_stories must be an array or string");
    }
    if ("requirements" in data && !Array.isArray(data.requirements) && typeof data.requirements !== "string") {
      errors.push("spec requirements must be an array or string");
    }
  } else if (phase === "tasks") {
    if ("tasks" in data && !Array.isArray(data.tasks)) {
      errors.push("tasks field in tasks phase must be an array");
    }
  } else if (phase === "design") {
    if ("components" in data && !Array.isArray(data.components) && (typeof data.components !== "object" || data.components === null)) {
      errors.push("design components must be an array or object");
    }
  }
}

export function validateContract(input: unknown): ContractValidation {
  const errors: string[] = [];
  if (!input || typeof input !== "object" || Array.isArray(input)) return { valid: false, errors: ["contract must be an object"] };
  const x = input as Record<string, unknown>;
  for (const key of ["board_id", "project", "change_name"] as const) if (!text(x[key])) errors.push(`${key} is required`);
  if (!CONTRACT_PHASES.includes(x.phase as ContractPhase)) errors.push("phase is invalid");
  if (!CONTRACT_STATUSES.includes(x.status as ContractStatus)) errors.push("status is invalid");
  if (typeof x.confidence !== "number" || !Number.isFinite(x.confidence) || x.confidence < 0 || x.confidence > 1) errors.push("confidence must be between 0 and 1");
  if (!text(x.executive_summary, MAX_SUMMARY)) errors.push("executive_summary is required and bounded");
  if (!x.data || typeof x.data !== "object" || Array.isArray(x.data)) {
    errors.push("data must be a JSON object");
  } else if (CONTRACT_PHASES.includes(x.phase as ContractPhase)) {
    validatePhaseData(x.phase as ContractPhase, x.data as Record<string, unknown>, errors);
  }
  let normalized: Contract | undefined;
  try {
    if (!errors.length) {
      normalized = { board_id: x.board_id as string, project: x.project as string, change_name: x.change_name as string, phase: x.phase as ContractPhase, status: x.status as ContractStatus, confidence: x.confidence as number, executive_summary: x.executive_summary as string, data: x.data as Record<string, unknown> };
      if (Buffer.byteLength(canonicalJson(normalized), "utf8") > MAX_JSON) errors.push("contract JSON is too large");
    }
  } catch { errors.push("contract is not canonical JSON"); }
  if (!errors.length && x.digest !== undefined && (typeof x.digest !== "string" || x.digest !== canonicalSha256(normalized))) errors.push("digest does not match canonical contract");
  return errors.length ? { valid: false, errors } : { valid: true, normalized, digest: canonicalSha256(normalized) , errors };
}

export type CommitInput = { actor: string; idempotency_key: string; expected_board_revision: number; parent_contract_id?: string; contract: unknown };
export type CommitResult = { contract_id: string; revision: number; board_revision: number; digest: `sha256:${string}`; replayed: boolean };

export function commitContract(db: Database.Database, input: CommitInput): CommitResult {
  const checked = validateContract(input.contract); if (!checked.valid || !checked.normalized || !checked.digest) fail(checked.errors.join("; "));
  if (!text(input.actor) || !text(input.idempotency_key) || !Number.isSafeInteger(input.expected_board_revision) || input.expected_board_revision < 1) fail("invalid mutation context");
  const c = checked.normalized!;
  const digest = checked.digest!;
  if (!hasEffectiveAuthority(db, { actor: input.actor, boardId: c.board_id, resourceKind: "board", resourceId: c.board_id, operation: "update", now: Date.now() })) throw new ContractDomainError("RESOURCE_NOT_AVAILABLE");
  const request = { ...input, contract: c, digest };
  try { return executeMutation(db, { actor: input.actor, tool: "contract_commit", idempotencyKey: input.idempotency_key, request, work: (database) => {
    const board = database.prepare("SELECT project, revision FROM fs_boards WHERE id = ?").get(c.board_id) as { project: string; revision: number } | undefined;
    if (!board) throw new ContractDomainError("RESOURCE_NOT_AVAILABLE");
    if (board.project !== c.project || board.revision !== input.expected_board_revision) throw new ContractDomainError("CONFLICT");
    const parent = input.parent_contract_id ? database.prepare("SELECT * FROM fs_contracts WHERE id = ? AND board_id = ?").get(input.parent_contract_id, c.board_id) as any : undefined;
    if (input.parent_contract_id && (!parent || parent.project !== c.project || parent.change_name !== c.change_name || !transitions[parent.phase as ContractPhase]?.includes(c.phase))) throw new ContractDomainError("CONFLICT");
    const revision = parent ? parent.revision + 1 : 1;
    if ((!parent && c.phase !== "init") || (parent && revision !== parent.revision + 1)) throw new ContractDomainError("CONFLICT");
    const id = `contract-${createHash("sha256").update(`${input.actor}\0${input.idempotency_key}\0${checked.digest}`).digest("hex")}`;
    const now = Date.now();
    database.prepare("INSERT INTO fs_contracts (id, board_id, project, parent_contract_id, digest, change_name, planning_json, phase, status, confidence, executive_summary, revision, contract_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)").run(id, c.board_id, c.project, input.parent_contract_id ?? null, digest, c.change_name, canonicalJson(c.data), c.phase, c.status, c.confidence, c.executive_summary, revision, canonicalJson(c), now, now);
    const updated = database.prepare("UPDATE fs_boards SET revision = revision + 1, updated_at = ? WHERE id = ? AND revision = ?").run(now, c.board_id, input.expected_board_revision);
    if (updated.changes !== 1) throw new ContractDomainError("CONFLICT");
    return { contract_id: id, revision, board_revision: input.expected_board_revision + 1, digest, replayed: false };
  }, fromPersisted: (r) => ({ ...r, replayed: true }) }).response; } catch (e) { if (e instanceof TransactionDomainError) throw new ContractDomainError(e.error.code === "IDEMPOTENCY_CONFLICT" ? "IDEMPOTENCY_CONFLICT" : "CONFLICT"); throw e; }
}

export type QueryInput = { actor: string; board_id: string; change_name?: string; phase?: ContractPhase; limit?: number; offset?: number };
export function queryContracts(db: Database.Database, input: QueryInput): { items: Array<Record<string, unknown>>; total_count: number } {
  if (!text(input.actor) || !text(input.board_id) || (input.change_name !== undefined && !text(input.change_name)) || (input.phase !== undefined && !CONTRACT_PHASES.includes(input.phase)) || (input.limit !== undefined && (!Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 100)) || (input.offset !== undefined && (!Number.isSafeInteger(input.offset) || input.offset < 0))) fail("invalid query");
  return withImmediate(db, () => { if (!db.prepare("SELECT 1 FROM fs_boards WHERE id = ?").get(input.board_id) || !hasEffectiveAuthority(db, { actor: input.actor, boardId: input.board_id, resourceKind: "board", resourceId: input.board_id, operation: "read_board", now: Date.now() })) throw new ContractDomainError("RESOURCE_NOT_AVAILABLE");
    const where = ["board_id = ?"], args: Array<string | number> = [input.board_id]; if (input.change_name) { where.push("change_name = ?"); args.push(input.change_name); } if (input.phase) { where.push("phase = ?"); args.push(input.phase); } const total_count = (db.prepare(`SELECT COUNT(*) AS n FROM fs_contracts WHERE ${where.join(" AND ")}`).get(...args) as { n: number }).n; const limit = input.limit ?? 20, offset = input.offset ?? 0; const items = db.prepare(`SELECT id AS contract_id, project, change_name, phase, status, confidence, executive_summary, revision, digest, parent_contract_id, created_at, updated_at FROM fs_contracts WHERE ${where.join(" AND ")} ORDER BY revision, id LIMIT ? OFFSET ?`).all(...args, limit, offset) as Array<Record<string, unknown>>; return { items, total_count }; });
}
