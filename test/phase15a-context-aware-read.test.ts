import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { readContextAware } from "../src/core/context/context-aware-read.service.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";

test("context-aware file reads return full, unchanged, exact delta, and rehydrate", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-read-"));
  const filePath = path.join(root, "source.ts");
  const request = { sessionId: "session-1", contextGeneration: "context-1", subject: { kind: "file" as const, path: "source.ts" }, projection: "source-v1" };
  try {
    await writeFile(filePath, "one\n");
    const first = await readContextAware(root, request);
    assert.equal(first.mode, "full");
    assert.equal(first.content, "one\n");

    const unchanged = await readContextAware(root, request);
    assert.equal(unchanged.mode, "unchanged");

    await writeFile(filePath, "two\n");
    const delta = await readContextAware(root, request);
    assert.equal(delta.mode, "delta");
    assert.equal(delta.delta?.content, "two\n");
    assert.equal(delta.content, undefined);

    const database = new DatabaseSync(path.join(root, ".codeatlas", "context.db"));
    database.prepare("UPDATE context_receipts SET workspace_identity = 'other-workspace' WHERE receipt_id = ?").run(delta.receipt.receiptId);
    database.close();
    const rehydrated = await readContextAware(root, request);
    assert.equal(rehydrated.mode, "rehydrate");
    assert.equal(rehydrated.content, "two\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("context-aware reads preserve current source metadata and survive restart", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-read-restart-"));
  try {
    await writeFile(path.join(root, "source.ts"), "source\n");
    const request = { sessionId: "session-1", contextGeneration: "context-1", subject: { kind: "file" as const, path: "source.ts" }, projection: "source-v1" };
    const first = await readContextAware(root, request);
    assert.equal(first.current.contentIdentity, first.receipt.deliveredContentIdentity);
    assert.equal(first.current.reliability.mayBeIncomplete, false);
    const reopened = await readContextAware(root, request);
    assert.equal(reopened.mode, "unchanged");
    assert.equal(await readFile(path.join(root, ".codeatlas", "context.db"), "utf8").then(() => true), true);
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("context-aware symbol reads require one exact indexed selector", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-symbol-"));
  try {
    await writeFile(path.join(root, "source.ts"), "export function target() {\n  return 42;\n}\n");
    await indexRepository(root, { skipGit: true });
    const graph = await loadIndexedGraphReadOnly(root);
    const node = graph.graph.nodes.find((candidate) => candidate.name === "target");
    assert.ok(node?.startLine !== undefined && node.endLine !== undefined);
    const result = await readContextAware(root, { sessionId: "s", contextGeneration: "g", subject: { kind: "symbol", path: "source.ts", symbolId: node.id, selectorVersion: "1" }, projection: "source-v1" });
    assert.equal(result.mode, "full");
    assert.equal(result.content, "export function target() {\n  return 42;\n}");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("context database corruption fails safe without blocking the current read", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-corrupt-read-"));
  const databasePath = path.join(root, ".codeatlas", "context.db");
  try {
    await writeFile(path.join(root, "source.ts"), "current\n");
    const request = { sessionId: "s", contextGeneration: "g", subject: { kind: "file" as const, path: "source.ts" }, projection: "source-v1" };
    await readContextAware(root, request);
    await writeFile(databasePath, "corrupt sqlite");
    const result = await readContextAware(root, request);
    assert.equal(result.mode, "rehydrate");
    assert.equal(result.content, "current\n");
    assert.match(result.reason ?? "", /context|database/i);
  } finally { await rm(root, { recursive: true, force: true }); }
});
