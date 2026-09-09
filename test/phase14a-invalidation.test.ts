import assert from "node:assert/strict";
import test from "node:test";

import type { FileFactBinding, IndexVersionDomains } from "../src/core/facts/facts.types.js";
import type { ImportReference } from "../src/core/graph/imports.js";
import {
  buildReverseImporterIndex,
  planInvalidation,
} from "../src/core/indexing/invalidation-planner.js";

const versions: IndexVersionDomains = {
  schemaVersion: "schema-1",
  factsSchemaVersion: "facts-schema-1",
  factsVersion: "facts-1",
  resolutionVersion: "resolution-1",
  derivedVersion: "derived-1",
};

function binding(
  relativePath: string,
  contentHash: string,
  language: "typescript" | "tsx" | "javascript" = "typescript",
): FileFactBinding {
  return {
    repositoryId: "repo",
    relativePath,
    generationId: "generation-1",
    factBlobKey: `blob-${contentHash}` as FileFactBinding["factBlobKey"],
    contentHash,
    language,
  };
}

function input(overrides: Partial<Parameters<typeof planInvalidation>[0]> = {}) {
  return {
    repositoryFiles: ["src/a.ts", "src/b.ts", "src/c.ts"],
    currentFiles: new Map([
      ["src/a.ts", { contentHash: "a-1", language: "typescript" as const }],
      ["src/b.ts", { contentHash: "b-1", language: "typescript" as const }],
      ["src/c.ts", { contentHash: "c-1", language: "typescript" as const }],
    ]),
    previousBindings: new Map([
      ["src/a.ts", binding("src/a.ts", "a-1")],
      ["src/b.ts", binding("src/b.ts", "b-1")],
      ["src/c.ts", binding("src/c.ts", "c-1")],
    ]),
    directImporters: new Map([
      ["src/a.ts", new Set(["src/b.ts"])],
    ]),
    versions,
    ...overrides,
  };
}

test("unchanged files reuse compatible facts without resolution work", () => {
  assert.deepEqual(planInvalidation(input()), {
    parsePaths: [],
    reusePaths: ["src/a.ts", "src/b.ts", "src/c.ts"],
    resolvePaths: [],
    removedPaths: [],
    derivedRebuild: false,
    fullGraphResolution: false,
    dependencyImpact: "bounded",
    importersInvalidated: [],
    reasons: [],
  });
});

test("modified dependency resolves the file and its direct importers", () => {
  const result = planInvalidation(input({
    currentFiles: new Map([
      ["src/a.ts", { contentHash: "a-2", language: "typescript" as const }],
      ["src/b.ts", { contentHash: "b-1", language: "typescript" as const }],
      ["src/c.ts", { contentHash: "c-1", language: "typescript" as const }],
    ]),
  }));

  assert.deepEqual(result.parsePaths, ["src/a.ts"]);
  assert.deepEqual(result.importersInvalidated, ["src/b.ts"]);
  assert.deepEqual(result.resolvePaths, ["src/a.ts", "src/b.ts"]);
  assert.equal(result.dependencyImpact, "bounded");
});

test("adds and deletes paths while retaining unchanged facts", () => {
  const result = planInvalidation(input({
    repositoryFiles: ["src/a.ts", "src/d.ts"],
    currentFiles: new Map([
      ["src/a.ts", { contentHash: "a-1", language: "typescript" as const }],
      ["src/d.ts", { contentHash: "d-1", language: "typescript" as const }],
    ]),
  }));

  assert.deepEqual(result.parsePaths, ["src/d.ts"]);
  assert.deepEqual(result.reusePaths, ["src/a.ts"]);
  assert.deepEqual(result.removedPaths, ["src/b.ts", "src/c.ts"]);
  assert.deepEqual(result.resolvePaths, ["src/d.ts"]);
});

test("same-content rename reuses the blob and resolves the old import boundary", () => {
  const result = planInvalidation(input({
    repositoryFiles: ["src/renamed.ts", "src/b.ts", "src/c.ts"],
    currentFiles: new Map([
      ["src/renamed.ts", { contentHash: "a-1", language: "typescript" as const }],
      ["src/b.ts", { contentHash: "b-1", language: "typescript" as const }],
      ["src/c.ts", { contentHash: "c-1", language: "typescript" as const }],
    ]),
    directImporters: new Map([
      ["src/a.ts", new Set(["src/b.ts"])],
    ]),
  }));

  assert.deepEqual(result.parsePaths, []);
  assert.deepEqual(result.reusePaths, ["src/b.ts", "src/c.ts", "src/renamed.ts"]);
  assert.deepEqual(result.removedPaths, ["src/a.ts"]);
  assert.deepEqual(result.resolvePaths, ["src/b.ts", "src/renamed.ts"]);
});

test("version domains invalidate only the work they own", () => {
  const resolution = planInvalidation(input({
    previousVersions: { ...versions, resolutionVersion: "resolution-2" },
  }));
  assert.deepEqual(resolution.parsePaths, []);
  assert.deepEqual(resolution.resolvePaths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.equal(resolution.fullGraphResolution, true);
  assert.equal(resolution.derivedRebuild, false);

  const facts = planInvalidation(input({
    previousVersions: { ...versions, factsVersion: "facts-2" },
  }));
  assert.deepEqual(facts.parsePaths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(facts.resolvePaths, ["src/a.ts", "src/b.ts", "src/c.ts"]);

  const derived = planInvalidation(input({
    previousVersions: { ...versions, derivedVersion: "derived-2" },
  }));
  assert.deepEqual(derived.parsePaths, []);
  assert.deepEqual(derived.resolvePaths, []);
  assert.equal(derived.derivedRebuild, true);
});

test("explicit module configuration evidence broadens resolution without parsing reusable facts", () => {
  const result = planInvalidation(input({
    directImporters: new Map([
      ["src/a.ts", new Set(["src/b.ts"])],
      ["module:workspace-alias", new Set(["src/c.ts"])],
    ]),
    unsafeTopologyReasons: new Set(["module_config_changed"]),
    currentFiles: new Map([
      ["src/a.ts", { contentHash: "a-2", language: "typescript" as const }],
      ["src/b.ts", { contentHash: "b-1", language: "typescript" as const }],
      ["src/c.ts", { contentHash: "c-1", language: "typescript" as const }],
    ]),
  }));

  assert.deepEqual(result.parsePaths, ["src/a.ts"]);
  assert.deepEqual(result.reusePaths, ["src/b.ts", "src/c.ts"]);
  assert.deepEqual(result.resolvePaths, ["src/a.ts", "src/b.ts", "src/c.ts"]);
  assert.deepEqual(result.importersInvalidated, ["src/b.ts"]);
  assert.equal(result.dependencyImpact, "uncertain");
  assert.equal(result.fullGraphResolution, true);
});

test("reverse importer index is sorted, deduplicated, and path/module evidence only", () => {
  const imports = new Map<string, ImportReference[]>([
    ["src/z.ts", [{ source: "../shared" }, { source: "react" }, { source: "../shared" }]],
    ["src/a.ts", [{ source: "./target.js" }]],
  ]);

  const first = buildReverseImporterIndex(imports);
  const second = buildReverseImporterIndex(new Map([...imports].reverse()));
  assert.deepEqual([...first.entries()].map(([target, importers]) => [target, [...importers]]), [
    ["module:react", ["src/z.ts"]],
    ["shared.js", ["src/z.ts"]],
    ["shared.jsx", ["src/z.ts"]],
    ["shared.ts", ["src/z.ts"]],
    ["shared.tsx", ["src/z.ts"]],
    ["shared/index.js", ["src/z.ts"]],
    ["shared/index.jsx", ["src/z.ts"]],
    ["shared/index.ts", ["src/z.ts"]],
    ["shared/index.tsx", ["src/z.ts"]],
    ["src/target.js", ["src/a.ts"]],
    ["src/target.jsx", ["src/a.ts"]],
    ["src/target.ts", ["src/a.ts"]],
    ["src/target.tsx", ["src/a.ts"]],
  ]);
  assert.deepEqual(
    [...second.entries()].map(([target, importers]) => [target, [...importers]]),
    [...first.entries()].map(([target, importers]) => [target, [...importers]]),
  );
});
