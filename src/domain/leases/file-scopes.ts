export type FileCasePolicy = "sensitive" | "insensitive";
export type FileScopeKind = "exact" | "children" | "tree";

export interface NormalizedFileScope {
  normalized_scope: string;
  base_path: string;
  scope_kind: FileScopeKind;
}

const MAX_SCOPE_BYTES = 4096;
const MAX_PATTERNS = 100;

export function normalizeFileScopes(patterns: string[], casePolicy: FileCasePolicy): NormalizedFileScope[] {
  if (patterns.length < 1 || patterns.length > MAX_PATTERNS) {
    throw new Error("File scope requests require between 1 and 100 patterns");
  }
  const result = patterns.map((pattern) => normalizeFileScope(pattern, casePolicy));
  const seen = new Set<string>();
  for (const scope of result) {
    if (seen.has(scope.normalized_scope)) throw new Error("Duplicate normalized file scope");
    seen.add(scope.normalized_scope);
  }
  return result;
}

export function normalizeFileScope(pattern: string, casePolicy: FileCasePolicy): NormalizedFileScope {
  if (typeof pattern !== "string" || pattern.length === 0 || pattern.includes("\0") || Buffer.byteLength(pattern, "utf8") > MAX_SCOPE_BYTES) {
    throw new Error("File scope is empty, contains NUL, or exceeds the size limit");
  }
  let value = pattern.normalize("NFC").replace(/\\/g, "/");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error("File scope must be workspace-relative");
  }

  let scope_kind: FileScopeKind = "exact";
  if (value.endsWith("/**")) {
    scope_kind = "tree";
    value = value.slice(0, -3);
  } else if (value.endsWith("/*")) {
    scope_kind = "children";
    value = value.slice(0, -2);
  }
  if (/[*?\[\]{}]/.test(value)) throw new Error("Only trailing /* and /** file scopes are supported");

  const segments = value.split("/");
  if (segments.some((segment) => segment === "")) throw new Error("File scope contains an empty path segment");
  const canonical = segments.filter((segment) => segment !== ".");
  if (canonical.some((segment) => segment === "..") || canonical.length === 0) {
    throw new Error("File scope cannot escape the workspace or be empty");
  }
  let base_path = canonical.join("/").normalize("NFC");
  if (casePolicy === "insensitive") base_path = base_path.toLocaleLowerCase("en-US");
  const suffix = scope_kind === "tree" ? "/**" : scope_kind === "children" ? "/*" : "";
  return { normalized_scope: `${base_path}${suffix}`, base_path, scope_kind };
}

export function scopesOverlap(left: NormalizedFileScope, right: NormalizedFileScope): boolean {
  if (!isValid(left) || !isValid(right)) return false;
  if (left.scope_kind === "exact" && right.scope_kind === "exact") return left.base_path === right.base_path;
  if (left.scope_kind === "exact") return contains(right, left.base_path);
  if (right.scope_kind === "exact") return contains(left, right.base_path);
  if (left.scope_kind === "children" && right.scope_kind === "children") return left.base_path === right.base_path;
  return descendant(left.base_path, right.base_path) || descendant(right.base_path, left.base_path);
}

function isValid(scope: NormalizedFileScope): boolean {
  return !!scope.base_path && (scope.scope_kind === "exact" || scope.scope_kind === "children" || scope.scope_kind === "tree") && scope.normalized_scope.length > 0;
}
function contains(scope: NormalizedFileScope, path: string): boolean {
  return scope.scope_kind === "tree" ? descendant(path, scope.base_path) : parent(path) === scope.base_path;
}
function descendant(candidate: string, base: string): boolean { return candidate === base || candidate.startsWith(`${base}/`); }
function parent(value: string): string { const index = value.lastIndexOf("/"); return index < 0 ? "" : value.slice(0, index); }
