import { createPublicKey } from "node:crypto";
import path from "node:path";
import type { TrustedBootstrap } from "../identity/verifier.js";

export const IDENTITY_ENV = {
  rootPublicKey: "FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY",
  issuer: "FORGESPEC_IDENTITY_ISSUER",
  audience: "FORGESPEC_IDENTITY_AUDIENCE",
  sidecar: "FORGESPEC_IDENTITY_SIDECAR_PATH",
} as const;

export type IdentityBootstrapConfig = TrustedBootstrap & { sidecarPath: string };

export function readIdentityBootstrap(env: NodeJS.ProcessEnv = process.env): IdentityBootstrapConfig {
  const rootPublicKey = env[IDENTITY_ENV.rootPublicKey]?.trim();
  const issuer = env[IDENTITY_ENV.issuer]?.trim();
  const audience = env[IDENTITY_ENV.audience]?.trim();
  const sidecarPath = env[IDENTITY_ENV.sidecar]?.trim();
  if (!rootPublicKey || !issuer || !audience || !sidecarPath || sidecarPath === ":memory:") throw new Error("TRUST_BOOTSTRAP_INVALID");
  try { createPublicKey({ key: Buffer.from(rootPublicKey, "base64url"), format: "der", type: "spki" }); }
  catch { throw new Error("TRUST_BOOTSTRAP_INVALID"); }
  return { rootPublicKey, issuer, audience, sidecarPath: path.resolve(sidecarPath) };
}
