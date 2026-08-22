import { describe, expect, it } from "vitest";
import { IdentityBroker } from "../../src/identity/broker.js";
import { canonicalJson, sha256 } from "../../src/identity/canonical.js";
import { openIdentityStore } from "../../src/identity/store.js";
import { verifyIdentity } from "../../src/identity/verifier.js";

describe("identity verifier", () => {
  it("pins the supplied root, binds tool and sanitized arguments", () => {
    const broker = new IdentityBroker({ now: () => 100 });
    const envelope = broker.attest({ session: { root: "r" }, tool: "echo", args: { value: 1 }, now: 100 });
    const db = openIdentityStore(":memory:");
    const bootstrap = { rootPublicKey: broker.rootPublicKey, issuer: envelope.payload.issuer, audience: "broker" };
    expect(verifyIdentity(db, bootstrap, "echo", { value: 1, _identity: envelope }, 100).args).toEqual({ value: 1 });
    expect(() => verifyIdentity(db, bootstrap, "other", { value: 1, _identity: envelope }, 100)).toThrow("identity verification failed");
    expect(() => verifyIdentity(db, { ...bootstrap, rootPublicKey: "bad" }, "echo", { value: 1, _identity: envelope }, 100)).toThrow("identity verification failed");
  });

  it("rejects expired, revoked, and lineage-invalid attestations", () => {
    let now = 100; const broker = new IdentityBroker({ now: () => now }); const db = openIdentityStore(":memory:");
    const e = broker.attest({ session: { root: "r" }, tool: "echo", args: {}, now });
    const bootstrap = { rootPublicKey: broker.rootPublicKey, issuer: e.payload.issuer, audience: "broker" };
    now = e.payload.exp + 1; expect(() => verifyIdentity(db, bootstrap, "echo", { _identity: e }, now)).toThrow();
    now = 100; const e2 = broker.attest({ session: { root: "r" }, tool: "echo", args: {}, now });
    db.prepare("INSERT INTO fsi_revocations (issuer,jti,revoked_at) VALUES (?,?,?)").run(e2.payload.issuer, e2.payload.jti, now);
    expect(() => verifyIdentity(db, bootstrap, "echo", { _identity: e2 }, now)).toThrow();
    expect(canonicalJson(e2.payload.session.lineage)).toContain(e2.payload.session.root);
  });
});
