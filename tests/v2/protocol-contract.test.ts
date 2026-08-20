import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  STABLE_PROTOCOL_ERROR_CODES,
  normalizeProtocolCode,
  type StableErrorCode,
  type ProtocolCoordinationMode,
} from "../../src/v2/protocol/types.js";
import {
  antiOracleError,
  type AntiOracleError,
} from "../../src/v2/protocol/errors.js";

describe("Protocol v2 contract", () => {
  it("defines strict protocol constants and stable anti-oracle error codes", () => {
    expect(PROTOCOL_VERSION).toBe("2.0");

    const mode: ProtocolCoordinationMode = "direct-v1";
    expect(mode).toBe("direct-v1");

    expect(normalizeProtocolCode("protocol_incompatible")).toBe("PROTOCOL_INCOMPATIBLE");
    expect(normalizeProtocolCode("stale_revision")).toBe("STALE_REVISION");
    expect(normalizeProtocolCode("idempotency_conflict")).toBe("IDEMPOTENCY_CONFLICT");
    expect(normalizeProtocolCode("invalid_scope")).toBe("INVALID_SCOPE");
    expect(normalizeProtocolCode("invalid_transition")).toBe("INVALID_TRANSITION");
    expect(normalizeProtocolCode("authority_expired")).toBe("AUTHORITY_EXPIRED");
    expect(normalizeProtocolCode("gate_required")).toBe("GATE_REQUIRED");
    expect(normalizeProtocolCode("lease_conflict")).toBe("LEASE_CONFLICT");
    expect(normalizeProtocolCode("audit_integrity")).toBe("AUDIT_INTEGRITY");
    expect(normalizeProtocolCode("database_incompatible")).toBe("DATABASE_INCOMPATIBLE");
    expect(normalizeProtocolCode("contract_conflict")).toBe("CONTRACT_CONFLICT");
    expect(normalizeProtocolCode("limit_exceeded")).toBe("LIMIT_EXCEEDED");
    expect(normalizeProtocolCode("phase_invalid")).toBe("PHASE_INVALID");
    expect(normalizeProtocolCode("evidence_invalid")).toBe("EVIDENCE_INVALID");
    expect(normalizeProtocolCode("secret_rejected")).toBe("SECRET_REJECTED");
    expect(normalizeProtocolCode("request_invalid")).toBe("REQUEST_INVALID");
    expect(normalizeProtocolCode("resource_not_available")).toBe("RESOURCE_NOT_AVAILABLE");
    expect(normalizeProtocolCode("task_blocked")).toBe("TASK_BLOCKED");
    expect(normalizeProtocolCode("approval_forbidden")).toBe("APPROVAL_FORBIDDEN");
    expect(normalizeProtocolCode("cursor_invalid")).toBe("CURSOR_INVALID");

    const antiOracleVocab: StableErrorCode[] = [
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
    ];
    const closedSet: StableErrorCode[] = [...STABLE_PROTOCOL_ERROR_CODES];

    expect(antiOracleVocab).toHaveLength(20);
    expect(antiOracleVocab).toEqual(closedSet);
    const closed = antiOracleError("PROTOCOL_INCOMPATIBLE");
    expect(antiOracleVocab.includes(closed.code)).toBe(true);

    for (const code of antiOracleVocab) {
      const envelope = antiOracleError(code);
      expect(envelope.code).toBe(code);
      expect(typeof envelope.message).toBe("string");
      expect(envelope.message.length).toBeGreaterThan(0);
      expect(envelope.restartQuery).toBe(false);
      expect(typeof envelope.retryable).toBe("boolean");
    }
  });

  it("normalizes stale legacy tokens only through explicit SDD vocabulary and rejects old v1/legacy aliases", () => {
    expect(normalizeProtocolCode("AUTH_ATTEMPT_EXPIRED")).toBe("REQUEST_INVALID");
    expect(normalizeProtocolCode("request_invalid")).toBe("REQUEST_INVALID");
    expect(normalizeProtocolCode("resource_not_available")).toBe("RESOURCE_NOT_AVAILABLE");
    expect(normalizeProtocolCode("not_a_known_code")).toBe("REQUEST_INVALID");
  });

  it("maps protocol codes with noisy caller input to canonical anti-oracle forms", () => {
    const noisyRequest = antiOracleError("  request_invalid  ");
    const noisyResource = antiOracleError("ReSoUrCe_NoT_AvAiLaBlE");
    const noisyCursor = antiOracleError("\nCURSOR_INVALID\t");

    expect(noisyRequest.code).toBe("REQUEST_INVALID");
    expect(noisyResource.code).toBe("RESOURCE_NOT_AVAILABLE");
    expect(noisyCursor.code).toBe("CURSOR_INVALID");

    expect(noisyRequest.message).toBe("Request payload is not valid for this operation.");
    expect(noisyResource.message).toBe("Resource is not available.");
    expect(noisyCursor.message).toBe("Cursor parameter is invalid.");
  });

  it("rejects caller-controlled anti-oracle message injection for unknown codes", () => {
    const malicious = antiOracleError("PROTOCOL_INCOMPATIBLE\nInjected message");
    expect(malicious.code).toBe("REQUEST_INVALID");
    expect(malicious.message).toBe("Request payload is not valid for this operation.");
  });

  it("rejects malformed stable-code payloads with a machine-readable fallback", () => {
    const safe: StableErrorCode = normalizeProtocolCode("not_a_known_code");
    const err: AntiOracleError = antiOracleError("not_a_known_code");

    expect(safe).toBe("REQUEST_INVALID");
    expect(err.code).toBe("REQUEST_INVALID");
    expect(err.message).toBe("Request payload is not valid for this operation.");
    expect(err.retryable).toBe(false);
    expect(err.restartQuery).toBe(false);
  });

  it("uses closed anti-oracle templates and cannot be caller-message controlled", () => {
    const first = antiOracleError("AUTHORITY_EXPIRED");
    const second = antiOracleError("AUTHORITY_EXPIRED");

    expect(first.code).toBe("AUTHORITY_EXPIRED");
    expect(second.code).toBe("AUTHORITY_EXPIRED");
    expect(first.message).toBe(second.message);
    expect(first.message).toBe("Attempt authority is expired or no longer active.");
  });
});
