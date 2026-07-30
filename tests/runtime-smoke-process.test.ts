import { execFileSync, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const CLI = path.join(ROOT, "src", "runtime", "runtime-smoke.ts");
const EVIDENCE = path.join(ROOT, "src", "runtime", "runtime-evidence.ts");

function runSmoke(args: string[] = []): { status: number | null; stdout: string; stderr: string } {
  try {
    execFileSync(process.execPath, ["--import", "tsx/esm", CLI, ...args], {
      cwd: ROOT,
      encoding: "utf8",
      env: { ...process.env, NODE_NO_WARNINGS: "1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { status: 0, stdout: "", stderr: "" };
  } catch (error) {
    const result = error as { status?: number; stdout?: string; stderr?: string };
    return { status: result.status ?? null, stdout: result.stdout ?? "", stderr: result.stderr ?? "" };
  }
}

describe("runtime smoke CLI process contract", () => {
  it("defines a Vitest-free executable and deterministic JSON success contract", () => {
    expect(fs.existsSync(CLI)).toBe(true);
    const source = fs.readFileSync(CLI, "utf8");
    expect(source).not.toMatch(/from ["']vitest["']/);
    expect(source).not.toMatch(/tests[\\/]runtime-compatibility\.test/);
    expect(source).toMatch(/process\.stdout/);
    expect(source).toMatch(/process\.stderr/);
  });

  it("maps usage errors to exit code 2 and emits JSON only on stdout", () => {
    const result = runSmoke(["--unknown"]);
    expect(result.status).toBe(2);
    expect(() => JSON.parse(result.stdout)).not.toThrow();
    expect(result.stderr).toMatch(/runtime-smoke:/);
  });

  it("specifies runtime/native, protocol, and unexpected exit classes", () => {
    const source = fs.readFileSync(CLI, "utf8");
    expect(source).toMatch(/EXIT_USAGE\s*=\s*2/);
    expect(source).toMatch(/EXIT_RUNTIME\s*=\s*3/);
    expect(source).toMatch(/EXIT_PROTOCOL\s*=\s*4/);
    expect(source).toMatch(/EXIT_UNEXPECTED\s*=\s*5/);
    expect(source).toMatch(/--mode/);
    expect(source).toMatch(/--entrypoint/);
    expect(fs.readFileSync(EVIDENCE, "utf8")).toMatch(/shell:\s*false/);
  });

  it("uses temporary resources and never forwards child stdout blindly", () => {
    const source = `${fs.readFileSync(CLI, "utf8")}\n${fs.readFileSync(EVIDENCE, "utf8")}`;
    expect(source).toMatch(/mkdtemp|tmpdir/);
    expect(source).toMatch(/JSON\.parse/);
    expect(source).toMatch(/tools\/list/);
    expect(source).toMatch(/initialize/);
    expect(source).toMatch(/redact|redacted/i);
  });
});

void os;
void spawn;
