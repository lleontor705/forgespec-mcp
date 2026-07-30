import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION } from "../src/database/migrations.js";
import { createServer } from "../src/server.js";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

const PROJECT_ROOT = path.resolve(__dirname, "..");
const packageJson = JSON.parse(fs.readFileSync(path.join(PROJECT_ROOT, "package.json"), "utf8")) as {
  name: string;
  version: string;
  bin: Record<string, string>;
  engines: { node: string };
  volta: { node: string };
};
const readme = fs.readFileSync(path.join(PROJECT_ROOT, "README.md"), "utf8");
const directV1 = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "direct-v1.md"), "utf8");
const migrations = fs.readFileSync(path.join(PROJECT_ROOT, "docs", "migrations.md"), "utf8");
const ci = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "ci.yml"), "utf8");
const release = fs.readFileSync(path.join(PROJECT_ROOT, ".github", "workflows", "release.yml"), "utf8");

const PRIMARY_NODE24 = "24.18.1";
const COMPAT_NODE22 = "22.x";
const COMPAT_NODE24 = "24.x";

function workflowSection(workflow: string, start: string, end?: string): string {
  const startIndex = workflow.indexOf(start);
  expect(startIndex).toBeGreaterThanOrEqual(0);
  const endIndex = end ? workflow.indexOf(end, startIndex + start.length) : workflow.length;
  expect(endIndex).toBeGreaterThan(startIndex);
  return workflow.slice(startIndex, endIndex);
}

describe("documentation truth checks", () => {
  it("documents the runtime package, schema, executable, and tool facts", async () => {
    const server = createServer({ database: () => { throw new Error("database not expected"); } });
    const client = new Client({ name: "documentation-facts", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    const toolNames = tools.tools.map((tool) => tool.name);

    expect(readme).toContain(`${packageJson.name}@${packageJson.version}`);
    expect(readme).toContain(`schema ${LATEST_SCHEMA_VERSION}`);
    expect(readme).toContain(`${packageJson.bin["forgespec-mcp"]}`);
    expect(directV1).toContain(`**Version:** ${packageJson.version}`);
    expect(migrations).toContain(`| ${LATEST_SCHEMA_VERSION} |`);
    for (const document of [readme, directV1]) {
      expect(document).toContain(`${toolNames.length} MCP tools`);
      for (const name of toolNames) expect(document).toContain(`\`${name}\``);
    }
    await client.close();
    await server.close();
  });

  it("documents the Node version actually exercised by CI", () => {
    const nodeVersions = [...ci.matchAll(/node-version:\s*["']?([0-9]+(?:\.[0-9]+|\.x)?)["']?/g)].map((match) => match[1]);
    expect(nodeVersions.length).toBeGreaterThan(0);
    for (const version of new Set(nodeVersions)) {
      expect(readme).toMatch(new RegExp(`Node[^\\n]*${version}`));
      expect(directV1).toMatch(new RegExp(`Node[^\\n]*${version}`));
    }
  });

  it("enforces the Node22 compatibility gate before exact Node24 release", () => {
    expect(release).toMatch(/node22-compatibility-gate:/);
    expect(release).toMatch(new RegExp(`node-version:\\s*["']${COMPAT_NODE22}["']`));
    expect(release).toMatch(new RegExp(`node-version:\\s*["']${PRIMARY_NODE24}["']`));
    expect(release).toMatch(/publish:[\s\S]*needs:\s*\[[^\]]*node22-compatibility-gate/);
    expect(release).not.toMatch(/node-version:\s*["'](?:24|24\.x|latest)["']/);
    expect(release).not.toMatch(/node-version:\s*["'](?:18|20|22)["']/);
    expect((release.match(/npm publish\b/g) ?? []).length).toBe(1);
  });

  it("uses package verification without publishing a real version", () => {
    expect(release).toMatch(/Validate packed manifest without publishing/);
    expect(release).toMatch(/npm pack --json/);
    expect(release).toMatch(/tar -xOf/);
    expect(release).toMatch(/build\/index\.js/);
    expect(release).toMatch(/if:\s*github\.event_name/);
    const verification = release.split("  publish:")[0];
    expect(verification).not.toMatch(/npm publish\b/);
  });

  it("makes Node22 compatibility and exact Node24 release a serial workflow graph", () => {
    const node22 = workflowSection(release, "  node22-compatibility-gate:", "  release-node24:");
    const node24 = workflowSection(release, "  release-node24:", "  approve-release:");
    const publish = workflowSection(release, "  publish:");
    for (const section of [node22, node24]) {
      expect(section).toMatch(/actions\/checkout@/);
      expect(section).toMatch(/npm ci/);
      expect(section).toMatch(/npm test/);
      expect(section).toMatch(/better-sqlite3/);
      expect(section).toMatch(/initialize|handshake/i);
    }
    expect(node22).toMatch(/migrations/i);
    expect(node22).toMatch(/process\.versions\.modules/);
    expect(node24).toMatch(/npm run lint/);
    expect(node24).toMatch(/npm run build/);
    expect(node24).toMatch(/npm pack/);
    expect(publish).toMatch(/needs:\s*\[[^\]]*node22-compatibility-gate/);
    expect(publish).toMatch(new RegExp(`node-version:\\s*["']${PRIMARY_NODE24}["']`));
    expect(publish).toMatch(/npm ci/);
    expect(publish).toMatch(/npm publish\b/);
  });

  it("keeps the CI primary pin distinct from maintained compatibility lines", () => {
    expect(ci).toMatch(new RegExp(`node-version:\\s*["']${PRIMARY_NODE24}["']`));
    expect(ci).toMatch(new RegExp(`node-version:\\s*["']${COMPAT_NODE22}["']`));
    expect(ci).toMatch(new RegExp(`node-version:\\s*["']${COMPAT_NODE24}["']`));
    expect(ci).toMatch(/ubuntu-latest/);
    expect(ci).toMatch(/windows-latest/);
    expect(ci).toMatch(/macos-latest/);
    expect(ci).not.toMatch(/node-version:\s*["'](?:24|latest)["']/);
  });

  it("states the verified performance and retention guarantees", () => {
    for (const document of [readme, directV1, migrations]) {
      expect(document).toMatch(/10,000|10000/);
      expect(document).toMatch(/30 warmed pages|30 pages/);
      expect(document).toMatch(/page 100/);
      expect(document).toMatch(/250\s*ms/);
      expect(document).toMatch(/500\s*ms/);
      expect(document).toMatch(/append-only|without pruning|no pruning/i);
    }
  });

  it("documents only verified startup, rollout, and rollback guarantees", () => {
    for (const document of [readme, directV1, migrations]) {
      expect(document).toMatch(/checksum/i);
      expect(document).toMatch(/STRICT/);
      expect(document).toMatch(/JSON1|json_valid/);
      expect(document).toMatch(/WAL|wal/);
      expect(document).toMatch(/backup/i);
    }
    expect(readme).toMatch(/P0.*P1|P0\/P1/s);
    expect(directV1).toMatch(/P0.*P1|P0\/P1/s);
    expect(migrations).toMatch(/server stopped/i);
  });

  it("documents the exact Node 24 primary and supported major lines", () => {
    for (const document of [readme, directV1, migrations]) {
      expect(document).toContain(packageJson.volta.node);
      expect(document).toMatch(/Node[^\n]*22\.x[^\n]*24\.x/i);
      expect(document).toMatch(/ABI\s*137/i);
      expect(document).toMatch(/ABI\s*127/i);
      expect(document).toMatch(/npm ci/i);
    }
  });

  it("keeps documentation tied to package metadata and the six-job runtime matrix", () => {
    expect(packageJson.engines.node).toBe(">=22 <23 || >=24 <25");
    expect(packageJson.volta.node).toBe(PRIMARY_NODE24);
    expect(ci.match(/node-line:/g)).toHaveLength(6);
    for (const document of [readme, directV1, migrations]) {
      expect(document).toMatch(/six isolated|six jobs|six-job|6-job/i);
      expect(document).toMatch(/22\.x/);
      expect(document).toMatch(/24\.x/);
    }
    expect(readme).toMatch(/lockfile[\s\S]*npm ci|npm ci[\s\S]*lockfile/i);
    expect(directV1).toMatch(/direct global|direct executable|global wrapper/i);
    expect(migrations).toMatch(/Volta/i);
  });

  it("documents the complete runtime rollout and rollback policy", () => {
    for (const document of [readme, directV1, migrations]) {
      expect(document).toMatch(/primary[^\n]*24\.18\.1/i);
      expect(document).toMatch(/(?:supported[^\n]*22\.x[^\n]*24\.x|22\.x[^\n]*24\.x[^\n]*supported)/i);
      expect(document).toMatch(/lockfile[\s\S]*npm ci|npm ci[\s\S]*lockfile/i);
      expect(document).toMatch(/Node 22[\s\S]*gate|gate[\s\S]*Node 22/i);
      expect(document).toMatch(/rollback[\s\S]*(?:Volta|wrapper|runtime)/i);
    }
    expect(readme).toMatch(/existing direct global ForgeSpec wrapper[\s\S]*direct OpenCode command/i);
    expect(directV1).toMatch(/direct global.*wrapper[\s\S]*do not substitute `npx`/i);
    expect(migrations).toMatch(/do not reinstall the working wrapper[\s\S]*direct OpenCode command/i);
  });

  it("does not retain official Node 18/20 support claims", () => {
    for (const document of [readme, directV1, migrations]) {
      expect(document).not.toMatch(/Node(?:\.js)?\s*(?:18|20)(?:\b|\.x)/i);
    }
  });
});
