import type Database from "better-sqlite3";
import { canonicalJson } from "../core/canonical-json.js";
import { antiOracleError, type AntiOracleError } from "../protocol/errors.js";
import { executeMutation, TransactionDomainError } from "./transaction.js";
import { withImmediate } from "../storage/database.js";
import { createHash } from "node:crypto";
import { createRootAuthorityRows, hasEffectiveAuthority } from "./authority/service.js";

const MAX_TEXT = 128;
const MAX_METADATA = 64 * 1024;
const DEFAULT_AUTHORITY_LIFETIME = 365 * 24 * 60 * 60 * 1000;

export interface BoardRecord {
  id: string;
  project: string;
  name: string;
  revision: number;
  metadata: Record<string, unknown>;
  createdAt: number;
  updatedAt: number;
  rootAuthorityExpiresAt?: number;
}

export interface CreateBoardInput {
  project: string;
  name: string;
  metadata?: Record<string, unknown>;
  actor: string;
  idempotencyKey: string;
  /** Owner authority expiry; omitted values use a one-year lifetime. */
  authorityExpiresAt?: number;
  /** Test seam; production callers should omit this. */
  id?: string;
}

export interface GetBoardInput { boardId: string; actor: string }

export class BoardDomainError extends Error {
  readonly error: AntiOracleError;
  readonly envelope: { ok: false; error: AntiOracleError };

  constructor(code: "REQUEST_INVALID" | "IDEMPOTENCY_CONFLICT" | "RESOURCE_NOT_AVAILABLE") {
    const error = antiOracleError(code);
    super(error.message);
    this.name = "BoardDomainError";
    this.error = error;
    this.envelope = { ok: false, error };
  }
}

function text(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= MAX_TEXT;
}

function metadataJson(metadata: unknown): string {
  if (metadata === undefined) return "{}";
  if (metadata === null || typeof metadata !== "object" || Array.isArray(metadata)) throw new BoardDomainError("REQUEST_INVALID");
  try {
    const json = canonicalJson(metadata);
    if (Buffer.byteLength(json, "utf8") > MAX_METADATA || JSON.parse(json) === null) throw new Error();
    return json;
  } catch {
    throw new BoardDomainError("REQUEST_INVALID");
  }
}

function generatedBoardId(actor: string, idempotencyKey: string): string {
  return `board-${createHash("sha256").update(`${actor}\0${idempotencyKey}`).digest("hex")}`;
}

function record(row: { id: string; project: string; name: string; revision: number; metadata_json: string; created_at: number; updated_at: number }): BoardRecord {
  try {
    return { id: row.id, project: row.project, name: row.name, revision: row.revision,
      metadata: JSON.parse(row.metadata_json) as Record<string, unknown>, createdAt: row.created_at, updatedAt: row.updated_at };
  } catch {
    throw new BoardDomainError("REQUEST_INVALID");
  }
}

export function createBoard(database: Database.Database, input: CreateBoardInput): BoardRecord {
  if (!text(input.project) || !text(input.name) || !text(input.actor) || !text(input.idempotencyKey) ||
      (input.id !== undefined && !text(input.id))) throw new BoardDomainError("REQUEST_INVALID");
  const metadata = metadataJson(input.metadata);
  const id = input.id ?? generatedBoardId(input.actor, input.idempotencyKey);
  if (input.authorityExpiresAt !== undefined && !Number.isFinite(input.authorityExpiresAt))
    throw new BoardDomainError("REQUEST_INVALID");
  const request = { project: input.project, name: input.name, metadata, id,
    ...(input.authorityExpiresAt === undefined ? {} : { authorityExpiresAt: input.authorityExpiresAt }) };
  try {
    const result = executeMutation(database, {
      actor: input.actor, tool: "boards.create", idempotencyKey: input.idempotencyKey,
      request,
      work: (db) => {
        const now = Date.now();
        const expiresAt = input.authorityExpiresAt ?? now + DEFAULT_AUTHORITY_LIFETIME;
        if (!Number.isFinite(expiresAt) || expiresAt <= now) throw new BoardDomainError("REQUEST_INVALID");
        db.prepare("INSERT INTO fs_boards (id, project, name, revision, metadata_json, created_at, updated_at) VALUES (?, ?, ?, 1, ?, ?, ?)")
          .run(id, input.project, input.name, metadata, now, now);
        createRootAuthorityRows(db, { boardId: id, ownerActor: input.actor, expiresAt, now, transactional: false });
        return { ...record({ id, project: input.project, name: input.name, revision: 1, metadata_json: metadata, created_at: now, updated_at: now }), rootAuthorityExpiresAt: expiresAt };
      },
    });
    return result.response;
  } catch (error) {
    if (error instanceof TransactionDomainError && error.error.code === "IDEMPOTENCY_CONFLICT")
      throw new BoardDomainError("IDEMPOTENCY_CONFLICT");
    throw error;
  }
}

export function getBoard(database: Database.Database, input: GetBoardInput): BoardRecord {
  if (!text(input.boardId) || !text(input.actor)) throw new BoardDomainError("REQUEST_INVALID");
  return withImmediate(database, () => {
    const row = database.prepare("SELECT id, project, name, revision, metadata_json, created_at, updated_at FROM fs_boards WHERE id = ?")
      .get(input.boardId) as Parameters<typeof record>[0] | undefined;
    if (!row) throw new BoardDomainError("RESOURCE_NOT_AVAILABLE");
    if (!hasEffectiveAuthority(database, { actor: input.actor, boardId: input.boardId, resourceKind: "board", resourceId: input.boardId, operation: "read_board", now: Date.now() })) throw new BoardDomainError("RESOURCE_NOT_AVAILABLE");
    return record(row);
  });
}
