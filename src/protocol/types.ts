/**
 * ForgeSpec Protocol 2.0 transport and error surface contracts.
 */

export const PROTOCOL_VERSION = "2.0";

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

export function normalizeProtocolCode(raw: string): StableErrorCode {
  if ((STABLE_PROTOCOL_ERROR_CODES as readonly string[]).includes(raw)) {
    return raw as StableErrorCode;
  }
  return "REQUEST_INVALID";
}
