export type FileCasePolicy = "sensitive" | "insensitive";
export type FileScopeKind = "exact" | "children" | "tree";

export interface NormalizedFileScope {
  normalized_scope: string;
  base_path: string;
  scope_kind: FileScopeKind;
}

const MAX_SCOPE_BYTES = 4096;

export function normalizeFileScopes(
  patterns: string[],
  casePolicy: FileCasePolicy
): NormalizedFileScope[] {
  if (patterns.length === 0 || patterns.length > 100) {
    throw new Error("File scope requests require between 1 and 100 patterns");
  }
  const normalized = patterns.map((pattern) => normalizeFileScope(pattern, casePolicy));
  const seen = new Set<string>();
  for (const scope of normalized) {
    if (seen.has(scope.normalized_scope)) throw new Error("Duplicate normalized file scope");
    seen.add(scope.normalized_scope);
  }
  return normalized;
}

export function normalizeFileScope(pattern: string, casePolicy: FileCasePolicy): NormalizedFileScope {
  if (!pattern || pattern.includes("\0") || Buffer.byteLength(pattern, "utf8") > MAX_SCOPE_BYTES) {
    throw new Error("File scope is empty, contains NUL, or exceeds the size limit");
  }
  let value = pattern.normalize("NFC").replace(/\\/g, "/");
  if (value.startsWith("/") || /^[A-Za-z]:/.test(value)) {
    throw new Error("File scope must be workspace-relative");
  }

  let scopeKind: FileScopeKind = "exact";
  if (value.endsWith("/**")) {
    scopeKind = "tree";
    value = value.slice(0, -3);
  } else if (value.endsWith("/*")) {
    scopeKind = "children";
    value = value.slice(0, -2);
  }
  if (/[*?\[\]{}]/.test(value)) throw new Error("Only trailing /* and /** file scopes are supported");

  const segments: string[] = [];
  for (const segment of value.split("/")) {
    if (!segment || segment === ".") continue;
    if (segment === "..") throw new Error("File scope cannot escape the workspace");
    segments.push(segment);
  }
  if (segments.length === 0) throw new Error("File scope is ambiguous or empty");
  let basePath = segments.join("/").normalize("NFC");
  if (casePolicy === "insensitive") basePath = basePath.toLocaleLowerCase("en-US");
  const suffix = scopeKind === "tree" ? "/**" : scopeKind === "children" ? "/*" : "";
  return { normalized_scope: `${basePath}${suffix}`, base_path: basePath, scope_kind: scopeKind };
}

export function scopesOverlap(left: NormalizedFileScope, right: NormalizedFileScope): boolean {
  if (left.scope_kind === "exact" && right.scope_kind === "exact") {
    return left.base_path === right.base_path;
  }
  if (left.scope_kind === "exact") return collectionContains(right, left.base_path);
  if (right.scope_kind === "exact") return collectionContains(left, right.base_path);
  if (left.scope_kind === "children" && right.scope_kind === "children") {
    return left.base_path === right.base_path;
  }
  return isSameOrDescendant(left.base_path, right.base_path)
    || isSameOrDescendant(right.base_path, left.base_path);
}

function collectionContains(scope: NormalizedFileScope, exactPath: string): boolean {
  if (scope.scope_kind === "tree") return isSameOrDescendant(exactPath, scope.base_path);
  return parentPath(exactPath) === scope.base_path;
}

function isSameOrDescendant(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(`${base}/`);
}

function parentPath(value: string): string {
  const separator = value.lastIndexOf("/");
  return separator < 0 ? "" : value.slice(0, separator);
}
