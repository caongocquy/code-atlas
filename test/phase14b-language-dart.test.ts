import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractDartFacts, dartFactExtractor } from "../src/core/facts/extractors/dart.js";
import { DART_CAPABILITIES, dartSemanticAdapter, normalizeDartFacts } from "../src/core/graph/resolver/adapters/dart.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const filePath = "phase14b/dart/main.dart";
const source = `import "package:flutter/material.dart";
import "dart:math" as math;

mixin LoggableOne { void ping() {} }
mixin LoggableTwo { void ping() {} }
abstract class Base { Base(); void baseMethod() {} }
class Runnable { void run() {} }
class Worker extends Base with LoggableOne, LoggableTwo implements Runnable {
  final String value;
  Worker(this.value);
  void run() { ping(); }
}
extension WorkerTools on Worker { void reset() { value; } }
void main() {
  final worker = Worker("x");
  worker.run();
  worker.ping();
  worker.value = "y";
  dynamic dynamicWorker;
  dynamicWorker.run();
}`;
const expected = JSON.parse(readFileSync(new URL("./fixtures/phase14b/dart/expected.json", import.meta.url), "utf8")) as {
  language: string; grammar: string; imports: string[]; ownership: string[]; uncertain: string[];
};
const input = factExtractorInput({ filePath, source, language: "dart" });

test("Dart extracts parser identity, ownership, imports, constructors, receivers, and assignments", () => {
  const outcome = extractDartFacts(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.equal(outcome.facts.language, expected.language);
  assert.equal(`${outcome.facts.parserIdentity.packageName}@${outcome.facts.parserIdentity.grammarVersion}`, expected.grammar);
  assert.equal(outcome.facts.parseStatus, "complete");
  assert.deepEqual(outcome.facts.imports.map((item) => item.moduleSpecifier), expected.imports);
  for (const name of expected.ownership) assert.ok(outcome.facts.symbols.some((item) => item.name === name), name);
  assert.ok(outcome.facts.constructors.some((item) => item.constructedTypeName === "Worker"));
  assert.ok(outcome.facts.inheritances.some((item) => item.targetName === "Base"));
  assert.ok(outcome.facts.implementations.some((item) => item.relationKind === "mixin" && item.targetName === "LoggableOne"));
  assert.ok(outcome.facts.implementations.some((item) => item.relationKind === "extension" && item.targetName === "Worker"));
  const extension = outcome.facts.symbols.find((item) => item.name === "WorkerTools");
  const extensionRelation = outcome.facts.implementations.find((item) => item.relationKind === "extension");
  const reset = outcome.facts.members.find((item) => item.memberName === "reset");
  assert.ok(extension);
  assert.ok(extensionRelation);
  assert.ok(reset);
  assert.equal(extensionRelation.subjectId, extension.localId);
  assert.equal(reset.ownerSymbolId, extension.localId);
  assert.equal(reset.access, "extension");
  assert.ok(outcome.facts.members.some((item) => item.memberName === "run" && item.receiverId));
  const reassignment = outcome.facts.assignments.find((item) => item.assignmentKind === "reassignment");
  assert.ok(reassignment);
  assert.ok(outcome.facts.members.some((item) => item.localId === reassignment.targetId && item.memberName === "value"));
  assert.equal(outcome.facts.bindingSeeds.some((item) => item.localId === reassignment.targetId), false);
});

test("Dart preserves mixin selection ambiguity and excludes dynamic/framework semantics", async () => {
  const outcome = dartFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const receiverSites = outcome.facts.members.filter((item) => item.receiverId).map((item) => ({
    sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "dart" as const }, localId: item.localId,
  }));
  const binding = outcome.facts.bindingSeeds.find((item) => item.name === "worker");
  assert.ok(binding);
  const receiverResult = await runFixtureThroughResolver({ name: "dart-receivers", cases: [{ filePath, source, language: "dart" }], sites: [...receiverSites, { sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "dart" as const }, localId: binding.localId }] }, [outcome.facts], dartSemanticAdapter);
  const evidence = normalizeDartFacts(outcome.facts, { generationId: "dart-test", repositoryIdentity: { id: "phase14b-fixtures", identityKey: "phase14b-fixtures", rootPath: "/phase14b-fixtures", displayName: "phase14b-fixtures" }, sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "dart" }, resolutionVersion: "14b-2" });
  assert.ok(evidence.diagnostics.some((item) => item.code === "flutter_semantics_excluded"));
  const dynamicMember = outcome.facts.members.find((item) => item.memberName === "run" && outcome.facts.expressions.some((expression) => expression.localId === item.receiverId && expression.text === "dynamicWorker"));
  assert.ok(dynamicMember);
  assert.equal(evidence.members.some((item) => item.evidenceId.endsWith(`member:${dynamicMember.localId}`)), false);
  assert.ok(expected.uncertain.includes("mixin-selection"));
  assert.ok(expected.uncertain.includes("dynamic-member"));
  assert.ok(expected.uncertain.includes("framework-semantics"));
  const pingMember = outcome.facts.members.find((item) => item.memberName === "ping" && outcome.facts.expressions.some((expression) => expression.localId === item.receiverId && expression.text === "worker"));
  assert.ok(pingMember);
  const pingDecision = receiverResult.decisions.find((decision) => decision.site.localId === pingMember.localId);
  assert.equal(pingDecision?.status, "ambiguous");
  assert.notEqual(pingDecision?.status, "resolved");
  assert.equal(pingDecision && "target" in pingDecision, false);
  assert.equal(evidence.members.some((item) => item.evidenceId.endsWith(`member:${pingMember.localId}`)), false);
  const pingAmbiguity = evidence.diagnostics.find((item) => item.code === "mixin_selection_ambiguity" && item.siteLocalId === pingMember.localId);
  assert.equal(pingAmbiguity?.candidates?.length, 2);
  const runMember = outcome.facts.members.find((item) => item.memberName === "run" && outcome.facts.expressions.some((expression) => expression.localId === item.receiverId && expression.text === "worker"));
  assert.ok(runMember);
  const runDecision = receiverResult.decisions.find((decision) => decision.site.localId === runMember.localId);
  assert.equal(runDecision?.status, "resolved");
  assert.equal(runDecision && "candidates" in runDecision, false);
  if (runDecision?.status === "resolved") assert.equal(runDecision.target.qualifiedName, "Worker.run");
  assert.equal(receiverResult.decisions.filter((decision) => decision.site.localId === runMember.localId).length, 1);
  const reassignment = outcome.facts.assignments.find((item) => item.assignmentKind === "reassignment");
  assert.ok(reassignment);
  assert.equal(evidence.assignments.some((item) => item.evidenceId.endsWith(`assignment:${reassignment.localId}`)), false);
  assert.ok(evidence.diagnostics.some((item) => item.code === "assignment_target_member_unsupported"));
  for (const assignment of evidence.assignments) assert.ok(outcome.facts.bindingSeeds.some((bindingSeed) => bindingSeed.localId === assignment.targetBindingId));
  const dynamicDecision = receiverResult.decisions.find((decision) => decision.site.localId === dynamicMember.localId);
  assert.ok(dynamicDecision);
  assert.notEqual(dynamicDecision.status, "resolved");
  assert.equal(receiverResult.usedSourceSemanticFallback, false);
});

test("Dart is deterministic, reuses warm memo state, and reports budget exhaustion", async () => {
  const first = dartFactExtractor.extract(input);
  const second = dartFactExtractor.extract(input);
  assert.deepEqual(first, second);
  const outcome = first;
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const binding = outcome.facts.bindingSeeds.find((item) => item.name === "worker");
  assert.ok(binding);
  const sites = [...outcome.facts.members.filter((item) => item.receiverId).map((item) => ({ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "dart" as const }, localId: item.localId })), { sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "dart" as const }, localId: binding.localId }];
  const fixture = { name: "dart-controls", cases: [{ filePath, source, language: "dart" as const }], sites };
  const cold = await runFixtureThroughResolver(fixture, [outcome.facts], dartSemanticAdapter);
  const coldMemoHits = cold.resolverState.memoHitCount;
  const warm = await runFixtureThroughResolver(fixture, [outcome.facts], dartSemanticAdapter, "warm", true, cold.resolverState);
  const budgetPath = "phase14b/dart/budget.dart";
  const budgetSource = "class BudgetWorker { BudgetWorker(); void run() {} }\nvoid main() { final worker = BudgetWorker(); worker.run(); }";
  const budgetOutcome = dartFactExtractor.extract(factExtractorInput({ filePath: budgetPath, source: budgetSource, language: "dart" }));
  assert.equal(budgetOutcome.kind, "facts");
  if (budgetOutcome.kind !== "facts") return;
  const budgetSite = budgetOutcome.facts.members.find((item) => item.memberName === "run" && item.receiverId);
  assert.ok(budgetSite);
  const exhausted = await runFixtureThroughResolver({ name: "dart-budget", cases: [{ filePath: budgetPath, source: budgetSource, language: "dart" as const }], sites: [{ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: budgetPath, language: "dart" as const }, localId: budgetSite.localId }] }, [budgetOutcome.facts], dartSemanticAdapter, "cold", false, undefined, { candidateExpansions: 0, memberCandidates: 0 });
  assert.deepEqual(warm.decisions, cold.decisions);
  assert.deepEqual(warm.decisions.map((decision) => decision.status), cold.decisions.map((decision) => decision.status));
  assert.equal(warm.floorPassed, cold.floorPassed);
  assert.equal(warm.resolverState, cold.resolverState);
  assert.equal(cold.floorPassed, false);
  assert.ok(warm.resolverState.memoHitCount > coldMemoHits);
  assert.equal(exhausted.decisions.some((decision) => decision.status === "budget_exhausted"), true, JSON.stringify(exhausted.decisions));
});

test("Dart adapter exposes its floor and rejects other languages", () => {
  assert.deepEqual(dartSemanticAdapter.capabilities("dart"), DART_CAPABILITIES);
  assert.equal(dartFactExtractor.extract({ ...input, language: "go" }).kind, "infrastructure_failure");
});
