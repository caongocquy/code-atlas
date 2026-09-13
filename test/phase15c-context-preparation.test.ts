import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTEXT_AWARE_SOURCE_PROJECTION,
  prepareContextAwareRead,
} from "../src/core/context/context-delivery-preparation.js";
import { ContextDeliveryPreparationError } from "../src/core/context/context.types.js";
import { readContextAware } from "../src/core/context/context-aware-read.service.js";
import { ContextStore } from "../src/storage/context/context.store.js";

test("preparation builds a full delivery without changing receipt or snapshot counts", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-preparation-"));
  try {
    await writeFile(path.join(root, "source.ts"), "one\n");
    const request = { sessionId: "session-1", contextGeneration: "context-1", subject: { kind: "file" as const, path: "source.ts" }, projection: CONTEXT_AWARE_SOURCE_PROJECTION };
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    const prepared = await prepareContextAwareRead(root, request, store);
    const database = new DatabaseSync(path.join(root, ".codeatlas", "context.db"));
    assert.equal(prepared.result.mode, "full");
    assert.equal(prepared.result.content, "one\n");
    assert.equal((database.prepare("SELECT count(*) AS count FROM context_receipts").get() as { count: number }).count, 0);
    assert.equal((database.prepare("SELECT count(*) AS count FROM context_snapshots").get() as { count: number }).count, 0);
    database.close();
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("public reads preserve full, unchanged, delta, and rehydrate behavior", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-public-read-"));
  try {
    const filePath = path.join(root, "source.ts");
    const request = { sessionId: "session-1", contextGeneration: "context-1", subject: { kind: "file" as const, path: "source.ts" }, projection: CONTEXT_AWARE_SOURCE_PROJECTION };
    await writeFile(filePath, "one\n");
    assert.equal((await readContextAware(root, request)).mode, "full");
    assert.equal((await readContextAware(root, request)).mode, "unchanged");
    await writeFile(filePath, "two\n");
    const delta = await readContextAware(root, request);
    assert.equal(delta.mode, "delta");
    const database = new DatabaseSync(path.join(root, ".codeatlas", "context.db"));
    database.prepare("UPDATE context_receipts SET workspace_identity = 'other-workspace' WHERE receipt_id = ?").run(delta.receipt.receiptId);
    database.close();
    const rehydrated = await readContextAware(root, request);
    assert.equal(rehydrated.mode, "rehydrate");
    assert.equal(rehydrated.content, "two\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("graph storage failures remain hard failures instead of preparation errors", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-preparation-graph-failure-"));
  try {
    await writeFile(path.join(root, "source.ts"), "export function target() { return 1; }\n");
    const store = new ContextStore(path.join(root, ".codeatlas", "context.db"));
    await writeFile(path.join(root, ".codeatlas", "atlas.db"), "corrupt graph database");
    await assert.rejects(
      prepareContextAwareRead(root, { sessionId: "s", contextGeneration: "g", subject: { kind: "symbol", path: "source.ts", symbolId: "missing", selectorVersion: "1" }, projection: CONTEXT_AWARE_SOURCE_PROJECTION }, store),
      (error: unknown) => !(error instanceof ContextDeliveryPreparationError),
    );
    store.close();
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("subject delivery rejects traversal and symlink escapes outside the repository", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-symlink-"));
  const outside = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-outside-"));
  try {
    await writeFile(path.join(outside, "secret.ts"), "secret\n");
    await symlink(outside, path.join(root, "linked"));
    const request = { sessionId: "s", contextGeneration: "g", subject: { kind: "file" as const, path: "linked/secret.ts" }, projection: CONTEXT_AWARE_SOURCE_PROJECTION };
    await assert.rejects(prepareContextAwareRead(root, request), ContextDeliveryPreparationError);
    await assert.rejects(prepareContextAwareRead(root, { ...request, subject: { kind: "file", path: "../secret.ts" } }), ContextDeliveryPreparationError);
  } finally {
    await Promise.all([rm(root, { recursive: true, force: true }), rm(outside, { recursive: true, force: true })]);
  }
});

test("context database corruption falls back to current delivery without changing source state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-context-corruption-"));
  const databasePath = path.join(root, ".codeatlas", "context.db");
  try {
    const source = path.join(root, "source.ts");
    await writeFile(source, "current\n");
    const request = { sessionId: "s", contextGeneration: "g", subject: { kind: "file" as const, path: "source.ts" }, projection: CONTEXT_AWARE_SOURCE_PROJECTION };
    const first = await readContextAware(root, request);
    assert.equal(first.mode, "full");
    await writeFile(databasePath, "corrupt sqlite");
    const recovered = await readContextAware(root, request);
    assert.equal(recovered.mode, "rehydrate");
    assert.equal(recovered.content, "current\n");
    assert.match(recovered.reason ?? "", /context|database/i);
    assert.equal(await readFile(source, "utf8"), "current\n");
  } finally { await rm(root, { recursive: true, force: true }); }
});
