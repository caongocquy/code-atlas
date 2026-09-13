import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  CONTEXT_AWARE_SOURCE_PROJECTION,
  prepareContextAwareRead,
} from "../src/core/context/context-delivery-preparation.js";
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
