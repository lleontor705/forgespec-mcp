import { describe, expect, it } from "vitest";
import { IdentityBroker, decodeFrame, derivePseudonymousHandles, encodeFrame, sanitizeBusinessArgs } from "../../src/identity/broker.js";

describe("identity broker", () => {
  it("derives stable pseudonyms without exposing session strings", () => {
    const a = derivePseudonymousHandles({ root: "official-root", parent: "p", worker: "w" }, "c");
    expect(a).toEqual(derivePseudonymousHandles({ root: "official-root", parent: "p", worker: "w" }, "c"));
    expect(JSON.stringify(a)).not.toContain("official-root");
  });
  it("sanitizes aliases and hashes exact canonical business args", () => {
    expect(sanitizeBusinessArgs({ z: 1, caller: "secret", _identity: "old", a: { n: 2 } })).toEqual({ a: { n: 2 }, z: 1 });
    expect(() => sanitizeBusinessArgs({ x: Number.NaN })).toThrow();
    const cycle: Record<string, unknown> = {}; cycle.self = cycle; expect(() => sanitizeBusinessArgs(cycle)).toThrow();
  });
  it("attests, detects tampering, rotates and revokes", () => {
    let now = 1000; const broker = new IdentityBroker({ now: () => now });
    const input = { session: { root: "r", parent: "p", worker: "w" }, tool: "forge_health", args: { caller: "x", value: 1 } };
    const first = broker.attest(input); expect(broker.verify(first, now)).toBe(true);
    expect(broker.verify({ ...first, payload: { ...first.payload, tool: "bad" } }, now)).toBe(false);
    now += 601; const second = broker.attest(input); expect(second.leaf_certificate.public_key).not.toBe(first.leaf_certificate.public_key);
    expect(broker.verify(second, now)).toBe(true); broker.revoke(first.leaf_certificate.public_key); expect(broker.verify(first, now)).toBe(false);
  });
  it("bounds attestation and child stdio frames", () => {
    let now = 1; const broker = new IdentityBroker({ now: () => now, attestationSeconds: 99, leafSeconds: 9999 });
    const e = broker.attest({ session: { root: "r" }, tool: "forge_health", args: {} }); expect(e.payload.exp - e.payload.iat).toBe(30);
    const encoded = encodeFrame("corr", { b: 2, a: 1 }); expect(decodeFrame(encoded.trim())).toEqual({ id: "corr", payload: { a: 1, b: 2 } });
    expect(() => encodeFrame("x", "a".repeat(100), 10)).toThrow(); expect(() => decodeFrame("{}\n")).toThrow();
  });
});
