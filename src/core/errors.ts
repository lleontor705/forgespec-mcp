export type DirectErrorCategory =
  | "compatibility"
  | "validation"
  | "authorization"
  | "state"
  | "cas"
  | "idempotency"
  | "dependency"
  | "approval"
  | "lease"
  | "cursor"
  | "migration"
  | "busy";

export interface SafeDirectError extends Error {
  category: DirectErrorCategory;
  code: string;
  currentRevision?: number;
  retryable?: boolean;
  restartQuery?: boolean;
}

export type NormativeErrorCode =
  | "ATTEMPT_EXPIRED"
  | "BOARD_QUERY_FORBIDDEN"
  | "CURSOR_INVALID"
  | "CURSOR_EXPIRED"
  | "CURSOR_VERSION_UNSUPPORTED"
  | "CURSOR_CONTEXT_MISMATCH"
  | "SNAPSHOT_EXPIRED"
  | "SNAPSHOT_INTEGRITY_ERROR"
  | "MIGRATION_CHECKSUM_MISMATCH"
  | "SQLITE_CAPABILITY_MISSING";

const normativeCodes: Record<string, NormativeErrorCode> = {
  attempt_expired: "ATTEMPT_EXPIRED",
  query_not_authorized: "BOARD_QUERY_FORBIDDEN",
  cursor_invalid: "CURSOR_INVALID",
  cursor_expired: "CURSOR_EXPIRED",
  cursor_version_unsupported: "CURSOR_VERSION_UNSUPPORTED",
  cursor_context_mismatch: "CURSOR_CONTEXT_MISMATCH",
  snapshot_expired: "SNAPSHOT_EXPIRED",
  snapshot_integrity_error: "SNAPSHOT_INTEGRITY_ERROR",
  migration_checksum_mismatch: "MIGRATION_CHECKSUM_MISMATCH",
  sqlite_capability_missing: "SQLITE_CAPABILITY_MISSING",
};

export function normativeErrorCode(code: string): string {
  return normativeCodes[code] ?? code;
}

export function directErrorResponse(error: unknown) {
  const safe = isSafeDirectError(error) ? error : null;
  return {
    ok: false as const,
    error: {
      category: safe?.category ?? "validation",
      code: safe?.code ?? "request_invalid",
      message: safe?.message ?? "The request could not be processed",
      data: { code: normativeErrorCode(safe?.code ?? "request_invalid") },
      retryable: safe?.retryable ?? (safe?.category === "cas" && safe.code === "stale_revision"),
      ...(safe?.currentRevision === undefined ? {} : { current_revision: safe.currentRevision }),
      ...(safe?.restartQuery === undefined ? {} : { restart_query: safe.restartQuery }),
    },
  };
}

function isSafeDirectError(error: unknown): error is SafeDirectError {
  if (!(error instanceof Error)) return false;
  const candidate = error as Partial<SafeDirectError>;
  return typeof candidate.category === "string" && typeof candidate.code === "string";
}
