import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerIdentityTool, type IdentityVerifierLike } from "../src/identity/dispatcher.js";
import { installIdentityRuntime } from "../src/identity/dispatcher.js";
import { createIdentityRuntime } from "./helpers/identity-runtime.js";

type Registration = { config: Record<string, unknown>; callback: (args: unknown) => Promise<unknown> };

function setup(verifier: IdentityVerifierLike = { verify: vi.fn() }) {
  let registration: Registration | undefined;
  const server = { registerTool: (_name: string, config: Record<string, unknown>, callback: Registration["callback"]) => {
    registration = { config, callback };
  } };
  installIdentityRuntime(server, { verifier });
  const handler = vi.fn(async (args: { value: number }, principal: unknown) => ({ value: args.value, issuer: (principal as any).issuer }));
  registerIdentityTool(server as any, { verifier, toolName: "identity_echo", businessSchema: z.object({ value: z.number() }).strict(), outputSchema: z.object({ value: z.number(), issuer: z.string() }).strict(), annotations: { readOnlyHint: true }, handler });
  return { registration: registration!, verifier, handler };
}

describe("identity-first MCP dispatcher", () => {
  it("uses the exact registration and injects a verified principal", async () => {
    let registration: Registration | undefined;
    const server = { registerTool: (_name: string, config: Record<string, unknown>, callback: Registration["callback"]) => { registration = { config, callback }; } };
    const runtime = await createIdentityRuntime(server as any);
    const handler = vi.fn(async (args: { value: number }, principal: any) => ({ value: args.value, issuer: principal.issuer }));
    registerIdentityTool(server as any, { verifier: runtime.verifier, toolName: "identity_echo", businessSchema: z.object({ value: z.number() }).strict(), outputSchema: z.object({ value: z.number(), issuer: z.string() }).strict(), annotations: { readOnlyHint: true }, handler });
    const signed = runtime.signExactToolArgs("identity_echo", { value: 7 });
    expect(registration!.config.annotations).toEqual({ readOnlyHint: true });
    const response: any = await registration!.callback(signed);
    expect(response.isError).toBe(false);
    expect(response.structuredContent).toMatchObject({ ok: true, data: { value: 7 }, error: null, _identity_context: { issuer: expect.any(String), worker: expect.any(String) } });
    expect(handler).toHaveBeenCalledOnce();
    await runtime.cleanup();
  });

  it.each([undefined, { forged: true }, { replay: true }])("does not invoke handler for missing, forged, or replayed identity", async (identity) => {
    const verifier = { verify: vi.fn(() => { throw new Error("identity verification failed"); }) };
    const { registration, handler } = setup(verifier);
    const response: any = await registration.callback(identity === undefined ? { value: 1 } : { value: 1, _identity: identity });
    expect(response).toEqual({ content: [{ type: "text", text: JSON.stringify(response.structuredContent) }], structuredContent: { ok: false, data: null, error: { code: "IDENTITY_INVALID", message: "identity verification failed" }, _identity_context: null }, isError: true });
    expect(handler).not.toHaveBeenCalled();
  });

  it("consumes verification before rejecting unknown business fields", async () => {
    const principal = { issuer: "trusted" };
    const verifier = { verify: vi.fn(() => ({ principal, args: { value: 1, extra: true } })) };
    const { registration, handler } = setup(verifier);
    const response: any = await registration.callback({ value: 1, extra: true, actor: "caller", _identity: {} });
    expect(response.structuredContent).toMatchObject({ ok: false, data: null, error: { code: "INVALID_ARGUMENTS", message: "invalid tool arguments" }, _identity_context: null });
    expect(verifier.verify).toHaveBeenCalledOnce();
    expect(handler).not.toHaveBeenCalled();
  });

  it("rejects output that does not satisfy the declared schema", async () => {
    const verifier = { verify: vi.fn(() => ({ principal: { issuer: "trusted" }, args: { value: 1 } })) };
    const { registration } = setup(verifier);
    const broken = setup(verifier);
    (broken.handler as any).mockResolvedValue({ value: "wrong", issuer: "trusted" });
    const response: any = await broken.registration.callback({ value: 1, _identity: {} });
    expect(response.structuredContent).toMatchObject({ ok: false, data: null, error: { code: "OUTPUT_INVALID", message: "invalid tool output" }, _identity_context: { issuer: expect.any(String), worker: expect.any(String) } });
    expect(response.isError).toBe(true);
  });

  it.each(["success", "domain", "schema"] as const)("fails closed when finalization fails for %s while leaving replay pending", async (kind) => {
    let registration: Registration | undefined;
    const server = { registerTool: (_name: string, config: Record<string, unknown>, callback: Registration["callback"]) => { registration = { config, callback }; } };
    const runtime = await createIdentityRuntime(server as any);
    runtime.verifier.finalizeReplay = () => { throw new Error("injected SQLITE_BUSY"); };
    const handler = vi.fn(async () => {
      if (kind === "domain") throw Object.assign(new Error("domain"), { code: "DOMAIN_ERROR" });
      return kind === "schema" ? { value: "wrong", issuer: "trusted" } : { value: 3, issuer: "trusted" };
    });
    registerIdentityTool(server as any, { verifier: runtime.verifier, toolName: "identity_echo", businessSchema: z.object({ value: z.number() }).strict(), outputSchema: z.object({ value: z.number(), issuer: z.string() }).strict(), handler });
    const response: any = await registration!.callback(runtime.signExactToolArgs("identity_echo", { value: 3 }));
    expect(response.structuredContent).toMatchObject({ ok: false, data: null, error: { code: "IDENTITY_AUDIT_FAILED", message: "identity audit could not be persisted" }, _identity_context: { issuer: expect.any(String), worker: expect.any(String) } });
    expect(response.isError).toBe(true);
    expect(runtime.database.prepare("SELECT outcome FROM fsi_replay").all()).toEqual([{ outcome: "pending" }]);
    await runtime.cleanup();
  });
});
