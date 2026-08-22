import { describe, expect, it } from "vitest";

import {
  CAPABILITY_FAMILIES,
  CAPABILITY_LIMITS,
  PROTOCOL_VERSION,
  PROFILE_TOOLSETS,
  SDD_TOOL_CATALOG,
  getProfile,
  listProfiles,
  validateToolsetDeterministic,
} from "../../src/protocol/capabilities.js";

  describe("Protocol 2.0 capabilities registry", () => {
   it("expone los metadatos de capacidades del protocolo", () => {
     expect(PROTOCOL_VERSION).toBe("2.0.0");
    expect(CAPABILITY_LIMITS.maxToolsPerProfile).toBe(18);
     expect(CAPABILITY_FAMILIES).toEqual([
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
    ]);
  });

  it("valida catálogo canónico y perfiles mínimos para planner/worker/orchestrator/reviewer", () => {
    const expectedCatalog = [
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
    ];

    const expectedRoles = ["orchestrator", "planner", "reviewer", "worker"] as const;

    expect(listProfiles()).toEqual([...expectedRoles]);
    expect(SDD_TOOL_CATALOG).toEqual([...expectedCatalog].sort());
    expect(SDD_TOOL_CATALOG.length).toBe(18);
    expect(new Set(SDD_TOOL_CATALOG).size).toBe(SDD_TOOL_CATALOG.length);

    const expectedProfiles = {
      planner: ["board_create", "contract_commit", "contract_query", "contract_validate", "event_query", "forge_health", "forge_negotiate", "task_define", "task_query"],
      worker: ["attempt_claim", "attempt_renew", "contract_query", "event_query", "forge_health", "forge_negotiate", "lease_release", "lease_renew", "lease_reserve", "task_query", "task_transition"],
      orchestrator: ["attempt_recover", "authority_manage", "board_create", "contract_query", "event_query", "forge_health", "forge_negotiate", "task_define", "task_query"],
      reviewer: ["approval_record", "contract_query", "event_query", "forge_health", "forge_negotiate", "task_query"],
    } as const;

    for (const role of expectedRoles) {
      const profile = getProfile(role);
       expect(profile.version).toBe(PROTOCOL_VERSION);
      expect(profile.maxTools).toBe(CAPABILITY_LIMITS.maxToolsPerProfile);
      expect(profile.toolset.length).toBeGreaterThan(0);
      expect(profile.toolset.length).toBeLessThanOrEqual(CAPABILITY_LIMITS.maxToolsPerProfile);
      expect(profile.toolset).toEqual([...profile.toolset].sort());
      expect(new Set(profile.toolset).size).toBe(profile.toolset.length);
      expect(profile.toolset.every((tool) => SDD_TOOL_CATALOG.includes(tool))).toBe(true);
      expect(PROFILE_TOOLSETS[role]).toEqual(profile.toolset);
      expect(profile.toolset).toEqual([...expectedProfiles[role]]);
    }

    const planner = getProfile("planner");
    const worker = getProfile("worker");
    const orchestrator = getProfile("orchestrator");
    const reviewer = getProfile("reviewer");

    expect(planner.toolset).toEqual(expectedProfiles.planner);
    expect(worker.toolset).toEqual(expectedProfiles.worker);
    expect(orchestrator.toolset).toEqual(expectedProfiles.orchestrator);
    expect(reviewer.toolset).toEqual(expectedProfiles.reviewer);
  });

  it("expone catálogo canónico y congelado", () => {
    expect(Object.isFrozen(SDD_TOOL_CATALOG)).toBe(true);
    expect(Object.isFrozen(PROFILE_TOOLSETS)).toBe(true);
    for (const role of listProfiles()) {
      expect(Object.isFrozen(PROFILE_TOOLSETS[role])).toBe(true);
    }
  });

  it("rechaza perfiles inválidos con pruebas negativas", () => {
    const baseProfile = getProfile("planner");

    expect(() => {
      validateToolsetDeterministic({
        ...baseProfile,
        role: "planner",
        toolset: [...baseProfile.toolset].reverse(),
      });
    }).toThrow("toolset must be deterministic-sorted");

    expect(() => {
      validateToolsetDeterministic({
        ...baseProfile,
        role: "planner",
        toolset: [...baseProfile.toolset, "forgespec_nonexistent_tool"],
      });
    }).toThrow("includes unknown tool in protocol catalog");

    expect(() => {
      validateToolsetDeterministic({
        ...baseProfile,
        role: "planner",
        toolset: ["forge_negotiate", "forge_negotiate"],
        version: baseProfile.version,
        maxTools: baseProfile.maxTools,
      });
    }).toThrow("contains duplicates");

    expect(() => {
      validateToolsetDeterministic({
        role: "ghost" as never,
        version: "2.0.0",
        maxTools: 2,
        toolset: ["forge_negotiate"],
      });
    }).toThrow("Unknown role for capabilities profile: ghost");

    expect(() => getProfile("toString")).toThrow("Unknown role");
  });

  it("falla al solicitar perfil inexistente", () => {
    expect(() => getProfile("ghost" as never)).toThrowError("Unknown role");
  });
});
