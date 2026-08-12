import type Database from "better-sqlite3";
import { evaluateAttemptAuthority } from "../core/attempt-authority.js";
import { authorityTokenMatches } from "../core/tokens.js";
import {
  TASK_OPERATIONS,
  type AuthorityBasis,
  type AuthorityDecision,
  type AuthorityDenyCode,
  type AuthorizeTaskOperationInput,
  type ResourceRef,
  type TaskOperation,
} from "../types/index.js";
import { generateId } from "../utils/id.js";

const TASK_AUTHORITY_CAPABILITY = "task-authority@1.0.0";
const ATTEMPT_OPERATIONS = new Set<TaskOperation>(["read_task", "update"]);

interface BoardAuthorityRow {
  revision: number;
  metadata_json: string;
}

interface AttemptAuthorityRow {
  current_attempt_id: string | null;
  id: string;
  actor: string;
  token_hash: string;
  state: string;
  expires_at_ms: number;
}

interface GrantAuthorityRow {
  grant_id: string;
  board_id: string;
  resource_kind: "board" | "task";
  resource_id: string;
  grantee_actor: string;
  operation: TaskOperation;
  granted_by_actor: string;
  expires_at_ms: number;
  parent_grant_id: string | null;
  lineage_kind: "owner_root" | "delegated" | "legacy_unknown";
  revoked: number;
}

type AttemptBasisResult =
  | { allowed: true; basis: Extract<AuthorityBasis, { kind: "attempt" }> }
  | { allowed: false; code: "AUTH_ATTEMPT_MISMATCH" | "AUTH_ATTEMPT_INACTIVE" | "AUTH_ATTEMPT_EXPIRED" };

/**
 * The single decision facade for direct-v1 task operations.
 * Callers supply one transaction handle and one server timestamp, then act only
 * on an allow decision inside that same transaction.
 */
export class TaskAuthorityService {
  constructor(private readonly database: Database.Database) {}

  authorizeTaskOperation(
    tx: Database.Database,
    input: AuthorizeTaskOperationInput
  ): AuthorityDecision {
    const operation = input.operation;
    if (!this.isOperation(operation)) return this.deny(input, "AUTH_UNKNOWN_OPERATION");
    if (!this.hasCompleteContext(input)) return this.deny(input, "AUTH_CONTEXT_REQUIRED");
    if (tx !== this.database) return this.deny(input, "AUTH_STATE_UNAVAILABLE");

    try {
      const board = tx.prepare(
        "SELECT revision, metadata_json FROM direct_boards WHERE board_id = ?"
      ).get(input.resource.boardId) as BoardAuthorityRow | undefined;
      if (!board) return this.deny(input, "RESOURCE_NOT_AVAILABLE");
      if (input.expectedRevision !== undefined && board.revision !== input.expectedRevision) {
        return this.deny(input, "AUTH_REVISION_CONFLICT");
      }
      if (!this.resourceExists(tx, input.resource)) return this.deny(input, "RESOURCE_NOT_AVAILABLE");

      const ownerActor = this.ownerActor(board.metadata_json);
      const ownerBasis: AuthorityBasis | null = ownerActor === input.actor ? { kind: "owner" } : null;

      if (operation === "approve") {
        const approvalDecision = this.validateApproval(tx, input, ownerBasis);
        return approvalDecision.allowed
          ? this.allow(input, approvalDecision.basis)
          : approvalDecision;
      }

      if (operation === "grant" || operation === "handoff" || operation === "revoke") {
        if (!this.hasCapability(input)) return this.deny(input, "AUTH_CAPABILITY_REQUIRED");
        const delegationBasis = this.delegationBasis(tx, input, ownerBasis);
        return delegationBasis
          ? this.allow(input, delegationBasis)
          : this.deny(input, "AUTH_SCOPE_MISMATCH");
      }
      const attemptDecision = this.attemptBasis(tx, input);
      if (attemptDecision && !attemptDecision.allowed && !ownerBasis) return this.deny(input, attemptDecision.code);

      const grantBasis = ownerBasis ? null : this.grantBasis(tx, input);
      const basis = attemptDecision?.allowed ? attemptDecision.basis : ownerBasis ?? grantBasis;
      if (!basis) return this.deny(input, "AUTH_OWNER_OR_GRANT_REQUIRED");
      return this.allow(input, basis);
    } catch {
      return this.deny(input, "AUTH_STATE_UNAVAILABLE");
    }
  }

  /** Resolve the exact durable parent selected by the authority policy. */
  activeDelegationParent(
    tx: Database.Database,
    input: Pick<AuthorizeTaskOperationInput, "actor" | "resource" | "nowMs">,
    operation: TaskOperation
  ): Extract<AuthorityBasis, { kind: "grant" }> | null {
    if (tx !== this.database) return null;
    return this.activeGrantFor(tx, input, operation, input.nowMs)?.basis ?? null;
  }

  private delegationBasis(
    tx: Database.Database,
    input: AuthorizeTaskOperationInput,
    ownerBasis: AuthorityBasis | null
  ): AuthorityBasis | null {
    const intent = input.delegation;
    if (!intent || intent.kind !== input.operation) return null;

    if (intent.kind === "revoke") {
      const target = tx.prepare(
        `SELECT grant_id, board_id, resource_kind, resource_id, granted_by_actor, expires_at_ms
           FROM task_authority_grants WHERE grant_id = ?`
      ).get(intent.grantId) as {
        grant_id: string;
        board_id: string;
        resource_kind: "board" | "task";
        resource_id: string;
        granted_by_actor: string;
        expires_at_ms: number;
      } | undefined;
      if (!target || !this.sameParentResource(input.resource, target)) return null;
      if (ownerBasis) return ownerBasis;
      if (target.granted_by_actor === input.actor) {
        const targetLineage = this.grantById(tx, target.grant_id);
        if (!targetLineage || targetLineage.lineage_kind !== "delegated" || !targetLineage.parent_grant_id) return null;
        const parent = this.grantById(tx, targetLineage.parent_grant_id);
        if (!parent || !this.validParentEdge(targetLineage, parent)
            || parent.grantee_actor !== input.actor || !this.activeLineage(tx, parent, input.nowMs)) return null;
        return { kind: "grant", grantId: parent.grant_id, expiresAtMs: parent.expires_at_ms };
      }
      return this.activeGrantFor(tx, input, "revoke", input.nowMs)?.basis ?? null;
    }

    const expiresAtMs = intent.expiresAtMs;
    const operations = intent.kind === "grant" ? [intent.operation] : intent.operations;
    if (!Number.isSafeInteger(expiresAtMs) || expiresAtMs <= input.nowMs || operations.length === 0
        || new Set(operations).size !== operations.length
        || operations.some((operation) => !this.isOperation(operation))) return null;
    if (intent.kind === "grant" && !intent.granteeActor) return null;
    if (intent.kind === "handoff" && (!intent.toActor || !this.validReferences(intent.refs))) return null;
    if (ownerBasis) return ownerBasis;

    let basis: AuthorityBasis | null = null;
    for (const operation of operations) {
      const parent = this.activeGrantFor(tx, input, operation, input.nowMs);
      if (!parent || expiresAtMs > parent.expiresAtMs) return null;
      basis ??= parent.basis;
    }
    return basis;
  }

  private activeGrantFor(
    tx: Database.Database,
    input: Pick<AuthorizeTaskOperationInput, "actor" | "resource">,
    operation: TaskOperation,
    nowMs: number
  ): { basis: Extract<AuthorityBasis, { kind: "grant" }>; expiresAtMs: number } | null {
    if (input.resource.kind === "grant") return null;
    const resourceId = input.resource.kind === "board" ? input.resource.boardId : input.resource.taskId;
    const rows = tx.prepare(
      `SELECT g.*,
              EXISTS(SELECT 1 FROM task_authority_revocations r WHERE r.grant_id = g.grant_id) AS revoked
         FROM task_authority_grants g
        WHERE g.board_id = ? AND g.resource_kind = ? AND g.resource_id = ?
          AND g.grantee_actor = ? AND g.operation = ?
        ORDER BY g.expires_at_ms DESC, g.grant_id`
    ).all(input.resource.boardId, input.resource.kind, resourceId, input.actor, operation) as GrantAuthorityRow[];
    const row = rows.find((candidate) => this.activeLineage(tx, candidate, nowMs));
    return row ? {
      basis: { kind: "grant", grantId: row.grant_id, expiresAtMs: row.expires_at_ms },
      expiresAtMs: row.expires_at_ms,
    } : null;
  }

  private activeLineage(tx: Database.Database, leaf: GrantAuthorityRow, nowMs: number): boolean {
    const visited = new Set<string>();
    let current: GrantAuthorityRow | undefined = leaf;
    while (current) {
      if (visited.has(current.grant_id) || current.revoked !== 0 || nowMs >= current.expires_at_ms) return false;
      visited.add(current.grant_id);
      if (current.lineage_kind === "legacy_unknown") return false;
      if (current.lineage_kind === "owner_root") {
        return current.parent_grant_id === null && this.grantRootedInOwner(tx, current);
      }
      if (!current.parent_grant_id) return false;
      const parent = this.grantById(tx, current.parent_grant_id);
      if (!parent || !this.validParentEdge(current, parent)) return false;
      current = parent;
    }
    return false;
  }

  private grantById(tx: Database.Database, grantId: string): GrantAuthorityRow | undefined {
    return tx.prepare(
      `SELECT g.*,
              EXISTS(SELECT 1 FROM task_authority_revocations r WHERE r.grant_id = g.grant_id) AS revoked
         FROM task_authority_grants g WHERE g.grant_id = ?`
    ).get(grantId) as GrantAuthorityRow | undefined;
  }

  private validParentEdge(child: GrantAuthorityRow, parent: GrantAuthorityRow): boolean {
    return parent.board_id === child.board_id
      && parent.resource_kind === child.resource_kind
      && parent.resource_id === child.resource_id
      && parent.operation === child.operation
      && parent.grantee_actor === child.granted_by_actor
      && parent.expires_at_ms >= child.expires_at_ms;
  }

  private grantRootedInOwner(tx: Database.Database, grant: GrantAuthorityRow): boolean {
    const board = tx.prepare("SELECT metadata_json FROM direct_boards WHERE board_id = ?")
      .get(grant.board_id) as { metadata_json: string } | undefined;
    return Boolean(board && this.ownerActor(board.metadata_json) === grant.granted_by_actor);
  }

  private sameParentResource(
    resource: ResourceRef,
    target: { board_id: string; resource_kind: "board" | "task"; resource_id: string }
  ): boolean {
    if (resource.kind === "grant" || resource.boardId !== target.board_id || resource.kind !== target.resource_kind) return false;
    return target.resource_id === (resource.kind === "board" ? resource.boardId : resource.taskId);
  }

  private validReferences(refs: Array<{ provider: string; kind: string; externalId: string; digest: string }>): boolean {
    return refs.length > 0 && refs.every((ref) =>
      (ref.provider === "forgespec" || ref.provider === "cortex")
      && Boolean(ref.kind && ref.externalId)
      && /^sha256:[0-9a-f]{64}$/.test(ref.digest)
    );
  }

  private attemptBasis(
    tx: Database.Database,
    input: AuthorizeTaskOperationInput
  ): AttemptBasisResult | null {
    if (!input.attempt || input.resource.kind !== "task" || !ATTEMPT_OPERATIONS.has(input.operation)) return null;
    const row = tx.prepare(
      `SELECT t.current_attempt_id, a.id, a.actor, a.token_hash, a.state, a.expires_at_ms
         FROM direct_tasks t
         LEFT JOIN task_attempts a ON a.id = ?
        WHERE t.task_id = ? AND t.board_id = ?`
    ).get(input.attempt.attemptId, input.resource.taskId, input.resource.boardId) as AttemptAuthorityRow | undefined;
    if (!row || !row.id) return { allowed: false, code: "AUTH_ATTEMPT_MISMATCH" };
    const decision = evaluateAttemptAuthority({
      requestedAttemptId: input.attempt.attemptId,
      activeAttemptId: row.current_attempt_id,
      requestedActor: input.actor,
      attemptActor: row.actor,
      tokenMatches: authorityTokenMatches(input.attempt.claimToken, row.token_hash),
      state: row.state,
      expiresAtMs: row.expires_at_ms,
      nowMs: input.nowMs,
    });
    return decision.allowed
      ? { allowed: true, basis: { kind: "attempt", attemptId: decision.attemptId, expiresAtMs: decision.expiresAtMs } }
      : decision;
  }

  private grantBasis(tx: Database.Database, input: AuthorizeTaskOperationInput): AuthorityBasis | null {
    if (!this.hasCapability(input) || !this.tableExists(tx, "task_authority_grants")) return null;
    return this.activeGrantFor(tx, input, input.operation, input.nowMs)?.basis ?? null;
  }

  private validateApproval(
    tx: Database.Database,
    input: AuthorizeTaskOperationInput,
    ownerBasis: AuthorityBasis | null
  ): { allowed: true; basis: AuthorityBasis } | Extract<AuthorityDecision, { allowed: false }> {
    if (input.resource.kind !== "task" || !input.gateId) return this.deny(input, "AUTH_CONTEXT_REQUIRED");
    const provenance = input.approval;
    if (
      !provenance
      || provenance.kind !== "asserted"
      || provenance.assertedActor !== input.actor
      || provenance.boundary !== "local-trusted-client"
      || provenance.mode !== "direct-v1"
      || !provenance.approvalRef.provider
      || !provenance.approvalRef.kind
      || !provenance.approvalRef.externalId
      || !/^sha256:[0-9a-f]{64}$/.test(provenance.approvalRef.digest)
    ) return this.deny(input, "AUTH_PROVENANCE_REQUIRED");
    const gate = tx.prepare(
      "SELECT policy_json FROM approval_gates WHERE task_id = ? AND gate_id = ?"
    ).get(input.resource.taskId, input.gateId) as { policy_json: string } | undefined;
    if (!gate) return this.deny(input, "AUTH_CONTEXT_REQUIRED");
    const allowedActors = (JSON.parse(gate.policy_json) as { allowed_actors?: unknown }).allowed_actors;
    if (!Array.isArray(allowedActors) || !allowedActors.includes(input.actor)) {
      return this.deny(input, "AUTH_ACTOR_NOT_ALLOWED");
    }
    // Approve is conjunctive: allowed_actors and canonical asserted provenance
    // constrain the decision independently from owner or exact active grant authority.
    // The asserted provenance is audit metadata, not authenticated identity.
    if (ownerBasis) return { allowed: true, basis: ownerBasis };
    if (input.capability) {
      const grantBasis = this.grantBasis(tx, input);
      return grantBasis
        ? { allowed: true, basis: grantBasis }
        : this.deny(input, "AUTH_OWNER_OR_GRANT_REQUIRED");
    }
    if (this.hasRecordedApproveGrant(tx, input)) return this.deny(input, "AUTH_CAPABILITY_REQUIRED");
    return { allowed: true, basis: { kind: "allowed_actor", gateId: input.gateId } };
  }

  private hasRecordedApproveGrant(tx: Database.Database, input: AuthorizeTaskOperationInput): boolean {
    if (input.resource.kind !== "task" || !this.tableExists(tx, "task_authority_grants")) return false;
    return Boolean(tx.prepare(
      `SELECT 1 FROM task_authority_grants
        WHERE board_id = ? AND resource_kind = 'task' AND resource_id = ?
          AND grantee_actor = ? AND operation = 'approve' LIMIT 1`
    ).get(input.resource.boardId, input.resource.taskId, input.actor));
  }

  private resourceExists(tx: Database.Database, resource: ResourceRef): boolean {
    if (resource.kind === "board") return true;
    if (resource.kind === "task") {
      return Boolean(tx.prepare(
        "SELECT 1 FROM direct_tasks WHERE task_id = ? AND board_id = ?"
      ).get(resource.taskId, resource.boardId));
    }
    if (!this.tableExists(tx, "task_authority_grants")) return false;
    return Boolean(tx.prepare(
      "SELECT 1 FROM task_authority_grants WHERE grant_id = ? AND board_id = ?"
    ).get(resource.grantId, resource.boardId));
  }

  private tableExists(tx: Database.Database, table: string): boolean {
    return Boolean(tx.prepare(
      "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?"
    ).get(table));
  }

  private ownerActor(metadataJson: string): string | null {
    const actor = (JSON.parse(metadataJson) as { owner_actor?: unknown }).owner_actor;
    return typeof actor === "string" && actor.length > 0 ? actor : null;
  }

  private hasCapability(input: AuthorizeTaskOperationInput): boolean {
    return input.capability?.coordinationMode === "direct-v1"
      && input.capability.apiVersion === "1.0.0"
      && input.capability.schemaVersion === "1.0.0"
      && input.capability.negotiated.includes(TASK_AUTHORITY_CAPABILITY);
  }

  private hasCompleteContext(input: AuthorizeTaskOperationInput): boolean {
    return Boolean(
      input.actor
      && input.resource
      && input.resource.boardId
      && Number.isSafeInteger(input.nowMs)
      && input.nowMs >= 0
      && (input.resource.kind !== "task" || input.resource.taskId)
      && (input.resource.kind !== "grant" || input.resource.grantId)
      && (!input.attempt || (input.attempt.attemptId && input.attempt.claimToken))
    );
  }

  private isOperation(operation: unknown): operation is TaskOperation {
    return typeof operation === "string" && (TASK_OPERATIONS as readonly string[]).includes(operation);
  }

  private allow(input: AuthorizeTaskOperationInput, basis: AuthorityBasis): Extract<AuthorityDecision, { allowed: true }> {
    return { ...this.decisionBase(input), allowed: true, basis };
  }

  private deny(input: AuthorizeTaskOperationInput, code: AuthorityDenyCode): Extract<AuthorityDecision, { allowed: false }> {
    return { ...this.decisionBase(input), allowed: false, code };
  }

  private decisionBase(input: AuthorizeTaskOperationInput): Omit<AuthorityDecision, "allowed" | "basis" | "code"> {
    return {
      decisionId: generateId("decision"),
      operation: input.operation,
      resource: input.resource,
      actor: input.actor,
      evaluatedAtMs: input.nowMs,
    };
  }
}
