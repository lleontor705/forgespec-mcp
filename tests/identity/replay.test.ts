import { describe, expect, it } from "vitest";
import { IdentityBroker } from "../../src/identity/broker.js";
import { openIdentityStore } from "../../src/identity/store.js";
import { verifyIdentity } from "../../src/identity/verifier.js";

describe("identity replay consumption", () => {
  it("accepts once and persists the decision across reopen", () => {
    const file = ":memory:"; const broker = new IdentityBroker({ now: () => 10 }); const db = openIdentityStore(file);
    const envelope = broker.attest({ session: { root: "r" }, tool: "echo", args: {}, now: 10 });
    const bootstrap = { rootPublicKey: broker.rootPublicKey, issuer: envelope.payload.issuer, audience: "broker" };
    verifyIdentity(db, bootstrap, "echo", { _identity: envelope }, 10);
    expect(() => verifyIdentity(db, bootstrap, "echo", { _identity: envelope }, 10)).toThrow("identity verification failed");
    expect((db.prepare("SELECT COUNT(*) AS count FROM fsi_replay").get() as { count: number }).count).toBe(1);
  });
});
