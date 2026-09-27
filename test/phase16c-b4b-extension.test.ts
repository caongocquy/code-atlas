import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { computeB4bExtensionHash } from "../eval/retrieval/b4b.js";
import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import { RETRIEVAL_DATASET_VERSION, validateRetrievalDataset, validateRetrievalExtension } from "../eval/retrieval/types.js";

const repoRoot = process.cwd();
const extensionPath = path.join(repoRoot, "eval/retrieval/b4b-extension.json");

test("B4B extension judgments are valid, development-only, and frozen before retrieval", async () => {
  const extensionBytes = await readFile(extensionPath);
  const extension = validateRetrievalExtension(JSON.parse(extensionBytes.toString("utf8")) as unknown);
  const frozen = JSON.parse(await readFile(path.join(repoRoot, "eval/retrieval/dataset.json"), "utf8")) as { semanticVectorFixtureId: string; cases: unknown[] };
  assert.equal(extension.semanticVectorFixtureId, frozen.semanticVectorFixtureId);
  assert.equal(extension.cases.length, 8);
  assert.equal(new Set(extension.cases.map((item) => item.fixture)).size, 4);
  assert.ok(extension.cases.every((item) => item.split === "development" && item.relevant.length > 0 && !item.semanticVectors));
  validateRetrievalDataset({ datasetVersion: RETRIEVAL_DATASET_VERSION, semanticVectorFixtureId: frozen.semanticVectorFixtureId, cases: [...frozen.cases, ...extension.cases] });

  const sourceFacts = new Map<string, ParsedFactsBlob>();
  for (const item of extension.cases) {
    for (const selector of [...item.relevant, ...(item.supporting ?? []), ...(item.irrelevant ?? []), ...(item.forbidden ?? [])]) {
      if (selector.kind !== "symbol") continue;
      const key = `${item.fixture}/${selector.path}`;
      let facts = sourceFacts.get(key);
      if (!facts) {
        const source = await readFile(path.join(repoRoot, "eval/retrieval/fixtures", item.fixture, selector.path), "utf8");
        const parsed = extractParsedFacts({ source, filePath: selector.path, language: "typescript" });
        assert.equal(parsed.kind, "facts", `parser must support ${key}`);
        if (parsed.kind !== "facts") continue;
        facts = parsed.facts;
        sourceFacts.set(key, facts);
      }
      assert.ok(facts.symbols.some((symbol) => symbol.name === selector.name && symbol.kind === selector.symbolKind), `unknown frozen selector ${key}:${selector.name}/${selector.symbolKind}`);
    }
  }

  const actualHash = await computeB4bExtensionHash(repoRoot, extensionBytes, extension.cases);
  assert.equal((await readFile(path.join(repoRoot, "eval/retrieval/b4b-extension.sha256"), "utf8")).trim(), actualHash);
});
