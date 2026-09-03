import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";

import { parseCodeSymbols } from "../src/parsers/code-parser.js";
import { collectIndexedFileStates } from "../src/utils/indexed-file-state.js";
import { splitLargeSymbol } from "../src/utils/split-symbol.js";

test("zero-chunk fixture exposes the current stale-state ceiling", async () => {
  const filePath = fileURLToPath(new URL("./fixtures/phase-0-zero-chunk/empty.ts", import.meta.url));
  const source = await readFile(filePath, "utf8");
  const chunks = parseCodeSymbols(source, "empty.ts").flatMap(splitLargeSymbol);

  assert.deepEqual(chunks, []);
  assert.equal(collectIndexedFileStates([]).get("empty.ts"), undefined);
  // TODO(AtlasStore/file_capability_state): current Qdrant-derived state has no
  // row to mark this file current, so a later sync cannot distinguish it from new work.
});
