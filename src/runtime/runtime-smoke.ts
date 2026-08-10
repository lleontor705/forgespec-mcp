#!/usr/bin/env node
import { collectRuntimeEvidence, expectedAbiForNodeMajor, type RuntimeSmokeOptions } from "./runtime-evidence.js";

const EXIT_USAGE = 2;
const EXIT_RUNTIME = 3;
const EXIT_PROTOCOL = 4;
const EXIT_UNEXPECTED = 5;

async function main(argv: string[]): Promise<void> {
  try {
    const options = parseArguments(argv);
    const evidence = await collectRuntimeEvidence(options);
    if (!evidence.better_sqlite3_loaded || !evidence.migration_ok || !Object.values(evidence.sqlite_features).every(Boolean)) {
      throw new SmokeError(EXIT_RUNTIME, "Runtime, SQLite, or migration qualification failed");
    }
    if (!evidence.handshake.initialize || !evidence.handshake.tools_list) {
      throw new SmokeError(EXIT_PROTOCOL, "MCP initialize/tools-list handshake failed");
    }
    emit({ ok: true, evidence });
  } catch (error) {
    const smokeError = error instanceof SmokeError ? error : classifyError(error);
    emit({ ok: false, error: { code: smokeError.code, message: redact(smokeError.message) } });
    process.stderr.write(`runtime-smoke: ${redact(smokeError.message)}\n`);
    process.exitCode = smokeError.code;
  }
}

function parseArguments(argv: string[]): RuntimeSmokeOptions {
  const values = new Map<string, string>();
  for (let index = 0; index < argv.length; index += 1) {
    const key = argv[index];
    if (!key.startsWith("--") || argv[index + 1] === undefined || argv[index + 1].startsWith("--")) throw new SmokeError(EXIT_USAGE, "Arguments must use --name value");
    values.set(key.slice(2), argv[++index]);
  }
  const mode = values.get("mode");
  const entrypoint = values.get("entrypoint");
  const expectedAbi = values.get("expected-abi");
  if ((mode !== "source" && mode !== "build") || !entrypoint || (expectedAbi !== undefined && expectedAbi !== "127" && expectedAbi !== "137" && expectedAbi !== "147")) throw new SmokeError(EXIT_USAGE, "Required arguments: --mode source|build --entrypoint path [--expected-abi 127|137|147]");
  const nodeMajor = Number(/^v(\d+)/.exec(process.version)?.[1]);
  return { mode, entrypoint, expectedAbi: expectedAbi === undefined ? expectedAbiForNodeMajor(nodeMajor) : expectedAbi as "127" | "137" | "147" };
}

function classifyError(error: unknown): SmokeError {
  const message = error instanceof Error ? error.message : "Unexpected runtime smoke failure";
  if (/handshake|MCP|JSON-RPC|timed out|child exited|Malformed/i.test(message)) return new SmokeError(EXIT_PROTOCOL, message);
  return new SmokeError(EXIT_RUNTIME, message);
}

function emit(value: unknown): void { process.stdout.write(`${JSON.stringify(value)}\n`); }
function redact(value: string): string { return value.replace(/[A-Za-z]:\\[^\r\n ]+/g, "<path>").replace(/(token|secret|password)=?[^\s]+/gi, "$1=<redacted>"); }

class SmokeError extends Error {
  constructor(public readonly code: number, message: string) { super(message); }
}

void main(process.argv.slice(2));
