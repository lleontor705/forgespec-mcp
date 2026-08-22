import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { canonicalIdentityBytes, signIdentityEnvelope, verifyIdentityEnvelope, type IdentityEnvelope } from "../../src/identity/types.js";

const b64 = (value: Buffer) => value.toString("base64url");
const keys = generateKeyPairSync("ed25519");
const publicKey = b64(keys.publicKey.export({ type: "spki", format: "der" }));
const certificate = { algorithm: "Ed25519" as const, public_key: publicKey, issuer: "root", not_before: 100, not_after: 200, signature: b64(Buffer.alloc(64)) };
const payload = { issuer: "leaf", audience: "broker", tool: "echo", args_sha256: `sha256:${"a".repeat(64)}`, session: { root: "r", parent: "p", worker: "w", depth: 1, lineage: ["r", "p", "w"] }, call_id: "call-1", jti: "jti-1", iat: 100, exp: 200 };

describe("identity envelope contract", () => {
  it("signs and verifies the canonical bounded envelope", () => {
    const envelope = signIdentityEnvelope({ version: "1.1", leaf_certificate: certificate, payload }, keys.privateKey);
    expect(envelope.signature).toMatch(/^[A-Za-z0-9_-]+$/);
    const principal = verifyIdentityEnvelope(envelope);
    expect(principal).toEqual({ issuer: "leaf", audience: "broker", tool: "echo", session: payload.session, jti: "jti-1" });
    expect(Object.isFrozen(principal)).toBe(true);
    expect(canonicalIdentityBytes(envelope)).toEqual(canonicalIdentityBytes({ ...envelope, signature: envelope.signature }));
  });

  it("rejects non-canonical encodings, excessive depth, and invalid time integers", () => {
    const envelope = signIdentityEnvelope({ version: "1.1", leaf_certificate: certificate, payload }, keys.privateKey);
    for (const bad of [
      { ...envelope, signature: `${envelope.signature}=` },
      { ...envelope, payload: { ...payload, session: { ...payload.session, depth: 65 } } },
      { ...envelope, payload: { ...payload, iat: 1.5 } },
    ]) expect(() => verifyIdentityEnvelope(bad as IdentityEnvelope)).toThrow();
  });
});
