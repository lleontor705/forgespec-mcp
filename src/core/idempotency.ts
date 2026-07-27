import type Database from "better-sqlite3";
import { createHash } from "node:crypto";
import { canonicalSha256 } from "./canonical-json.js";

interface IdempotencyRow {
  request_digest: string;
  response_json: string;
}

export function hashIdempotencyKey(key: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(key).digest("hex")}`;
}

export function requestDigest(request: unknown): `sha256:${string}` {
  return canonicalSha256(request);
}

export function readIdempotentResponse<T>(
  database: Database.Database,
  scope: string,
  keyHash: string,
  digest: string
): T | null {
  const row = database
    .prepare("SELECT request_digest, response_json FROM idempotency_records WHERE scope = ? AND key_hash = ?")
    .get(scope, keyHash) as IdempotencyRow | undefined;
  if (!row) return null;
  if (row.request_digest !== digest) throw new Error("Idempotency key is already bound to a different request digest");
  return JSON.parse(row.response_json) as T;
}

export function storeIdempotentResponse(
  database: Database.Database,
  input: {
    scope: string;
    keyHash: string;
    requestDigest: string;
    response: unknown;
    resourceType: string;
    resourceId: string;
    resultingRevision: number;
    createdAtMs: number;
  }
): void {
  database
    .prepare(
      `INSERT INTO idempotency_records
         (scope, key_hash, request_digest, response_json, resource_type, resource_id, resulting_revision, created_at_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      input.scope,
      input.keyHash,
      input.requestDigest,
      JSON.stringify(input.response),
      input.resourceType,
      input.resourceId,
      input.resultingRevision,
      input.createdAtMs
    );
}
