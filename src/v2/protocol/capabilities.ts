const VERSION_2_0_0 = "2.0.0" as const;

export const CAPABILITIES_V2_VERSION = VERSION_2_0_0;

export const CAPABILITY_LIMITS = {
  maxToolsPerProfile: 18,
  allowedToolPrefix: "",
} as const;

export const CAPABILITY_FAMILIES_V2 = [
  "cas@2",
  "idempotency@2",
  "attempts@2",
  "recovery@2",
  "leases@2",
  "authority@2",
  "approvals@2",
  "audit-chain@2",
  "cursor-snapshots@2",
  "evidence-refs@2",
  "sdd-revisions@2",
] as const;

export const SDD_TOOL_CATALOG = Object.freeze([
  "attempt_claim",
  "attempt_recover",
  "attempt_renew",
  "authority_manage",
  "approval_record",
  "board_create",
  "contract_commit",
  "contract_query",
  "contract_validate",
  "event_query",
  "forge_health",
  "forge_negotiate",
  "lease_release",
  "lease_renew",
  "lease_reserve",
  "task_define",
  "task_query",
  "task_transition",
].sort());

export type CapabilityProfileRole = "planner" | "worker" | "orchestrator" | "reviewer";

const buildFrozenRoleTools = <T extends readonly string[]>(items: T): readonly T[number][] => Object.freeze([...items].sort()) as readonly T[number][];

export const PROFILE_TOOLSETS: Readonly<{ [key in CapabilityProfileRole]: readonly string[] }> = Object.freeze({
  planner: buildFrozenRoleTools([
    "contract_validate",
    "contract_commit",
    "contract_query",
    "event_query",
    "board_create",
    "forge_health",
    "forge_negotiate",
    "task_define",
    "task_query",
  ]),
  worker: buildFrozenRoleTools([
    "attempt_claim",
    "attempt_renew",
    "forge_health",
    "forge_negotiate",
    "lease_release",
    "contract_query",
    "event_query",
    "lease_renew",
    "lease_reserve",
    "task_query",
    "task_transition",
  ]),
  orchestrator: buildFrozenRoleTools([
    "attempt_recover",
    "authority_manage",
    "board_create",
    "contract_query",
    "event_query",
    "forge_health",
    "forge_negotiate",
    "task_define",
    "task_query",
  ]),
  reviewer: buildFrozenRoleTools([
    "approval_record",
    "event_query",
    "contract_query",
    "forge_health",
    "forge_negotiate",
    "task_query",
  ]),
});

const VALID_TOOLSET = new Set<string>(SDD_TOOL_CATALOG);

export interface CapabilityProfile {
  role: CapabilityProfileRole;
  version: string;
  maxTools: number;
  toolset: readonly string[];
}

const allRoles = Object.freeze(Object.keys(PROFILE_TOOLSETS) as CapabilityProfileRole[]);

export function listProfiles(): CapabilityProfileRole[] {
  return [...allRoles];
}

export function getProfile(role: string): CapabilityProfile {
  const toolset = PROFILE_TOOLSETS[role as CapabilityProfileRole];
  if (!toolset) {
    throw new Error(`Unknown role for capabilities profile: ${role}`);
  }

  return {
    role: role as CapabilityProfileRole,
    version: CAPABILITIES_V2_VERSION,
    maxTools: CAPABILITY_LIMITS.maxToolsPerProfile,
    toolset,
  };
}

export function isKnownRole(role: string): role is CapabilityProfileRole {
  return role in PROFILE_TOOLSETS;
}

export function validateToolsetDeterministic(profile: CapabilityProfile): void {
  if (!isKnownRole(profile.role)) {
    throw new Error(`Unknown role for capabilities profile: ${profile.role}`);
  }

  const sorted = [...profile.toolset].sort();
  const unique = new Set(profile.toolset);

  if (profile.toolset.length !== sorted.length) {
    throw new Error(`Profile ${profile.role} toolset has duplicate entries`);
  }
  const hasLegacyPrefix = profile.toolset.some((tool) => tool.startsWith("tb_") || tool.startsWith("sdd_") || tool.startsWith("fs_"));
  if (hasLegacyPrefix) {
    throw new Error(`Profile ${profile.role} contains legacy-prefixed tool`);
  }
  if (unique.size !== profile.toolset.length) {
    throw new Error(`Profile ${profile.role} contains duplicates`);
  }
  if (!profile.toolset.every((tool) => VALID_TOOLSET.has(tool))) {
    throw new Error(`Profile ${profile.role} includes unknown tool in v2 catalog`);
  }
  if (profile.toolset.length > CAPABILITY_LIMITS.maxToolsPerProfile) {
    throw new Error(`Profile ${profile.role} exceeds maxToolsPerProfile`);
  }
  if (!profile.toolset.every((tool, index) => tool === sorted[index])) {
    throw new Error(`Profile ${profile.role} toolset must be deterministic-sorted`);
  }
}

for (const role of allRoles) {
  validateToolsetDeterministic(getProfile(role));
}
