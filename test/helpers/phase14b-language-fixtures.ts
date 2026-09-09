import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import type { ParsedFactsBlob } from "../../src/core/facts/facts.types.js";
import type { FactExtractionOutcome } from "../../src/core/facts/facts-extractor.js";
import type { LanguageFactExtractor, LanguageFactExtractorInput } from "../../src/core/facts/language-fact-extractor.js";
import { createBudgetLedger, type BudgetLedger, type ResolverBudgets } from "../../src/core/graph/resolver/budgets.js";
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
  expectedDecisionStatuses?: readonly ResolutionDecision["status"][];
};

export type LanguageFixtureDependencies = {
  extractors: readonly LanguageFactExtractor[];
  adapter: LanguageSemanticAdapter;
  memoMode?: "cold" | "warm";
  parallel?: boolean;
  resolverState?: LanguageFixtureResolverState;
  budget?: Partial<ResolverBudgets>;
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
    case "java": return `package fixture.jvm;
import java.util.List;
interface Api { String get(); }
class Base { }
class Child extends Base implements Api {
  private String value;
  Child(String value) { this.value = value; }
  String get() { return value; }
}
class Overload { void run(String value) { } void run(Integer value) { } }
class Use { Child create(String value) { return new Child(value); } }
`;
    case "kotlin": return `package fixture.jvm
import kotlin.collections.List
typealias MaybeName = String?
public sealed interface Api {
  fun get(): String?
}
open class Base
class Child(val value: String?) : Base(), Api {
  override fun get(): String? = value
}
object Registry {
  fun load(): Child = Child(null)
}
class Holder {
  companion object {
    fun load(): Child = Child(null)
  }
}
class Use {
  fun read(child: Child): String? {
    return child.value
  }
}
class Overload {
  fun run(value: String) { }
  fun run(value: Int) { }
}
fun use() { Overload().run(null) }
fun String.extension(): String = this
`;
    case "go": return readFileSync(new URL("../fixtures/phase14b/go/main.go", import.meta.url), "utf8");
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

export const parserFixtures: Readonly<Record<string, LanguageFixtureDefinition>> = Object.fromEntries([
  ...targetLanguages.map((language) => [language, { name: language, cases: [fixtureCase(language)], sites: [] }] as const),
  ["jvm", { name: "jvm", cases: [fixtureCase("java"), fixtureCase("kotlin")], sites: [] }],
]);

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

function prepareFixture(fixture: LanguageFixtureDefinition, facts: readonly ParsedFactsBlob[]): LanguageFixtureDefinition {
  if (fixture.name === "go") {
    const expected = JSON.parse(readFileSync(new URL("../fixtures/phase14b/go/expected.json", import.meta.url), "utf8")) as { sites: readonly { callee: string; status: ResolutionDecision["status"] }[] };
    const blob = facts[0];
    if (!blob) return fixture;
    const calls = new Map(blob.callSites.map((item) => [item.calleeText, item]));
    const sites = expected.sites.flatMap((item) => {
      const call = calls.get(item.callee);
      return call ? [{ sourceUnit: sourceUnit(fixture, 0, blob), localId: call.localId }] : [];
    });
    return { ...fixture, sites, expectedDecisionStatuses: expected.sites.map((item) => item.status).filter((_, index) => sites[index]) };
  }
  if (fixture.name !== "java" && fixture.name !== "kotlin" && fixture.name !== "jvm") return fixture;
  const sites: ResolutionSiteIdentity[] = [];
  const expectedDecisionStatuses: ResolutionDecision["status"][] = [];
  for (const [index, factsBlob] of facts.entries()) {
    const source = sourceUnit(fixture, index, factsBlob);
    if (factsBlob.language === "java") {
      const member = factsBlob.members.find((item) => item.memberName === "value");
      if (member) { sites.push({ sourceUnit: source, localId: member.localId }); expectedDecisionStatuses.push("resolved"); }
    }
    if (factsBlob.language === "kotlin") {
      const inheritance = factsBlob.inheritances.find((item) => item.relationKind === "extends");
      const extension = factsBlob.implementations.find((item) => item.relationKind === "extension");
      const overloadCall = factsBlob.callSites.find((item) => item.calleeText.includes(".run"));
      if (inheritance) { sites.push({ sourceUnit: source, localId: inheritance.localId }); expectedDecisionStatuses.push("unknown"); }
      if (extension) { sites.push({ sourceUnit: source, localId: extension.localId }); expectedDecisionStatuses.push("unknown"); }
      if (overloadCall) { sites.push({ sourceUnit: source, localId: overloadCall.localId }); expectedDecisionStatuses.push("ambiguous"); }
    }
  }
  return { ...fixture, sites, expectedDecisionStatuses };
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
  return runFixtureThroughResolver(prepareFixture(fixture, normalizedFacts), normalizedFacts, deps.adapter, deps.memoMode, deps.parallel, deps.resolverState, deps.budget);
}

export async function runFixtureThroughResolver(
  fixture: LanguageFixtureDefinition,
  facts: readonly ParsedFactsBlob[],
  adapter: LanguageSemanticAdapter,
  memoMode: "cold" | "warm" = "cold",
  parallel = false,
  resolverState?: LanguageFixtureResolverState,
  budgetOverrides: Partial<ResolverBudgets> = {},
): Promise<LanguageFixtureResult> {
  const repositoryIdentity = { id: "phase14b-fixtures", identityKey: "phase14b-fixtures", rootPath: "/phase14b-fixtures", displayName: "phase14b-fixtures" };
  const normalize = (factsBlob: ParsedFactsBlob, index: number) => adapter.normalizeFile(factsBlob, {
    generationId: `fixture:${fixture.name}`,
    repositoryIdentity,
    sourceUnit: sourceUnit(fixture, index, factsBlob),
    resolutionVersion: "14b-2",
  });
  const evidence = resolverState?.evidence ?? (parallel ? await Promise.all(facts.map(normalize)) : facts.map(normalize));
  const state = resolverState ?? createFixtureResolverState(fixture, facts, evidence, memoMode, repositoryIdentity, adapter, budgetOverrides);
  const decisions = fixture.sites.map((site) => {
    const index = fixture.cases.findIndex((item) => item.filePath === site.sourceUnit.relativePath && item.language === site.sourceUnit.language);
    const factsBlob = facts[index];
    if (!factsBlob) throw new Error(`missing facts for ${site.sourceUnit.relativePath}`);
    return resolveSite({ facts: factsBlob, evidence: evidence[index], environment: state.typeEnvironment, context: state.context }, site);
  });
  const expected = fixture.expectedDecisionStatuses;
  const floorPassed = decisions.length > 0 && (expected
    ? expected.length === decisions.length && decisions.every((decision, index) => decision.status === expected[index])
    : decisions.every((decision) => decision.status === "resolved"));
  return { decisions, usedSourceSemanticFallback: false, floorPassed, normalizedFacts: facts, resolverState: state };
}

function createFixtureResolverState(
  fixture: LanguageFixtureDefinition,
  facts: readonly ParsedFactsBlob[],
  evidence: readonly SemanticEvidenceBatch[],
  memoMode: "cold" | "warm",
  repositoryIdentity: { id: string; identityKey: string; rootPath: string; displayName: string },
  adapter: LanguageSemanticAdapter,
  budgetOverrides: Partial<ResolverBudgets>,
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
  state.budget = createBudgetLedger({ candidateExpansions: 1000, bindingHops: 1000, returnDepth: 1000, inheritanceDepth: 1000, memberCandidates: 1000, expressionNodes: 1000, propagationRounds: 1000, ...budgetOverrides });
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
