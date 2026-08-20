/**
 * Protocol v2 transport + error surface contracts.
 */

export const PROTOCOL_VERSION = "2.0";

export type ProtocolCoordinationMode = "direct-v1";

export const STABLE_PROTOCOL_ERROR_CODES = [
  "APPROVAL_FORBIDDEN",
  "AUDIT_INTEGRITY",
  "AUTHORITY_EXPIRED",
  "CONTRACT_CONFLICT",
  "CURSOR_INVALID",
  "DATABASE_INCOMPATIBLE",
  "EVIDENCE_INVALID",
  "GATE_REQUIRED",
  "IDEMPOTENCY_CONFLICT",
  "INVALID_SCOPE",
  "INVALID_TRANSITION",
  "LEASE_CONFLICT",
  "LIMIT_EXCEEDED",
  "PHASE_INVALID",
  "PROTOCOL_INCOMPATIBLE",
  "REQUEST_INVALID",
  "RESOURCE_NOT_AVAILABLE",
  "SECRET_REJECTED",
  "STALE_REVISION",
  "TASK_BLOCKED",
] as const;

export type StableErrorCode = (typeof STABLE_PROTOCOL_ERROR_CODES)[number];

export interface ProtocolEnvelope {
  ok: false;
  error: {
    category: "authorization" | "validation" | "state" | "compatibility" | "state-management" | "audit" | "datastore" | "limit" | "lease";
    code: string;
    message: string;
  };
}

const LEGACY_TO_STABLE_ERROR_MAP: Readonly<Record<string, StableErrorCode>> = {
  approval_forbidden: "APPROVAL_FORBIDDEN",
  protocol_incompatible: "PROTOCOL_INCOMPATIBLE",
  contract_conflict: "CONTRACT_CONFLICT",
  stale_revision: "STALE_REVISION",
  idempotency_conflict: "IDEMPOTENCY_CONFLICT",
  invalid_scope: "INVALID_SCOPE",
  invalid_transition: "INVALID_TRANSITION",
  authority_expired: "AUTHORITY_EXPIRED",
  gate_required: "GATE_REQUIRED",
  phase_invalid: "PHASE_INVALID",
  task_blocked: "TASK_BLOCKED",
  lease_conflict: "LEASE_CONFLICT",
  audit_integrity: "AUDIT_INTEGRITY",
  database_incompatible: "DATABASE_INCOMPATIBLE",
  limit_exceeded: "LIMIT_EXCEEDED",
  evidence_invalid: "EVIDENCE_INVALID",
  secret_rejected: "SECRET_REJECTED",
  request_invalid: "REQUEST_INVALID",
  resource_not_available: "RESOURCE_NOT_AVAILABLE",
  cursor_invalid: "CURSOR_INVALID",
};

export function normalizeProtocolCode(raw: string): StableErrorCode {
  if (raw === "") return "REQUEST_INVALID";
  const direct = raw.trim().toLowerCase();
  const normalized = direct.toUpperCase();
  if ((STABLE_PROTOCOL_ERROR_CODES as readonly string[]).includes(normalized)) {
    return normalized as StableErrorCode;
  }
  return LEGACY_TO_STABLE_ERROR_MAP[direct] ?? "REQUEST_INVALID";
}
