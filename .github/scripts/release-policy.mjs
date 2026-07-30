import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

export function parseRemoteTagCommit(output, tag) {
  const directRef = `refs/tags/${tag}`;
  const peeledRef = `${directRef}^{}`;
  const refs = new Map();

  for (const line of output.trim().split(/\r?\n/).filter(Boolean)) {
    const [sha, ref, ...extra] = line.split("\t");
    if (extra.length || !/^[0-9a-f]{40}$/i.test(sha ?? "") || (ref !== directRef && ref !== peeledRef)) {
      throw new Error(`Unexpected remote tag response for ${tag}`);
    }
    if (refs.has(ref)) throw new Error(`Duplicate remote tag ref: ${ref}`);
    refs.set(ref, sha.toLowerCase());
  }

  const direct = refs.get(directRef);
  const peeled = refs.get(peeledRef);
  if (!direct && peeled) throw new Error(`Remote tag ${tag} returned a peeled ref without its tag ref`);
  return peeled ?? direct ?? null;
}

export function assertRemoteTagAbsent(output, tag) {
  const commit = parseRemoteTagCommit(output, tag);
  if (commit) throw new Error(`Remote release tag already exists: ${tag} -> ${commit}`);
}

export function assertRemoteTagCommit(output, tag, sourceSha) {
  const commit = parseRemoteTagCommit(output, tag);
  if (!commit) throw new Error(`Remote release tag is missing: ${tag}`);
  if (commit !== sourceSha.toLowerCase()) {
    throw new Error(`Remote release tag ${tag} points to ${commit}; expected ${sourceSha}`);
  }
}

function queryRemoteTag(tag) {
  const result = spawnSync(
    "git",
    ["ls-remote", "--tags", "origin", `refs/tags/${tag}`, `refs/tags/${tag}^{}`],
    { encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(`Unable to query remote release tag ${tag}: ${result.stderr.trim() || "git ls-remote failed"}`);
  }
  return result.stdout;
}

function main([command, tag, sourceSha]) {
  if (!tag) throw new Error("Release tag is required");
  const output = queryRemoteTag(tag);

  if (command === "assert-remote-tag-absent") {
    assertRemoteTagAbsent(output, tag);
    console.log(`Remote release tag is absent: ${tag}`);
    return;
  }
  if (command === "verify-remote-tag") {
    if (!sourceSha) throw new Error("Source SHA is required");
    assertRemoteTagCommit(output, tag, sourceSha);
    console.log(`Remote release tag verified: ${tag} -> ${sourceSha}`);
    return;
  }
  throw new Error(`Unknown release policy command: ${command ?? "<missing>"}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
