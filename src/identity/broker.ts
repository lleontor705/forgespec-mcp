import { createHash, createPublicKey, generateKeyPairSync, sign, verify, type KeyObject } from "node:crypto";
import { canonicalJson, canonicalBytes, sha256, base64url } from "./canonical.js";
import { signIdentityEnvelope, verifyIdentityEnvelope, type IdentityEnvelope, type LeafCertificate, type IdentitySession } from "./types.js";
import { MAX_LINEAGE_DEPTH } from "./constants.js";

export type SessionStrings = { root: string; parent?: string; worker?: string; lineage?: string[] };
export type PseudonymousHandles = { root: string; parent: string; worker: string; call: string; lineage: string[] };
export type BrokerOptions = { attestationSeconds?: number; leafSeconds?: number; overlapSeconds?: number; now?: () => number; publishRevocation?: (statement: { certificate: string; revoked_at: number; signature: string }) => void };
export type AttestInput = { session: SessionStrings; tool: string; args?: unknown; audience?: string; callId?: string; now?: number };
export const canonicalIssuer = (rootPublicKey: string) => `root:${digest(rootPublicKey)}`;

const B64 = (k: KeyObject) => k.export({ format: "der", type: "spki" }).toString("base64url");
const digest = (v: unknown) => sha256(canonicalJson(v));

export function derivePseudonymousHandles(session: SessionStrings, callId = ""): PseudonymousHandles {
  const source = session.lineage?.length
    ? (session.lineage.length >= 3
        ? session.lineage
        : (session.lineage.length === 2
            ? [session.lineage[0], `${session.root}:parent`, session.lineage[1]]
            : [session.lineage[0], `${session.root}:parent`, `${session.root}:worker`]))
    : [session.root, session.parent ?? `${session.root}:parent`, session.worker ?? `${session.root}:worker`];
  if (source.length - 1 > MAX_LINEAGE_DEPTH) throw new Error("SESSION_LINEAGE_INVALID");
  if (source.length < 3 || source.some((item) => typeof item !== "string" || !item)) throw new Error("invalid session lineage");
  const lineage = source.map((item, index) => `lineage:${digest(`${session.root}\0${index}\0${item}`)}`);
  const [root, parent, worker] = [lineage[0], lineage.at(-2)!, lineage.at(-1)!];
  return { root, parent, worker, lineage, call: `call:${digest(`${worker}\0${callId}`)}` };
}

export function sanitizeBusinessArgs(args: unknown): unknown {
  const value = args === undefined ? null : args;
  const top = value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : value;
  if (top && typeof top === "object" && !Array.isArray(top)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(top).sort()) if (!/^(?:caller|caller_id|callerId|actor|actor_id|actorId|identity|_identity)$/i.test(key)) out[key] = (top as Record<string, unknown>)[key];
    return JSON.parse(canonicalJson(out));
  }
  return JSON.parse(canonicalJson(value));
}

function certBody(cert: LeafCertificate) { return { algorithm: cert.algorithm, issuer: cert.issuer, public_key: cert.public_key, not_before: cert.not_before, not_after: cert.not_after }; }

export class IdentityBroker {
  readonly rootPublicKey: string;
  private readonly rootPrivate: KeyObject;
  private leaf: { privateKey: KeyObject; certificate: LeafCertificate; expires: number } | undefined;
  private readonly revoked = new Set<string>();
  private readonly now: () => number;
  private readonly attestationSeconds: number;
  private readonly leafSeconds: number;
  private readonly overlapSeconds: number;
  private readonly publishRevocation?: BrokerOptions["publishRevocation"];

  constructor(options: BrokerOptions = {}) {
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000));
    this.attestationSeconds = Math.min(options.attestationSeconds ?? 15, 30);
    this.leafSeconds = Math.min(options.leafSeconds ?? 600, 3600);
    this.overlapSeconds = Math.min(options.overlapSeconds ?? 60, 3600);
    this.publishRevocation = options.publishRevocation;
    if (this.attestationSeconds <= 0 || this.leafSeconds <= 0 || this.leafSeconds > 3600 || this.overlapSeconds < 0) throw new Error("invalid broker bounds");
    const root = generateKeyPairSync("ed25519"); this.rootPrivate = root.privateKey; this.rootPublicKey = B64(root.publicKey);
  }

  attest(input: AttestInput): IdentityEnvelope {
    const now = input.now ?? this.now();
    if (!Number.isSafeInteger(now)) throw new Error("invalid time");
    const leaf = this.ensureLeaf(now);
    const handles = derivePseudonymousHandles(input.session, input.callId ?? `${now}`);
    const session: IdentitySession = { root: handles.root, parent: handles.parent, worker: handles.worker, depth: handles.lineage.length - 3, lineage: handles.lineage };
    const payload = { issuer: leaf.certificate.issuer, audience: input.audience ?? "broker", tool: input.tool, args_sha256: digest(sanitizeBusinessArgs(input.args)) as `sha256:${string}`, session, call_id: handles.call, jti: `jti:${digest(`${handles.call}\0${now}\0${Math.random()}`)}`, iat: now, exp: now + this.attestationSeconds };
    return signIdentityEnvelope({ version: "1.1", leaf_certificate: leaf.certificate, payload }, leaf.privateKey);
  }

  revokeLeaf(certificateOrKey: string): { certificate: string; revoked_at: number; signature: string } {
    const statement = { certificate: certificateOrKey, revoked_at: this.now() };
    const signed = sign(null, canonicalBytes(statement), this.rootPrivate).toString("base64url");
    const result = { ...statement, signature: signed };
    try { this.publishRevocation?.(result); } catch { throw new Error("REVOCATION_PUBLICATION_FAILED"); }
    this.revoked.add(certificateOrKey);
    if (this.leaf?.certificate.public_key === certificateOrKey) this.leaf = undefined;
    return result;
  }
  revoke(certificateOrKey: string) { return this.revokeLeaf(certificateOrKey); }

  verify(envelope: IdentityEnvelope, now = this.now()): boolean {
    try {
      if (this.revoked.has(envelope.leaf_certificate.public_key)) return false;
      const certKey = createPublicKey({ key: base64url(envelope.leaf_certificate.public_key), format: "der", type: "spki" });
      const certOk = verify(null, canonicalBytes(certBody(envelope.leaf_certificate)), createPublicKey({ key: base64url(this.rootPublicKey), format: "der", type: "spki" }), base64url(envelope.leaf_certificate.signature));
      return certOk && envelope.payload.exp - envelope.payload.iat <= 30 && envelope.payload.iat <= now + 5 && envelope.payload.exp >= now - 5 && now >= envelope.leaf_certificate.not_before - 5 && now <= envelope.leaf_certificate.not_after + 5 && envelope.payload.iat >= envelope.leaf_certificate.not_before && envelope.payload.exp <= envelope.leaf_certificate.not_after && verifyIdentityEnvelope(envelope).issuer === envelope.payload.issuer && verify(null, canonicalBytes({ leaf_certificate: envelope.leaf_certificate, payload: envelope.payload, version: envelope.version }), certKey, base64url(envelope.signature));
    } catch { return false; }
  }

  private ensureLeaf(now: number) {
    if (this.leaf && now < this.leaf.expires - this.overlapSeconds) return this.leaf;
    const pair = generateKeyPairSync("ed25519"); const expires = now + this.leafSeconds;
    const unsigned = { algorithm: "Ed25519" as const, public_key: B64(pair.publicKey), issuer: canonicalIssuer(this.rootPublicKey), not_before: now, not_after: now + this.leafSeconds };
    const certificate = { ...unsigned, signature: sign(null, canonicalBytes(unsigned), this.rootPrivate).toString("base64url") };
    this.leaf = { privateKey: pair.privateKey, certificate, expires }; return this.leaf;
  }
}

export const MAX_FRAME_BYTES = 16_384;
export function encodeFrame(correlationId: string, payload: unknown, maxBytes = MAX_FRAME_BYTES): string {
  const frame = canonicalJson({ id: correlationId, payload }); const bytes = Buffer.byteLength(frame, "utf8");
  if (!correlationId || bytes > maxBytes || frame.includes("\n") || frame.includes("\r")) throw new Error("frame exceeds bound");
  return `${frame}\n`;
}
export function decodeFrame(line: string, maxBytes = MAX_FRAME_BYTES): { id: string; payload: unknown } {
  if (!line || line.length > maxBytes || line.includes("\n") || line.includes("\r")) throw new Error("invalid frame bound");
  const parsed = JSON.parse(line) as { id?: unknown; payload?: unknown };
  if (typeof parsed.id !== "string" || !parsed.id) throw new Error("invalid frame correlation");
  canonicalJson(parsed.payload); return { id: parsed.id, payload: parsed.payload };
}
