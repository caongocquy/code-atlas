import { createHash } from "node:crypto";

import type { ParsedFactsBlob } from "../../src/core/facts/facts.types.js";
import type { FactExtractionOutcome } from "../../src/core/facts/facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../../src/core/facts/language-fact-extractor.js";
import { createBudgetLedger, type BudgetLedger } from "../../src/core/graph/resolver/budgets.js";
import { resolveSite, type ResolutionDecision } from "../../src/core/graph/resolver/resolver.js";
import { createGenerationResolverContext, type GenerationResolverContext } from "../../src/core/graph/resolver/generation-context.js";
import { symbolIdentity, type ResolutionSiteIdentity, type SourceUnitIdentity, type SymbolIdentity } from "../../src/core/graph/resolver/identities.js";
import { createResolverMemo, type ResolverMemo } from "../../src/core/graph/resolver/memo.js";
import { createTypeEnvironment } from "../../src/core/graph/resolver/type-environment.js";
import type { LanguageSemanticAdapter, SemanticEvidenceBatch } from "../../src/core/graph/resolver/types.js";
import type { TypeEnvironment } from "../../src/core/graph/resolver/type-environment.js";
import type { LanguageId } from "../../src/core/graph/parsers/types.js";

export type LanguageFixtureCase = {
  filePath: string;
  source: string;
  language: LanguageId;
};

export type LanguageFixtureDefinition = {
  name: string;
  cases: readonly LanguageFixtureCase[];
  sites: readonly ResolutionSiteIdentity[];
};

export type LanguageFixtureDependencies = {
  extractors: readonly LanguageFactExtractor[];
  adapter: LanguageSemanticAdapter;
  memoMode?: "cold" | "warm";
  parallel?: boolean;
};

export type LanguageFixtureResult = {
  decisions: readonly ResolutionDecision[];
  usedSourceSemanticFallback: boolean;
  floorPassed: boolean;
  normalizedFacts: readonly ParsedFactsBlob[];
  resolverState: LanguageFixtureResolverState;
};

export type LanguageFixtureResolverState = {
  memo: ResolverMemo;
  budget: BudgetLedger;
  typeEnvironment: TypeEnvironment;
  context: GenerationResolverContext;
  evidence: readonly SemanticEvidenceBatch[];
  memoHitCount: number;
};

const source = (language: LanguageId): string => {
  switch (language) {
    case "typescript": return "const value: number = 1;";
    case "tsx": return "const view = <div />;";
    case "javascript": return "const value = 1;";
    case "python": return "value = 1\n";
    case "java": return "class Main { int value = 1; }\n";
    case "kotlin": return "class Main {\n  val value: Int = 1\n}\n";
    case "go": return "package main\n\nvar value = 1\n";
    case "rust": return "fn main() { let value = 1; }\n";
    case "swift": return "let value = 1\n";
    case "dart": return "void main() { var value = 1; }\n";
    case "c": return "int value = 1;\n";
    case "cpp": return "int value = 1;\n";
  }
};

const extension: Record<LanguageId, string> = {
  typescript: ".ts", tsx: ".tsx", javascript: ".js", python: ".py", java: ".java", kotlin: ".kt",
  go: ".go", rust: ".rs", swift: ".swift", dart: ".dart", c: ".c", cpp: ".cpp",
};

const fixtureCase = (language: LanguageId): LanguageFixtureCase => ({
  filePath: `phase14b/${language}/main${extension[language]}`,
  source: source(language),
  language,
});

export const targetLanguages: readonly LanguageId[] = [
  "typescript", "tsx", "javascript", "python", "java", "kotlin", "go", "rust", "swift", "dart", "c", "cpp",
];

export const parserFixtures: Readonly<Record<string, LanguageFixtureDefinition>> = Object.fromEntries(
  targetLanguages.map((language) => [language, { name: language, cases: [fixtureCase(language)], sites: [] }]),
);

export function factExtractorInput(item: LanguageFixtureCase): LanguageFactExtractorInput {
  return {
    source: item.source,
    filePath: item.filePath,
    language: item.language,
    contentHash: createHash("sha256").update(item.source).digest("hex"),
    factsVersion: "2.0.0",
    factsSchemaVersion: "2.0.0",
  };
}

function sourceUnit(fixture: LanguageFixtureDefinition, index: number, facts: ParsedFactsBlob): SourceUnitIdentity {
  return { repositoryId: "phase14b-fixtures", relativePath: fixture.cases[index]?.filePath ?? "", language: facts.language };
}

function symbolsFor(fixture: LanguageFixtureDefinition, facts: readonly ParsedFactsBlob[]): SymbolIdentity[] {
  return facts.flatMap((blob, index) => blob.symbols.map((item) => symbolIdentity({
    repositoryId: "phase14b-fixtures",
    relativePath: sourceUnit(fixture, index, blob).relativePath,
    language: blob.language,
    kind: item.kind,
    qualifiedName: item.declaredQualifiedName ?? item.name,
    discriminator: item.localId,
  })));
}

export async function runLanguageFixture(name: string, deps: LanguageFixtureDependencies): Promise<LanguageFixtureResult> {
  const fixture = parserFixtures[name];
  if (!fixture) throw new Error(`unknown Phase14B fixture: ${name}`);
  const extract = (item: LanguageFixtureCase): ParsedFactsBlob => {
    const extractor = deps.extractors.find((candidate) => candidate.language === item.language);
    if (!extractor) throw new Error(`missing extractor for ${item.language}`);
    if (extractor.language !== item.language) throw new Error(`extractor language mismatch for ${item.filePath}`);
    const outcome: FactExtractionOutcome = extractor.extract(factExtractorInput(item));
    if (outcome.kind !== "facts") throw new Error(`fact extraction failed for ${item.filePath}: ${outcome.kind}`);
    return outcome.facts;
  };
  const normalizedFacts = fixture.cases.map(extract);
  return runFixtureThroughResolver(fixture, normalizedFacts, deps.adapter, deps.memoMode, deps.parallel);
}

export async function runFixtureThroughResolver(
  fixture: LanguageFixtureDefinition,
  facts: readonly ParsedFactsBlob[],
  adapter: LanguageSemanticAdapter,
  memoMode: "cold" | "warm" = "cold",
  parallel = false,
  resolverState?: LanguageFixtureResolverState,
): Promise<LanguageFixtureResult> {
  const repositoryIdentity = { id: "phase14b-fixtures", identityKey: "phase14b-fixtures", rootPath: "/phase14b-fixtures", displayName: "phase14b-fixtures" };
  const normalize = (factsBlob: ParsedFactsBlob, index: number) => adapter.normalizeFile(factsBlob, {
    generationId: `fixture:${fixture.name}`,
    repositoryIdentity,
    sourceUnit: sourceUnit(fixture, index, factsBlob),
    resolutionVersion: "14b-2",
  });
  const evidence = resolverState?.evidence ?? (parallel ? await Promise.all(facts.map(normalize)) : facts.map(normalize));
  const state = resolverState ?? createFixtureResolverState(fixture, facts, evidence, memoMode, repositoryIdentity, adapter);
  const decisions = fixture.sites.map((site) => {
    const index = fixture.cases.findIndex((item) => item.filePath === site.sourceUnit.relativePath && item.language === site.sourceUnit.language);
    const factsBlob = facts[index];
    if (!factsBlob) throw new Error(`missing facts for ${site.sourceUnit.relativePath}`);
    return resolveSite({ facts: factsBlob, evidence: evidence[index], environment: state.typeEnvironment, context: state.context }, site);
  });
  return { decisions, usedSourceSemanticFallback: false, floorPassed: decisions.every((decision) => decision.status === "resolved"), normalizedFacts: facts, resolverState: state };
}

function createFixtureResolverState(
  fixture: LanguageFixtureDefinition,
  facts: readonly ParsedFactsBlob[],
  evidence: readonly SemanticEvidenceBatch[],
  memoMode: "cold" | "warm",
  repositoryIdentity: { id: string; identityKey: string; rootPath: string; displayName: string },
  adapter: LanguageSemanticAdapter,
): LanguageFixtureResolverState {
  const state = { memoHitCount: 0 } as LanguageFixtureResolverState;
  const backingMemo = createResolverMemo();
  state.memo = {
    get: (key) => {
      const entry = backingMemo.get(key);
      if (entry) state.memoHitCount += 1;
      return entry;
    },
    set: (key, value) => backingMemo.set(key, value),
    size: () => backingMemo.size(),
  };
  state.budget = createBudgetLedger({ candidateExpansions: 1000, bindingHops: 1000, returnDepth: 1000, inheritanceDepth: 1000, memberCandidates: 1000, expressionNodes: 1000, propagationRounds: 1000 });
  state.evidence = evidence;
  state.typeEnvironment = createTypeEnvironment({ generationId: `fixture:${fixture.name}`, symbols: symbolsFor(fixture, facts), evidence, budget: state.budget, memo: state.memo });
  state.context = createGenerationResolverContext({
    generationId: `fixture:${fixture.name}:${memoMode}`,
    repositoryIdentity,
    parsedFactsView: facts,
    languageRegistry: [adapter],
    typeEnvironment: state.typeEnvironment,
    budget: state.budget,
    memo: state.memo,
    resolutionVersion: "14b-2",
  });
  return state;
}
