import { createHash } from "node:crypto";

const encode = row => JSON.stringify(row);
const digest = rows => createHash("sha256").update(JSON.stringify(rows.sort((a, b) => encode(a) < encode(b) ? -1 : encode(a) > encode(b) ? 1 : 0))).digest("hex");
const logicalKey = id => JSON.stringify([id.name, id.nesting]);

// Source blobs are independently checked by the caller. This is a complete
// reviewed source registry, not a fallback matching strategy for arbitrary tests.
export function selectReviewedSourcePairs(baseline, candidate, group) {
  if (!/^test\/[\w.-]+\.test\.ts$/.test(group.file) || !Number.isSafeInteger(group.identityCount) || group.identityCount < 1 ||
      !/^[a-f0-9]{64}$/.test(group.baselineIdentitySha256) || !/^[a-f0-9]{64}$/.test(group.logicalIdentitySha256)) {
    throw new Error("Invalid reviewed source registry");
  }
  const collect = events => {
    const rows = events.filter(row => (row.type === "test:pass" || row.type === "test:fail") && row.identity.file === group.file).map(row => row.identity);
    const keys = new Map(rows.map(id => [logicalKey(id), id]));
    if (rows.length !== group.identityCount || keys.size !== rows.length ||
        rows.some(id => typeof id.name !== "string" || !id.name || !Number.isSafeInteger(id.nesting) || id.nesting < 0 ||
          !Number.isSafeInteger(id.line) || id.line < 1 || !Number.isSafeInteger(id.column) || id.column < 1) ||
        digest(rows.map(id => [id.name, id.nesting])) !== group.logicalIdentitySha256) {
      throw new Error("Unreviewed or ambiguous source registry: " + group.file);
    }
    return { rows, keys };
  };
  const before = collect(baseline), after = collect(candidate);
  if (digest(before.rows.map(id => [id.name, id.nesting, id.line, id.column])) !== group.baselineIdentitySha256) {
    throw new Error("Reviewed baseline identity coordinates changed");
  }
  return before.rows.flatMap(id => {
    const next = after.keys.get(logicalKey(id));
    if (!next) throw new Error("Missing reviewed source identity");
    return id.line === next.line && id.column === next.column ? [] : [{ before: id, after: next }];
  });
}
