import { mkdtemp, readFile, rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { parseCodeSymbols } from "../src/core/graph/parsers/code-parser.js";
import { collectIndexedFileStates } from "../src/core/repository/indexed-file-state.js";
import { splitLargeSymbol } from "../src/core/semantic/split-symbol.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

test("zero-chunk files have explicit ready semantic state", async () => {
  const filePath = fileURLToPath(new URL("./fixtures/phase-0-zero-chunk/empty.ts", import.meta.url));
  const source = await readFile(filePath, "utf8");
  const chunks = parseCodeSymbols(source, "empty.ts").flatMap(splitLargeSymbol);

  assert.deepEqual(chunks, []);
  assert.equal(collectIndexedFileStates([]).get("empty.ts"), undefined);

  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-zero-chunk-"));
  const store = new AtlasStore(path.join(repoPath, "atlas.db"));

  try {
    const repo = store.ensureRepository(getRepositoryIdentity(repoPath));
    store.setFileCapabilityState(repo.id, "empty.ts", "semantic", {
      version: "semantic-1",
      state: "ready",
      itemCount: 0,
      fileHash: "empty-hash",
    });
    assert.equal(
      store.getFileCapabilityState(repo.id, "empty.ts", "semantic")?.state,
      "ready",
    );
  } finally {
    store.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
