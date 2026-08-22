import { describe, expect, it } from "vitest";

import {
  PROTOCOL_VERSION,
  STABLE_PROTOCOL_ERROR_CODES,
  normalizeProtocolCode,
  type StableErrorCode,
} from "../../src/protocol/types.js";
import {
  antiOracleError,
  type AntiOracleError,
} from "../../src/protocol/errors.js";

 describe("Protocol 2.0 contract", () => {
  it("defines strict protocol constants and stable anti-oracle error codes", () => {
    expect(PROTOCOL_VERSION).toBe("2.0");
    for (const code of STABLE_PROTOCOL_ERROR_CODES) expect(normalizeProtocolCode(code)).toBe(code);
    const antiOracleVocab: StableErrorCode[] = ["APPROVAL_FORBIDDEN", "AUDIT_INTEGRITY", "AUTHORITY_EXPIRED", "CONTRACT_CONFLICT", "CURSOR_INVALID", "DATABASE_INCOMPATIBLE", "EVIDENCE_INVALID", "GATE_REQUIRED", "IDEMPOTENCY_CONFLICT", "INVALID_SCOPE", "INVALID_TRANSITION", "LEASE_CONFLICT", "LIMIT_EXCEEDED", "PHASE_INVALID", "PROTOCOL_INCOMPATIBLE", "REQUEST_INVALID", "RESOURCE_NOT_AVAILABLE", "SECRET_REJECTED", "STALE_REVISION", "TASK_BLOCKED"];
    expect(antiOracleVocab).toHaveLength(20);
    expect(antiOracleVocab).toEqual([...STABLE_PROTOCOL_ERROR_CODES]);
    expect(antiOracleVocab.includes(antiOracleError("PROTOCOL_INCOMPATIBLE").code)).toBe(true);
    for (const code of antiOracleVocab) {
      const envelope = antiOracleError(code);
      expect(envelope.code).toBe(code);
      expect(typeof envelope.message).toBe("string");
      expect(envelope.message.length).toBeGreaterThan(0);
      expect(envelope.restartQuery).toBe(false);
      expect(typeof envelope.retryable).toBe("boolean");
    }
  });
  it("rejects aliases and non-canonical casing", () => {
    for (const value of ["AUTH_ATTEMPT_EXPIRED", "protocol_incompatible", "resource_not_available", " resource_not_available ", "ReSoUrCe_NoT_AvAiLaBlE", "not_a_known_code"]) expect(normalizeProtocolCode(value)).toBe("REQUEST_INVALID");
  });
  it("accepts only exact canonical codes", () => {
    expect(antiOracleError("REQUEST_INVALID").code).toBe("REQUEST_INVALID");
    expect(antiOracleError(" resource_not_available ").code).toBe("REQUEST_INVALID");
    expect(antiOracleError("ReSoUrCe_NoT_AvAiLaBlE").code).toBe("REQUEST_INVALID");
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
