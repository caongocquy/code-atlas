import assert from "node:assert/strict";
import test from "node:test";

import { extractJavaFacts, javaFactExtractor } from "../src/core/facts/extractors/java.js";
import { extractKotlinFacts, kotlinFactExtractor } from "../src/core/facts/extractors/kotlin.js";
import { JAVA_CAPABILITIES, KOTLIN_CAPABILITIES, jvmSemanticAdapter } from "../src/core/graph/resolver/adapters/jvm.js";
import { factExtractorInput, runFixtureThroughResolver, runLanguageFixture } from "./helpers/phase14b-language-fixtures.js";

const javaSource = `
package demo.api;
import java.util.List;
interface Api { String get(); }
class Child extends Base implements Api {
  private String value;
  Child(String value) { this.value = value; }
  String get() { return value; }
}
class Use {
  Child create(String value) { return new Child(value); }
}
`;

const kotlinSource = `
package demo.api
import java.util.List
typealias Name = String
interface Api { fun get(): String? }
open class Base
class Child(val value: String?) : Base(), Api { override fun get(): String? = value }
object Registry { fun load(): Child = Child(null) }
class Holder {
  companion object {
    fun load(): Child = Child(null)
  }
}
fun String.ext(): String = this
`;

function input(language: "java" | "kotlin", source: string) {
  return factExtractorInput({ filePath: `phase14b/jvm/Main.${language === "java" ? "java" : "kt"}`, source, language });
}

test("JVM extractors keep Java and Kotlin grammar mappings separate and complete", () => {
  const java = extractJavaFacts(input("java", javaSource));
  const kotlin = extractKotlinFacts(input("kotlin", kotlinSource));
  assert.equal(java.kind, "facts");
  assert.equal(kotlin.kind, "facts");
  if (java.kind !== "facts" || kotlin.kind !== "facts") return;

  assert.deepEqual(java.facts.imports.map((item) => item.moduleSpecifier), ["java.util.List"]);
  assert.ok(java.facts.symbols.some((item) => item.kind === "interface" && item.name === "Api"));
  assert.ok(java.facts.symbols.some((item) => item.kind === "class" && item.name === "Child"));
  assert.ok(java.facts.inheritances.some((item) => item.relationKind === "extends" && item.targetName === "Base"));
  assert.ok(java.facts.implementations.some((item) => item.relationKind === "implements" && item.targetName === "Api"));
  assert.ok(java.facts.constructors.some((item) => item.constructedTypeName === "Child"));
  assert.ok(java.facts.parameters.some((item) => item.name === "value" && item.typeText === "String"));
  assert.ok(java.facts.returns.some((item) => item.typeText === "Child"));
  assert.ok(java.facts.members.some((item) => item.memberName === "value"));

  assert.deepEqual(kotlin.facts.imports.map((item) => item.moduleSpecifier), ["java.util.List"]);
  assert.ok(kotlin.facts.aliases.some((item) => item.aliasName === "Name" && item.targetName === "String"));
  assert.ok(kotlin.facts.symbols.some((item) => item.kind === "interface" && item.name === "Api"));
  assert.ok(kotlin.facts.symbols.some((item) => item.kind === "class" && item.name === "Child"));
  assert.ok(kotlin.facts.symbols.some((item) => item.kind === "class" && item.name === "Registry"));
  assert.ok(kotlin.facts.symbols.some((item) => item.kind === "class" && item.name === "Holder.Companion"));
  assert.ok(kotlin.facts.parameters.some((item) => item.name === "value" && item.typeText === "String?"));
  assert.ok(kotlin.facts.returns.some((item) => item.typeText === "String?"));
  assert.ok(kotlin.facts.constructors.some((item) => item.constructedTypeName === "Child"));
  assert.ok(kotlin.facts.implementations.some((item) => item.targetName === "Api"));
});

test("JVM adapter normalizes declared member ownership and nullable types", async () => {
  const outcome = javaFactExtractor.extract(input("java", javaSource));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const member = outcome.facts.members.find((item) => item.memberName === "value");
  assert.ok(member);
  const result = await runFixtureThroughResolver(
    { name: "jvm", cases: [{ filePath: input("java", javaSource).filePath, source: javaSource, language: "java" }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: input("java", javaSource).filePath, language: "java" }, localId: member.localId }] },
    [outcome.facts], jvmSemanticAdapter,
  );
  assert.equal(result.decisions[0]?.status, "resolved");
  assert.equal(result.usedSourceSemanticFallback, false);
});

test("JVM dispatch uncertainty is explicit and never guessed", () => {
  const source = `class Overload {
  fun run(value: String) {}
  fun run(value: Int) {}
}
class Use { fun use() { Overload().run(null) } }
fun String.extension(): String = this
`;
  const outcome = kotlinFactExtractor.extract(input("kotlin", source));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const evidence = jvmSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "test",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "Main.kt", language: "kotlin" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.diagnostics.some((item) => item.code === "overload_ambiguity"));
  assert.ok(evidence.diagnostics.some((item) => item.code === "extension_dispatch_unsupported"));
  assert.ok(evidence.diagnostics.some((item) => item.code === "compiler_dispatch_unknown"));
});

test("JVM extractors reject mismatched language inputs", () => {
  const mismatched = factExtractorInput({ filePath: "Main.kt", source: "class Main", language: "kotlin" });
  assert.equal(javaFactExtractor.extract(mismatched).kind, "infrastructure_failure");
});

test("Kotlin modifiers do not hide public or sealed interfaces", () => {
  for (const [name, source] of [["public", "public interface PublicApi {\n fun get(): String?\n}"], ["sealed", "sealed interface SealedApi {\n fun get(): String?\n}"], ["combined", "public sealed interface CombinedApi {\n fun get(): String?\n}"]] as const) {
    const outcome = kotlinFactExtractor.extract(input("kotlin", source));
    assert.equal(outcome.kind, "facts", name);
    if (outcome.kind !== "facts") continue;
    assert.equal(outcome.facts.parseStatus, "complete", name);
    assert.ok(outcome.facts.symbols.some((item) => item.kind === "interface" && item.name.endsWith("Api")), name);
  }
});

test("JVM normalization preserves nullable syntax in evidence", () => {
  const outcome = kotlinFactExtractor.extract(input("kotlin", kotlinSource));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const evidence = jvmSemanticAdapter.normalizeFile(outcome.facts, {
    generationId: "nullable",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "Main.kt", language: "kotlin" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.typeAnnotations.some((item) => item.type.kind === "named" && item.type.name === "String?"));
});

test("JVM capabilities distinguish Java from Kotlin compiler-semantic coverage", () => {
  assert.equal(jvmSemanticAdapter.capabilities("java"), JAVA_CAPABILITIES);
  assert.equal(jvmSemanticAdapter.capabilities("kotlin"), KOTLIN_CAPABILITIES);
  assert.notDeepEqual(JAVA_CAPABILITIES, KOTLIN_CAPABILITIES);
  assert.notEqual(KOTLIN_CAPABILITIES.directCall, "full");
  assert.notEqual(KOTLIN_CAPABILITIES.receiverMember, "full");
});

test("real Java and Kotlin fixtures exercise the full floor deterministically", async () => {
  const jvmCold = await runLanguageFixture("jvm", { extractors: [javaFactExtractor, kotlinFactExtractor], adapter: jvmSemanticAdapter });
  const jvmWarm = await runLanguageFixture("jvm", { extractors: [javaFactExtractor, kotlinFactExtractor], adapter: jvmSemanticAdapter, memoMode: "warm", parallel: true, resolverState: jvmCold.resolverState });
  const javaFacts = jvmCold.normalizedFacts.find((facts) => facts.language === "java");
  const kotlinFacts = jvmCold.normalizedFacts.find((facts) => facts.language === "kotlin");
  for (const [facts, language, grammar] of [[javaFacts, "java", "tree-sitter-java@0.23.5"], [kotlinFacts, "kotlin", "tree-sitter-kotlin@0.3.8"]] as const) {
    assert.equal(facts?.language, language);
    assert.equal(facts?.parserIdentity.packageName, grammar.split("@")[0]);
    assert.equal(`${facts?.parserIdentity.packageName}@${facts?.parserIdentity.grammarVersion}`, grammar);
    assert.equal(facts?.parseStatus, "complete");
  }
  assert.ok(javaFacts?.modules.some((item) => item.name === "fixture.jvm"));
  assert.ok(javaFacts?.imports.length);
  assert.ok(javaFacts?.inheritances.length);
  assert.ok(javaFacts?.implementations.length);
  assert.ok(javaFacts?.constructors.length);
  assert.ok(javaFacts?.members.length);
  assert.ok(javaFacts?.parameters.length);
  assert.ok(javaFacts?.returns.length);
  assert.ok(kotlinFacts?.aliases.length);
  assert.ok(kotlinFacts?.constructors.length);
  assert.ok(kotlinFacts?.implementations.some((item) => item.relationKind === "extension"));
  const kotlinEvidence = jvmCold.resolverState.evidence.find((evidence) => evidence.typeAnnotations.some((item) => item.sourceUnit.language === "kotlin"));
  assert.ok(kotlinEvidence?.diagnostics.some((item) => item.code === "extension_dispatch_unsupported"));
  assert.ok(kotlinEvidence?.diagnostics.some((item) => item.code === "overload_ambiguity"));
  assert.ok(kotlinEvidence?.diagnostics.some((item) => item.code === "compiler_dispatch_unknown"));
  assert.ok(kotlinEvidence?.typeAnnotations.some((item) => item.type.kind === "named" && item.type.name.endsWith("?")));
  assert.notEqual(jvmCold.decisions.length, 0);
  assert.deepEqual(jvmCold.decisions.map((decision) => decision.status), ["resolved", "unknown", "unknown", "ambiguous"]);
  const overloadDecision = jvmCold.decisions.at(-1);
  assert.equal(overloadDecision?.status, "ambiguous");
  if (overloadDecision?.status === "ambiguous") assert.ok(overloadDecision.candidates.length >= 2);
  assert.deepEqual(jvmWarm.decisions, jvmCold.decisions);
  assert.deepEqual(jvmWarm.normalizedFacts, jvmCold.normalizedFacts);
  assert.deepEqual(jvmWarm.resolverState.evidence, jvmCold.resolverState.evidence);
  assert.strictEqual(jvmWarm.resolverState, jvmCold.resolverState);
  assert.ok(jvmWarm.resolverState.memoHitCount > 0);
  assert.equal(jvmWarm.usedSourceSemanticFallback, false);
  assert.equal(jvmCold.floorPassed, true);
});
