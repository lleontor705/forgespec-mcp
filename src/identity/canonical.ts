import { createHash } from "node:crypto";

export const MAX_IDENTITY_BYTES = 16_384;
const B64URL = /^[A-Za-z0-9_-]+$/;

export function base64url(value: string, name = "value"): Buffer {
  if (!B64URL.test(value) || value.length > 8192) throw new IdentityValidationError("IDENTITY_ENCODING_INVALID", `${name} is not canonical base64url`);
  const bytes = Buffer.from(value, "base64url");
  if (bytes.toString("base64url") !== value) throw new IdentityValidationError("IDENTITY_ENCODING_INVALID", `${name} is not canonical base64url`);
  return bytes;
}

export function canonicalJson(value: unknown): string {
  return encode(value, new Set<object>());
}

export function canonicalBytes(value: unknown): Buffer {
  const bytes = Buffer.from(canonicalJson(value), "utf8");
  if (bytes.length > MAX_IDENTITY_BYTES) throw new IdentityValidationError("IDENTITY_SIZE_EXCEEDED", "identity envelope is too large");
  return bytes;
}

export function sha256(value: string): string { return `sha256:${createHash("sha256").update(value).digest("hex")}`; }

export class IdentityValidationError extends Error {
  constructor(public readonly code: "IDENTITY_INVALID" | "IDENTITY_ENCODING_INVALID" | "IDENTITY_SIZE_EXCEEDED" | "IDENTITY_SIGNATURE_INVALID", message: string) { super(message); }
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new IdentityValidationError("IDENTITY_INVALID", "numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value !== "object" || value === undefined) throw new IdentityValidationError("IDENTITY_INVALID", "unsupported JSON value");
  if (ancestors.has(value)) throw new IdentityValidationError("IDENTITY_INVALID", "cyclic JSON value");
  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    return `{${Object.keys(value as object).sort().map((key) => `${JSON.stringify(key)}:${encode((value as Record<string, unknown>)[key], ancestors)}`).join(",")}}`;
  } finally { ancestors.delete(value); }
}
