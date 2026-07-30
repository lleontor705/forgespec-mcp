import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { describe, expect, it } from "vitest";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const lockfilePath = path.join(PROJECT_ROOT, "package-lock.json");
const ci = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const release = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "release.yml"), "utf8");
const workflows = `${ci}\n${release}`;

const RUNTIME_KEY = /npm-\$\{\{ runner\.os \}\}-\$\{\{ runner\.arch \}\}-(?:\$\{\{ matrix\.node-line \}\}|22\.x|24\.18\.1)/;

function workflowJobs(workflow: string): string[] {
  return workflow
    .split(/\n(?=  [A-Za-z0-9_-]+:)/)
    .filter((section) => /^  [A-Za-z0-9_-]+:/.test(section));
}

function readLockfile(): Record<string, any> {
  return JSON.parse(fs.readFileSync(lockfilePath, "utf8")) as Record<string, any>;
}

describe("package-lock runtime policy", () => {
  it("contains only the supported root engines metadata", () => {
    const lock = readLockfile();
    expect(lock.packages?.[""]?.engines?.node).toBe(">=22 <23 || >=24 <25");
  });

  it("rejects dependency-tree churn outside the approved native dependency upgrade", () => {
    const current = readLockfile();
    const baseline = JSON.parse(
      execFileSync("git", ["show", "HEAD:package-lock.json"], { cwd: PROJECT_ROOT, encoding: "utf8" })
    ) as Record<string, any>;

    expect(current.packages?.[""]?.dependencies?.["better-sqlite3"]).toBe("12.11.1");
    expect(current.packages?.["node_modules/better-sqlite3"]).toEqual({
      version: "12.11.1",
      resolved: "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-12.11.1.tgz",
      integrity: "sha512-dq9AtApgg5PGFtBzPFSBl3HZQjHok5gaQCM6zh2Yk0aSmDCs1CbnVI8/HgASQkNKsWFpseIO9beg5xxpYhbIfA==",
      hasInstallScript: true,
      license: "MIT",
      dependencies: {
        bindings: "^1.5.0",
        "prebuild-install": "^7.1.1",
      },
      engines: {
        node: "20.x || 22.x || 23.x || 24.x || 25.x || 26.x",
      },
    });

    const currentWithoutRootEngine = structuredClone(current);
    const baselineWithoutRootEngine = structuredClone(baseline);
    delete currentWithoutRootEngine.packages?.[""]?.engines?.node;
    delete baselineWithoutRootEngine.packages?.[""]?.engines?.node;
    delete currentWithoutRootEngine.packages?.[""]?.dependencies?.["better-sqlite3"];
    delete baselineWithoutRootEngine.packages?.[""]?.dependencies?.["better-sqlite3"];
    delete currentWithoutRootEngine.packages?.["node_modules/better-sqlite3"];
    delete baselineWithoutRootEngine.packages?.["node_modules/better-sqlite3"];

    expect(currentWithoutRootEngine).toEqual(baselineWithoutRootEngine);
    expect(Object.keys(current.packages?.[""]?.engines ?? {})).toEqual(["node"]);
    expect(current.packages?.[""]?.volta).toBeUndefined();
  });

  it("installs every runtime job from its own checkout with npm ci", () => {
    const installJobs = workflowJobs(workflows).filter((job) => /npm ci/.test(job));
    expect(installJobs.length).toBeGreaterThanOrEqual(3);
    for (const job of installJobs) {
      expect(job).toMatch(/actions\/checkout@/);
      expect(job).not.toMatch(/actions\/cache[^\n]*node_modules|path:\s*.*node_modules/);
    }
  });

  it("segments npm download caches by OS, architecture, runtime, and lockfile", () => {
    expect(workflows).toMatch(/uses:\s*actions\/cache@/);
    expect(workflows).toMatch(/path:\s*~\/\.npm/);
    expect(workflows).toMatch(RUNTIME_KEY);
    expect(workflows).toMatch(/hashFiles\(['"]package-lock\.json['"]\)/);
    expect(workflows).not.toMatch(/path:\s*[^\n]*node_modules/);
    expect(workflows).not.toMatch(/restore-keys:[\s\S]*node_modules/);
  });

  it("forbids dependency resolver commands and cross-job native artifacts", () => {
    expect(workflows).not.toMatch(/npm (?:install|update|audit\s+fix)/);
    expect(workflows).not.toMatch(/upload-artifact|download-artifact/);
  });
});
