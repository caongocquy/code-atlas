import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import Parser from "tree-sitter";

import { LEXICAL_INDEX_VERSION } from "../src/config/constants.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { indexLexical, toLexicalDocumentsFromFacts } from "../src/core/lexical/lexical-index.service.js";
import { searchLexical } from "../src/core/lexical/lexical-search.service.js";
import { inspectHybridSearch } from "../src/core/retrieval/hybrid-search.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "2",
  factsSchemaVersion: "1",
  factsVersion: "1",
  resolutionVersion: "1",
  derivedVersion: "1",
};

function unit(relativePath: string, source: string): IndexedSourceUnit {
  const extracted = extractParsedFacts({
    source,
    language: "typescript",
    contentHash: `${relativePath}:${source}`,
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") throw extracted.error;
  return { relativePath, source, facts: extracted.facts };
}

async function withIndexedUnits<T>(units: IndexedSourceUnit[], run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase16c-b3-"));
  await mkdir(path.join(root, ".codeatlas"), { recursive: true });
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(root));
  const generation = createCandidateGeneration(repository.id, undefined, versions, []);
  store.beginCandidateGeneration(generation);
  store.writeCandidateManifest(generation.manifest);
  store.writeCandidateLexicalDocuments(generation.id, units.map((sourceUnit) => ({
    file: sourceUnit.relativePath,
    fileHash: sourceUnit.facts.contentHash,
    documents: toLexicalDocumentsFromFacts(repository.id, sourceUnit),
  })));
  store.publishCandidateGeneration(generation.id, { requireLexical: true });
  store.close();

  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("class methods receive owner-qualified names while symbol names remain bare", () => {
  const indexed = unit("gateways.ts", "class CardGateway { connect() {} }\nclass ApiGateway { connect() {} }\n");
  const methods = toLexicalDocumentsFromFacts("repo", indexed).filter((document) => document.symbolType === "method");

  assert.deepEqual(methods.map(({ symbolName, qualifiedName }) => ({ symbolName, qualifiedName })), [
    { symbolName: "connect connect", qualifiedName: "CardGateway.connect Card Gateway connect" },
    { symbolName: "connect connect", qualifiedName: "ApiGateway.connect Api Gateway connect" },
  ]);
});

test("top-level and nested local functions keep their existing unqualified names", () => {
  const indexed = unit("nested.ts", `
    class Outer {
      run() {
        function localThing() {}
        if (true) { function blockThing() {} }
      }
    }
    function topLevel() {}
  `);
  const documents = toLexicalDocumentsFromFacts("repo", indexed);

  assert.equal(documents.find((document) => document.symbolName.startsWith("run"))?.qualifiedName, "Outer.run Outer run");
  assert.equal(documents.find((document) => document.symbolName.startsWith("localThing"))?.qualifiedName, "localThing local Thing");
  assert.equal(documents.find((document) => document.symbolName.startsWith("blockThing"))?.qualifiedName, "blockThing block Thing");
  assert.equal(documents.find((document) => document.symbolName.startsWith("topLevel"))?.qualifiedName, "topLevel top Level");
});

test("anonymous class scopes do not create owner-qualified member names", () => {
  const indexed = unit("anonymous.ts", "const anonymous = class { run() {} };\n");
  const method = toLexicalDocumentsFromFacts("repo", indexed).find((document) => document.symbolName.startsWith("run"));

  assert.equal(method?.qualifiedName, "run run");
});

test("full owner context promotes its matching same-name method", async () => {
  const source = [
    "class PaymentGateway { authorize() {} }",
    "class BackupGateway { authorize() {} }",
    "class ImageCache { read() {} }",
    "class DiskCache { read() {} }",
  ].join("\n");
  const indexed = unit("gateways.ts", source);

  await withIndexedUnits([indexed], async (root) => {
    const payment = await searchLexical("PaymentGateway authorize", 20, root);
    const backup = await searchLexical("BackupGateway authorize", 20, root);
    const image = await searchLexical("ImageCache read", 20, root);
    const disk = await searchLexical("DiskCache read", 20, root);
    const paymentHybrid = await inspectHybridSearch("PaymentGateway authorize", 20, root, { semanticState: "not_configured" });
    const backupHybrid = await inspectHybridSearch("BackupGateway authorize", 20, root, { semanticState: "not_configured" });

    assert.equal(payment[0]?.startLine, 1);
    assert.equal(payment[0]?.symbolType, "method");
    assert.equal(backup[0]?.startLine, 2);
    assert.equal(backup[0]?.symbolType, "method");
    assert.equal(image[0]?.startLine, 3);
    assert.equal(image[0]?.symbolType, "method");
    assert.equal(disk[0]?.startLine, 4);
    assert.equal(disk[0]?.symbolType, "method");
    assert.equal(paymentHybrid.fusedResults[0]?.startLine, 1);
    assert.equal(paymentHybrid.fusedResults[0]?.symbolType, "method");
    assert.equal(backupHybrid.fusedResults[0]?.startLine, 2);
    assert.equal(backupHybrid.fusedResults[0]?.symbolType, "method");
  });
});

test("shared partial owner context does not change lexical relevance scores", async () => {
  const indexed = unit("gateways.ts", "class CardGateway { authorize() {} }\nclass ApiGateway { authorize() {} }\n");

  await withIndexedUnits([indexed], async (root) => {
    const results = await searchLexical("Gateway authorize", 20, root);
    const methods = results.filter((result) => result.symbolType === "method");
    const hybrid = await inspectHybridSearch("Gateway authorize", 20, root, { semanticState: "not_configured" });
    const fusedMethods = hybrid.fusedResults.filter((result) => result.symbolType === "method");

    assert.equal(methods.length, 2);
    assert.equal(methods[0]?.score, methods[1]?.score);
    assert.ok(methods[0]?.lexicalRankGroup);
    assert.equal(methods[0]?.lexicalRankGroup, methods[1]?.lexicalRankGroup);
    assert.equal(fusedMethods.length, 2);
    assert.equal(fusedMethods[0]?.fusionScore, fusedMethods[1]?.fusionScore);
  });
});

test("partial owner words do not promote methods for unrelated natural-language intent", async () => {
  const indexed = unit("src/cache.ts", "class CatalogCache { load() {} }\n");

  await withIndexedUnits([indexed], async (root) => {
    const results = await searchLexical("catalog title search", 20, root);
    const method = results.find((result) => result.symbolType === "method");

    assert.ok(method, "partial owner text still makes the method retrievable");
    assert.equal(method.lexicalScore, 0, "partial owner text must not add lexical relevance");
  });
});

test("bare same-name method lookup remains B1.1 ambiguity-safe", async () => {
  const indexed = unit("gateways.ts", "class CardGateway { authorize() {} }\nclass BackupGateway { authorize() {} }\n");

  await withIndexedUnits([indexed], async (root) => {
    const results = await searchLexical("authorize", 20, root);
    const methods = results.filter((result) => result.symbolType === "method");

    assert.equal(methods.length, 2);
    assert.deepEqual(new Set(methods.map((result) => result.score)), new Set([0]));
    assert.ok(methods.every((result) => result.lexicalRankGroup === methods[0]?.lexicalRankGroup));
  });
});

test("file and module terms continue to disambiguate same-name top-level functions", async () => {
  const users = unit("src/users/repository.ts", "export function findById() { return 'users'; }\n");
  const orders = unit("src/orders/repository.ts", "export function findById() { return 'orders'; }\n");

  await withIndexedUnits([users, orders], async (root) => {
    const moduleResults = await searchLexical("users module findById", 20, root);
    const pathResults = await searchLexical("src/orders/repository.ts findById", 20, root);

    assert.equal(moduleResults[0]?.file, "src/users/repository.ts");
    assert.equal(pathResults[0]?.file, "src/orders/repository.ts");
  });
});

test("unique exact-name function remains the first lexical result", async () => {
  const indexed = unit("src/catalog/cache.ts", "export function loadCatalogCache() {}\n");

  await withIndexedUnits([indexed], async (root) => {
    const results = await searchLexical("loadCatalogCache", 20, root);
    assert.equal(results[0]?.symbolName, "loadCatalogCache load Catalog Cache");
  });
});

test("lexical version rebuild regenerates owner context from cached parser facts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase16c-b3-version-"));
  const source = "class CatalogCache { load() {} }\n";
  const indexed = unit("src/catalog-cache.ts", source);
  const file = path.join(root, indexed.relativePath);
  await mkdir(path.dirname(file), { recursive: true });
  await mkdir(path.join(root, ".codeatlas"), { recursive: true });
  await writeFile(file, source);

  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  const repository = store.ensureRepository(getRepositoryIdentity(root));
  store.setVersion(repository.id, "lexical", "pre-owner-context");
  store.close();

  const originalParse = Parser.prototype.parse;
  let parserCalls = 0;
  Parser.prototype.parse = function (...args: Parameters<typeof originalParse>) {
    parserCalls += 1;
    return originalParse.apply(this, args);
  };

  try {
    const result = await indexLexical(root, { files: [file], units: [indexed] });
    assert.equal(result.fullRebuild, true);
    assert.equal(result.version, LEXICAL_INDEX_VERSION);
    assert.equal(parserCalls, 0);

    const rebuiltStore = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const rows = rebuiltStore.searchLexical(repository.id, "catalogcache* OR load*", 10);
      assert.ok(rows.some((row) => row.symbolName === "load load" && row.qualifiedName?.startsWith("CatalogCache.load")));
    } finally {
      rebuiltStore.close();
    }
  } finally {
    Parser.prototype.parse = originalParse;
    await rm(root, { recursive: true, force: true });
  }
});
