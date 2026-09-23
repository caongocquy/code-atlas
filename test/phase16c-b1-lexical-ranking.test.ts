import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { searchLexical as searchLexicalService } from "../src/core/lexical/lexical-search.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const versions = {
  schemaVersion: "2",
  factsSchemaVersion: "1",
  factsVersion: "1",
  resolutionVersion: "1",
  derivedVersion: "1",
};

async function withActiveLexicalGeneration(
  documents: Array<{
    documentId: string;
    file: string;
    symbolName?: string;
    qualifiedName?: string;
    symbolType?: string;
    content: string;
    startLine?: number;
    endLine?: number;
  }>,
  run: (store: AtlasStore, repositoryId: string) => void,
): Promise<void> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase16c-b1-"));
  const store = new AtlasStore(path.join(root, "atlas.db"));

  try {
    const repository = store.ensureRepository(getRepositoryIdentity(path.join(root, "repo")));
    const generation = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    const documentsByFile = new Map<string, typeof documents>();
    for (const document of documents) {
      const fileDocuments = documentsByFile.get(document.file) ?? [];
      fileDocuments.push(document);
      documentsByFile.set(document.file, fileDocuments);
    }
    store.writeCandidateLexicalDocuments(generation.id, [...documentsByFile].map(([file, fileDocuments]) => ({
      file,
      fileHash: file,
      documents: fileDocuments,
    })));
    store.publishCandidateGeneration(generation.id, { requireLexical: true });
    run(store, repository.id);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("generation lexical ranking puts exact identifiers ahead of partial and content-only matches before limiting", async () => {
  await withActiveLexicalGeneration([
    { documentId: "noise", file: "a-noise.ts", symbolName: "tokenHandler", content: "createUserToken" },
    { documentId: "partial", file: "b-partial.ts", symbolName: "createUserTokenOptions", content: "createUserTokenOptions" },
    { documentId: "content", file: "c-content.ts", symbolName: "requestHandler", content: "createUserToken" },
    { documentId: "exact", file: "z-exact.ts", symbolName: "createUserToken", content: "createUserToken" },
  ], (store, repositoryId) => {
    const matchQuery = "createusertoken* OR (create* AND user* AND token*)";
    const rows = store.searchLexical(repositoryId, matchQuery, 10);

    assert.deepEqual(rows.map((row) => row.documentId), ["exact", "partial", "noise", "content"]);
    assert.ok(rows.every((row, index) => index === 0 || rows[index - 1]!.score < row.score));
    assert.deepEqual(store.searchLexical(repositoryId, matchQuery, 1).map((row) => row.documentId), ["exact"]);
    assert.deepEqual(store.searchLexical(repositoryId, "missing*", 10), []);
  });
});

test("generation lexical ranking uses matching file terms to disambiguate equal symbol names", async () => {
  await withActiveLexicalGeneration([
    { documentId: "orders", file: "src/orders.ts", symbolName: "findById", content: "findById" },
    { documentId: "users", file: "src/users.ts", symbolName: "findById", content: "findById" },
  ], (store, repositoryId) => {
    const matchQuery = "users* OR module* OR findbyid* OR (find* AND by* AND id*)";

    assert.deepEqual(store.searchLexical(repositoryId, matchQuery, 10).map((row) => row.documentId), ["users", "orders"]);
  });
});

test("generation lexical ties keep the existing file, line, and document ordering", async () => {
  await withActiveLexicalGeneration([
    { documentId: "b", file: "b.ts", symbolName: "findById", content: "findById", startLine: 1 },
    { documentId: "a-late", file: "a.ts", symbolName: "findById", content: "findById", startLine: 8 },
    { documentId: "a-early", file: "a.ts", symbolName: "findById", content: "findById", startLine: 2 },
  ], (store, repositoryId) => {
    assert.deepEqual(
      store.searchLexical(repositoryId, "findbyid*", 10).map((row) => row.documentId),
      ["a-early", "a-late", "b"],
    );
  });
});

test("generation lexical ranking preserves content-only matches and file-prefix filtering", async () => {
  await withActiveLexicalGeneration([
    { documentId: "content", file: "src/content.ts", symbolName: "requestHandler", content: "needle" },
    { documentId: "other", file: "src/other.ts", symbolName: "needleHandler", content: "needle" },
  ], (store, repositoryId) => {
    assert.deepEqual(store.searchLexical(repositoryId, "needle*", 10).map((row) => row.documentId), ["other", "content"]);
    assert.deepEqual(store.searchLexical(repositoryId, "needle*", 10, "src/content").map((row) => row.documentId), ["content"]);
  });
});

test("bare exact-name ambiguity is counted before limit and cannot promote one target", async () => {
  await withActiveLexicalGeneration([
    { documentId: "load-a", file: "src/a.ts", symbolName: "load", qualifiedName: "A.load", symbolType: "method", content: "load" },
    { documentId: "load-b", file: "src/b.ts", symbolName: "load", qualifiedName: "B.load", symbolType: "method", content: "load" },
    { documentId: "content-heavy", file: "src/z.ts", symbolName: "loadHelper", content: "load load load" },
  ], (store, repositoryId) => {
    const rows = store.searchLexical(repositoryId, "load*", 10, undefined, "load");

    assert.deepEqual(rows.map((row) => row.documentId), ["load-a", "load-b", "content-heavy"]);
    assert.deepEqual(new Set(rows.map((row) => row.score)), new Set([0]));
    assert.equal(store.searchLexical(repositoryId, "load*", 1, undefined, "load")[0]!.score, 0);
    assert.deepEqual(store.searchLexical(repositoryId, "load*", 1, undefined, "load").map((row) => row.documentId), ["load-a"]);
  });
});

test("duplicate lexical chunks for one exact target do not create ambiguity", async () => {
  await withActiveLexicalGeneration([
    { documentId: "load-part-1", file: "src/a.ts", symbolName: "load", qualifiedName: "load", symbolType: "function", content: "load", startLine: 1, endLine: 120 },
    { documentId: "load-part-2", file: "src/a.ts", symbolName: "load", qualifiedName: "load", symbolType: "function", content: "load load load", startLine: 101, endLine: 220 },
    { documentId: "partial", file: "src/b.ts", symbolName: "loadHelper", content: "load" },
  ], (store, repositoryId) => {
    const rows = store.searchLexical(repositoryId, "load*", 10, undefined, "load");

    assert.deepEqual(rows.map((row) => row.documentId), ["load-part-1", "load-part-2", "partial"]);
    assert.ok(rows[0]!.score < rows[2]!.score);
    assert.ok(rows[1]!.score < rows[2]!.score);
  });
});

test("same-name methods in different classes remain distinct logical targets", async () => {
  await withActiveLexicalGeneration([
    { documentId: "class-a-load", file: "src/classes.ts", symbolName: "load", qualifiedName: "load", symbolType: "method", content: "load", startLine: 10, endLine: 20 },
    { documentId: "class-b-load", file: "src/classes.ts", symbolName: "load", qualifiedName: "load", symbolType: "method", content: "load load", startLine: 40, endLine: 50 },
  ], (store, repositoryId) => {
    const rows = store.searchLexical(repositoryId, "load*", 10, undefined, "load");

    assert.deepEqual(rows.map((row) => row.documentId), ["class-a-load", "class-b-load"]);
    assert.deepEqual(new Set(rows.map((row) => row.score)), new Set([0]));
  });
});

test("file-prefix scope can make an otherwise ambiguous bare exact name unique", async () => {
  await withActiveLexicalGeneration([
    { documentId: "inside", file: "src/current/load.ts", symbolName: "load", content: "load" },
    { documentId: "outside", file: "src/other/load.ts", symbolName: "load", content: "load load" },
  ], (store, repositoryId) => {
    const rows = store.searchLexical(repositoryId, "load*", 10, "src/current", "load");

    assert.deepEqual(rows.map((row) => row.documentId), ["inside"]);
    assert.ok(rows[0]!.score < 0);
  });
});

test("context-bearing lexical queries keep normal relevance ordering", async () => {
  await withActiveLexicalGeneration([
    { documentId: "context", file: "src/users/load.ts", symbolName: "load", content: "load" },
    { documentId: "other", file: "src/orders/load.ts", symbolName: "load", content: "load load" },
  ], (store, repositoryId) => {
    const rows = store.searchLexical(repositoryId, "users* OR load*", 10);

    assert.deepEqual(rows.map((row) => row.documentId), ["context", "other"]);
    assert.ok(rows[0]!.score < rows[1]!.score);
  });
});

test("public lexical search guards bare identifiers but keeps path context", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase16c-b1-service-"));
  await mkdir(path.join(root, ".codeatlas"), { recursive: true });
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));

  try {
    const repository = store.ensureRepository(getRepositoryIdentity(root));
    const generation = createCandidateGeneration(repository.id, undefined, versions, []);
    store.beginCandidateGeneration(generation);
    store.writeCandidateManifest(generation.manifest);
    store.writeCandidateLexicalDocuments(generation.id, [
      { file: "src/orders.ts", fileHash: "orders", documents: [{ documentId: "orders", file: "src/orders.ts", symbolName: "load Load", qualifiedName: "load Load", symbolType: "method", content: "load" }] },
      { file: "src/users.ts", fileHash: "users", documents: [{ documentId: "users", file: "src/users.ts", symbolName: "load Load", qualifiedName: "load Load", symbolType: "method", content: "load load" }] },
    ]);
    store.publishCandidateGeneration(generation.id, { requireLexical: true });

    const bareRows = await searchLexicalService("load", 10, root);
    assert.deepEqual(bareRows.map((row) => row.documentId), ["orders", "users"]);
    assert.deepEqual(new Set(bareRows.map((row) => row.score)), new Set([0]));

    const contextualRows = await searchLexicalService("users load", 10, root);
    assert.deepEqual(contextualRows.map((row) => row.documentId), ["users", "orders"]);
    assert.ok(contextualRows[0]!.score < contextualRows[1]!.score);
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});
