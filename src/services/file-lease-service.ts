import type Database from "better-sqlite3";
import { observeServerTime, SystemClock, type Clock } from "../core/clock.js";
import { appendAuthorityEvent } from "../core/events.js";
import {
  normalizeFileScopes,
  scopesOverlap,
  type FileCasePolicy,
  type NormalizedFileScope,
} from "../core/file-scopes.js";
import {
  hashIdempotencyKey,
  readIdempotentResponse,
  requestDigest,
  storeIdempotentResponse,
} from "../core/idempotency.js";
import { authorityTokenMatches, generateAuthorityToken, hashAuthorityToken } from "../core/tokens.js";
import { generateId } from "../utils/id.js";

interface DirectVersions {
  coordination_mode: "direct-v1";
  api_version: string;
  schema_version: string;
}

export interface DirectFileReserveInput extends DirectVersions {
  patterns: string[];
  agent: string;
  ttl_minutes: number;
  workspace_id: string;
  case_policy: FileCasePolicy;
  task_id: string;
  attempt_id: string;
  claim_token: string;
  expected_task_revision: number;
  idempotency_key: string;
}

export interface DirectFileRenewInput extends DirectVersions {
  actor: string;
  lease_id: string;
  lease_token: string;
  task_id: string;
  attempt_id: string;
  claim_token: string;
  expected_revision: number;
  extend_seconds: number;
  idempotency_key: string;
}

export interface DirectFileReleaseInput extends DirectVersions {
  actor: string;
  lease_id: string;
  lease_token: string;
  task_id: string;
  attempt_id: string;
  claim_token: string;
  expected_revision: number;
  idempotency_key: string;
}

export interface DirectFileReserveResult {
  ok: true;
  replayed: boolean;
  lease_id: string;
  lease_token: string;
  revision: number;
  normalized_scopes: string[];
  expires_at: string;
}

export interface DirectFileRenewResult {
  ok: true;
  replayed: boolean;
  lease_id: string;
  revision: number;
  expires_at: string;
}

export interface DirectFileReleaseResult {
  ok: true;
  replayed: boolean;
  lease_id: string;
  revision: number;
  released_at: string;
}

interface FileLeaseRow {
  id: string;
  workspace_id: string;
  case_policy: FileCasePolicy;
  actor: string;
  task_id: string;
  attempt_id: string;
  token_hash: string;
  revision: number;
  state: "active" | "released" | "expired";
  expires_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
  released_at_ms: number | null;
}

interface AttemptAuthorityRow {
  task_revision: number;
  current_attempt_id: string | null;
  attempt_id: string;
  actor: string;
  token_hash: string;
  state: string;
  expires_at_ms: number;
}

interface StoredScopeRow extends NormalizedFileScope {
  lease_id: string;
  case_policy: FileCasePolicy;
}

export class FileLeaseConflictError extends Error {
  constructor(
    message: string,
    readonly category: "validation" | "authorization" | "cas" | "idempotency" | "lease" | "compatibility" = "lease",
    readonly code = "file_lease_invalid",
    readonly currentRevision?: number
  ) {
    super(message);
    this.name = "FileLeaseConflictError";
  }
}

export class FileLeaseService {
  private readonly clock: Clock;

  constructor(
    private readonly database: Database.Database,
    options: { clock?: Clock; now?: () => number } = {}
  ) {
    this.clock = options.clock ?? (options.now ? { now: options.now } : new SystemClock());
  }

  reserve(input: DirectFileReserveInput): DirectFileReserveResult {
    this.validateVersions(input);
    if (!input.agent || !input.workspace_id || !input.task_id || !input.attempt_id || !input.idempotency_key) {
      throw new FileLeaseConflictError("File lease authority fields are required", "validation");
    }
    if (!Number.isInteger(input.expected_task_revision) || input.expected_task_revision < 1) {
      throw new FileLeaseConflictError("Expected task revision is required", "cas", "expected_revision_required");
    }
    if (!Number.isFinite(input.ttl_minutes) || input.ttl_minutes < 1 || input.ttl_minutes > 60) {
      throw new FileLeaseConflictError("File lease TTL must be between 1 and 60 minutes", "validation", "lease_ttl_invalid");
    }
    let scopes: NormalizedFileScope[];
    try {
      scopes = normalizeFileScopes(input.patterns, input.case_policy);
    } catch (error) {
      throw new FileLeaseConflictError((error as Error).message, "validation", "file_scope_invalid");
    }
    const scope = ["file_reserve", input.workspace_id, input.task_id, input.attempt_id, input.agent].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest(this.withoutUndefined({
      ...input,
      idempotency_key: undefined,
      claim_token: hashAuthorityToken(input.claim_token),
    }));
    return this.runMutation(() => {
      const replay = this.readReplay<DirectFileReserveResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const now = this.effectiveNow();
      this.expireStaleLeases(now);
      this.requireAttemptAuthority(input.task_id, input.attempt_id, input.agent, input.claim_token, input.expected_task_revision, now);
      const active = this.database.prepare(
        `SELECT s.lease_id, s.normalized_scope, s.base_path, s.scope_kind, l.case_policy
           FROM file_lease_scopes s JOIN file_leases l ON l.id = s.lease_id
          WHERE l.workspace_id = ? AND l.state = 'active'`
      ).all(input.workspace_id) as StoredScopeRow[];
      if (active.some((item) => item.case_policy !== input.case_policy)) {
        throw new FileLeaseConflictError("Active workspace leases use another case policy", "lease", "case_policy_conflict");
      }
      if (active.some((existing) => scopes.some((candidate) => scopesOverlap(existing, candidate)))) {
        throw new FileLeaseConflictError("Requested file scope overlaps an active lease", "lease", "scope_overlap");
      }

      const leaseId = generateId("lease");
      const leaseToken = generateAuthorityToken();
      const expiresAt = now + input.ttl_minutes * 60_000;
      this.database.prepare(
        `INSERT INTO file_leases
           (id, workspace_id, case_policy, actor, task_id, attempt_id, token_hash, revision,
            state, expires_at_ms, created_at_ms, updated_at_ms)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, 'active', ?, ?, ?)`
      ).run(
        leaseId, input.workspace_id, input.case_policy, input.agent, input.task_id, input.attempt_id,
        hashAuthorityToken(leaseToken), expiresAt, now, now
      );
      const insertScope = this.database.prepare(
        `INSERT INTO file_lease_scopes (lease_id, normalized_scope, base_path, scope_kind) VALUES (?, ?, ?, ?)`
      );
      for (const item of scopes) insertScope.run(leaseId, item.normalized_scope, item.base_path, item.scope_kind);
      const response: DirectFileReserveResult = {
        ok: true,
        replayed: false,
        lease_id: leaseId,
        lease_token: leaseToken,
        revision: 1,
        normalized_scopes: scopes.map((item) => item.normalized_scope),
        expires_at: new Date(expiresAt).toISOString(),
      };
      this.appendEvent(leaseId, 1, "file_lease_reserved", input.agent, keyHash, {
        workspace_id: input.workspace_id,
        task_id: input.task_id,
        attempt_id: input.attempt_id,
        normalized_scopes: response.normalized_scopes,
        expires_at: response.expires_at,
      }, now);
      this.storeReplay(scope, keyHash, digest, response, leaseId, 1, now);
      return response;
    });
  }

  renew(input: DirectFileRenewInput): DirectFileRenewResult {
    this.validateMutationInput(input);
    if (!Number.isFinite(input.extend_seconds) || input.extend_seconds < 15 || input.extend_seconds > 3600) {
      throw new FileLeaseConflictError("Extension must be between 15 and 3600 seconds", "validation", "lease_extension_invalid");
    }
    const scope = ["file_renew", input.lease_id, input.task_id, input.attempt_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = this.mutationDigest(input);
    return this.runMutation(() => {
      const replay = this.readReplay<DirectFileRenewResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const now = this.effectiveNow();
      this.expireStaleLeases(now);
      const lease = this.requireLeaseAuthority(input, now);
      const expiresAt = Math.min(
        Math.max(lease.expires_at_ms, now) + input.extend_seconds * 1000,
        now + 3_600_000
      );
      const revision = lease.revision + 1;
      const updated = this.database.prepare(
        `UPDATE file_leases SET revision = ?, expires_at_ms = ?, updated_at_ms = ?
          WHERE id = ? AND revision = ? AND state = 'active'`
      ).run(revision, expiresAt, now, lease.id, lease.revision);
      if (updated.changes !== 1) this.stale(lease.revision);
      const response: DirectFileRenewResult = {
        ok: true, replayed: false, lease_id: lease.id, revision, expires_at: new Date(expiresAt).toISOString(),
      };
      this.appendEvent(lease.id, revision, "file_lease_renewed", input.actor, keyHash, {
        expires_at: response.expires_at,
      }, now);
      this.storeReplay(scope, keyHash, digest, response, lease.id, revision, now);
      return response;
    });
  }

  release(input: DirectFileReleaseInput): DirectFileReleaseResult {
    this.validateMutationInput(input);
    const scope = ["file_release", input.lease_id, input.task_id, input.attempt_id, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = this.mutationDigest(input);
    return this.runMutation(() => {
      const replay = this.readReplay<DirectFileReleaseResult>(scope, keyHash, digest);
      if (replay) return { ...replay, replayed: true };
      const now = this.effectiveNow();
      this.expireStaleLeases(now);
      const lease = this.requireLeaseAuthority(input, now);
      const revision = lease.revision + 1;
      const updated = this.database.prepare(
        `UPDATE file_leases SET revision = ?, state = 'released', updated_at_ms = ?, released_at_ms = ?
          WHERE id = ? AND revision = ? AND state = 'active'`
      ).run(revision, now, now, lease.id, lease.revision);
      if (updated.changes !== 1) this.stale(lease.revision);
      const response: DirectFileReleaseResult = {
        ok: true, replayed: false, lease_id: lease.id, revision, released_at: new Date(now).toISOString(),
      };
      this.appendEvent(lease.id, revision, "file_lease_released", input.actor, keyHash, {}, now);
      this.storeReplay(scope, keyHash, digest, response, lease.id, revision, now);
      return response;
    });
  }

  private validateMutationInput(input: DirectFileRenewInput | DirectFileReleaseInput): void {
    this.validateVersions(input);
    if (!input.actor || !input.lease_id || !input.task_id || !input.attempt_id || !input.idempotency_key) {
      throw new FileLeaseConflictError("File lease authority fields are required", "validation");
    }
    if (!Number.isInteger(input.expected_revision) || input.expected_revision < 1) {
      throw new FileLeaseConflictError("Expected lease revision is required", "cas", "expected_revision_required");
    }
  }

  private validateVersions(input: DirectVersions): void {
    if (input.coordination_mode !== "direct-v1" || input.api_version !== "1.0.0" || input.schema_version !== "1.0.0") {
      throw new FileLeaseConflictError("Unsupported direct-v1 file lease version", "compatibility", "unsupported_version");
    }
  }

  private requireLeaseAuthority(
    input: DirectFileRenewInput | DirectFileReleaseInput,
    now: number
  ): FileLeaseRow {
    const lease = this.database.prepare("SELECT * FROM file_leases WHERE id = ?").get(input.lease_id) as FileLeaseRow | undefined;
    if (!lease || lease.state !== "active" || now >= lease.expires_at_ms) {
      this.authorityDenied("File lease is expired or not active");
    }
    if (lease.revision !== input.expected_revision) this.stale(lease.revision);
    if (
      lease.actor !== input.actor
      || lease.task_id !== input.task_id
      || lease.attempt_id !== input.attempt_id
      || !authorityTokenMatches(input.lease_token, lease.token_hash)
    ) this.authorityDenied("File lease authority is invalid");
    this.requireAttemptAuthority(input.task_id, input.attempt_id, input.actor, input.claim_token, undefined, now);
    return lease;
  }

  private requireAttemptAuthority(
    taskId: string,
    attemptId: string,
    actor: string,
    claimToken: string,
    expectedTaskRevision: number | undefined,
    now: number
  ): AttemptAuthorityRow {
    const authority = this.database.prepare(
      `SELECT t.revision AS task_revision, t.current_attempt_id, a.id AS attempt_id, a.actor,
              a.token_hash, a.state, a.expires_at_ms
         FROM direct_tasks t LEFT JOIN task_attempts a ON a.id = ?
        WHERE t.task_id = ?`
    ).get(attemptId, taskId) as AttemptAuthorityRow | undefined;
    if (!authority) this.authorityDenied("Task attempt authority is invalid");
    if (expectedTaskRevision !== undefined && authority.task_revision !== expectedTaskRevision) {
      throw new FileLeaseConflictError("Task revision is stale", "cas", "stale_revision", authority.task_revision);
    }
    if (
      authority.current_attempt_id !== attemptId
      || authority.attempt_id !== attemptId
      || authority.actor !== actor
      || authority.state !== "active"
      || now >= authority.expires_at_ms + 5_000
      || !authorityTokenMatches(claimToken, authority.token_hash)
    ) this.authorityDenied("Task attempt authority is invalid");
    return authority;
  }

  private expireStaleLeases(now: number): void {
    this.database.prepare(
      `UPDATE file_leases SET state = 'expired', revision = revision + 1, updated_at_ms = ?
        WHERE state = 'active' AND expires_at_ms <= ?`
    ).run(now, now);
  }

  private effectiveNow(): number {
    return observeServerTime(this.database, this.clock);
  }

  private mutationDigest(input: DirectFileRenewInput | DirectFileReleaseInput): string {
    return requestDigest(this.withoutUndefined({
      ...input,
      idempotency_key: undefined,
      lease_token: hashAuthorityToken(input.lease_token),
      claim_token: hashAuthorityToken(input.claim_token),
    }));
  }

  private withoutUndefined(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== undefined));
  }

  private readReplay<T>(scope: string, keyHash: string, digest: string): T | null {
    try {
      return readIdempotentResponse<T>(this.database, scope, keyHash, digest);
    } catch {
      throw new FileLeaseConflictError(
        "Idempotency key is bound to a different request",
        "idempotency",
        "idempotency_conflict"
      );
    }
  }

  private storeReplay(
    scope: string,
    keyHash: string,
    digest: string,
    response: unknown,
    leaseId: string,
    revision: number,
    now: number
  ): void {
    storeIdempotentResponse(this.database, {
      scope,
      keyHash,
      requestDigest: digest,
      response,
      resourceType: "file_lease",
      resourceId: leaseId,
      resultingRevision: revision,
      createdAtMs: now,
    });
  }

  private appendEvent(
    leaseId: string,
    revision: number,
    eventType: string,
    actor: string,
    correlationHash: string,
    details: Record<string, unknown>,
    now: number
  ): void {
    appendAuthorityEvent(this.database, {
      resource_type: "file_lease",
      resource_id: leaseId,
      resource_revision: revision,
      event_type: eventType,
      actor,
      outcome: "success",
      correlation_hash: correlationHash,
      details,
      created_at_ms: now,
    });
  }

  private runMutation<T>(operation: () => T): T {
    try {
      return this.database.transaction(operation).immediate();
    } catch (error) {
      if (error instanceof FileLeaseConflictError) throw error;
      const message = error instanceof Error ? error.message : "File lease mutation failed";
      if (/busy|locked/i.test(message)) {
        const busy = new FileLeaseConflictError("File lease database is busy", "lease", "busy");
        (busy as FileLeaseConflictError & { retryable: boolean }).retryable = true;
        throw busy;
      }
      throw error;
    }
  }

  private stale(currentRevision: number): never {
    throw new FileLeaseConflictError("File lease revision is stale", "cas", "stale_revision", currentRevision);
  }

  private authorityDenied(message: string): never {
    throw new FileLeaseConflictError(message, "authorization", "invalid_file_lease_authority");
  }
}
