import { canonicalJson } from "../core/canonical-json.js";

function normalizeActorValue(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value.trim().toLowerCase();
  return normalized.length > 0 ? normalized : null;
}

/** Return the canonical, sorted, unique actor set or null for invalid JSON. */
export function normalizeActorSet(value: string): string | null {
  try {
    const parsed: unknown = JSON.parse(value);
    if (!Array.isArray(parsed)) throw new Error("allowed_actors_json must be an array");
    const actors = new Set<string>();
    for (const actor of parsed) {
      const normalized = normalizeActorValue(actor);
      if (normalized !== null) actors.add(normalized);
    }
    return canonicalJson(Array.from(actors).sort());
  } catch {
    return null;
  }
}

export const canonicalizeActorsJson = normalizeActorSet;

export function validateActorSet(value: string): void {
  if (normalizeActorSet(value) === null) throw new Error("invalid actor set JSON");
}
