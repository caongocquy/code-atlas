import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const parserIdentity = {
  language: "typescript" as const,
  parserName: "tree-sitter",
  parserVersion: "0.25.1",
  grammarName: "tree-sitter-typescript",
  grammarVersion: "0.23.2",
  adapterVersion: "1",
};

function facts(overrides: Partial<ParsedFactsBlob> = {}): ParsedFactsBlob {
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

  assert.equal(payload, encodeFacts({ ...value }));
  assert.deepEqual(decodeFacts(payload, expectation(value)), { kind: "hit", facts: value });
});

test("fact codec reports every miss reason", () => {
  const value = facts();
  const expected = expectation(value);
  const cases: Array<[string | undefined, typeof expected, string]> = [
    [undefined, expected, "absent"],
    ["{", expected, "invalid_json"],
    [JSON.stringify({ ...value, symbols: "not-an-array" }), expected, "schema_mismatch"],
    [encodeFacts({ ...value, contentHash: "other-hash" }), expected, "hash_mismatch"],
    [encodeFacts({ ...value, factsVersion: "2" }), expected, "version_mismatch"],
    [encodeFacts({ ...value, parserIdentity: { ...value.parserIdentity, adapterVersion: "2" } }), expected, "parser_identity_mismatch"],
  ];

  for (const [payload, current, reason] of cases) {
    assert.deepEqual(decodeFacts(payload, current), { kind: "miss", reason });
  }
});

test("fact blobs are reused across paths and repositories", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14a-cache-"));
  const databasePath = path.join(root, "atlas.db");
  const value = facts();
  const key = factBlobKey(value);

  try {
    const first = new AtlasStore(databasePath);
    first.putFactBlob(key, value);
    assert.equal(first.getFactBlob(key), encodeFacts(value));
    first.close();

    const second = new AtlasStore(databasePath);
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
