#!/usr/bin/env node
import { createInterface } from "node:readline";
import { IdentityBroker, MAX_FRAME_BYTES, encodeFrame, decodeFrame, canonicalIssuer } from "./broker.js";
import { SDD_TOOL_CATALOG } from "../protocol/capabilities.js";
import { openIdentityStore } from "./store.js";

type Request = { session?: { root?: unknown; parent?: unknown; worker?: unknown; lineage?: unknown }; root?: unknown; parent?: unknown; call?: unknown; tool?: unknown; args?: unknown; audience?: unknown; revokeLeaf?: unknown };
const sidecar = process.env.FORGESPEC_IDENTITY_SIDECAR_PATH;
const broker = new IdentityBroker({ publishRevocation: (statement) => {
  if (!sidecar) throw new Error("REVOCATION_SIDECAR_UNAVAILABLE");
  const database = openIdentityStore(sidecar);
   try { database.prepare("INSERT INTO fsi_revocations (issuer,key_id,revoked_at,signature) VALUES (?,?,?,?)").run(issuer, statement.certificate, statement.revoked_at, statement.signature); }
  finally { database.close(); }
} });
const issuer = canonicalIssuer(broker.rootPublicKey);
const kid = issuer.slice("root:".length);

function write(value: string): void { process.stdout.write(`${value}\n`); }
function error(id: string, code: string): void {
  write(encodeFrame(id || "error", { error: { code, message: code } }));
}
function requestPayload(value: unknown): { session: { root: string; parent?: string; worker?: string }; tool: string; args?: unknown; audience?: string; callId?: string } {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("INVALID_REQUEST");
  const input = value as Request;
  if (typeof input.tool !== "string" || !SDD_TOOL_CATALOG.includes(input.tool as never)) throw new Error("INVALID_TOOL");
  const raw = input.session && typeof input.session === "object" ? input.session : undefined;
  const root = raw?.root ?? input.root;
  const parent = raw?.parent ?? input.parent;
  const worker = raw?.worker;
  const lineage = raw?.lineage ?? (value as Request & { lineage?: unknown }).lineage;
  if (typeof root !== "string" || !root || (parent !== undefined && typeof parent !== "string") || (worker !== undefined && typeof worker !== "string")) throw new Error("INVALID_SESSION");
  if (input.call !== undefined && typeof input.call !== "string") throw new Error("INVALID_CALL");
  if (input.audience !== undefined && typeof input.audience !== "string") throw new Error("INVALID_AUDIENCE");
  if (lineage !== undefined && (!Array.isArray(lineage) || lineage.some((x) => typeof x !== "string"))) throw new Error("INVALID_SESSION");
  return { session: { root, ...(parent === undefined ? {} : { parent }), ...(worker === undefined ? {} : { worker }), ...(lineage === undefined ? {} : { lineage: lineage as string[] }) }, tool: input.tool, args: input.args, audience: input.audience as string | undefined, callId: input.call as string | undefined };
}

write(JSON.stringify({ type: "ready", issuer, audience: "broker", root_public_key: broker.rootPublicKey, kid }));
const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });
let closed = false;
rl.on("line", (line) => {
  if (closed) return;
  try {
    if (Buffer.byteLength(line, "utf8") > MAX_FRAME_BYTES) throw new Error("FRAME_TOO_LARGE");
    const frame = decodeFrame(line);
    const payload = frame.payload as Request;
    if (payload && typeof payload.revokeLeaf === "string") write(encodeFrame(frame.id, broker.revokeLeaf(payload.revokeLeaf)));
    else { const input = requestPayload(payload); write(encodeFrame(frame.id, broker.attest({ session: input.session, tool: input.tool, args: input.args, audience: input.audience, callId: input.callId }))); }
  } catch (cause) {
    const code = cause instanceof Error && /^(INVALID_|FRAME_|invalid frame)/.test(cause.message) ? cause.message : "INVALID_REQUEST";
    error("request", code);
    closed = true;
    rl.close();
    process.stdin.destroy();
  }
});
rl.on("close", () => { closed = true; });
