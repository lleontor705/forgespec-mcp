import { normalizeProtocolCode, type StableErrorCode } from "./types.js";

export type AntiOracleErrorCategory =
  | "authorization"
  | "validation"
  | "state-management"
  | "compatibility"
  | "state"
  | "audit"
  | "datastore"
  | "limit"
  | "lease"
  | "secret";

export interface AntiOracleError {
  category: AntiOracleErrorCategory;
  code: StableErrorCode;
  message: string;
  retryable: boolean;
  restartQuery: boolean;
}

export interface AntiOracleTemplate {
  category: AntiOracleErrorCategory;
  message: string;
  retryable: boolean;
  restartQuery: boolean;
}

const ANTI_ORACLE_TEMPLATES: Record<StableErrorCode, AntiOracleTemplate> = {
  APPROVAL_FORBIDDEN: {
    category: "authorization",
    message: "Operation is forbidden by policy.",
    retryable: false,
    restartQuery: false,
  },
  AUDIT_INTEGRITY: {
    category: "audit",
    message: "Audit trail integrity check failed for the request.",
    retryable: false,
    restartQuery: false,
  },
  AUTHORITY_EXPIRED: {
    category: "authorization",
    message: "Attempt authority is expired or no longer active.",
    retryable: false,
    restartQuery: false,
  },
  CONTRACT_CONFLICT: {
    category: "state",
    message: "Operation conflicts with the active contract lifecycle.",
    retryable: false,
    restartQuery: false,
  },
  CURSOR_INVALID: {
    category: "validation",
    message: "Cursor parameter is invalid.",
    retryable: false,
    restartQuery: false,
  },
  DATABASE_INCOMPATIBLE: {
    category: "datastore",
    message: "Datastore is incompatible with the requested protocol state.",
    retryable: false,
    restartQuery: false,
  },
  EVIDENCE_INVALID: {
    category: "validation",
    message: "Evidence reference is missing required fields or has invalid shape.",
    retryable: false,
    restartQuery: false,
  },
  GATE_REQUIRED: {
    category: "authorization",
    message: "Required task gate has not been approved yet.",
    retryable: false,
    restartQuery: false,
  },
  IDEMPOTENCY_CONFLICT: {
    category: "state",
    message: "Idempotency key was reused for a conflicting request payload.",
    retryable: false,
    restartQuery: false,
  },
  INVALID_SCOPE: {
    category: "validation",
    message: "The supplied scope is invalid for this operation.",
    retryable: false,
    restartQuery: false,
  },
  INVALID_TRANSITION: {
    category: "state-management",
    message: "Task state transition is not allowed in the current lifecycle.",
    retryable: false,
    restartQuery: false,
  },
  LEASE_CONFLICT: {
    category: "lease",
    message: "Requested file scope overlaps an active lease.",
    retryable: false,
    restartQuery: false,
  },
  LIMIT_EXCEEDED: {
    category: "limit",
    message: "Request exceeded an enforced protocol limit.",
    retryable: false,
    restartQuery: false,
  },
  PHASE_INVALID: {
    category: "state-management",
    message: "Operation is invalid for the current protocol phase.",
    retryable: false,
    restartQuery: false,
  },
  PROTOCOL_INCOMPATIBLE: {
    category: "compatibility",
    message: "Protocol contract is incompatible with this operation.",
    retryable: false,
    restartQuery: false,
  },
  REQUEST_INVALID: {
    category: "validation",
    message: "Request payload is not valid for this operation.",
    retryable: false,
    restartQuery: false,
  },
  RESOURCE_NOT_AVAILABLE: {
    category: "authorization",
    message: "Resource is not available.",
    retryable: false,
    restartQuery: false,
  },
  SECRET_REJECTED: {
    category: "secret",
    message: "A secret-related secret was rejected due to policy.",
    retryable: false,
    restartQuery: false,
  },
  STALE_REVISION: {
    category: "state-management",
    message: "Task revision is stale relative to the server projection.",
    retryable: true,
    restartQuery: false,
  },
  TASK_BLOCKED: {
    category: "state-management",
    message: "Task cannot proceed while blocked.",
    retryable: false,
    restartQuery: false,
  },
};

export function antiOracleError(inputCode: string): AntiOracleError {
  const code = normalizeProtocolCode(inputCode);
  const template = ANTI_ORACLE_TEMPLATES[code];
  return {
    code,
    message: template.message,
    category: template.category,
    retryable: template.retryable,
    restartQuery: template.restartQuery,
  };
}

export function antiOracleEnvelope(inputCode: string): {
  ok: false;
  error: AntiOracleError;
} {
  const error = antiOracleError(inputCode);
  return { ok: false, error };
}
