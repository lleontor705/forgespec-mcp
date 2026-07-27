import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export function generateAuthorityToken(): string {
  return randomBytes(32).toString("base64url");
}

export function hashAuthorityToken(token: string): string {
  return `sha256:${createHash("sha256").update(token).digest("hex")}`;
}

export function authorityTokenMatches(token: string, storedHash: string): boolean {
  const candidate = Buffer.from(hashAuthorityToken(token));
  const expected = Buffer.from(storedHash);
  return candidate.length === expected.length && timingSafeEqual(candidate, expected);
}
