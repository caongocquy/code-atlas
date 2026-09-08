import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { factBlobKey } from "../src/core/facts/facts-identity.js";
import {
  extractParsedFacts,
  materializeFileFacts,
} from "../src/core/facts/facts-extractor.js";
import type {
  FileFactBinding,
  IndexVersionDomains,
  ParsedFactsBlob,
} from "../src/core/facts/facts.types.js";
import {
  CURRENT_INDEX_VERSION_DOMAINS,
  INDEX_SCHEMA_VERSION,
} from "../src/core/repository/index-version.js";
import { parseCodeSymbols } from "../src/core/graph/parsers/code-parser.js";

const parserIdentity = {
  language: "typescript" as const,
  runtimeName: "tree-sitter" as const,
  runtimeVersion: "0.25.1",
  packageName: "tree-sitter-typescript",
  grammarName: "tree-sitter-typescript",
  grammarVersion: "0.23.2",
};

function factInput(overrides: Partial<ParsedFactsBlob> = {}): ParsedFactsBlob {
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
    imports: [],
    exports: [],
    references: [],
    callSites: [],
    bindingSeeds: [],
    declaredTypeAnnotations: [],
    expressions: [],
    members: [],
    assignments: [],
    parameters: [],
    returns: [],
    constructors: [],
    inheritances: [],
    implementations: [],
    aliases: [],
    modules: [],
    namespaces: [],
    ...overrides,
  };
}

test("fact blob keys are canonical and path-independent", () => {
  const facts = factInput();
  const key = factBlobKey(facts);
  const expected = createHash("sha256")
    .update(JSON.stringify({
      contentHash: facts.contentHash,
      language: facts.language,
      parserIdentity: {
        language: facts.parserIdentity.language,
        parserName: undefined,
        parserVersion: undefined,
        grammarName: facts.parserIdentity.grammarName,
        grammarVersion: facts.parserIdentity.grammarVersion,
        adapterVersion: undefined,
      },
      factsVersion: facts.factsVersion,
      factsSchemaVersion: facts.factsSchemaVersion,
    }))
    .digest("hex");

  assert.equal(key, expected);
  const firstBinding: FileFactBinding = {
    repositoryId: "repo-a",
    relativePath: "src/first.ts",
    generationId: "generation-a",
    factBlobKey: key,
    contentHash: facts.contentHash,
    language: facts.language,
  };
  const secondBinding: FileFactBinding = {
    ...firstBinding,
    repositoryId: "repo-b",
    relativePath: "src/renamed.ts",
    generationId: "generation-b",
  };

  assert.equal(firstBinding.factBlobKey, secondBinding.factBlobKey);
});

test("parser identity and facts version changes miss the fact cache", () => {
  const facts = factInput();
  const original = factBlobKey(facts);

  assert.notEqual(original, factBlobKey({
    ...facts,
    parserIdentity: { ...facts.parserIdentity, grammarVersion: "0.23.3" },
  }));
  assert.notEqual(original, factBlobKey({ ...facts, factsVersion: "2" }));
});

test("resolution-only and derived-only version changes retain the facts domain", () => {
  const resolutionOnly: IndexVersionDomains = {
    ...CURRENT_INDEX_VERSION_DOMAINS,
    resolutionVersion: "next-resolution",
  };
  const derivedOnly: IndexVersionDomains = {
    ...CURRENT_INDEX_VERSION_DOMAINS,
    derivedVersion: "next-derived",
  };

  assert.equal(resolutionOnly.factsVersion, CURRENT_INDEX_VERSION_DOMAINS.factsVersion);
  assert.equal(derivedOnly.factsVersion, CURRENT_INDEX_VERSION_DOMAINS.factsVersion);
  const facts = factInput({ factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion });

  assert.equal(factBlobKey({ ...facts, factsVersion: resolutionOnly.factsVersion }), factBlobKey(facts));
  assert.equal(factBlobKey({ ...facts, factsVersion: derivedOnly.factsVersion }), factBlobKey(facts));
});

test("storage schema version is independently owned from facts schema version", () => {
  assert.equal(CURRENT_INDEX_VERSION_DOMAINS.schemaVersion, INDEX_SCHEMA_VERSION);
});

test("persisted facts exercise every path-neutral DTO and reject path state", () => {
  const facts = factInput({
    parserDiagnostics: ["missing:semicolon"],
    symbols: [{
      localId: "symbol:1",
      name: "parse",
      kind: "function",
      range: { startLine: 1, endLine: 1, startColumn: 0, endColumn: 5 },
      scopeId: "scope:1",
      declaredQualifiedName: "Parser.parse",
    }],
    containmentScopes: [{
      localId: "scope:1",
      kind: "class",
      name: "Parser",
      parentId: "scope:0",
      range: { startLine: 1, endLine: 10, startColumn: 0, endColumn: 1 },
    }],
    imports: [{
      localId: "import:1",
      moduleSpecifier: "./parser.js",
      importedName: "parse",
      localName: "parseSource",
      kind: "named",
      range: { startLine: 1, endLine: 1 },
    }],
    exports: [{
      localId: "export:1",
      exportedName: "parse",
      localName: "parseSource",
      moduleSpecifier: "./parser.js",
      kind: "named",
      range: { startLine: 2, endLine: 2 },
    }],
    references: [{
      localId: "reference:1",
      name: "parseSource",
      ownerId: "symbol:1",
      scopeId: "scope:1",
      range: { startLine: 3, endLine: 3 },
    }],
    callSites: [{
      localId: "call:1",
      calleeText: "parseSource()",
      callerId: "symbol:1",
      scopeId: "scope:1",
      range: { startLine: 4, endLine: 4 },
    }],
    bindingSeeds: [{
      localId: "binding:1",
      name: "parse",
      bindingKind: "import",
      sourceModule: "./parser.js",
      importedName: "parse",
      ownerId: "symbol:1",
      range: { startLine: 1, endLine: 1 },
    }],
    declaredTypeAnnotations: [{
      localId: "type:1",
      ownerId: "symbol:1",
      text: "ParserResult",
      range: { startLine: 1, endLine: 1 },
    }],
  });
  const forbidden = /(?:repository|path|filePath|sourcePath|resolved|target|confidence|evidence|nodeId|edgeId)/i;

  function assertPathNeutral(value: unknown): void {
    if (Array.isArray(value)) {
      value.forEach(assertPathNeutral);
      return;
    }
    if (value && typeof value === "object") {
      for (const [key, nested] of Object.entries(value)) {
        assert.doesNotMatch(key, forbidden);
        assertPathNeutral(nested);
      }
    }
  }

  assertPathNeutral(facts);
  assert.throws(() => assertPathNeutral({ filePath: "src/parser.ts" }));
  assert.throws(() => assertPathNeutral({ sourcePath: "src/parser.ts" }));
});

test("extracts one path-neutral fact blob from a TypeScript source snapshot", () => {
  const source = `
import { helper as alias } from "./dep.js";
export const value: Result = helper();
class Service {
  run(input: Input): Result { return alias(input); }
}
function outer() {
  const nested = () => value;
  return nested();
}
export { Service };
`;
  const input = {
    source,
    language: "typescript" as const,
    contentHash: "snapshot-hash",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
  };

  const result = extractParsedFacts(input);

  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  assert.equal(result.facts.parseStatus, "complete");
  assert.equal(result.facts.symbols.length, 4);
  assert.deepEqual(
    result.facts.symbols.map((fact) => fact.localId),
    ["symbol:1", "symbol:2", "symbol:3", "symbol:4"],
  );
  assert.equal(result.facts.imports.length, 1);
  assert.equal(result.facts.exports.length, 2);
  assert.equal(result.facts.bindingSeeds.length, 3);
  assert.equal(result.facts.callSites.length, 3);
  assert.ok(result.facts.containmentScopes.length >= 4);
  assert.equal(result.facts.references.length, 5);
  assert.equal(result.facts.declaredTypeAnnotations.length, 3);
  assert.ok(result.facts.parserIdentity.grammarName.includes("typescript"));

  const materializedA = materializeFileFacts("src/first.ts", result.facts);
  const materializedB = materializeFileFacts("src/renamed.ts", result.facts);
  assert.deepEqual(materializedA.facts, materializedB.facts);
  assert.equal(materializedA.relativePath, "src/first.ts");
  assert.equal(materializedB.relativePath, "src/renamed.ts");
  assert.equal(factBlobKey(materializedA.facts), factBlobKey(materializedB.facts));

  const existingSymbols = parseCodeSymbols(source, "fixture.ts");
  assert.deepEqual(
    result.facts.symbols.map((fact) => [fact.name, fact.kind, fact.range.startLine]),
    existingSymbols
      .toSorted((left, right) => left.startLine - right.startLine)
      .map((chunk) => [chunk.symbolName, chunk.symbolType, chunk.startLine]),
  );
});

test("preserves side-effect imports and aliased export bindings", () => {
  const result = extractParsedFacts({
    source: 'import "./setup.js"; const local = value; export { local as published };',
    language: "typescript",
    contentHash: "snapshot-hash",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
  });

  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  assert.deepEqual(result.facts.imports.map(({ moduleSpecifier, kind }) => ({ moduleSpecifier, kind })), [
    { moduleSpecifier: "./setup.js", kind: "side-effect" },
  ]);
  assert.deepEqual(result.facts.exports.map(({ exportedName, localName }) => ({ exportedName, localName })), [
    { exportedName: "published", localName: "local" },
  ]);
});

test("retains parser diagnostics for missing tree-sitter nodes", () => {
  const result = extractParsedFacts({
    source: "class A {",
    language: "typescript",
    contentHash: "broken-hash",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
  });

  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  assert.equal(result.facts.parseStatus, "deterministic_partial");
  assert.ok(result.facts.parserDiagnostics.length > 0);
});

test("records containment ownership for symbols, calls, and references", () => {
  const result = extractParsedFacts({
    source: `
function outer() {
  const value = helper();
  return value;
}
`,
    language: "typescript",
    contentHash: "ownership-hash",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
  });

  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  const outer = result.facts.symbols.find((symbol) => symbol.name === "outer");
  assert.ok(outer?.scopeId);
  assert.equal(outer?.scopeId, "scope:1");
  assert.equal(result.facts.callSites[0]?.callerId, outer?.localId);
  assert.equal(result.facts.callSites[0]?.scopeId, "scope:3");
  assert.equal(result.facts.references.find((reference) => reference.name === "value")?.ownerId, outer?.localId);
});

test("extracts export-star facts with their source module", () => {
  const result = extractParsedFacts({
    source: 'export * from "./dep.js";',
    language: "typescript",
    contentHash: "star-hash",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: "1.0.0",
  });

  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  assert.equal(result.facts.exports.length, 1);
  assert.deepEqual(
    result.facts.exports.map(({ exportedName, moduleSpecifier, kind }) => ({ exportedName, moduleSpecifier, kind })),
    [{ exportedName: "*", moduleSpecifier: "./dep.js", kind: "star" }],
  );
});
