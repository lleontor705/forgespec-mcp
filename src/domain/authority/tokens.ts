import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateClaimToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashClaimToken(token: string): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(token, "utf8").digest("hex")}`;
}

export function verifyClaimToken(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashClaimToken(token), "utf8");
  const expected = Buffer.from(storedHash, "utf8");
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
