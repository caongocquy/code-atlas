import { DatabaseSync } from "node:sqlite";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { LEXICAL_INDEX_VERSION } from "../src/config/constants.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { indexLexical } from "../src/core/lexical/lexical-index.service.js";
import { searchLexical } from "../src/core/lexical/lexical-search.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function temporaryRepository(name: string): Promise<string> {
  return mkdtemp(path.join(tmpdir(), `code-atlas-phase-3-${name}-`));
}

test("lexical indexing uses FTS5, supports identifiers and paths, and survives reopen", async () => {
  const repoPath = await temporaryRepository("search");

  try {
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(
      path.join(repoPath, "src", "registry.ts"),
      "export function createUserToken(input: string) { return input; }\n",
    );
    await writeFile(
      path.join(repoPath, "src", "other.ts"),
      "export function useToken() { return createUserToken(); }\n",
    );

    const first = await indexLexical(repoPath);
    assert.equal(first.status, "indexed");
    assert.ok(first.documents > 0);

    const identifierResults = await searchLexical("createUserToken", 10, repoPath);
    assert.ok(identifierResults.length > 0);
    assert.equal(identifierResults[0]?.file, "src/registry.ts");
    assert.ok(identifierResults[0]?.lexicalScore);
    assert.match(identifierResults[0]?.snippet ?? "", /createUserToken/);

    const pathResults = await searchLexical("src/registry.ts", 10, repoPath);
    assert.ok(pathResults.some((result) => result.file === "src/registry.ts"));

    const reopenedResults = await searchLexical("createUserToken", 10, repoPath);
    assert.deepEqual(
      reopenedResults.map((result) => result.documentId),
      identifierResults.map((result) => result.documentId),
    );
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("lexical indexing updates changed files and removes deleted files", async () => {
  const repoPath = await temporaryRepository("updates");
  const filePath = path.join(repoPath, "target.ts");

  try {
    await writeFile(filePath, "export function createUserToken() { return true; }\n");
    await indexLexical(repoPath);
    assert.ok((await searchLexical("createUserToken", 10, repoPath)).length > 0);

    await writeFile(filePath, "export function refreshUserToken() { return true; }\n");
    const updated = await indexLexical(repoPath);
    assert.equal(updated.status, "indexed");
    assert.equal((await searchLexical("createUserToken", 10, repoPath)).length, 0);
    assert.ok((await searchLexical("refreshUserToken", 10, repoPath)).length > 0);

    await rm(filePath);
    const deleted = await indexLexical(repoPath);
    assert.equal(deleted.deletedFiles, 1);
    assert.equal((await searchLexical("refreshUserToken", 10, repoPath)).length, 0);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("lexical zero-item state, stale state, version mismatch, and other capability state stay explicit", async () => {
  const repoPath = await temporaryRepository("state");
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");

  try {
    await writeFile(path.join(repoPath, "empty.ts"), "// no symbols\n");
    const first = await indexLexical(repoPath);
    assert.equal(first.documents, 0);

    const store = new AtlasStore(databasePath);
    const repo = store.ensureRepository(getRepositoryIdentity(repoPath));
    assert.equal(store.getFileCapabilityState(repo.id, "empty.ts", "lexical")?.itemCount, 0);
    assert.equal(store.getFileCapabilityState(repo.id, "empty.ts", "lexical")?.state, "ready");

    store.setFileCapabilityState(repo.id, "empty.ts", "lexical", {
      version: "old-lexical",
      state: "stale",
      itemCount: 0,
      fileHash: "old-hash",
    });
    store.setFileCapabilityState(repo.id, "error.ts", "lexical", {
      version: "lexical-1",
      state: "error",
      itemCount: 1,
      lastError: "fts write failed",
    });
    assert.equal(
      store.getFileCapabilityState(repo.id, "error.ts", "lexical")?.lastError,
      "fts write failed",
    );
    store.setFileCapabilityState(repo.id, "empty.ts", "graph", {
      version: "graph-keep",
      state: "ready",
      itemCount: 1,
      fileHash: "graph-hash",
    });
    store.setFileCapabilityState(repo.id, "empty.ts", "semantic", {
      version: "semantic-keep",
      state: "ready",
      itemCount: 1,
      fileHash: "semantic-hash",
    });
    store.setVersion(repo.id, "graph", "graph-version");
    store.setVersion(repo.id, "semantic", "semantic-version");
    store.setVersion(repo.id, "lexical", "old-lexical");
    store.close();

    const rebuilt = await indexLexical(repoPath);
    assert.equal(rebuilt.fullRebuild, true);

    const reopened = new AtlasStore(databasePath);
    try {
      const identity = reopened.ensureRepository(getRepositoryIdentity(repoPath));
      assert.equal(reopened.getVersion(identity.id, "lexical"), LEXICAL_INDEX_VERSION);
      assert.equal(reopened.getVersion(identity.id, "graph"), "graph-version");
      assert.equal(reopened.getVersion(identity.id, "semantic"), "semantic-version");
      assert.equal(
        reopened.getFileCapabilityState(identity.id, "empty.ts", "graph")?.state,
        "ready",
      );
      assert.equal(
        reopened.getFileCapabilityState(identity.id, "empty.ts", "graph")?.fileHash,
        "graph-hash",
      );
      assert.equal(
        reopened.getFileCapabilityState(identity.id, "empty.ts", "semantic")?.state,
        "ready",
      );
      assert.equal(
        reopened.getFileCapabilityState(identity.id, "empty.ts", "semantic")?.fileHash,
        "semantic-hash",
      );
    } finally {
      reopened.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("FTS5 rows are repository-scoped even for same-basename repositories", async () => {
  const root = await temporaryRepository("isolation");
  const databasePath = path.join(root, "atlas.db");
  const store = new AtlasStore(databasePath);

  try {
    const repoAPath = path.join(root, "a", "same-name");
    const repoBPath = path.join(root, "b", "same-name");
    await mkdir(repoAPath, { recursive: true });
    await mkdir(repoBPath, { recursive: true });
    const repoA = store.ensureRepository(getRepositoryIdentity(repoAPath));
    const repoB = store.ensureRepository(getRepositoryIdentity(repoBPath));

    store.replaceLexicalDocuments(repoA.id, [{
      file: "a.ts",
      fileHash: "a",
      documents: [{
        documentId: "a-doc",
        file: "a.ts",
        symbolName: "alphaNeedle",
        symbolType: "function",
        content: "alphaNeedle()",
      }],
    }], [], LEXICAL_INDEX_VERSION);
    store.replaceLexicalDocuments(repoB.id, [{
      file: "b.ts",
      fileHash: "b",
      documents: [{
        documentId: "b-doc",
        file: "b.ts",
        symbolName: "betaNeedle",
        symbolType: "function",
        content: "betaNeedle()",
      }],
    }], [], LEXICAL_INDEX_VERSION);

    assert.deepEqual(
      store.searchLexical(repoA.id, "alphaNeedle*", 10).map((row) => row.documentId),
      ["a-doc"],
    );
    assert.deepEqual(
      store.searchLexical(repoB.id, "alphaNeedle*", 10),
      [],
    );
  } finally {
    store.close();
    await rm(root, { recursive: true, force: true });
  }
});

test("AtlasStore exposes the FTS5 schema without requiring external infrastructure", async () => {
  const repoPath = await temporaryRepository("schema");
  const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");

  try {
    const store = new AtlasStore(databasePath);
    store.close();
    const database = new DatabaseSync(databasePath);
    try {
      const table = database.prepare(
        "SELECT sql FROM sqlite_master WHERE name = 'lexical_documents'",
      ).get() as { sql: string } | undefined;
      assert.match(table?.sql ?? "", /VIRTUAL TABLE.*fts5/i);
      assert.equal(
        database.prepare("SELECT name FROM sqlite_master WHERE name = 'vectors'").get(),
        undefined,
      );
    } finally {
      database.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
