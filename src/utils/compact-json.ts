/**
 * Compacts data structures for LLM agent token optimization.
 * Removes null, undefined, empty arrays/strings to save context window tokens.
 */
export function compactJson<T>(value: T): T {
  if (value === null || value === undefined) {
    return undefined as unknown as T;
  }
  if (Array.isArray(value)) {
    const compactedArray = value
      .map(compactJson)
      .filter((item) => item !== undefined);
    return compactedArray as unknown as T;
  }
  if (typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      if (val === null || val === undefined) continue;
      if (typeof val === "string" && val === "") continue;
      if (Array.isArray(val) && val.length === 0) continue;
      const compacted = compactJson(val);
      if (compacted !== undefined) {
        result[key] = compacted;
      }
    }
    return result as unknown as T;
  }
  return value;
}
