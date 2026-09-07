import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { buildCodeGraph, buildCodeGraphWithResolutionFromFacts } from "../src/core/graph/build-graph.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";

test("facts graph preserves clean-fixture graph nodes and edges", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-equivalence-"));
  const source = "export function helper() {}\nexport function run() { helper(); }\n";
  await writeFile(path.join(repoPath, "run.ts"), source);
  try {
    const extracted = extractParsedFacts({
    source,
    language: "typescript",
    contentHash: "equivalence",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
    });
    assert.equal(extracted.kind, "facts");
    if (extracted.kind !== "facts") throw extracted.error;

    const expected = await buildCodeGraph(repoPath, undefined, "repo");
    const actual = await buildCodeGraphWithResolutionFromFacts(repoPath, [{
    relativePath: "run.ts",
    source,
    facts: extracted.facts,
    } satisfies IndexedSourceUnit], undefined, "repo");

    assert.deepEqual(
    actual.graph.nodes.map(({ id, ...node }) => node),
    expected.nodes.map(({ id, ...node }) => node),
    );
    assert.deepEqual(
    actual.graph.edges.map(({ from, to, ...edge }) => ({ ...edge, from: from.replace(/^.*?:/, ""), to: to.replace(/^.*?:/, "") })),
    expected.edges.map(({ from, to, ...edge }) => ({ ...edge, from: from.replace(/^.*?:/, ""), to: to.replace(/^.*?:/, "") })),
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
