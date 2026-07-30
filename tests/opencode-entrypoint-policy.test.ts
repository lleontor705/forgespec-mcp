import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = path.resolve(__dirname, "..");
const SCRIPT = path.join(ROOT, "scripts", "opencode-forgespec-repair.ps1");

describe("stable OpenCode entrypoint policy", () => {
  it("provides a guarded repair procedure", () => {
    expect(fs.existsSync(SCRIPT)).toBe(true);
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toContain("$env:LOCALAPPDATA\\Volta\\bin\\forgespec-mcp.cmd");
    expect(source).toMatch(/tools[\\/]image/i);
    expect(source).toMatch(/forgespec-mcp@1\.4\.0/);
    expect(source).toMatch(/volta install/);
    expect(source).toMatch(/finally/i);
    expect(source).toMatch(/backup/i);
    expect(source).toMatch(/rollback/i);
    expect(source).toMatch(/npx/);
  });

  it("requires public shim persistence and rejects internal Volta paths", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toMatch(/Volta[\\/]bin[\\/]forgespec-mcp\.cmd/);
    expect(source).toMatch(/throw|return.*false/i);
    expect(source).toMatch(/command/);
    expect(source).toMatch(/ConvertFrom-Json|ConvertTo-Json/);
    expect(source).toMatch(/Move-Item|File\.Replace|Replace/);
    expect(source).toMatch(/sha256|Hash/i);
  });

  it("documents conditional repair, handshake, and no automatic OpenCode restart", () => {
    const source = fs.readFileSync(SCRIPT, "utf8");
    expect(source).toMatch(/if.*(missing|broken)|Test-Path/i);
    expect(source).toMatch(/initialize/);
    expect(source).toMatch(/tools\/list/);
    expect(source).toMatch(/restart.*manual|manual.*restart/i);
    expect(source).toMatch(/resource|lock/i);
  });
});
