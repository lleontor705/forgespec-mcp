import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";
import {
  assertRemoteTagAbsent,
  assertRemoteTagCommit,
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

describe("release workflow policy", () => {
  it("accepts only one leading v followed by strict stable SemVer", () => {
    const prepare = job("prepare-release", "node22-compatibility-gate");
    expect(prepare).toMatch(/TAG: \$\{\{ inputs\.tag \}\}/);
    expect(prepare).toMatch(/VERSION="\$\{TAG#v\}"/);
    expect(prepare).toMatch(/semver\.valid\(version\)/);
    expect(prepare).toMatch(/semver\.prerelease\(version\) === null/);
    expect(prepare).toMatch(/semver\.parse\(version\)\.build\.length === 0/);
    expect(prepare).toMatch(/this workflow publishes stable releases only; expected vMAJOR\.MINOR\.PATCH/);

    const semver = path.join(PROJECT_ROOT, "node_modules", "semver");
    const validate = 'const semver = require(process.argv[1]); const version = process.argv[2]; process.exit(semver.valid(version) !== null && semver.prerelease(version) === null && semver.parse(version).build.length === 0 ? 0 : 1)';
    for (const tag of ["v0.0.0", "v1.2.3", "v1.5.0"]) {
      expect(() => execFileSync(process.execPath, ["-e", validate, semver, tag.slice(1)], { stdio: "pipe" })).not.toThrow();
    }
    for (const tag of ["v1.5.0-alpha.1", "v1.5.0+build.1", "v=1.2.3", "v1.2", "v01.2.3", "v1.2.3-01", "v1.2.3+build..1"]) {
      expect(() => execFileSync(process.execPath, ["-e", validate, semver, tag.slice(1)], { stdio: "pipe" })).toThrow();
    }
  });

  it("uses manual dispatch as the only authority and binds source to dispatch SHA", () => {
    expect(release).toMatch(/on:\s*\n\s+workflow_dispatch:/);
    expect(release).not.toMatch(/push:\s*\n\s+tags:/);
    expect(release).toMatch(/SOURCE_SHA: \$\{\{ github\.sha \}\}/);
    expect(release).toMatch(/concurrency:\s*\n\s+group: release-publication\s*\n\s+cancel-in-progress: false/);
    expect(release).not.toMatch(/group:[^\n]*(?:inputs\.tag|github\.ref|github\.sha)/);
    expect(release).toMatch(/cancel-in-progress: false/);
  });

  it("checks out the immutable source in every job that reads repository content", () => {
    const sections = [
      job("prepare-release", "node22-compatibility-gate"),
      job("node22-compatibility-gate", "release-node24"),
      job("release-node24", "approve-release"),
      job("publish"),
    ];
    for (const section of sections) {
      expect(section).toMatch(/actions\/checkout@v5[\s\S]*?ref: \$\{\{ (?:env\.SOURCE_SHA|needs\.prepare-release\.outputs\.source_sha) \}\}/);
    }
  });

  it("distinguishes an absent remote tag and verifies annotated tag targets", () => {
    const tag = "v1.2.3";
    const tagObject = "a".repeat(40);
    const source = "b".repeat(40);
    expect(parseRemoteTagCommit("", tag)).toBeNull();
    expect(parseRemoteTagCommit(`${source}\trefs/tags/${tag}\n`, tag)).toBe(source);
    expect(parseRemoteTagCommit(`${tagObject}\trefs/tags/${tag}\n${source}\trefs/tags/${tag}^{}\n`, tag)).toBe(source);
    expect(() => assertRemoteTagAbsent("", tag)).not.toThrow();
    expect(() => assertRemoteTagAbsent(`${source}\trefs/tags/${tag}\n`, tag)).toThrow(/already exists/);
    expect(() => assertRemoteTagCommit(`${tagObject}\trefs/tags/${tag}\n${source}\trefs/tags/${tag}^{}\n`, tag, source)).not.toThrow();
    expect(() => assertRemoteTagCommit(`${tagObject}\trefs/tags/${tag}\n${source}\trefs/tags/${tag}^{}\n`, tag, tagObject)).toThrow(/expected/);
    expect(() => assertRemoteTagCommit("", tag, source)).toThrow(/missing/);
    expect(() => parseRemoteTagCommit(`invalid\trefs/tags/${tag}\n`, tag)).toThrow(/Unexpected/);
  });

  it("re-checks HEAD and remote absence immediately before external mutation", () => {
    const publish = job("publish");
    const headCheck = publish.indexOf('test "$(git rev-parse HEAD)" = "$EXPECTED_SOURCE_SHA"');
    const absenceCheck = publish.indexOf("assert-remote-tag-absent");
    const tagPush = publish.indexOf("git push --no-verify origin");
    expect(Math.min(headCheck, absenceCheck, tagPush)).toBeGreaterThanOrEqual(0);
    expect(headCheck).toBeLessThan(absenceCheck);
    expect(absenceCheck).toBeLessThan(tagPush);
  });

  it("runs gates before package mutation and avoids repeating lint or tests in publish", () => {
    const verification = job("release-node24", "approve-release");
    const publish = job("publish");
    expect(verification).toMatch(/npm run lint[\s\S]*npm test[\s\S]*npm run build/);
    expect(publish).toMatch(/npm ci[\s\S]*npm run build[\s\S]*npm version/);
    expect(publish).not.toMatch(/npm run lint|npm test/);
    expect(publish).toMatch(/npm version[^\n]*--ignore-scripts/);
    expect(publish).toMatch(/npm pack[^\n]*--ignore-scripts/);
    expect(publish).toMatch(/npm publish[^\n]*--provenance[^\n]*--access public[^\n]*--ignore-scripts/);
  });

  it("creates and verifies the tag before npm and GitHub release mutations", () => {
    const publish = job("publish");
    const recheck = publish.indexOf("assert-remote-tag-absent");
    const push = publish.indexOf("git push --no-verify origin");
    const verifications = [...publish.matchAll(/verify-remote-tag "\$TAG" "\$EXPECTED_SOURCE_SHA"/g)].map((match) => match.index);
    const npm = publish.indexOf("npm publish");
    const github = publish.indexOf("gh release create");
    expect(verifications).toHaveLength(2);
    expect(Math.min(recheck, push, ...verifications, npm, github)).toBeGreaterThanOrEqual(0);
    expect(recheck).toBeLessThan(push);
    expect(push).toBeLessThan(verifications[0]);
    expect(verifications[0]).toBeLessThan(npm);
    expect(npm).toBeLessThan(verifications[1]);
    expect(verifications[1]).toBeLessThan(github);
    expect(npm).toBeLessThan(github);
    expect(publish).toMatch(/git tag --annotate "\$TAG" "\$EXPECTED_SOURCE_SHA"/);
    expect(publish).toMatch(/gh release create "\$TAG" --verify-tag/);
    expect(publish).not.toMatch(/gh release create[^\n]*\|\| true/);
  });

  it("bypasses hooks only for the non-force release tag push", () => {
    const publish = job("publish");
    const tagPush = publish
      .split("\n")
      .find((line) => line.includes('git push') && line.includes('"refs/tags/$TAG:refs/tags/$TAG"'));
    expect(tagPush?.trim()).toBe('git push --no-verify origin "refs/tags/$TAG:refs/tags/$TAG"');
    expect(tagPush).not.toMatch(/(?:^|\s)(?:--force(?:-with-lease)?|-f)(?:\s|$)/);
    expect(tagPush).not.toMatch(/\|\||;|\|\s*true/);
  });

  it("keeps approval, runtime, permissions, and partial-state safeguards", () => {
    expect(release).toMatch(/matrix:[\s\S]*ubuntu-latest, windows-latest, macos-latest/);
    expect(release).toMatch(/node-version: "22\.x"/);
    expect(release.match(/node-version: "24\.18\.1"/g)).toHaveLength(2);
    expect(job("approve-release", "publish")).toMatch(/environment: production/);
    expect(release).toMatch(/permissions:\s*\n\s+contents: read/);
    expect(job("publish")).toMatch(/permissions:\s*\n\s+contents: write\s*\n\s+id-token: write/);
    expect(job("publish")).toMatch(/Reconcile manually:[^\n]*refs\/tags\/\$TAG[^\n]*npm view[^\n]*gh release view/);
  });
});
