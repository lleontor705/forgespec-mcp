import { describe, expect, it } from "vitest";
import {
  normalizeFileScope,
  normalizeFileScopes,
  scopesOverlap,
} from "../../src/domain/leases/file-scopes.js";

describe("domain file scopes", () => {
  it("canonicalizes separators, NFC, dots, and Windows-insensitive paths", () => {
    expect(normalizeFileScope("./src\\É\\./file.ts", "sensitive")).toEqual({
      normalized_scope: "src/É/file.ts", base_path: "src/É/file.ts", scope_kind: "exact",
    });
    expect(normalizeFileScope("SRC\\File.TS", "insensitive").normalized_scope).toBe("src/file.ts");
  });

  it.each(["", "/tmp/x", "\\\\server\\share", "C:/tmp/x", "../x", "a/../x", "a//x", "a/", "a\0x"])(
    "rejects unsafe or non-canonical pattern %j", (pattern) => {
      expect(() => normalizeFileScope(pattern, "sensitive")).toThrow();
    },
  );

  it.each(["src/**", "src/*"])(
    "accepts only trailing glob forms (%j)", (pattern) => {
      expect(() => normalizeFileScope(pattern, "sensitive")).not.toThrow();
    },
  );

  it.each(["*", "src/*/x", "src/**/x", "src/[ab].ts", "src/{a,b}.ts"])(
    "rejects unsupported glob %j", (pattern) => {
      expect(() => normalizeFileScope(pattern, "sensitive")).toThrow();
    },
  );

  it("rejects duplicates and excessive requests", () => {
    expect(() => normalizeFileScopes(["src\\x", "src/x"], "sensitive")).toThrow("Duplicate");
    expect(() => normalizeFileScopes(Array.from({ length: 101 }, (_, i) => `x${i}`), "sensitive")).toThrow();
  });

  it("uses exact, direct-child, and recursive overlap semantics", () => {
    const n = (value: string) => normalizeFileScope(value, "sensitive");
    expect(scopesOverlap(n("a/x"), n("a/*"))).toBe(true);
    expect(scopesOverlap(n("a/x/y"), n("a/*"))).toBe(false);
    expect(scopesOverlap(n("a/x/y"), n("a/**"))).toBe(true);
    expect(scopesOverlap(n("a/*"), n("a/x/**"))).toBe(true);
    expect(scopesOverlap(n("a/**"), n("a/x/*"))).toBe(true);
    expect(scopesOverlap(n("a/*"), n("a/x/*"))).toBe(false);
  });

  it("fails closed for invalid scope objects", () => {
    expect(scopesOverlap({ normalized_scope: "", base_path: "", scope_kind: "exact" }, normalizeFileScope("x", "sensitive"))).toBe(false);
  });
});
