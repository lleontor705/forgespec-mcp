import { createPublicKey, sign, verify, type KeyObject } from "node:crypto";
import { base64url, canonicalBytes, IdentityValidationError } from "./canonical.js";
import { MAX_LINEAGE_DEPTH, MAX_LINEAGE_LENGTH } from "./constants.js";

export interface LeafCertificate { algorithm: "Ed25519"; public_key: string; issuer: string; not_before: number; not_after: number; signature: string }
export interface IdentitySession { root: string; parent: string; worker: string; depth: number; lineage: string[] }
export interface IdentityPayload { issuer: string; audience: string; tool: string; args_sha256: `sha256:${string}`; session: IdentitySession; call_id: string; jti: string; iat: number; exp: number }
export interface IdentityEnvelope { version: "1.1"; leaf_certificate: LeafCertificate; payload: IdentityPayload; signature: string }
export interface VerifiedPrincipal { readonly issuer: string; readonly audience: string; readonly tool: string; readonly session: Readonly<Omit<IdentitySession, "lineage">> & { readonly lineage: readonly string[] }; readonly jti: string }

export function canonicalIdentityBytes(envelope: IdentityEnvelope): Buffer {
  validate(envelope, false);
  return canonicalBytes({ leaf_certificate: envelope.leaf_certificate, payload: envelope.payload, version: envelope.version });
}

export function signIdentityEnvelope(input: Omit<IdentityEnvelope, "signature">, privateKey: KeyObject): IdentityEnvelope {
  validate({ ...input, signature: "x" }, false);
  const signature = sign(null, canonicalBytes(input), privateKey).toString("base64url");
  return Object.freeze({ ...input, signature });
}

export function verifyIdentityEnvelope(envelope: IdentityEnvelope): VerifiedPrincipal {
  validate(envelope, true);
  const key = createPublicKey({ key: base64url(envelope.leaf_certificate.public_key, "public_key"), format: "der", type: "spki" });
  if (!verify(null, canonicalBytes({ version: envelope.version, leaf_certificate: envelope.leaf_certificate, payload: envelope.payload }), key, base64url(envelope.signature, "signature"))) throw new IdentityValidationError("IDENTITY_SIGNATURE_INVALID", "identity signature is invalid");
  return Object.freeze({ issuer: envelope.payload.issuer, audience: envelope.payload.audience, tool: envelope.payload.tool, session: Object.freeze({ ...envelope.payload.session, lineage: Object.freeze([...envelope.payload.session.lineage]) }), jti: envelope.payload.jti });
}

function validate(value: IdentityEnvelope, signed: boolean): void {
  if (!value || value.version !== "1.1" || !value.leaf_certificate || !value.payload || (signed && typeof value.signature !== "string")) throw new IdentityValidationError("IDENTITY_INVALID", "invalid identity envelope");
  const cert = value.leaf_certificate; if (cert.algorithm !== "Ed25519") throw new IdentityValidationError("IDENTITY_INVALID", "unsupported certificate algorithm");
  for (const [name, item] of Object.entries(cert)) if (name !== "not_before" && name !== "not_after" && (typeof item !== "string" || item.length === 0)) throw new IdentityValidationError("IDENTITY_INVALID", `invalid certificate ${name}`);
  if (!Number.isSafeInteger(cert.not_before) || !Number.isSafeInteger(cert.not_after) || cert.not_after <= cert.not_before || cert.not_after - cert.not_before > 3600) throw new IdentityValidationError("IDENTITY_INVALID", "invalid certificate lifetime");
  base64url(cert.public_key, "public_key"); base64url(cert.signature, "certificate signature");
  const p = value.payload; const s = p.session;
  for (const item of [p.issuer, p.audience, p.tool, p.call_id, p.jti, p.args_sha256, s?.root, s?.parent, s?.worker]) if (typeof item !== "string" || item.length === 0 || item.length > 1024) throw new IdentityValidationError("IDENTITY_INVALID", "invalid identity field");
  if (!/^sha256:[0-9a-f]{64}$/.test(p.args_sha256) || !s || !Number.isSafeInteger(s.depth) || s.depth < 0 || s.depth > MAX_LINEAGE_DEPTH || !Array.isArray(s.lineage) || s.lineage.length < 3 || s.lineage.length > MAX_LINEAGE_LENGTH || s.lineage.some((x) => typeof x !== "string" || x.length > 1024) || !Number.isSafeInteger(p.iat) || !Number.isSafeInteger(p.exp) || p.exp <= p.iat) throw new IdentityValidationError("IDENTITY_INVALID", "invalid identity bounds");
  if (signed) base64url(value.signature, "signature");
}
