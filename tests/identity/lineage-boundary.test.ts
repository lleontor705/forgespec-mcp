import { describe, expect, it } from "vitest";
import { generateKeyPairSync } from "node:crypto";
import { signIdentityEnvelope } from "../../src/identity/types.js";

describe("identity lineage boundary", () => {
  it("accepts depth 64 and rejects depth 65", () => {
    const { privateKey } = generateKeyPairSync("ed25519");
    const base = { issuer: "i", audience: "a", tool: "t", args_sha256: `sha256:${"a".repeat(64)}` as `sha256:${string}`, call_id: "c", jti: "j", iat: 1, exp: 2 };
    const cert = { algorithm: "Ed25519" as const, public_key: "eA", issuer: "i", not_before: 0, not_after: 10, signature: "eA" };
    const line64 = Array.from({ length: 67 }, (_, i) => `n${i}`);
    expect(() => signIdentityEnvelope({ version: "1.1", leaf_certificate: cert, payload: { ...base, session: { root: line64[0], parent: line64[65], worker: line64[66], depth: 64, lineage: line64 } } }, privateKey)).not.toThrow();
    expect(() => signIdentityEnvelope({ version: "1.1", leaf_certificate: cert, payload: { ...base, session: { root: "n0", parent: "n66", worker: "n67", depth: 65, lineage: [...line64, "n67"] } } }, privateKey)).toThrow();
  });
});
