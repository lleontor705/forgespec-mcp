import type Database from "better-sqlite3";
import { canonicalJson } from "../core/canonical-json.js";
import { antiOracleError, type AntiOracleError } from "../protocol/errors.js";
import { canonicalIdempotencyKeyHash, canonicalRequestDigest } from "../storage/idempotency.js";
import { withImmediate } from "../storage/database.js";

const MAX_ACTOR = 128;
const MAX_TOOL = 128;
const MAX_KEY = 256;
const MAX_RESPONSE = 64 * 1024;

export class TransactionDomainError extends Error {
  readonly error: AntiOracleError;
  readonly envelope: { ok: false; error: AntiOracleError };

  constructor(code: "REQUEST_INVALID" | "LIMIT_EXCEEDED" | "IDEMPOTENCY_CONFLICT") {
    const error = antiOracleError(code);
    super(error.message);
    this.name = "TransactionDomainError";
    this.error = error;
    this.envelope = { ok: false, error };
  }
}

export interface MutationOptions<Request, Response, PersistedResponse = Response> {
  actor: string;
  tool: string;
  idempotencyKey: string;
  request: Request;
  work: (database: Database.Database) => Response;
  /** Maps the first result to the representation safe to store for replay. */
  toPersisted?: (response: Response) => PersistedResponse;
  /** Reconstructs the response returned by an idempotent replay. */
  fromPersisted?: (response: PersistedResponse) => Response;
}

export interface MutationResult<Response> {
  response: Response;
  replayed: boolean;
}

function bounded(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= max;
}

function boundedUtf8(value: unknown, max: number): value is string {
  return typeof value === "string" && value.trim().length > 0 && Buffer.byteLength(value, "utf8") <= max;
}

function result<Response>(response: Response, replayed: boolean): MutationResult<Response> {
  return { response, replayed };
}

/** Runs one final-store mutation, making retries safe without storing plaintext keys. */
export function executeMutation<Request, Response, PersistedResponse = Response>(
  database: Database.Database,
  options: MutationOptions<Request, Response, PersistedResponse>,
): MutationResult<Response> {
  if (!bounded(options.actor, MAX_ACTOR) || !bounded(options.tool, MAX_TOOL) || !boundedUtf8(options.idempotencyKey, MAX_KEY)) {
    throw new TransactionDomainError("REQUEST_INVALID");
  }

  let requestDigest: string;
  try {
    requestDigest = canonicalRequestDigest(options.request);
  } catch {
    throw new TransactionDomainError("REQUEST_INVALID");
  }
  const keyHash = canonicalIdempotencyKeyHash(options.idempotencyKey);

  return withImmediate(database, () => {
    const existing = database.prepare(
      "SELECT request_digest, response_json FROM fs_idempotency WHERE actor = ? AND tool = ? AND key_hash = ?",
    ).get(options.actor, options.tool, keyHash) as { request_digest: string; response_json: string } | undefined;
    if (existing) {
      if (existing.request_digest !== requestDigest) throw new TransactionDomainError("IDEMPOTENCY_CONFLICT");
      try {
        const persisted = JSON.parse(existing.response_json) as PersistedResponse;
        return result(options.fromPersisted ? options.fromPersisted(persisted) : persisted as unknown as Response, true);
      } catch {
        throw new TransactionDomainError("REQUEST_INVALID");
      }
    }

    const response = options.work(database);
    const persisted = options.toPersisted ? options.toPersisted(response) : response as unknown as PersistedResponse;
    let responseJson: string;
    try {
      responseJson = canonicalJson(persisted);
    } catch {
      throw new TransactionDomainError("REQUEST_INVALID");
    }
    if (Buffer.byteLength(responseJson, "utf8") > MAX_RESPONSE) throw new TransactionDomainError("LIMIT_EXCEEDED");
    const now = Date.now();
    database.prepare(
      `INSERT INTO fs_idempotency
       (actor, tool, scope, key_hash, request_digest, response_json, result_code, resulting_revision, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'ok', 1, ?)`,
    ).run(options.actor, options.tool, "transaction", keyHash, requestDigest, responseJson, now);
    return result(response, false);
  });
}
