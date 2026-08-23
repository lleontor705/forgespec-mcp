import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type Database from "better-sqlite3";
import { z } from "zod";
import { get as getDb } from "../storage/database.js";
import { CONTRACT_PHASES, CONTRACT_STATUSES, ContractDomainError, commitContract, queryContracts, validateContract } from "../domain/contracts.js";
import { getIdentityRuntime, registerIdentityTool } from "../identity/dispatcher.js";
import { contractValidateResult, contractCommitResult, contractQueryResult } from "./schemas.js";

const MAX_DATA_BYTES = 64 * 1024;
const MAX_DATA_DEPTH = 8;
const MAX_DATA_NODES = 2048;
const text = (max: number) => z.string().min(1).max(max);
const jsonValue = (value: unknown, depth = 0, state = { nodes: 0 }): boolean => {
  if (++state.nodes > MAX_DATA_NODES || depth > MAX_DATA_DEPTH) return false;
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1, state));
  return typeof value === "object" && Object.keys(value as object).every((key) => key.length <= 256 && jsonValue((value as Record<string, unknown>)[key], depth + 1, state));
};
const dataObject = z.record(z.string().min(1).max(256), z.unknown()).superRefine((value, issue) => {
  if (!jsonValue(value) || Buffer.byteLength(JSON.stringify(value), "utf8") > MAX_DATA_BYTES) issue.addIssue({ code: "custom", message: "data must be bounded JSON" });
});
/** Published shape is concrete; recursive size/depth checks remain runtime refinements. */
const contract = z.object({
  board_id: text(256), project: text(256), change_name: text(256),
  phase: z.enum(CONTRACT_PHASES), status: z.enum(CONTRACT_STATUSES),
  confidence: z.number().finite().min(0).max(1), executive_summary: text(4096),
  revision: z.number().int().min(1).optional(), parent_contract_id: text(256).nullable().optional(),
  digest: z.string().regex(/^sha256:[a-f0-9]{64}$/).optional(), data: dataObject,
}).strict();
const contractInput = contract;
const readAnnotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false } as const;
const mutationAnnotations = { idempotentHint: true, destructiveHint: true, openWorldHint: false } as const;

export function registerContractTools(server: McpServer, databaseProvider: () => Database.Database = getDb): void {
  const verifier = getIdentityRuntime(server)?.verifier; if (!verifier) throw new Error("identity runtime is not installed");
  const validateInput = z.object({ contract: contractInput }).strict();
  registerIdentityTool<any, any>(server, { verifier, toolName: "contract_validate", description: "Validate a final contract without writing state.", businessSchema: validateInput, outputSchema: contractValidateResult, annotations: readAnnotations, handler: async ({ contract: raw }) => {
    const { revision: _revision, parent_contract_id: _parent, digest: _digest, ...value } = raw as z.infer<typeof contract>;
    const result = !jsonValue(value.data) || Buffer.byteLength(JSON.stringify(value.data), "utf8") > MAX_DATA_BYTES
      ? { valid: false, errors: ["data must be bounded JSON"] } : validateContract(value);
    return {
      ok: true,
      valid: result.valid,
      ...(result.digest ? { digest: result.digest } : {}),
      ...(result.errors?.length ? { errors: result.errors } : {})
    };
  }});
  const commitInput = z.object({ idempotency_key: text(256), expected_board_revision: z.number().int().min(1), parent_contract_id: text(256).optional(), contract: contractInput }).strict();
  registerIdentityTool<any, any>(server, { verifier, toolName: "contract_commit", description: "Append a final contract revision with board authority, CAS, and idempotency.", businessSchema: commitInput, outputSchema: contractCommitResult, annotations: mutationAnnotations, handler: async (input, principal) => ({ ok: true, ...commitContract(databaseProvider(), { idempotency_key: input.idempotency_key, expected_board_revision: input.expected_board_revision, ...(input.parent_contract_id === undefined ? {} : { parent_contract_id: input.parent_contract_id }), contract: input.contract, actor: principal.session.worker }) }) });
  const queryInput = z.object({ board_id: text(256), change_name: text(256).optional(), phase: z.enum(CONTRACT_PHASES).optional(), limit: z.number().int().min(1).max(100).optional(), offset: z.number().int().min(0).max(10000).optional() }).strict();
  registerIdentityTool<any, any>(server, { verifier, toolName: "contract_query", description: "Query final contract revisions for an authorized board.", businessSchema: queryInput, outputSchema: contractQueryResult, annotations: readAnnotations, handler: async (input, principal) => ({ ok: true, ...queryContracts(databaseProvider(), { ...input, actor: principal.session.worker }) }) });
}
