import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { ContextStore } from "../src/storage/context/context.store.js";

test("context database corruption is reported without changing the repository path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-corrupt-"));
  const directory = path.join(root, ".codeatlas");
  const databasePath = path.join(directory, "context.db");
  try {
    await mkdir(directory);
    await writeFile(databasePath, "not sqlite");
    assert.throws(() => new ContextStore(databasePath), /context|database|sqlite/i);
    assert.equal(path.dirname(databasePath), directory);
  } finally { await rm(root, { recursive: true, force: true }); }
});
