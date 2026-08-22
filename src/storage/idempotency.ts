import { canonicalJson } from "../core/canonical-json.js";
import { canonicalHash, ensureCanonicalSha256 } from "./audit-integrity.js";
import type Database from "better-sqlite3";

export interface InsertIdempotencyRecordInput {
  actor: string; tool: string; scope: string; idempotency_key: string;
  request?: unknown; request_digest?: string;
  response_json: string | unknown;
  result_code: "ok" | "error"; resulting_revision: number; created_at: number;
  key_hash?: string;
}

export function canonicalIdempotencyKeyHash(key: string): string {
  return canonicalHash(key);
}

export const hashIdempotencyKey = canonicalIdempotencyKeyHash;

export function canonicalRequestDigest(request: unknown): string {
  return canonicalHash(canonicalJson(request));
}

export const requestDigest = canonicalRequestDigest;

export function validateDigest(value: string): string {
  return ensureCanonicalSha256(value);
}

export const validateRequestDigest = validateDigest;

export function validateIdempotencyKeyHash(key: string, keyHash: string): void {
  if (keyHash !== canonicalIdempotencyKeyHash(key)) {
    throw new Error("idempotency key hash mismatch");
  }
}

/** Store an idempotency result without ever persisting the caller's plaintext key. */
export function insertIdempotencyRecord(database: Database.Database, input: InsertIdempotencyRecordInput): void {
  const keyHash = canonicalIdempotencyKeyHash(input.idempotency_key);
  if (input.key_hash !== undefined && input.key_hash !== keyHash) throw new Error("idempotency key hash mismatch");
  const requestDigest = input.request === undefined
    ? validateDigest(input.request_digest ?? "")
    : canonicalRequestDigest(input.request);
  if (input.request !== undefined && input.request_digest !== undefined && validateDigest(input.request_digest) !== requestDigest) {
    throw new Error("request digest mismatch");
  }
  const response = typeof input.response_json === "string"
    ? JSON.parse(input.response_json)
    : input.response_json;
  const responseJson = canonicalJson(response);
  const existing = database.prepare(
    "SELECT request_digest FROM fs_idempotency WHERE actor = ? AND tool = ? AND key_hash = ?",
  ).get(input.actor, input.tool, keyHash) as { request_digest: string } | undefined;
  if (existing) {
    if (existing.request_digest !== requestDigest) throw new Error("idempotency key conflict");
    return;
  }
  database.prepare(
    `INSERT INTO fs_idempotency
      (actor, tool, scope, key_hash, request_digest, response_json, result_code, resulting_revision, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(input.actor, input.tool, input.scope, keyHash, requestDigest, responseJson,
    input.result_code, input.resulting_revision, input.created_at);
}

export { canonicalHash, ensureCanonicalSha256 };

export interface ExpiredIdempotencyQueryOptions {
  olderThanMs?: number;
  now?: number;
}

export function queryExpiredIdempotencyCount(
  database: Database.Database,
  options: ExpiredIdempotencyQueryOptions = {},
): { expiredCount: number; cutoff: number } {
  const now = options.now ?? Date.now();
  const olderThanMs = options.olderThanMs ?? 7 * 24 * 60 * 60 * 1000;
  const cutoff = now - olderThanMs;
  const row = database.prepare("SELECT COUNT(*) AS count FROM fs_idempotency WHERE created_at < ?").get(cutoff) as { count: number };
  return { expiredCount: row.count, cutoff };
}
