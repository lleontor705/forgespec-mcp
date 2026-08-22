import { spawn } from "node:child_process";
import { once } from "node:events";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const entry = resolve("src/identity/broker-cli.ts");
function start() { return spawn(process.execPath, ["--import", "tsx/esm", entry], { stdio: ["pipe", "pipe", "pipe"] }); }
async function lines(child: ReturnType<typeof start>, count: number) {
  let text = ""; const records: unknown[] = [];
  return new Promise<unknown[]>((resolveLines, rejectLines) => {
    const onData = (chunk: Buffer) => { try { text += chunk; const rows = text.split("\n"); text = rows.pop() ?? ""; for (const row of rows) if (row) records.push(JSON.parse(row)); if (records.length >= count) { child.stdout.off("data", onData); resolveLines(records); } } catch (error) { rejectLines(error); } };
    child.stdout.on("data", onData); child.once("error", rejectLines);
  });
}
describe("identity broker process", () => {
  it("emits readiness and correlates concurrent requests without secrets", async () => {
    const child = start(); const records = await lines(child, 1); const ready = records[0] as Record<string, string>;
    expect(ready.type).toBe("ready"); expect(ready.root_public_key).toBeTruthy(); expect(ready.kid).toBeTruthy();
    const secret = "official-session-secret";
    child.stdin.write(JSON.stringify({ id: "a", payload: { root: secret, parent: "p", call: "ca", tool: "forge_health", args: { value: 1 } } }) + "\n");
    child.stdin.write(JSON.stringify({ id: "b", payload: { root: "other", tool: "task_query", args: { value: 2 } } }) + "\n");
    const responses = await lines(child, 2); expect((responses as Array<{ id: string }>).map((x) => x.id).sort()).toEqual(["a", "b"]);
    expect(JSON.stringify(responses)).not.toContain(secret); child.stdin.end(); await once(child, "close");
  });
  it("fails closed on malformed and oversized frames, and exits cleanly on EOF", async () => {
    const bad = start(); await lines(bad, 1); bad.stdin.write("not-json\n"); const [output] = await once(bad.stdout, "data"); expect(String(output)).toContain("INVALID_REQUEST"); await once(bad, "close");
    const eof = start(); await lines(eof, 1); eof.stdin.end(); const [code] = await once(eof, "close"); expect(code).toBe(0);
    expect(readFileSync(resolve("src/identity/broker-cli.ts"), "utf8")).not.toMatch(/privateKey|rootPrivate/);
  });
});
