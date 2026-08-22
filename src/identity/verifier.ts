import { createPublicKey, verify as cryptoVerify } from "node:crypto";
import { beginReplay, finalizeReplay as finalizeReplayRecord, resolveWorkerHandle as resolveEnrolledWorkerHandle, type IdentityStore, type ReplayAudit, type ReplayOutcome } from "./store.js";
import { sanitizeBusinessArgs } from "./broker.js";
import { base64url, canonicalBytes, canonicalJson, IdentityValidationError, sha256 } from "./canonical.js";
import { verifyIdentityEnvelope, type IdentityEnvelope, type VerifiedPrincipal } from "./types.js";

export type TrustedBootstrap = { rootPublicKey: string; issuer: string; audience: string };
export type VerificationResult = { principal: VerifiedPrincipal; args: unknown; audit: ReplayAudit };

const invalid = () => new IdentityValidationError("IDENTITY_INVALID", "identity verification failed");
const certBody = (c: IdentityEnvelope["leaf_certificate"]) => ({ algorithm: c.algorithm, issuer: c.issuer, public_key: c.public_key, not_before: c.not_before, not_after: c.not_after });
const CLOCK_SKEW = 5;

/** Verify an untrusted tool argument object and consume its attestation exactly once. */
export function verifyIdentity(
  database: IdentityStore, bootstrap: TrustedBootstrap, tool: string, rawArgs: unknown, now = Math.floor(Date.now() / 1000),
): VerificationResult {
  try {
    if (!Number.isSafeInteger(now) || !bootstrap || typeof bootstrap.rootPublicKey !== "string" || typeof bootstrap.issuer !== "string" || typeof bootstrap.audience !== "string") throw invalid();
    if (!rawArgs || typeof rawArgs !== "object" || Array.isArray(rawArgs)) throw invalid();
    const input = rawArgs as Record<string, unknown>;
    const identity = input._identity;
    if (!identity || typeof identity !== "object" || Array.isArray(identity)) throw invalid();
    const envelope = identity as IdentityEnvelope;
    const args = sanitizeBusinessArgs(rawArgs);
    const root = createPublicKey({ key: base64url(bootstrap.rootPublicKey), format: "der", type: "spki" });
    if (!cryptoVerify(null, canonicalBytes(certBody(envelope.leaf_certificate)), root, base64url(envelope.leaf_certificate.signature))) throw invalid();
    const principal = verifyIdentityEnvelope(envelope);
    const p = envelope.payload;
    if (envelope.leaf_certificate.issuer !== bootstrap.issuer || p.issuer !== bootstrap.issuer || p.audience !== bootstrap.audience || p.tool !== tool || p.exp - p.iat > 30 || p.iat > now + CLOCK_SKEW || p.exp < now - CLOCK_SKEW || now < envelope.leaf_certificate.not_before - CLOCK_SKEW || now > envelope.leaf_certificate.not_after + CLOCK_SKEW || p.iat < envelope.leaf_certificate.not_before || p.exp > envelope.leaf_certificate.not_after) throw invalid();
    if (p.args_sha256 !== sha256(canonicalJson(args))) throw invalid();
    const s = p.session;
    if (s.lineage.length !== s.depth + 3 || s.lineage[0] !== s.root || s.lineage.length < 3 || s.lineage[s.lineage.length - 2] !== s.parent || s.lineage[s.lineage.length - 1] !== s.worker || new Set(s.lineage).size !== s.lineage.length) throw invalid();
    const result = database.transaction(() => {
       database.prepare("INSERT OR IGNORE INTO fsi_keys (issuer,key_id,public_key,not_before,not_after,revoked_at) VALUES (?,?,?,?,?,NULL)").run(p.issuer, envelope.leaf_certificate.public_key, envelope.leaf_certificate.public_key, envelope.leaf_certificate.not_before, envelope.leaf_certificate.not_after);
      const key = database.prepare("SELECT not_before,not_after,revoked_at FROM fsi_keys WHERE issuer=? AND key_id=?").get(p.issuer, envelope.leaf_certificate.public_key) as { not_before: number; not_after: number; revoked_at: number | null } | undefined;
        const revocation = database.prepare("SELECT revoked_at,signature FROM fsi_revocations WHERE issuer=? AND key_id=?").get(p.issuer, envelope.leaf_certificate.public_key) as { revoked_at: number; signature: string } | undefined;
       const signedRevocation = revocation && cryptoVerify(null, canonicalBytes({ certificate: envelope.leaf_certificate.public_key, revoked_at: revocation.revoked_at }), root, base64url(revocation.signature));
       if (revocation && !signedRevocation) throw invalid();
       if (!key || key.revoked_at !== null || signedRevocation || key.not_before !== envelope.leaf_certificate.not_before || key.not_after !== envelope.leaf_certificate.not_after || now < key.not_before - CLOCK_SKEW || now > key.not_after + CLOCK_SKEW) throw invalid();
      if (database.prepare("SELECT 1 FROM fsi_revocations WHERE issuer=? AND jti=?").get(p.issuer, p.jti)) throw invalid();
      database.prepare("INSERT OR IGNORE INTO fsi_sessions (issuer,session_id,root,parent,worker,depth,lineage_json,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?,?)").run(p.issuer, s.worker, s.root, s.parent, s.worker, s.depth, JSON.stringify(s.lineage), p.iat, p.exp);
      const session = database.prepare("SELECT root,parent,worker,depth,lineage_json FROM fsi_sessions WHERE issuer=? AND session_id=?").get(p.issuer, s.worker) as { root: string; parent: string; worker: string; depth: number; lineage_json: string } | undefined;
      if (!session || session.root !== s.root || session.parent !== s.parent || session.worker !== s.worker || session.depth !== s.depth || session.lineage_json !== JSON.stringify(s.lineage)) throw invalid();
       if (!beginReplay(database, { issuer: p.issuer, jti: p.jti, callId: p.call_id, keyId: envelope.leaf_certificate.public_key, root: s.root, parent: s.parent, worker: s.worker, tool: p.tool, argsDigest: p.args_sha256, pendingAt: now, expiresAt: p.exp })) throw invalid();
       return Object.freeze({ principal, args, audit: { issuer: p.issuer, jti: p.jti, callId: p.call_id } });
    })();
    return result;
  } catch { throw invalid(); }
}

export const verifyAttestation = verifyIdentity;
export const verifyIdentityArgs = verifyIdentity;

export class IdentityVerifier {
  constructor(private readonly database: IdentityStore, private readonly bootstrap: TrustedBootstrap) {}
  verify(tool: string, rawArgs: unknown, now = Math.floor(Date.now() / 1000)): VerificationResult {
    return verifyIdentity(this.database, this.bootstrap, tool, rawArgs, now);
  }
  resolveWorkerHandle(handle: string): string | undefined {
    return resolveEnrolledWorkerHandle(this.database, handle);
  }
  finalizeReplay(audit: ReplayAudit, outcome: ReplayOutcome): void { finalizeReplayRecord(this.database, audit, outcome); }
}
