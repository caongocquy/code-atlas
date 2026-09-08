import assert from "node:assert/strict";
import test from "node:test";

import { extractJavaFacts, javaFactExtractor } from "../src/core/facts/extractors/java.js";
import { extractKotlinFacts, kotlinFactExtractor } from "../src/core/facts/extractors/kotlin.js";
import { jvmSemanticAdapter } from "../src/core/graph/resolver/adapters/jvm.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

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
