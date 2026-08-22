#!/usr/bin/env node
// Release gate: exercise the installed OpenCode host, not just the plugin module.
import { createServer } from "node:http";
import { mkdtemp, mkdir, writeFile, appendFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { spawn } from "node:child_process";
import { execFileSync } from "node:child_process";
const root = resolve(import.meta.dirname, "..");
// Packed mode resolves file://.../plugins/opencode-forgespec/index.js from installed node_modules.
const mode = process.argv.includes("--mode=registry") ? "registry" : "packed";
const which = (() => { try { return execFileSync(process.platform === "win32" ? "where" : "which", ["opencode"], { encoding: "utf8" }).trim().split(/\r?\n/)[0]; } catch { return null; } })();
if (!which) { console.error("OpenCode unavailable; required host gate failed"); process.exit(1); }
const temp = await mkdtemp(join(tmpdir(), "forgespec-opencode-gate-"));
const suppliedArtifacts = process.argv.find((arg) => arg.startsWith("--artifacts-dir="))?.slice("--artifacts-dir=".length);
const artifacts = suppliedArtifacts ?? join(temp, "artifacts");
let install = root;
if (mode === "packed") {
  await mkdir(artifacts, { recursive: true });
  const npm = process.platform === "win32" ? "npm.cmd" : "npm";
  const npmRun = (args, options = {}) => execFileSync(npm, args, { ...options, shell: process.platform === "win32" });
  const pack = (cwd) => JSON.parse(npmRun(["pack", "--json", "--ignore-scripts", "--pack-destination", artifacts], { cwd, encoding: "utf8" })).at(-1).filename;
  let rootTarball;
  let pluginTarball;
  if (suppliedArtifacts) {
    const tarballs = await readdir(artifacts);
    rootTarball = tarballs.find((name) => name.startsWith("forgespec-mcp-") && name.endsWith(".tgz"));
    pluginTarball = tarballs.find((name) => name.startsWith("opencode-forgespec-") && name.endsWith(".tgz"));
    if (!rootTarball || !pluginTarball) throw new Error(`packed artifacts missing in ${artifacts}`);
  } else {
    rootTarball = pack(root);
    pluginTarball = pack(join(root, "plugins", "opencode-forgespec"));
  }
  install = join(temp, "installed");
  await mkdir(install, { recursive: true });
  npmRun(["init", "--yes", "--prefix", install], { stdio: "ignore" });
  npmRun(["install", "--prefix", install, "--ignore-scripts", "--omit=peer", "--package-lock=false", join(artifacts, rootTarball), join(artifacts, pluginTarball)], { stdio: "ignore" });
}
let child;
let requests = 0;
let modelTurns = 0;
let verifiedToolResult = false;
let passed = false;
const server = createServer((req, res) => {
  if (req.url?.endsWith("/models")) return res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify({ object: "list", data: [{ id: "mock", object: "model", owned_by: "local" }] }));
  let body = ""; req.on("data", (chunk) => body += chunk); req.on("end", () => {
    requests++;
    let request; try { request = JSON.parse(body || "{}"); } catch { request = {}; }
    const requestSummary = { n: requests, method: req.method, url: req.url, model: request.model, stream: request.stream, messageRoles: request.messages?.map((item) => item.role), lastMessage: request.messages?.at(-1)?.content?.slice?.(0, 500), advertisedTools: request.tools?.map((tool) => tool?.function?.name).filter(Boolean), priorToolCalls: request.messages?.flatMap((item) => item.tool_calls ?? []).map((call) => call.function?.name).filter(Boolean) };
    void appendFile(join(temp, "provider-requests.log"), JSON.stringify(requestSummary) + "\n");
    // OpenCode performs a tool-free title pass before the real tool-enabled turn.
    const titleRequest = !Array.isArray(request.tools) || request.tools.length === 0;
    const advertisedHealth = request.tools?.find((tool) => tool?.function?.name?.endsWith("forge_health"))?.function?.name ?? "forgespec_forgespec_health";
    const secondToolTurn = !titleRequest && modelTurns === 1;
    if (secondToolTurn) {
      const toolMessage = request.messages?.findLast?.((item) => item.role === "tool") ?? request.messages?.slice().reverse().find((item) => item.role === "tool");
      const content = Array.isArray(toolMessage?.content) ? toolMessage.content.map((part) => part.text ?? "").join("") : toolMessage?.content;
      let result; try { result = JSON.parse(content ?? ""); } catch { result = null; }
       verifiedToolResult = result?.ok === true && result?.data?.storage?.qualified === true && result?.data?.storage?.table_count === 16;
      if (!verifiedToolResult) return res.writeHead(502, { "content-type": "text/plain" }).end("mock provider rejected invalid MCP tool result");
    }
    const message = titleRequest
      ? { role: "assistant", content: "ForgeSpec host verifier" }
      : ++modelTurns === 1
      ? { role: "assistant", content: "", tool_calls: [{ id: "call_health", type: "function", function: { name: advertisedHealth, arguments: "{}" } }] }
      : { role: "assistant", content: JSON.stringify({ isError: false, ok: true, storage: { qualified: true, table_count: 16 } }) };
    const id = `mock-${requests}`;
    if (request.stream) {
      res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
      const emit = (value) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: "mock", choices: [value] })}\n\n`);
      if (message.tool_calls) {
        emit({ index: 0, delta: { role: "assistant", tool_calls: [{ index: 0, id: message.tool_calls[0].id, type: "function", function: { name: message.tool_calls[0].function.name } }] }, finish_reason: null });
        emit({ index: 0, delta: { tool_calls: [{ index: 0, function: { arguments: "{}" } }] }, finish_reason: null });
        emit({ index: 0, delta: {}, finish_reason: "tool_calls" });
      } else { emit({ index: 0, delta: { role: "assistant", content: message.content }, finish_reason: null }); emit({ index: 0, delta: {}, finish_reason: "stop" }); }
      res.end("data: [DONE]\n\n");
    } else { res.writeHead(200, { "content-type": "application/json" }); res.end(JSON.stringify({ id, object: "chat.completion", choices: [{ index: 0, message, finish_reason: titleRequest || secondToolTurn || modelTurns > 1 ? "stop" : "tool_calls" }], usage: { prompt_tokens: 1, completion_tokens: 1, total_tokens: 2 } })); }
  });
});
await new Promise((resolveReady) => server.listen(0, "127.0.0.1", resolveReady));
try {
  const port = server.address().port;
   const plugin = mode === "registry" ? "opencode-forgespec" : pathToFileURL(resolve(install, "node_modules/opencode-forgespec/index.js")).href;
  const config = { plugin: [plugin], provider: { mock: { npm: "@ai-sdk/openai-compatible", options: { baseURL: `http://127.0.0.1:${port}/v1`, apiKey: "local-test-only" }, models: { mock: { name: "mock" } } } } };
  await writeFile(join(temp, "opencode.json"), JSON.stringify(config));
  const env = { ...process.env, OPENAI_API_KEY: "local-test-only", OPENCODE_CONFIG: join(temp, "opencode.json"), FORGESPEC_DB: join(temp, "domain.db"), FORGESPEC_IDENTITY_SIDECAR_PATH: join(temp, "identity.db"), FORGESPEC_CURSOR_SECRET: "host-gate-cursor-secret-0123456789012345" };
  child = spawn(process.platform === "win32" ? "opencode" : which, ["run", "--print-logs", "--format", "json", "--model", "mock/mock", "Call forge_health and return the complete tool result", "--dir", temp], { cwd: temp, env, shell: process.platform === "win32", stdio: ["ignore", "pipe", "pipe"] });
  let output = ""; let diagnostics = ""; child.stdout.on("data", (chunk) => output += chunk); child.stderr.on("data", (chunk) => diagnostics += chunk);
   const code = await new Promise((done) => {
     let settled = false;
     const finish = (value) => { if (!settled) { settled = true; clearTimeout(timeout); done(value); } };
     const timeout = setTimeout(() => { child.kill(); finish(124); }, 30_000);
     child.once("error", () => finish(127)); child.once("close", finish);
   });
   // The verifier intentionally completes after one tool turn; modelTurns < 2 is the bounded success shape.
   if (code !== 0 || modelTurns < 1 || !verifiedToolResult || !/qualified[^\n]*true/.test(output) || !/table_count[^\n]*16/.test(output) || !/ok[^\n]{0,20}true/.test(output)) {
    const log = await readFile(join(temp, "provider-requests.log"), "utf8").catch(() => "<no provider request log>");
    throw new Error(`OpenCode host health assertion failed (exit ${code}, requests ${requests}); temp=${temp}\nstdout=${output.slice(-2000)}\nstderr=${diagnostics.slice(-2000)}\nrequests=${log.slice(-12000)}`);
  }
  console.log(`OpenCode ${mode} host forge_health gate passed`);
  passed = true;
} finally { child?.kill(); server.close(); if (passed) await rm(temp, { recursive: true, force: true }); else console.error(`bounded verifier artifacts preserved at ${temp}`); }
