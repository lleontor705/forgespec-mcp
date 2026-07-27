import type Database from "better-sqlite3";
import { canonicalJson, canonicalSha256 } from "../core/canonical-json.js";
import { appendAuthorityEvent, type AuthorityEvent } from "../core/events.js";
import {
  hashIdempotencyKey,
  readIdempotentResponse,
  requestDigest,
  storeIdempotentResponse,
} from "../core/idempotency.js";
import { PHASE_TRANSITIONS, SddContractSchema, type SddContract } from "../types/index.js";
import { generateId } from "../utils/id.js";

export interface DirectContractSaveInput {
  contract: string;
  coordination_mode: "direct-v1";
  api_version: string;
  schema_version: string;
  actor: string;
  idempotency_key: string;
  expected_head_revision: number;
  parent_contract_id?: string;
  submitted_digest?: `sha256:${string}`;
}

export interface DirectContractSaveResult {
  ok: true;
  replayed: boolean;
  contract_id: string;
  revision: number;
  head_revision: number;
  parent_contract_id: string | null;
  contract_digest: `sha256:${string}`;
}

export class ContractConflictError extends Error {
  constructor(
    message: string,
    readonly category: "cas" | "idempotency" | "validation" | "compatibility" | "state" = "validation",
    readonly currentRevision?: number
  ) {
    super(message);
    this.name = "ContractConflictError";
  }
}

interface ContractRevisionRow {
  id: string;
  project: string;
  change_name: string;
  phase: SddContract["phase"];
  revision: number;
  parent_contract_id: string | null;
  contract_json: string;
  digest: `sha256:${string}`;
  actor: string;
  created_at_ms: number;
  head_contract_id: string;
}

export class ContractService {
  private readonly now: () => number;

  constructor(
    private readonly database: Database.Database,
    options: { now?: () => number } = {}
  ) {
    this.now = options.now ?? Date.now;
  }

  saveDirect(input: DirectContractSaveInput): DirectContractSaveResult {
    this.validateDirectContext(input);
    let parsedJson: unknown;
    try {
      parsedJson = JSON.parse(input.contract);
    } catch {
      throw new ContractConflictError("Contract must be valid JSON", "validation");
    }
    const result = SddContractSchema.safeParse(parsedJson);
    if (!result.success) throw new ContractConflictError(`Contract validation failed: ${result.error.message}`, "validation");
    const contract = result.data;
    this.validateContractMajor(contract.schema_version);

    const contractDigest = canonicalSha256(contract);
    if (input.submitted_digest && input.submitted_digest !== contractDigest) {
      throw new ContractConflictError("Submitted digest does not match canonical contract digest", "validation");
    }

    const scope = ["sdd_save", contract.project, contract.change_name, input.actor].join("|");
    const keyHash = hashIdempotencyKey(input.idempotency_key);
    const digest = requestDigest({
      contract,
      coordination_mode: input.coordination_mode,
      api_version: input.api_version,
      schema_version: input.schema_version,
      actor: input.actor,
      expected_head_revision: input.expected_head_revision,
      parent_contract_id: input.parent_contract_id ?? null,
      submitted_digest: input.submitted_digest ?? null,
    });

    const execute = this.database.transaction((): DirectContractSaveResult => {
      let replay: DirectContractSaveResult | null;
      try {
        replay = readIdempotentResponse<DirectContractSaveResult>(this.database, scope, keyHash, digest);
      } catch (error) {
        throw new ContractConflictError((error as Error).message, "idempotency");
      }
      if (replay) return { ...replay, replayed: true };

      const stream = this.database
        .prepare("SELECT head_revision, head_contract_id FROM contract_streams WHERE project = ? AND change_name = ?")
        .get(contract.project, contract.change_name) as { head_revision: number; head_contract_id: string } | undefined;
      const currentRevision = stream?.head_revision ?? 0;
      if (input.expected_head_revision !== currentRevision) {
        throw new ContractConflictError(
          `Stale contract head: expected ${input.expected_head_revision}, current ${currentRevision}`,
          "cas",
          currentRevision
        );
      }
      const expectedParent = stream?.head_contract_id ?? null;
      const submittedParent = input.parent_contract_id ?? null;
      if (submittedParent !== expectedParent) {
        throw new ContractConflictError("Parent contract does not match the current stream head", "cas", currentRevision);
      }
      if (stream) this.validatePhaseTransition(stream.head_contract_id, contract.phase);

      const revision = currentRevision + 1;
      const contractId = generateId("sdd");
      const createdAtMs = this.now();
      this.database
        .prepare(
          `INSERT INTO contract_revisions
             (id, project, change_name, phase, revision, parent_contract_id, contract_json, digest, actor, created_at_ms)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          contractId,
          contract.project,
          contract.change_name,
          contract.phase,
          revision,
          expectedParent,
          canonicalJson(contract),
          contractDigest,
          input.actor,
          createdAtMs
        );

      if (stream) {
        const updated = this.database
          .prepare(
            `UPDATE contract_streams SET head_revision = ?, head_contract_id = ?
             WHERE project = ? AND change_name = ? AND head_revision = ? AND head_contract_id = ?`
          )
          .run(revision, contractId, contract.project, contract.change_name, currentRevision, expectedParent);
        if (updated.changes !== 1) throw new ContractConflictError("Contract head changed during append", "cas");
      } else {
        this.database
          .prepare(
            "INSERT INTO contract_streams (project, change_name, head_revision, head_contract_id) VALUES (?, ?, ?, ?)"
          )
          .run(contract.project, contract.change_name, revision, contractId);
      }

      appendAuthorityEvent(this.database, {
        resource_type: "contract",
        resource_id: contractId,
        resource_revision: revision,
        event_type: "contract_revision_appended",
        actor: input.actor,
        outcome: "success",
        correlation_hash: keyHash,
        details: {
          project: contract.project,
          change_name: contract.change_name,
          phase: contract.phase,
          parent_contract_id: expectedParent,
          contract_digest: contractDigest,
        },
        created_at_ms: createdAtMs,
      });

      const response: DirectContractSaveResult = {
        ok: true,
        replayed: false,
        contract_id: contractId,
        revision,
        head_revision: revision,
        parent_contract_id: expectedParent,
        contract_digest: contractDigest,
      };
      storeIdempotentResponse(this.database, {
        scope,
        keyHash,
        requestDigest: digest,
        response,
        resourceType: "contract",
        resourceId: contractId,
        resultingRevision: revision,
        createdAtMs,
      });
      return response;
    });

    try {
      return execute.immediate();
    } catch (error) {
      if (error instanceof ContractConflictError) throw error;
      const message = (error as Error).message;
      if (/UNIQUE constraint failed: contract_revisions\.project, contract_revisions\.change_name, contract_revisions\.digest/.test(message)) {
        throw new ContractConflictError("Canonical contract digest already exists in this stream", "state");
      }
      throw error;
    }
  }

  saveLegacy(contractJson: string): { saved: true; id: string; phase: string; project: string } {
    const contract = SddContractSchema.parse(JSON.parse(contractJson));
    const id = generateId("sdd");
    this.database
      .prepare(
        `INSERT INTO contracts (id, phase, change_name, project, status, confidence, executive_summary, data)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        id,
        contract.phase,
        contract.change_name,
        contract.project,
        contract.status,
        contract.confidence,
        contract.executive_summary,
        JSON.stringify(contract.data)
      );
    return { saved: true, id, phase: contract.phase, project: contract.project };
  }

  get(contractId: string): Record<string, unknown> & { contract: unknown; mode: "legacy" | "direct-v1" } {
    const direct = this.database
      .prepare(
        `SELECT r.*, s.head_contract_id FROM contract_revisions r
         JOIN contract_streams s ON s.project = r.project AND s.change_name = r.change_name
         WHERE r.id = ?`
      )
      .get(contractId) as ContractRevisionRow | undefined;
    if (direct) {
      return {
        contract: JSON.parse(direct.contract_json),
        mode: "direct-v1",
        revision: direct.revision,
        parent_contract_id: direct.parent_contract_id,
        contract_digest: direct.digest,
        is_head: direct.head_contract_id === direct.id,
      };
    }
    const legacy = this.database.prepare("SELECT * FROM contracts WHERE id = ?").get(contractId) as
      | Record<string, unknown>
      | undefined;
    if (!legacy) throw new Error(`Contract ${contractId} not found`);
    return { contract: legacy, mode: "legacy" };
  }

  history(input: {
    project: string;
    change_name?: string;
    phase?: SddContract["phase"];
    since_revision?: number;
    limit?: number;
  }): { items: Record<string, unknown>[]; next_cursor: string | null; snapshot_revision: number } {
    const conditions = ["r.project = ?", "r.revision > ?"];
    const parameters: Array<string | number> = [input.project, input.since_revision ?? 0];
    if (input.change_name) {
      conditions.push("r.change_name = ?");
      parameters.push(input.change_name);
    }
    if (input.phase) {
      conditions.push("r.phase = ?");
      parameters.push(input.phase);
    }
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT r.id AS contract_id, r.project, r.change_name, r.phase, r.revision,
                r.parent_contract_id, r.digest AS contract_digest, r.actor, r.created_at_ms,
                CASE WHEN s.head_contract_id = r.id THEN 1 ELSE 0 END AS is_head
         FROM contract_revisions r
         JOIN contract_streams s ON s.project = r.project AND s.change_name = r.change_name
         WHERE ${conditions.join(" AND ")}
         ORDER BY r.revision, r.id LIMIT ?`
      )
      .all(...parameters) as Record<string, unknown>[];
    const hasMore = rows.length > limit;
    const items = rows.slice(0, limit);
    const snapshotRevision = items.length > 0 ? Number(items[items.length - 1].revision) : input.since_revision ?? 0;
    return { items, next_cursor: hasMore ? String(snapshotRevision) : null, snapshot_revision: snapshotRevision };
  }

  events(input: {
    resource_type?: string;
    resource_id?: string;
    since_id?: number;
    limit?: number;
  }): { items: AuthorityEvent[]; next_cursor: string | null } {
    const conditions = ["id > ?"];
    const parameters: Array<string | number> = [input.since_id ?? 0];
    if (input.resource_type) {
      conditions.push("resource_type = ?");
      parameters.push(input.resource_type);
    }
    if (input.resource_id) {
      conditions.push("resource_id = ?");
      parameters.push(input.resource_id);
    }
    const limit = Math.min(Math.max(input.limit ?? 20, 1), 100);
    parameters.push(limit + 1);
    const rows = this.database
      .prepare(
        `SELECT id, event_id, resource_type, resource_id, resource_revision, event_type,
                actor, outcome, correlation_hash, details_json, created_at_ms
         FROM authority_events WHERE ${conditions.join(" AND ")} ORDER BY id LIMIT ?`
      )
      .all(...parameters) as Array<Omit<AuthorityEvent, "details"> & { id: number; details_json: string }>;
    const hasMore = rows.length > limit;
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ details_json, id: _id, ...row }) => ({ ...row, details: JSON.parse(details_json) })),
      next_cursor: hasMore ? String(page[page.length - 1].id) : null,
    };
  }

  private validateDirectContext(input: DirectContractSaveInput): void {
    if (input.coordination_mode !== "direct-v1") throw new ContractConflictError("Unsupported coordination mode", "compatibility");
    if (input.api_version !== "1.0.0" || input.schema_version !== "1.0.0") {
      throw new ContractConflictError("Unsupported direct-v1 API or schema version", "compatibility");
    }
    if (!input.actor || !input.idempotency_key) throw new ContractConflictError("Actor and idempotency key are required", "validation");
    if (!Number.isSafeInteger(input.expected_head_revision) || input.expected_head_revision < 0) {
      throw new ContractConflictError("Expected head revision must be a non-negative integer", "validation");
    }
  }

  private validateContractMajor(version: string): void {
    if (!/^1(?:\.0(?:\.0)?)?$/.test(version)) {
      throw new ContractConflictError(`Unsupported contract schema version ${version}`, "compatibility");
    }
  }

  private validatePhaseTransition(parentId: string, nextPhase: SddContract["phase"]): void {
    const parent = this.database.prepare("SELECT phase FROM contract_revisions WHERE id = ?").get(parentId) as
      | { phase: SddContract["phase"] }
      | undefined;
    if (!parent || !PHASE_TRANSITIONS[parent.phase].includes(nextPhase)) {
      throw new ContractConflictError(`Invalid phase transition to ${nextPhase}`, "validation");
    }
  }
}
