import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const parserIdentity = {
  language: "typescript" as const,
  runtimeName: "tree-sitter" as const,
  runtimeVersion: "0.25.1",
  packageName: "tree-sitter-typescript",
  grammarName: "tree-sitter-typescript",
  grammarVersion: "0.23.2",
};

function facts(overrides: Partial<ParsedFactsBlob> = {}): ParsedFactsBlob {
  return {
    factsSchemaVersion: "2.0.0",
    factsVersion: "2.0.0",
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

function expectation(value: ParsedFactsBlob) {
  return {
    key: factBlobKey(value),
    contentHash: value.contentHash,
    language: value.language,
    parserIdentity: value.parserIdentity,
    factsVersion: value.factsVersion,
    factsSchemaVersion: value.factsSchemaVersion,
  };
}

test("fact blobs round-trip deterministically and validate", () => {
  const value = facts();
  const payload = encodeFacts(value);
  const reordered = {
    declaredTypeAnnotations: value.declaredTypeAnnotations,
    bindingSeeds: value.bindingSeeds,
    callSites: value.callSites,
    references: value.references,
    exports: value.exports,
    imports: value.imports,
    containmentScopes: value.containmentScopes,
    symbols: value.symbols,
    parserDiagnostics: value.parserDiagnostics,
    parseStatus: value.parseStatus,
    parserIdentity: { ...value.parserIdentity },
    expressions: value.expressions,
    members: value.members,
    assignments: value.assignments,
    parameters: value.parameters,
    returns: value.returns,
    constructors: value.constructors,
    inheritances: value.inheritances,
    implementations: value.implementations,
    aliases: value.aliases,
    modules: value.modules,
    namespaces: value.namespaces,
    language: value.language,
    contentHash: value.contentHash,
    factsVersion: value.factsVersion,
    factsSchemaVersion: value.factsSchemaVersion,
  };

  assert.equal(payload, encodeFacts(reordered));
  assert.deepEqual(decodeFacts(payload, expectation(value)), { kind: "hit", facts: value });

  const zeroIdFacts = facts({
    containmentScopes: [{
      localId: "scope:0",
      kind: "module",
      range: { startLine: 1, endLine: 1 },
    }],
  });
  assert.deepEqual(
    decodeFacts(encodeFacts(zeroIdFacts), expectation(zeroIdFacts)),
    { kind: "hit", facts: zeroIdFacts },
  );

  for (const localId of ["scope:00", "scope:01"]) {
    const malformedFacts = facts({
      containmentScopes: [{ localId, kind: "module", range: { startLine: 1, endLine: 1 } }],
    });
    assert.deepEqual(
      decodeFacts(encodeFacts(malformedFacts), expectation(malformedFacts)),
      { kind: "miss", reason: "schema_mismatch" },
    );
  }
});

test("fact codec reports every miss reason", () => {
  const value = facts();
  const expected = expectation(value);
  const cases: Array<[string | undefined, typeof expected, string]> = [
    [undefined, expected, "absent"],
    ["{", expected, "invalid_json"],
    [JSON.stringify({ ...value, symbols: "not-an-array" }), expected, "schema_mismatch"],
    [JSON.stringify({ ...value, symbols: [null] }), expected, "schema_mismatch"],
    [encodeFacts({ ...value, contentHash: "other-hash" }), expected, "hash_mismatch"],
    [encodeFacts({ ...value, factsVersion: "2" }), expected, "version_mismatch"],
    [encodeFacts({ ...value, factsSchemaVersion: "2" }), expected, "schema_mismatch"],
    [encodeFacts({ ...value, language: "javascript", parserIdentity: { ...value.parserIdentity, language: "javascript" } }), expected, "parser_identity_mismatch"],
    [encodeFacts({ ...value, parserIdentity: { ...value.parserIdentity, runtimeVersion: "0.25.2" } }), expected, "parser_identity_mismatch"],
  ];

  for (const [payload, current, reason] of cases) {
    assert.deepEqual(decodeFacts(payload, current), { kind: "miss", reason });
  }
});

test("fact blobs are reused across paths and repositories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-cache-"));
  const databasePath = path.join(root, "atlas.db");
  const firstRepositoryPath = path.join(root, "repository-a");
  const secondRepositoryPath = path.join(root, "repository-b");
  const value = facts();
  const key = factBlobKey(value);

  try {
    await mkdir(firstRepositoryPath);
    await mkdir(secondRepositoryPath);
    const first = new AtlasStore(databasePath);
    first.ensureRepository(getRepositoryIdentity(firstRepositoryPath));
    first.putFactBlob(key, value);
    assert.equal(first.getFactBlob(key), encodeFacts(value));
    first.close();

    const second = new AtlasStore(databasePath);
    second.ensureRepository(getRepositoryIdentity(secondRepositoryPath));
    assert.equal(second.getFactBlob(key), encodeFacts(value));
    second.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("corrupt fact rows miss and are repaired by putFactBlob", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-cache-repair-"));
  const databasePath = path.join(root, "atlas.db");
  const value = facts();
  const key = factBlobKey(value);

  try {
    const store = new AtlasStore(databasePath);
    store.putFactBlob(key, value);
    store.close();

    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE fact_blobs SET payload_json = ? WHERE fact_blob_key = ?").run("{", key);
    database.close();

    const repaired = new AtlasStore(databasePath);
    assert.equal(repaired.getFactBlob(key), undefined);
    repaired.putFactBlob(key, value);
    assert.equal(repaired.getFactBlob(key), encodeFacts(value));
    repaired.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("valid fact rows stay immutable across sequential writers", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-cache-immutable-"));
  const databasePath = path.join(root, "atlas.db");
  const value = facts();
  const key = factBlobKey(value);

  try {
    const first = new AtlasStore(databasePath);
    first.putFactBlob(key, value);
    const originalPayload = first.getFactBlob(key);
    const second = new AtlasStore(databasePath);
    second.putFactBlob(key, {
      declaredTypeAnnotations: value.declaredTypeAnnotations,
      bindingSeeds: value.bindingSeeds,
      callSites: value.callSites,
      references: value.references,
      exports: value.exports,
      imports: value.imports,
      containmentScopes: value.containmentScopes,
      symbols: value.symbols,
      parserDiagnostics: value.parserDiagnostics,
      parseStatus: value.parseStatus,
      parserIdentity: { ...value.parserIdentity },
      expressions: value.expressions,
      members: value.members,
      assignments: value.assignments,
      parameters: value.parameters,
      returns: value.returns,
      constructors: value.constructors,
      inheritances: value.inheritances,
      implementations: value.implementations,
      aliases: value.aliases,
      modules: value.modules,
      namespaces: value.namespaces,
      language: value.language,
      contentHash: value.contentHash,
      factsVersion: value.factsVersion,
      factsSchemaVersion: value.factsSchemaVersion,
    });
    assert.equal(second.getFactBlob(key), originalPayload);
    second.close();
    first.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("fact blob rows contain only immutable provenance and payload", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-cache-schema-"));
  const databasePath = path.join(root, "atlas.db");

  try {
    const store = new AtlasStore(databasePath);
    const database = new DatabaseSync(databasePath);
    const columns = database.prepare("PRAGMA table_info(fact_blobs)").all() as Array<{ name: string }>;
    assert.deepEqual(columns.map((column) => column.name), [
      "fact_blob_key",
      "content_hash",
      "language",
      "parser_identity_json",
      "facts_version",
      "facts_schema_version",
      "payload_json",
    ]);
    database.close();
    store.close();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
