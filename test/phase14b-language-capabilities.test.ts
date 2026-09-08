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
  getSupportedLanguages,
  isLanguageAdvertised,
  isLanguageFloorPassed,
  LANGUAGE_FLOOR_EVIDENCE,
  type LanguageFloorRegistry,
} from "../src/core/graph/resolver/adapter-registry.js";
import type { CapabilityLevel, LanguageSemanticAdapter, SemanticCapabilities, SemanticEvidenceBatch } from "../src/core/graph/resolver/types.js";
import type { LanguageId } from "../src/core/graph/parsers/types.js";
import { getRepositoryStatus } from "../src/core/repository/repository-status.service.js";
import {
  targetLanguages,
  factExtractorInput,
  parserFixtures,
  runFixtureThroughResolver,
  runLanguageFixture,
  type LanguageFixtureCase,
  type LanguageFixtureDefinition,
  type LanguageFixtureResult,
} from "./helpers/phase14b-language-fixtures.js";

const TARGET_LANGUAGES = targetLanguages;
const CAPABILITY_LEVELS: readonly CapabilityLevel[] = ["full", "partial", "unsupported", "not-applicable"];

export type Phase14bCapability = {
  floorPassed: boolean;
  supported: boolean;
  levels: SemanticCapabilities;
};

type CapabilityCase = LanguageFixtureCase & {
  expectedStatus: "resolved" | "unknown" | "unsupported";
};

const capabilityCases: Readonly<Record<LanguageId, CapabilityCase>> = {
  typescript: { language: "typescript", filePath: "phase14b/capability/main.ts", source: "interface ServiceLike { refresh(): void }\nclass Service implements ServiceLike { refresh(): void { return; } }\nfunction use(): Service { const local: Service = new Service(); local.refresh(); return local; }\n", expectedStatus: "resolved" },
  tsx: { language: "tsx", filePath: "phase14b/capability/main.tsx", source: "interface ServiceLike { refresh(): void }\nclass Service implements ServiceLike { refresh(): void { return; } }\nfunction use(): Service { const local: Service = new Service(); local.refresh(); return local; }\nconst view = <div />;\n", expectedStatus: "resolved" },
  javascript: { language: "javascript", filePath: "phase14b/capability/main.js", source: "class Service { refresh() {} } const local = new Service(); local.refresh();\n", expectedStatus: "resolved" },
  python: { language: "python", filePath: "phase14b/capability/main.py", source: "class Service:\n    total: int = 0\n    def read(self) -> int:\n        return self.total\n\ndef use(item: Service) -> Service:\n    local = Service()\n    local.read()\n    return item\n", expectedStatus: "resolved" },
  java: { language: "java", filePath: "phase14b/capability/Main.java", source: "class Child { private String value; Child(String value) { this.value = value; } String get() { return value; } } class Use { Child create(String value) { return new Child(value); } }\n", expectedStatus: "resolved" },
  kotlin: { language: "kotlin", filePath: "phase14b/capability/Main.kt", source: "open class Base\nclass Child(val value: String?) : Base()\nfun use(child: Child): String? { return child.value }\n", expectedStatus: "unknown" },
  go: { language: "go", filePath: "phase14b/capability/main.go", source: "package main\nfunc target() int { return 1 }\nfunc main() { target() }\n", expectedStatus: "resolved" },
  rust: { language: "rust", filePath: "phase14b/capability/main.rs", source: "fn target() -> i32 { 1 }\nfn main() { target(); }\n", expectedStatus: "unknown" },
  swift: { language: "swift", filePath: "phase14b/capability/main.swift", source: "class Widget { func run() {} }\nfunc use() { let widget = Widget(); widget.run() }\n", expectedStatus: "resolved" },
  dart: { language: "dart", filePath: "phase14b/capability/main.dart", source: "class Worker { void run() {} }\nvoid main() { final worker = Worker(); worker.run(); }\n", expectedStatus: "resolved" },
  c: { language: "c", filePath: "phase14b/capability/main.c", source: "struct Point { int x; }; int add(int value) { return value; } int main(void) { struct Point point = {1}; return add(point.x); }\n", expectedStatus: "resolved" },
  cpp: { language: "cpp", filePath: "phase14b/capability/main.cpp", source: "struct Child { int go() { return 1; } }; int main() { Child child; return child.go(); }\n", expectedStatus: "resolved" },
};

function evidenceCount(batch: SemanticEvidenceBatch): number {
  return Object.values(batch).reduce((count, value) => count + (Array.isArray(value) ? value.length : 0), 0);
}

function assertNonEmptyFloorEvidence(language: LanguageId, floor: LanguageFixtureResult): void {
  assert.ok(floor.normalizedFacts.length > 0, `missing facts for ${language}`);
  assert.ok(floor.decisions.length > 0, `missing semantic decision for ${language}`);
  const evidence = floor.resolverState.evidence.reduce((count, batch) => count + evidenceCount(batch), 0);
  assert.ok(evidence > 0, `missing semantic evidence for ${language}`);
}

async function runCapabilityFloor(
  language: LanguageId,
  extractor: NonNullable<ReturnType<typeof getLanguageFactExtractor>>,
  adapter: LanguageSemanticAdapter,
) {
  const item = capabilityCases[language];
  const outcome = extractor.extract(factExtractorInput(item));
  assert.equal(outcome.kind, "facts", `fact extraction failed for ${language}`);
  if (outcome.kind !== "facts") throw new Error(`fact extraction failed for ${language}`);
  const site = outcome.facts.members[0] ?? outcome.facts.callSites[0];
  assert.ok(site, `missing semantic site for ${language}`);
  const fixture: LanguageFixtureDefinition = {
    name: `capability-${language}`,
    cases: [item],
    sites: [{
      sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: item.filePath, language },
      localId: site.localId,
    }],
    expectedDecisionStatuses: [item.expectedStatus],
  };
  const result = await runFixtureThroughResolver(fixture, [outcome.facts], adapter);
  assertNonEmptyFloorEvidence(language, result);
  return { ...result, floorPassed: result.floorPassed };
}

export async function getPhase14bCapabilities(): Promise<Record<string, Phase14bCapability>> {
  const result: Record<string, Phase14bCapability> = {};
  for (const language of TARGET_LANGUAGES) {
    const extractor = getLanguageFactExtractor(language);
    const adapter = getSemanticAdapter(language);
    assert.ok(extractor, `missing extractor for ${language}`);
    assert.ok(adapter, `missing semantic adapter for ${language}`);
    const floor = language === "go"
      ? await runLanguageFixture(language, { extractors: [extractor], adapter })
      : await runCapabilityFloor(language, extractor, adapter);
    assertNonEmptyFloorEvidence(language, floor);
    result[language] = {
      floorPassed: floor.floorPassed,
      supported: floor.floorPassed && isLanguageAdvertised(language),
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

test("production floor gate excludes an unverified language despite its registered adapter", () => {
  assert.ok(getSemanticAdapter("python"));
  const unverified: LanguageFloorRegistry = {
    ...LANGUAGE_FLOOR_EVIDENCE,
    python: { ...LANGUAGE_FLOOR_EVIDENCE.python, state: "unverified" },
  };
  assert.equal(isLanguageFloorPassed("python", unverified), false);
  assert.equal(isLanguageAdvertised("python", unverified), false);
  assert.deepEqual(getSupportedLanguages(unverified), TARGET_LANGUAGES.filter((language) => language !== "python"));
});

test("semantic floors cannot pass with empty decisions", async () => {
  const extractor = getLanguageFactExtractor("typescript");
  const adapter = getSemanticAdapter("typescript");
  assert.ok(extractor);
  assert.ok(adapter);
  const result = await runLanguageFixture("typescript", { extractors: [extractor], adapter });
  assert.equal(result.decisions.length, 0);
  assert.equal(result.floorPassed, false);
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
