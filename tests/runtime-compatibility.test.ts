import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { assertSupportedRuntime, collectRuntimeEvidence } from "../src/runtime/runtime-evidence.js";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
  engines?: { node?: string };
  volta?: { node?: string };
};
const ci = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const release = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "release.yml"), "utf8");

describe("Node runtime compatibility policy", () => {
  it("pins the primary project runtime exactly and keeps Node 22 as the minimum", () => {
    expect(packageJson.volta?.node).toBe("24.18.1");
    expect(packageJson.engines?.node).toBe(">=22");
  });

  it("does not advertise EOL runtimes or floating primary pins", () => {
    const files = ["package.json", "README.md", path.join("docs", "direct-v1.md"), path.join("docs", "migrations.md")]
      .map((file) => fs.readFileSync(path.join(PROJECT_ROOT, file), "utf8")).join("\n");
    expect(files).not.toMatch(/Node(?:\.js)?\s*(?:18|20)(?:\b|\.x)/i);
    expect(packageJson.volta?.node).toBe("24.18.1");
  });

  it("defines six isolated runtime and operating-system compatibility jobs", () => {
    expect(ci).toMatch(/node-version(?:s)?:[\s\S]*22\.x/);
    expect(ci).toMatch(/node-version(?:s)?:[\s\S]*24\.x/);
    for (const os of ["ubuntu-latest", "windows-latest", "macos-latest"]) expect(ci).toContain(os);
    expect(ci.match(/npm ci/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });

  it("keeps exact Node24 distinct from 24.x compatibility and release", () => {
    expect(ci).toMatch(/node-version:\s*["']24\.18\.1["']/);
    expect(release).toMatch(/node-version:\s*["']24\.18\.1["']/);
    expect(release).toMatch(/node22-compatibility-gate/);
  });

  it("requires ABI-specific native and temporary handshake evidence", () => {
    expect(`${ci}\n${release}`).toMatch(/127/);
    expect(`${ci}\n${release}`).toMatch(/137/);
    expect(`${ci}\n${release}`).toMatch(/better-sqlite3/);
    expect(`${ci}\n${release}`).toMatch(/runtime-smoke/);
    expect(`${ci}\n${release}`).toMatch(/initialize/);
    expect(`${ci}\n${release}`).toMatch(/tools\/list/);
  });

  it("collects native, migration, and JSON-RPC evidence through the production seam", async () => {
    const evidence = await collectRuntimeEvidence({ mode: "source", entrypoint: path.join(PROJECT_ROOT, "src", "index.ts"), expectedAbi: "137" });
    assertSupportedRuntime(evidence, "137");
    expect(evidence.better_sqlite3_loaded).toBe(true);
    expect(evidence.sqlite_features).toEqual({ strict: true, json1: true, wal: true });
    expect(evidence.migration_ok).toBe(true);
    expect(evidence.handshake).toMatchObject({ initialize: true, tools_list: true });
    expect(evidence.handshake.tool_count).toBeGreaterThan(0);
  }, 15_000);
});
