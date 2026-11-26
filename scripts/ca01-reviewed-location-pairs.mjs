import { createHash } from "node:crypto";

// A digest binds every reviewed name, nesting level and exact old/new location.
// Matching a semantic name alone is never sufficient to translate an identity.
export function locationPairDigest(pairs) {
  const rows = pairs.map(({ before, after }) => {
    if (before.file !== after.file || before.name !== after.name || before.nesting !== after.nesting) {
      throw new Error("Invalid reviewed location pair");
    }
    return [before.name, before.nesting, before.line, before.column, after.line, after.column];
  }).sort((a, b) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0);
  return createHash("sha256").update(JSON.stringify(rows)).digest("hex");
}

export function selectReviewedLocationPairs(audit, sources) {
  if (!Array.isArray(sources) || sources.length === 0) throw new Error("Missing reviewed source contracts");
  const files = new Set();
  const pairs = [];
  for (const source of sources) {
    if (!/^test\/[\w.-]+\.test\.ts$/.test(source.file) || files.has(source.file) ||
        !Number.isSafeInteger(source.pairCount) || source.pairCount < 1 || !/^[a-f0-9]{64}$/.test(source.pairSha256)) {
      throw new Error("Invalid or duplicate reviewed source contract");
    }
    files.add(source.file);
    const matches = audit.moved.filter(pair => pair.before.file === source.file);
    if (matches.length !== source.pairCount || locationPairDigest(matches) !== source.pairSha256) {
      throw new Error(`Unreviewed identity locations in ${source.file}: expected ${source.pairCount}, observed ${matches.length}`);
    }
    pairs.push(...matches);
  }
  // Any extra missing or moved identities remain subject to the original comparator.
  return pairs;
}
