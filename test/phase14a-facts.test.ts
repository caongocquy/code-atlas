import { createHash } from "node:crypto";
import assert from "node:assert/strict";
import test from "node:test";

import { factBlobKey } from "../src/core/facts/facts-identity.js";
import type {
  FileFactBinding,
  IndexVersionDomains,
  ParsedFactsBlob,
} from "../src/core/facts/facts.types.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";

const parserIdentity = {
  language: "typescript" as const,
  parserName: "tree-sitter",
  parserVersion: "0.25.1",
  grammarName: "tree-sitter-typescript",
  grammarVersion: "0.23.2",
  adapterVersion: "1",
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
      parserIdentity: facts.parserIdentity,
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

test("persisted facts fixture contains only path-neutral structural evidence", () => {
  const facts = factInput({
    symbols: [{
      localId: "symbol:1",
      name: "parse",
      kind: "function",
      range: { startLine: 1, endLine: 1 },
    }],
    imports: [{
      localId: "import:1",
      moduleSpecifier: "./parser.js",
      kind: "named",
      range: { startLine: 1, endLine: 1 },
    }],
    bindingSeeds: [{
      localId: "binding:1",
      name: "parse",
      bindingKind: "import",
      sourceModule: "./parser.js",
      importedName: "parse",
      range: { startLine: 1, endLine: 1 },
    }],
  });
  const forbidden = /(?:repository|relativePath|resolved|target|confidence|evidence|nodeId|edgeId)/i;

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
});
