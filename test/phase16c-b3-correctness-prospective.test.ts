import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { searchLexical } from "../src/core/lexical/lexical-search.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const sourceFiles = {
  "src/storage/backend-a.ts": "export class PrimaryStore { fetch() { return 1; } }\n",
  "src/storage/backend-b.ts": "export class ArchiveStore { fetch() { return 1; } }\n",
  "src/messaging/channel-a.ts": "export class EmailTransport { send() { return 1; } }\n",
  "src/messaging/channel-b.ts": "export class SmsTransport { send() { return 1; } }\n",
  "src/users/repository.ts": "export function findById() { return 'users'; }\n",
  "src/orders/repository.ts": "export function findById() { return 'orders'; }\n",
  "src/tasks/runner.ts": "export class TaskRunner { run() { function normalizeInput() { return true; } return normalizeInput(); } }\n",
  "src/anonymous/transport.ts": "export const temporary = class { dispatch() { return true; } };\n",
} as const;

const noScip = {
  discover: async () => ({ status: "unavailable" as const, diagnostic: "Disabled in prospective fixture." }),
  index: async () => [],
};

async function withProspectiveIndex<T>(run: (root: string) => Promise<T>): Promise<T> {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-b3-correctness-"));
  try {
    for (const [relativePath, source] of Object.entries(sourceFiles)) {
      const file = path.join(root, relativePath);
      await mkdir(path.dirname(file), { recursive: true });
      await writeFile(file, source);
    }
    await indexRepository(root, { skipGit: true, scipIndexer: noScip });
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

function getLexicalRows(root: string, query: string) {
  const repoId = getRepositoryIdentity(root).id;
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
  try {
    return store.searchLexical(repoId, query, 20);
  } finally {
    store.close();
  }
}

test("parser-known PrimaryStore ownership is retained in qualified lexical identity", async () => {
  const source = sourceFiles["src/storage/backend-a.ts"];
  const parsed = extractParsedFacts({
    source,
    language: "typescript",
    contentHash: "prospective-primary-store",
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(parsed.kind, "facts");
  if (parsed.kind !== "facts") throw parsed.error;
  const method = parsed.facts.symbols.find((symbol) => symbol.kind === "method" && symbol.name === "fetch");
  assert.ok(method?.scopeId);
  const methodScope = parsed.facts.containmentScopes.find((scope) => scope.localId === method.scopeId);
  const ownerScope = parsed.facts.containmentScopes.find((scope) => scope.localId === methodScope?.parentId);
  assert.equal(ownerScope?.name, "PrimaryStore");

  await withProspectiveIndex(async (root) => {
    const row = getLexicalRows(root, "fetch*").find((candidate) => candidate.file === "src/storage/backend-a.ts" && candidate.symbolType === "method");
    assert.ok(row);
    assert.match(row.symbolName ?? "", /^fetch\b/, "bare symbol identity remains available");
    assert.match(row.qualifiedName ?? "", /^PrimaryStore\.fetch\b/, "qualified identity retains the parser-known owner");
  });
});

test("owner-qualified member queries retrieve the method whose owner was named", async () => {
  await withProspectiveIndex(async (root) => {
    const primary = await searchLexical("PrimaryStore fetch", 20, root);
    const archive = await searchLexical("ArchiveStore fetch", 20, root);
    assert.equal(primary[0]?.symbolType, "method");
    assert.equal(primary[0]?.file, "src/storage/backend-a.ts");
    assert.equal(archive[0]?.symbolType, "method");
    assert.equal(archive[0]?.file, "src/storage/backend-b.ts");
  });
});

test("a second owner-qualified member query distinguishes EmailTransport from SmsTransport", async () => {
  await withProspectiveIndex(async (root) => {
    const email = await searchLexical("EmailTransport send", 20, root);
    const sms = await searchLexical("SmsTransport send", 20, root);
    assert.equal(email[0]?.symbolType, "method");
    assert.equal(email[0]?.file, "src/messaging/channel-a.ts");
    assert.equal(sms[0]?.symbolType, "method");
    assert.equal(sms[0]?.file, "src/messaging/channel-b.ts");
  });
});

test("bare duplicate member names remain tied rather than selecting an owner", async () => {
  await withProspectiveIndex(async (root) => {
    const methods = (await searchLexical("fetch", 20, root)).filter((result) => result.symbolType === "method");
    const targets = new Set(methods.map((result) => result.file));
    assert.deepEqual(targets, new Set(["src/storage/backend-a.ts", "src/storage/backend-b.ts"]));
    assert.equal(new Set(methods.map((result) => result.lexicalScore)).size, 1);
    assert.ok(methods.every((result) => result.lexicalRankGroup === methods[0]?.lexicalRankGroup));
  });
});

test("shared partial owner context keeps same-name members at equal lexical relevance", async () => {
  await withProspectiveIndex(async (root) => {
    const methods = (await searchLexical("Store fetch", 20, root)).filter((result) => result.symbolType === "method");
    assert.deepEqual(new Set(methods.map((result) => result.file)), new Set(["src/storage/backend-a.ts", "src/storage/backend-b.ts"]));
    assert.equal(new Set(methods.map((result) => result.lexicalScore)).size, 1);
    assert.ok(methods.every((result) => result.lexicalRankGroup === methods[0]?.lexicalRankGroup));
  });
});

test("top-level and nested local functions stay unqualified", async () => {
  await withProspectiveIndex(async (root) => {
    const topLevel = getLexicalRows(root, "findById*").find((row) => row.file === "src/users/repository.ts" && row.symbolType === "function");
    const nested = getLexicalRows(root, "normalizeInput*").find((row) => row.symbolType === "function");
    assert.ok(topLevel?.symbolName && topLevel.qualifiedName?.startsWith(topLevel.symbolName));
    assert.ok(nested?.symbolName && nested.qualifiedName?.startsWith(nested.symbolName));
  });
});

test("anonymous class methods do not receive synthesized owner identity", async () => {
  await withProspectiveIndex(async (root) => {
    const method = getLexicalRows(root, "dispatch*").find((row) => row.file === "src/anonymous/transport.ts" && row.symbolType === "method");
    assert.ok(method?.symbolName && method.qualifiedName?.startsWith(method.symbolName));
  });
});

test("module and path context still selects the matching top-level function", async () => {
  await withProspectiveIndex(async (root) => {
    const users = await searchLexical("src/users/repository.ts findById", 20, root);
    const orders = await searchLexical("src/orders/repository.ts findById", 20, root);
    assert.equal(users.find((result) => result.symbolType === "function")?.file, "src/users/repository.ts");
    assert.equal(orders.find((result) => result.symbolType === "function")?.file, "src/orders/repository.ts");
  });
});
