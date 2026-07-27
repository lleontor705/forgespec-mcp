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

export function directErrorResponse(error: unknown) {
  const safe = isSafeDirectError(error) ? error : null;
  return {
    ok: false as const,
    error: {
      category: safe?.category ?? "validation",
      code: safe?.code ?? "request_invalid",
      message: safe?.message ?? "The request could not be processed",
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
