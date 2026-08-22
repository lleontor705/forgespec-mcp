import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import pluginFactory from "../plugins/opencode-forgespec/index.js";

const ROOT = path.resolve(__dirname, "..");
const PLUGIN_ENTRY = path.join(ROOT, "plugins", "opencode-forgespec", "index.js");
const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, "package.json"), "utf8")) as {
  bin: Record<string, string>;
  exports: Record<string, unknown>;
  files: string[];
  scripts: Record<string, string>;
};

describe("stable OpenCode entrypoint policy", () => {
  it("keeps the root package entrypoint portable and clean", () => {
    expect(packageJson.scripts.prebuild).toMatch(/^node\s+-e\s+/);
    expect(packageJson.scripts.prebuild).toContain("rmSync");
    expect(packageJson.bin["forgespec-mcp"]).toBe("build/index.js");
    expect(packageJson.bin["forgespec-identity-broker"]).toBe("build/identity/broker-cli.js");
    expect(packageJson.files).toContain("plugins/opencode-forgespec");
    expect(packageJson.exports["./plugin"]).toEqual({ import: "./plugins/opencode-forgespec/index.js" });
    expect(packageJson.exports["."]).toEqual({ import: "./build/index.js", types: "./build/index.d.ts" });
    expect(packageJson.exports["./mcp"]).toEqual({ import: "./build/index.js" });
    expect(packageJson.exports["./broker"]).toEqual({ import: "./build/identity/broker-cli.js" });

    const scripts = Object.values(packageJson.scripts).join("\n");
    expect(scripts).not.toMatch(/\.ps1\b|powershell(?:\.exe)?|cmd(?:\.exe)?/i);
    expect(scripts).not.toMatch(/\bshell\s*:\s*true\b/i);
    expect(fs.existsSync(path.join(ROOT, "scripts", "opencode-forgespec-repair.ps1"))).toBe(false);
  });

  it("keeps the standalone plugin package installable and single-export", () => {
    const pluginPackage = JSON.parse(fs.readFileSync(path.join(ROOT, "plugins", "opencode-forgespec", "package.json"), "utf8"));
    expect(pluginPackage.name).toBe("opencode-forgespec");
    expect(pluginPackage.dependencies["forgespec-mcp"]).toBe(packageJson.version);
    expect(pluginPackage.exports).toEqual({ ".": "./index.js" });
    expect(pluginPackage.engines.node).toBe(">=22");
  });

  it("keeps the checked-in OpenCode plugin path present and loadable", async () => {
    expect(fs.existsSync(PLUGIN_ENTRY)).toBe(true);
    expect(typeof pluginFactory).toBe("function");
    const plugin = await pluginFactory({ mcpPath: path.join(ROOT, "build", "index.js"), brokerPath: path.join(ROOT, "missing-broker.js") });
    expect(typeof plugin.config).toBe("function");
    expect(typeof plugin["tool.execute.before"]).toBe("function");
  });

  it("keeps the broker launch shell-free and the bootstrap schema exact", () => {
    const source = fs.readFileSync(PLUGIN_ENTRY, "utf8");
    expect(source).toMatch(/spawn\(nodeCommand \?\? resolveNodeCommand\(\), \[entry\], \{ shell: false/);
    expect(source).toMatch(/FORGESPEC_IDENTITY_ROOT_PUBLIC_KEY/);
    expect(source).toMatch(/FORGESPEC_IDENTITY_ISSUER/);
    expect(source).toMatch(/FORGESPEC_IDENTITY_AUDIENCE/);
    expect(source).toMatch(/FORGESPEC_IDENTITY_SIDECAR_PATH/);
    expect(source).not.toMatch(/FORGESPEC_(?:ACTOR|CALLER|IDENTITY_TOKEN)/);
  });
});
