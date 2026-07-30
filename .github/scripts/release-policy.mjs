import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

const RELEASE_USAGE = 'Dispatch with: gh workflow run release.yml --ref "$TAG" -f tag="$TAG"';

export function assertDispatchProvenance({ eventName, refType, refName, eventSha, tag, sourceSha }) {
  if (eventName !== "workflow_dispatch") return;

  if (refType !== "tag" || refName !== tag || eventSha.toLowerCase() !== sourceSha.toLowerCase()) {
    throw new Error(
      `Manual release provenance mismatch: expected tag ${tag} at ${sourceSha}, got ${refType} ${refName} at ${eventSha}. ${RELEASE_USAGE}`
    );
  }
}

export function parseRemoteTagCommit(output, tag) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const refs = new Map();

  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [sha, ref, ...extra] = line.split("\t");
    if (extra.length > 0 || !/^[0-9a-f]{40}$/i.test(sha ?? "") || (ref !== directRef && ref !== peeledRef)) {
      throw new Error(`Unexpected remote tag response for ${tag}`);
    }
    if (refs.has(ref)) throw new Error(`Duplicate remote tag ref: ${ref}`);
    refs.set(ref, sha.toLowerCase());
  }

  const direct = refs.get(directRef);
  if (!direct) throw new Error(`Remote release tag is missing: ${tag}`);
  return refs.get(peeledRef) ?? direct;
}

export function assertRemoteTagCommit(output, tag, sourceSha) {
  const remoteSha = parseRemoteTagCommit(output, tag);
  if (remoteSha !== sourceSha.toLowerCase()) {
    throw new Error(`Remote release tag ${tag} moved: expected ${sourceSha}, got ${remoteSha}`);
  }
}

export function classifyReleaseLookupStatus(status) {
  if (status === 200) return "exists";
  if (status === 404) return "missing";
  throw new Error(`GitHub release lookup failed with HTTP ${status}`);
}

function verifyRemoteTag(tag, sourceSha) {
  const result = spawnSync(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { encoding: "utf8" }
  );
  if (result.status !== 0) {
    throw new Error(`Unable to query remote release tag ${tag}: ${result.stderr.trim()}`);
  }

  assertRemoteTagCommit(result.stdout, tag, sourceSha);
  console.log(`Remote release tag verified: ${tag} -> ${sourceSha}`);
}

async function lookupGitHubRelease(tag) {
  const token = process.env.GH_TOKEN;
  const repository = process.env.GITHUB_REPOSITORY;
  if (!token || !repository) throw new Error("GH_TOKEN and GITHUB_REPOSITORY are required");

  const response = await fetch(
    `https://api.github.com/repos/${repository}/releases/tags/${encodeURIComponent(tag)}`,
    {
      headers: {
        Accept: "application/vnd.github+json",
        Authorization: `Bearer ${token}`,
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(30_000),
    }
  );
  console.log(classifyReleaseLookupStatus(response.status));
}

async function main([command, ...args]) {
  if (command === "assert-dispatch") {
    const [eventName, refType, refName, eventSha, tag, sourceSha] = args;
    assertDispatchProvenance({ eventName, refType, refName, eventSha, tag, sourceSha });
    return;
  }
  if (command === "verify-remote-tag") {
    verifyRemoteTag(args[0], args[1]);
    return;
  }
  if (command === "lookup-github-release") {
    await lookupGitHubRelease(args[0]);
    return;
  }
  throw new Error(`Unknown release policy command: ${command ?? "<missing>"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
