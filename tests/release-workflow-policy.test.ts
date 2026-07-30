import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertDispatchProvenance,
  assertRemoteTagCommit,
  classifyReleaseLookupStatus,
  parseRemoteTagCommit,
} from "../.github/scripts/release-policy.mjs";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const release = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "release.yml"), "utf8");

function job(name: string, next?: string): string {
  const start = release.indexOf(`  ${name}:`);
  expect(start).toBeGreaterThanOrEqual(0);
  const end = next ? release.indexOf(`  ${next}:`, start + name.length) : release.length;
  expect(end).toBeGreaterThan(start);
  return release.slice(start, end);
}

function stepIndex(section: string, command: RegExp): number {
  const index = section.search(command);
  expect(index).toBeGreaterThanOrEqual(0);
  return index;
}

describe("release workflow policy", () => {
  it("uses strict semver.valid semantics before resolving an immutable source", () => {
    const prepare = job("prepare-release", "node22-compatibility-gate");
    const node22 = job("node22-compatibility-gate", "release-node24");
    expect(prepare).toMatch(/REQUESTED_TAG:[^\n]*(?:inputs\.tag|github\.ref_name)/);
    expect(prepare).toMatch(/VERSION="\$\{TAG#v\}"/);
    expect(prepare).toMatch(/npm exec --yes --package=semver@7\.7\.4 -- node -e [^\n]*semver\.valid\(process\.argv\[1\]\)[^\n]*"\$VERSION"/);
    expect(prepare).toMatch(/show-ref --verify --quiet "refs\/tags\/\$TAG"/);
    expect(prepare).toMatch(/release-policy\.mjs assert-dispatch/);
    expect(prepare).toMatch(/source_sha=\$SOURCE_SHA/);
    expect(node22).toMatch(/needs: prepare-release/);

    const semver = path.join(PROJECT_ROOT, "node_modules", "semver");
    const strictValidation =
      'const semver = require(process.argv[1]); process.exit(semver.valid(process.argv[2]) === null ? 1 : 0)';
    for (const tag of ["v0.0.0", "v1.2.3", "v1.2.3-alpha.1", "v1.2.3-alpha.1+build.5", "v1.2.3+build.5"]) {
      expect(() => execFileSync(process.execPath, ["-e", strictValidation, semver, tag.slice(1)], { stdio: "pipe" })).not.toThrow();
    }
    for (const tag of ["v=1.2.3", "v1.2", "v01.2.3", "v1.2.3-01", "v1.2.3-alpha..1", "v1.2.3+build..1"]) {
      expect(() => execFileSync(process.execPath, ["-e", strictValidation, semver, tag.slice(1)], { stdio: "pipe" })).toThrow();
    }
  });

  it("requires manual dispatch provenance to match the requested tag and source", () => {
    const provenance = {
      eventName: "workflow_dispatch",
      refType: "tag",
      refName: "v1.2.3",
      eventSha: "a".repeat(40),
      tag: "v1.2.3",
      sourceSha: "a".repeat(40),
    };
    expect(() => assertDispatchProvenance(provenance)).not.toThrow();
    expect(() => assertDispatchProvenance({ ...provenance, refType: "branch" })).toThrow(/gh workflow run.*--ref/);
    expect(() => assertDispatchProvenance({ ...provenance, refName: "v1.2.4" })).toThrow(/provenance mismatch/);
    expect(() => assertDispatchProvenance({ ...provenance, eventSha: "b".repeat(40) })).toThrow(/provenance mismatch/);
    expect(() => assertDispatchProvenance({ ...provenance, eventName: "push", refType: "tag" })).not.toThrow();
  });

  it("checks out the resolved source SHA in every runtime and publish job", () => {
    const sections = [
      job("node22-compatibility-gate", "release-node24"),
      job("release-node24", "approve-release"),
      job("publish"),
    ];
    for (const section of sections) {
      expect(section).toMatch(/actions\/checkout@v5[\s\S]*?ref: \$\{\{ needs\.prepare-release\.outputs\.source_sha \}\}/);
    }
    expect(job("publish")).toMatch(/test "\$TAG_SHA" = "\$SOURCE_SHA"/);
  });

  it("peels annotated remote tags and fails closed for missing or moved tags", () => {
    const tag = "v1.2.3";
    const tagObject = "a".repeat(40);
    const source = "b".repeat(40);
    expect(parseRemoteTagCommit(`${source}\trefs/tags/${tag}\n`, tag)).toBe(source);
    expect(
      parseRemoteTagCommit(`${tagObject}\trefs/tags/${tag}\n${source}\trefs/tags/${tag}^{}\n`, tag)
    ).toBe(source);
    expect(() => parseRemoteTagCommit("", tag)).toThrow(/missing/);
    expect(() => assertRemoteTagCommit(`${source}\trefs/tags/${tag}\n`, tag, source)).not.toThrow();
    expect(() => assertRemoteTagCommit(`${source}\trefs/tags/${tag}\n`, tag, tagObject)).toThrow(/moved/);

    const publish = job("publish");
    const checks = publish.match(/verify-remote-tag "\$TAG" "\$SOURCE_SHA"/g) ?? [];
    expect(checks).toHaveLength(2);
    expect(stepIndex(publish, /verify-remote-tag/)).toBeLessThan(stepIndex(publish, /npm publish/));
    expect(publish.lastIndexOf("verify-remote-tag")).toBeLessThan(stepIndex(publish, /lookup-github-release/));
  });

  it("runs quality gates before mutating package metadata", () => {
    const publish = job("publish");
    const mutation = stepIndex(publish, /npm version/);
    for (const gate of [/npm run lint/, /npm test/, /npm run build/]) {
      expect(stepIndex(publish, gate)).toBeLessThan(mutation);
    }
    expect(mutation).toBeLessThan(stepIndex(publish, /npm pack --json/));
    expect(stepIndex(publish, /npm pack --json/)).toBeLessThan(stepIndex(publish, /npm publish/));
    expect(publish).toMatch(/npm publish[^\n]*--ignore-scripts/);
  });

  it("keeps the tag, packed version, published source, and GitHub release aligned", () => {
    const publish = job("publish");
    expect(publish).toMatch(/p\.version !== process\.env\.EXPECTED_VERSION/);
    expect(publish).toMatch(/gh release create "\$TAG" --verify-tag --target "\$SOURCE_SHA"/);
    expect(publish).toMatch(/lookup-github-release "\$TAG"/);
    expect(publish).not.toMatch(/gh release create[^\n]*\|\|/);
  });

  it("creates a GitHub release only for an explicit HTTP 404", () => {
    expect(classifyReleaseLookupStatus(200)).toBe("exists");
    expect(classifyReleaseLookupStatus(404)).toBe("missing");
    for (const status of [0, 401, 403, 429, 500, 503]) {
      expect(() => classifyReleaseLookupStatus(status)).toThrow(/lookup failed/);
    }
  });

  it("serializes each tag and grants write permissions only to publish", () => {
    expect(release).toMatch(/push:\s*\n\s+tags:\s*\n\s+- "v\*"/);
    expect(release).toMatch(/workflow_dispatch:/);
    expect(release).not.toMatch(/^\s+release:\s*$/m);
    expect(release).toMatch(/concurrency:\s*\n\s+group: release-.*inputs\.tag.*github\.ref_name/);
    expect(release).toMatch(/permissions:\s*\n\s+contents: read/);
    const publish = job("publish");
    expect(publish).toMatch(/permissions:\s*\n\s+contents: write\s*\n\s+id-token: write/);
    expect(job("prepare-release", "node22-compatibility-gate")).not.toMatch(/contents: write|id-token: write/);
  });
});
