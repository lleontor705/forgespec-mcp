import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { IdentityBroker, type SessionStrings } from "../../src/identity/broker.js";
import { installIdentityRuntime, type IdentityRuntimeContext } from "../../src/identity/dispatcher.js";
import { sha256 } from "../../src/identity/canonical.js";
import { openIdentityStore } from "../../src/identity/store.js";
import { IdentityVerifier, type TrustedBootstrap } from "../../src/identity/verifier.js";

export async function createIdentityRuntime(server: McpServer) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "forgespec-identity-"));
  const sidecar = path.join(directory, "identity.sqlite");
  const database = openIdentityStore(sidecar);
  const broker = new IdentityBroker();
  const bootstrap: TrustedBootstrap = { rootPublicKey: broker.rootPublicKey, issuer: `root:${sha256(JSON.stringify(broker.rootPublicKey))}`, audience: "broker" };
  const verifier = new IdentityVerifier(database, bootstrap);
  const context: IdentityRuntimeContext = { verifier };
  installIdentityRuntime(server, context);

  return {
    broker, verifier, bootstrap, sidecar, database,
    signExactToolArgs(tool: string, businessArgs: Record<string, unknown>, session: SessionStrings = { root: "test-root", parent: "test-parent", worker: "test-worker" }) {
      const callId = `test-call-${Date.now()}-${Math.random()}`;
      const args = Object.fromEntries(Object.entries(businessArgs).filter(([, value]) => value !== undefined));
      return { ...args, _identity: broker.attest({ tool, session, callId, args }) };
    },
    async cleanup() {
      if (database.open) database.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}
