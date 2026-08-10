import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  assertSupportedRuntime,
  collectRuntimeEvidence,
  expectedAbiForNodeMajor,
  validateRuntimeEvidence,
} from "../src/runtime/runtime-evidence.js";

const CURRENT_NODE_MAJOR = Number(/^v(\d+)/.exec(process.version)?.[1]);
const CURRENT_RUNTIME_SUPPORTED = CURRENT_NODE_MAJOR === 22 || CURRENT_NODE_MAJOR === 24;
const PROJECT_ROOT = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
  engines?: { node?: string };
  volta?: { node?: string };
};
const ci = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const release = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "release.yml"), "utf8");

describe("Node runtime compatibility policy", () => {
  it.each([
    [22, "127"],
    [24, "137"],
  ])("maps Node major %s to ABI %s without runtime inference", (major, abi) => {
    expect(expectedAbiForNodeMajor(major)).toBe(abi);
  });

  it.each([
    [{ node_version: "v22.18.0", modules_abi: "127" }, undefined],
    [{ node_version: "v24.18.1", modules_abi: "137" }, undefined],
  ])("accepts coherent observed runtime evidence", (evidence, expected) => {
    expect(validateRuntimeEvidence(evidence, expected)).toEqual({
      nodeMajor: Number(evidence.node_version.slice(1).split(".")[0]),
      expectedAbi: evidence.modules_abi,
      observedAbi: evidence.modules_abi,
    });
  });

  it("rejects observed ABI mismatches with corrective diagnostics", () => {
    expect(() => validateRuntimeEvidence({ node_version: "v24.18.1", modules_abi: "127" })).toThrow(
      /Node major 24.*expected ABI 137.*observed ABI 127.*verify the Node installation/i,
    );
  });

  it("rejects explicit CI ABI contradictions without treating CI as the source of truth", () => {
    expect(() => validateRuntimeEvidence({ node_version: "v22.18.0", modules_abi: "127" }, "137")).toThrow(
      /Node major 22.*mapped ABI 127.*observed ABI 127.*explicit ABI 137/i,
    );
  });

  it.each([
    [18, "127"],
    [26, "137"],
  ])("rejects unsupported major %s even when ABI looks familiar", (major, abi) => {
    expect(() => expectedAbiForNodeMajor(major)).toThrow(/unsupported.*Node major.*22.*24/i);
    expect(() => validateRuntimeEvidence({ node_version: `v${major}.0.0`, modules_abi: abi })).toThrow(
      /unsupported.*observed.*Node major.*22.*24/i,
    );
  });

  it("does not expose an inverse ABI policy or fallback for unknown values", () => {
    expect(expectedAbiForNodeMajor(22)).toBe("127");
    expect(expectedAbiForNodeMajor(24)).toBe("137");
    expect(() => expectedAbiForNodeMajor(23)).toThrow();
    expect(() => validateRuntimeEvidence({ node_version: "v23.0.0", modules_abi: "999" })).toThrow();
  });

  it("pins the primary project runtime and advertises only supported Node majors", () => {
    expect(packageJson.volta?.node).toBe("24.18.1");
    expect(packageJson.engines?.node).toBe(">=22 <23 || >=24 <25");
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

  it("pins Actions checkout, setup-node, and cache to v5 and documents the runner floor", () => {
    for (const workflow of [ci, release]) {
      expect(workflow).not.toMatch(/actions\/(?:checkout|setup-node|cache)@v(?:4|6|7)\b/);
      expect(workflow).toMatch(/actions\/(?:checkout|setup-node|cache)@v5\b/);
    }
    expect(`${ci}\n${release}`).toMatch(/runner[^\n]*(?:>=|at least|minimum)[^\n]*2\.327\.1/i);
  });

  it("does not override the real runtime ABI with the Node 24 value", () => {
    const source = fs.readFileSync(__filename, "utf8");
    expect(source).not.toMatch(/collectRuntimeEvidence\(\{[^}]*expectedAbi:\s*["']137["']/s);
  });

  it.skipIf(!CURRENT_RUNTIME_SUPPORTED)("collects native, migration, and JSON-RPC evidence through the production seam", async () => {
    const nodeMajor = Number(/^v(\d+)/.exec(process.version)?.[1]);
    const expectedAbi = expectedAbiForNodeMajor(nodeMajor);
    const evidence = await collectRuntimeEvidence({ mode: "source", entrypoint: path.join(PROJECT_ROOT, "src", "index.ts") });
    assertSupportedRuntime(evidence);
    expect(evidence.modules_abi).toBe(expectedAbi);
    expect(evidence.better_sqlite3_loaded).toBe(true);
    expect(evidence.sqlite_features).toEqual({ strict: true, json1: true, wal: true });
    expect(evidence.migration_ok).toBe(true);
    expect(evidence.handshake).toMatchObject({ initialize: true, tools_list: true });
    expect(evidence.handshake.tool_count).toBeGreaterThan(0);
  }, 15_000);
});
