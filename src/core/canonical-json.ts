import { createHash } from "node:crypto";

export function canonicalJson(value: unknown): string {
  return encode(value, new Set());
}

export function canonicalSha256(value: unknown): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(canonicalJson(value)).digest("hex")}`;
}

function encode(value: unknown, ancestors: Set<object>): string {
  if (value === null) return "null";
  if (typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("Canonical JSON numbers must be finite");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") throw new TypeError("Canonical JSON does not support undefined");
  if (typeof value !== "object") throw new TypeError(`Canonical JSON does not support ${typeof value}`);
  if (ancestors.has(value)) throw new TypeError("Canonical JSON does not support cyclic values");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) return `[${value.map((item) => encode(item, ancestors)).join(",")}]`;
    const object = value as Record<string, unknown>;
    const entries = Object.keys(object)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${encode(object[key], ancestors)}`);
    return `{${entries.join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}
