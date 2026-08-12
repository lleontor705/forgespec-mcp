export type CoordinationMode = "legacy" | "direct-v1";

export interface VersionRange {
  min_inclusive: string;
  max_exclusive?: string;
}

export interface CapabilityRequirement {
  id: string;
  range: VersionRange;
  optional?: boolean;
}

export interface CapabilitiesInput {
  client?: { name: string; version: string };
  requested_mode?: CoordinationMode;
  required?: CapabilityRequirement[];
}

const DIRECT_RANGE: VersionRange = { min_inclusive: "1.0.0", max_exclusive: "2.0.0" };

export const DIRECT_V1_P0_CAPABILITIES = [
  "forgespec.capabilities",
  "task-cas",
  "idempotency",
  "task-attempt-lease",
  "claim-recovery",
  "dependency-transitions",
  "audit-events",
  "sdd-contract-revisions",
] as const;

export const DIRECT_V1_P1_CAPABILITIES = [
  "structured-evidence-links",
  "approval-gates",
  "batch-status",
  "query-cursors",
  "file-lease",
] as const;

export const ALL_DIRECT_V1_CAPABILITIES = [
  ...DIRECT_V1_P0_CAPABILITIES,
  ...DIRECT_V1_P1_CAPABILITIES,
] as const;

export const TASK_AUTHORITY_CAPABILITY_ID = "task-authority" as const;
export const TASK_AUTHORITY_CAPABILITY_VERSION = "1.0.0" as const;
export const TASK_AUTHORITY_CAPABILITY = "task-authority@1.0.0" as const;

const DEFAULT_ADVERTISED_CAPABILITIES = [
  ...ALL_DIRECT_V1_CAPABILITIES,
  TASK_AUTHORITY_CAPABILITY_ID,
] as const;

export interface CapabilityNegotiationOptions {
  serverVersion?: string;
  availableCapabilities?: readonly string[];
}

export function negotiateCapabilities(
  input: CapabilitiesInput,
  options: CapabilityNegotiationOptions = {}
) {
  const available = new Set(options.availableCapabilities ?? DEFAULT_ADVERTISED_CAPABILITIES);
  const taskAuthoritySelected = (input.required ?? []).some(
    ({ id, range }) => id === TASK_AUTHORITY_CAPABILITY_ID
      && available.has(id)
      && rangeContains(range, TASK_AUTHORITY_CAPABILITY_VERSION)
  );
  const capabilities = [...available]
    .sort()
    .map((id) => ({
      id,
      supported: { ...DIRECT_RANGE },
      ...(id !== TASK_AUTHORITY_CAPABILITY_ID || taskAuthoritySelected
        ? { selected: TASK_AUTHORITY_CAPABILITY_VERSION }
        : {}),
    }));
  const missing: CapabilityRequirement[] = [];
  const unavailableOptional: CapabilityRequirement[] = [];
  const incompatible: Array<{
    id: string;
    required: VersionRange;
    supported?: VersionRange;
  }> = [];

  for (const requirement of input.required ?? []) {
    if (!available.has(requirement.id)) {
      (requirement.optional ? unavailableOptional : missing).push(requirement);
      continue;
    }
    if (!rangeContains(requirement.range, "1.0.0")) {
      if (requirement.optional) {
        unavailableOptional.push(requirement);
      } else {
        incompatible.push({ id: requirement.id, required: requirement.range, supported: { ...DIRECT_RANGE } });
      }
    }
  }

  const compatible = missing.length === 0 && incompatible.length === 0;
  const requestedMode = input.requested_mode ?? "legacy";
  return {
    server: {
      name: "forgespec-mcp" as const,
      version: options.serverVersion ?? "1.2.2",
      api_version: "1.0.0" as const,
    },
    security: { identity_model: "local-trusted-client" as const },
    modes: ["legacy", "direct-v1"] as CoordinationMode[],
    schemas: {
      sdd_envelope: { ...DIRECT_RANGE },
      task_metadata: { ...DIRECT_RANGE },
      evidence_ref: { ...DIRECT_RANGE },
    },
    capabilities,
    limits: {
      max_page_size: 200,
      max_batch_tasks: 100,
      max_dependencies_per_task: 100,
      min_lease_seconds: 15,
      max_lease_seconds: 3600,
      clock_skew_grace_ms: 5000,
      max_file_scopes: 100,
      max_idempotency_key_bytes: 256,
    },
    compatibility: {
      compatible,
      ...(compatible ? { selected_mode: requestedMode } : {}),
      missing,
      incompatible,
      unavailable_optional: unavailableOptional,
    },
  };
}

function rangeContains(range: VersionRange, version: string): boolean {
  return compareSemver(version, range.min_inclusive) >= 0 &&
    (!range.max_exclusive || compareSemver(version, range.max_exclusive) < 0);
}

function compareSemver(left: string, right: string): number {
  const a = parseSemver(left);
  const b = parseSemver(right);
  for (let index = 0; index < a.length; index += 1) {
    const difference = a[index] - b[index];
    if (difference !== 0) return difference;
  }
  return 0;
}

function parseSemver(version: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match) return [-1, -1, -1];
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}
