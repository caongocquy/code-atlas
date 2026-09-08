import assert from "node:assert/strict";
import test from "node:test";

import type { ImportFact, ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { buildFactReverseImporterIndex } from "../src/core/indexing/invalidation-planner.js";

function factsWithImports(...specifiers: string[]): ParsedFactsBlob {
  const parserIdentity = {
    language: "typescript" as const,
    parserName: "tree-sitter",
    parserVersion: "0.25.1",
    grammarName: "tree-sitter-typescript",
    grammarVersion: "0.23.2",
    adapterVersion: "1",
  };

  const imports: ImportFact[] = specifiers.map((moduleSpecifier, index) => ({
    localId: `import:${index}`,
    moduleSpecifier,
    kind: "import",
    range: { startLine: index + 1, endLine: index + 1 },
  }));

  return {
    factsSchemaVersion: "1",
    factsVersion: "1",
    contentHash: "content-hash",
    language: "typescript",
    parserIdentity,
    parseStatus: "complete",
    parserDiagnostics: [],
    symbols: [],
    containmentScopes: [],
    imports,
    exports: [],
    references: [],
    callSites: [],
    bindingSeeds: [],
    declaredTypeAnnotations: [],
  };
}

test("fact reverse importer index preserves unresolved and external ownership", () => {
  const reverse = buildFactReverseImporterIndex(new Map([
    ["src/a.ts", factsWithImports("./b.js", "workspace-alias")],
  ]));
  assert.deepEqual([...reverse.entries()].map(([target, importers]) => [target, [...importers]]), [
    ["module:workspace-alias", ["src/a.ts"]],
    ["src/b.js", ["src/a.ts"]],
  ]);
});
