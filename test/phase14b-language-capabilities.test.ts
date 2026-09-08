import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { getLanguageFactExtractor } from "../src/core/facts/language-fact-extractor.js";
import { LANGUAGE_CONFIGS } from "../src/core/graph/parsers/languages.js";
import {
  getLanguageAdapter,
  getSemanticAdapter,
} from "../src/core/graph/resolver/adapter-registry.js";
import type { CapabilityLevel, SemanticCapabilities } from "../src/core/graph/resolver/types.js";
import { getRepositoryStatus } from "../src/core/repository/repository-status.service.js";
import { targetLanguages, factExtractorInput, parserFixtures, runLanguageFixture } from "./helpers/phase14b-language-fixtures.js";

const TARGET_LANGUAGES = targetLanguages;
const CAPABILITY_LEVELS: readonly CapabilityLevel[] = ["full", "partial", "unsupported", "not-applicable"];

export type Phase14bCapability = {
  floorPassed: boolean;
  supported: boolean;
  levels: SemanticCapabilities;
};

export async function getPhase14bCapabilities(): Promise<Record<string, Phase14bCapability>> {
  const result: Record<string, Phase14bCapability> = {};
  for (const language of TARGET_LANGUAGES) {
    const extractor = getLanguageFactExtractor(language);
    const adapter = getSemanticAdapter(language);
    assert.ok(extractor, `missing extractor for ${language}`);
    assert.ok(adapter, `missing semantic adapter for ${language}`);
    const fixture = parserFixtures[language];
    const floor = await runLanguageFixture(language, {
      extractors: [extractor],
      adapter,
    });
    result[language] = {
      floorPassed: floor.floorPassed && floor.normalizedFacts.length === fixture.cases.length,
      supported: floor.floorPassed,
      levels: adapter.capabilities(language),
    };
  }
  return result;
}

test("all declared language extensions resolve through parser adapters", () => {
  for (const config of LANGUAGE_CONFIGS) {
    for (const extension of config.extensions) {
      assert.equal(getLanguageAdapter(`fixture${extension}`)?.language, config.language);
    }
  }
});

test("every target language has an exact extractor and one semantic family adapter", () => {
  const adapters = TARGET_LANGUAGES.map((language) => {
    const extractor = getLanguageFactExtractor(language);
    const adapter = getSemanticAdapter(language);
    assert.equal(extractor?.language, language);
    assert.ok(adapter?.languages.includes(language));
    return adapter;
  });
  assert.equal(new Set(adapters).size, 8);
  assert.notStrictEqual(getSemanticAdapter("javascript"), getSemanticAdapter("python"));
  assert.notStrictEqual(getLanguageFactExtractor("javascript"), getLanguageFactExtractor("typescript"));
  assert.notStrictEqual(getLanguageFactExtractor("typescript"), getLanguageFactExtractor("tsx"));
  assert.strictEqual(getSemanticAdapter("java"), getSemanticAdapter("kotlin"));
  assert.strictEqual(getSemanticAdapter("c"), getSemanticAdapter("cpp"));
});

test("repository status advertises only the registered, floor-gated languages", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-phase14b-"));
  const status = await getRepositoryStatus(repoPath);
  assert.deepEqual(status.capabilities.languages, TARGET_LANGUAGES);
});

test("capability status advertises only languages that pass the semantic floor", async () => {
  const capabilities = await getPhase14bCapabilities();
  for (const language of TARGET_LANGUAGES) {
    assert.equal(capabilities[language]?.floorPassed, true, language);
    assert.equal(capabilities[language]?.supported, true, language);
    assert.ok(Object.values(capabilities[language]!.levels).every((level) => CAPABILITY_LEVELS.includes(level)));
  }
});

test("fact extraction is deterministic for every target language", () => {
  for (const language of TARGET_LANGUAGES) {
    const extractor = getLanguageFactExtractor(language);
    assert.ok(extractor);
    const item = parserFixtures[language].cases[0]!;
    const first = extractor.extract(factExtractorInput(item));
    const second = extractor.extract(factExtractorInput(item));
    assert.deepEqual(second, first, language);
    assert.equal(first.kind, "facts", language);
  }
});
