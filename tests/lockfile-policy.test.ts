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
    expect(lock.name).toBe("forgespec-mcp");
    expect(lock.version).toBe("2.0.0");
    expect(lock.packages?.["" ]?.version).toBe("2.0.0");
    expect(lock.packages?.["" ]?.bin).toEqual({ "forgespec-identity-broker": "build/identity/broker-cli.js", "forgespec-mcp": "build/index.js" });
    expect(lock.packages?.[""]?.engines?.node).toBe(">=22 <23 || >=24 <25 || >=26 <27");
  });

  it("rejects dependency-tree churn outside the approved native dependency upgrade", () => {
    const current = readLockfile();
    const baseline = JSON.parse(
      execFileSync("git", ["show", "HEAD:package-lock.json"], { cwd: PROJECT_ROOT, encoding: "utf8" })
    ) as Record<string, any>;

    expect(current.packages?.[""]?.dependencies?.["better-sqlite3"]).toBe("^13.0.3");
    expect(current.packages?.["node_modules/better-sqlite3"]).toEqual({
      version: "13.0.3",
      resolved: "https://registry.npmjs.org/better-sqlite3/-/better-sqlite3-13.0.3.tgz",
      integrity: "sha512-RbOBxmLBG8uvFUc15X9+9SFemKcQ0WBuISBVkpuiaUB2qblC8UWlHEjdWVoZ8AdhSwmoEgsiXKfopX0CQxaACQ==",
      license: "MIT",
      dependencies: {
        "node-addon-api": "^8.0.0",
      },
      engines: {
        node: ">=22",
      },
    });

    const currentStripped = structuredClone(current);
    const baselineStripped = structuredClone(baseline);
    for (const tree of [currentStripped, baselineStripped]) {
      delete tree.version;
      delete tree.packages?.[""]?.engines?.node;
      delete tree.packages?.[""]?.version;
      delete tree.packages?.[""]?.dependencies?.["better-sqlite3"];
      delete tree.packages?.["node_modules/better-sqlite3"];
      delete tree.packages?.["node_modules/fast-uri"];
      delete tree.packages?.["node_modules/ip-address"];
      delete tree.packages?.[""]?.bin;
    }

    expect(currentStripped).toEqual(baselineStripped);
    expect(Object.keys(current.packages?.[""]?.engines ?? {})).toEqual(["node"]);
    expect(current.packages?.[""]?.volta).toBeUndefined();
    // overrides close the Trivy-flagged CVEs in the ajv transitive subtree.
    expect(current.packages?.["node_modules/fast-uri"]?.version).toBe("3.1.5");
    expect(current.packages?.["node_modules/ip-address"]?.version).toBe("10.5.0");
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
    expect(workflows).not.toMatch(/npm (?:update|audit\s+fix)/);
    const installs = workflows.match(/npm install[^\n]*/g) ?? [];
    expect(installs).toEqual([
      'npm install --prefix "$RUNNER_TEMP/opencode-host" --ignore-scripts --omit=peer --package-lock=false opencode-ai@1.18.3',
      'npm install --prefix "$TMP" --ignore-scripts --omit=peer --package-lock=false "$(pwd)/$TARBALL" "$(pwd)/$PLUGIN_TARBALL"',
      'npm install --prefix "$POST_TMP" --ignore-scripts --omit=peer --package-lock=false "opencode-forgespec@$VERSION" "forgespec-mcp@$VERSION"',
    ]);
    expect(workflows).not.toMatch(/upload-artifact|download-artifact/);
  });

  it("documents the only permitted isolated tarball install", () => {
    expect(workflows).toMatch(/npm install --prefix "\$TMP" --ignore-scripts --omit=peer --package-lock=false "\$\(pwd\)\/\$TARBALL"/);
    expect(workflows).toMatch(/npm install --prefix "\$POST_TMP" --ignore-scripts --omit=peer --package-lock=false "opencode-forgespec@\$VERSION" "forgespec-mcp@\$VERSION"/);
  });
});
