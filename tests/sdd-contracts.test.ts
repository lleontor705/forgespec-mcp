import { describe, it, expect } from "vitest";
import {
  SddContractSchema,
  PHASE_TRANSITIONS,
  CONFIDENCE_THRESHOLDS,
  SDD_PHASES,
} from "../src/types/index.js";
import { canonicalJson, canonicalSha256 } from "../src/core/canonical-json.js";

describe("SDD Contract Schema", () => {
  const validContract = {
    schema_version: "1.0",
    phase: "init",
    change_name: "test-feature",
    project: "my-project",
    status: "success",
    confidence: 0.8,
    executive_summary: "This is a test summary for the init phase.",
    artifacts_saved: [],
    next_recommended: ["explore"],
    risks: [],
    data: {},
  };

  it("accepts a valid contract", () => {
    const result = SddContractSchema.safeParse(validContract);
    expect(result.success).toBe(true);
  });

  it("rejects contract with missing required fields", () => {
    const result = SddContractSchema.safeParse({
      phase: "init",
    });
    expect(result.success).toBe(false);
  });

  it("rejects contract with invalid phase", () => {
    const result = SddContractSchema.safeParse({
      ...validContract,
      phase: "invalid-phase",
    });
    expect(result.success).toBe(false);
  });

  it("rejects confidence out of range", () => {
    const result = SddContractSchema.safeParse({
      ...validContract,
      confidence: 1.5,
    });
    expect(result.success).toBe(false);
  });

  it("rejects empty executive summary", () => {
    const result = SddContractSchema.safeParse({
      ...validContract,
      executive_summary: "short",
    });
    expect(result.success).toBe(false);
  });

  it("validates risk levels", () => {
    const withRisk = {
      ...validContract,
      risks: [{ description: "test risk", level: "high" }],
    };
    const result = SddContractSchema.safeParse(withRisk);
    expect(result.success).toBe(true);
  });
});

describe("Phase Transitions", () => {
  it("init can only go to explore or propose", () => {
    expect(PHASE_TRANSITIONS.init).toEqual(["explore", "propose"]);
  });

  it("archive has no transitions", () => {
    expect(PHASE_TRANSITIONS.archive).toEqual([]);
  });

  it("every phase has defined transitions", () => {
    for (const phase of SDD_PHASES) {
      expect(PHASE_TRANSITIONS[phase]).toBeDefined();
    }
  });
});

describe("Confidence Thresholds", () => {
  it("verify and archive require highest confidence", () => {
    expect(CONFIDENCE_THRESHOLDS.verify).toBe(0.9);
    expect(CONFIDENCE_THRESHOLDS.archive).toBe(0.9);
  });

  it("init and explore have lowest thresholds", () => {
    expect(CONFIDENCE_THRESHOLDS.init).toBe(0.5);
    expect(CONFIDENCE_THRESHOLDS.explore).toBe(0.5);
  });
});

describe("Canonical contract JSON", () => {
  it("produces one semantic encoding and digest regardless of object key order", () => {
    const left = {
      z: [{ beta: true, alpha: null }],
      a: { nested: "value", count: 2 },
    };
    const right = {
      a: { count: 2, nested: "value" },
      z: [{ alpha: null, beta: true }],
    };

    expect(canonicalJson(left)).toBe(canonicalJson(right));
    expect(canonicalSha256(left)).toMatch(/^sha256:[a-f0-9]{64}$/);
    expect(canonicalSha256(left)).toBe(canonicalSha256(right));
    expect(JSON.parse(canonicalJson(left))).toEqual(left);
  });

  it("rejects values that cannot be represented durably in JSON", () => {
    expect(() => canonicalJson({ value: Number.NaN })).toThrow(/finite/i);
    expect(() => canonicalJson({ value: undefined })).toThrow(/undefined/i);
  });
});
