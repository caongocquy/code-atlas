import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

import { extractSwiftFacts, swiftFactExtractor } from "../src/core/facts/extractors/swift.js";
import { SWIFT_CAPABILITIES, swiftSemanticAdapter } from "../src/core/graph/resolver/adapters/swift.js";
import { factExtractorInput, runFixtureThroughResolver } from "./helpers/phase14b-language-fixtures.js";

const source = `import Foundation
import struct CoreGraphics.CGPoint

protocol Renderable {
  func render() -> String
}

class Widget: Renderable {
  let title: String

  init(title: String) {
    self.title = title
  }

  func render() -> String { return title }
}

struct Point {
  let x: Int
  init(x: Int) { self.x = x }
}

enum State { case ready, done }

extension Widget {
  func reset() { _ = title }
}

extension Widget: CustomStringConvertible {
  var description: String { return title }
}

final class Use {
  func run() {
    let widget = Widget(title: "ok")
    widget.reset()
    widget.render()
  }
}

func overloaded(_ value: Int) {}
func overloaded(_ value: String) {}
`;
const filePath = "phase14b/swift/main.swift";
const input = factExtractorInput({ filePath, source, language: "swift" });
const expected = JSON.parse(readFileSync(new URL("./fixtures/phase14b/swift/expected.json", import.meta.url), "utf8")) as {
  language: string;
  grammar: string;
  extensionOwnership: string;
  uncertain: string[];
};

test("Swift extracts imports, declarations, initializers, methods, and explicit extension ownership", () => {
  const outcome = extractSwiftFacts(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  assert.equal(outcome.facts.language, expected.language);
  assert.equal(`${outcome.facts.parserIdentity.packageName}@${outcome.facts.parserIdentity.grammarVersion}`, expected.grammar);
  assert.deepEqual(outcome.facts.imports.map((item) => item.moduleSpecifier), ["Foundation", "CoreGraphics.CGPoint"]);
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "class" && item.name === "Widget"));
  assert.ok(outcome.facts.symbols.some((item) => item.name === "Point"));
  assert.ok(outcome.facts.containmentScopes.some((item) => item.name === "Point" && item.kind === "struct_declaration"));
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "enum" && item.name === "State"));
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "interface" && item.name === "Renderable"));
  assert.ok(outcome.facts.members.some((item) => item.memberName === "reset" && item.access === "extension"));
  assert.ok(outcome.facts.constructors.some((item) => item.constructedTypeName === "Widget"));
  assert.ok(outcome.facts.symbols.some((item) => item.name === "render" && item.kind === "method"));
  assert.ok(outcome.facts.implementations.some((item) => item.relationKind === "extension" && item.targetName === expected.extensionOwnership));
  assert.ok(outcome.facts.implementations.some((item) => item.relationKind === "protocol_conformance" && item.targetName === "CustomStringConvertible"));
});

test("Swift drops extension ownership when the static owner name is not unique", () => {
  const ambiguous = swiftFactExtractor.extract(factExtractorInput({
    filePath: "phase14b/swift/ambiguous.swift",
    language: "swift",
    source: "class Duplicate {}\nclass Duplicate {}\nextension Duplicate { func onlyHere() {} }\n",
  }));
  assert.equal(ambiguous.kind, "facts");
  if (ambiguous.kind !== "facts") return;
  assert.equal(ambiguous.facts.implementations.filter((item) => item.relationKind === "extension").length, 0);
  assert.equal(ambiguous.facts.members.filter((item) => item.memberName === "onlyHere" && item.ownerSymbolId).length, 0);
});

test("Swift keeps protocol witness and overload dispatch explicitly uncertain", async () => {
  const outcome = swiftFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const protocolCall = outcome.facts.callSites.find((item) => item.calleeText === "widget.render");
  const memberCall = outcome.facts.members.find((item) => item.memberName === "render" && item.receiverId);
  assert.ok(protocolCall);
  assert.ok(memberCall);
  const result = await runFixtureThroughResolver({
    name: "swift-uncertainty",
    cases: [{ filePath, source, language: "swift" }],
    sites: [protocolCall, memberCall].map((item) => ({ sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "swift" as const }, localId: item.localId })),
  }, [outcome.facts], swiftSemanticAdapter);
  const decisions = new Map(result.decisions.map((item) => [item.site.localId, item]));
  assert.ok(["ambiguous", "unknown", "unsupported"].includes(decisions.get(protocolCall.localId)?.status ?? ""));
  assert.ok(["ambiguous", "unknown", "unsupported"].includes(decisions.get(memberCall.localId)?.status ?? ""));
  assert.ok(result.resolverState.evidence[0]?.diagnostics.some((item) => expected.uncertain.some((code) => item.code.includes(code.replace("-", "_")))));
  assert.ok(result.resolverState.evidence[0]?.diagnostics.some((item) => item.code === "overload_ambiguity"));
  assert.ok(result.resolverState.evidence[0]?.diagnostics.some((item) => item.code === "protocol_witness_ambiguity"));
  assert.equal(result.resolverState.evidence[0]?.members.some((item) => item.evidenceId.endsWith(`member:${memberCall.localId}`)), false);
  assert.equal(result.usedSourceSemanticFallback, false);
});

test("Swift adapter exposes its capability floor and rejects non-Swift input", () => {
  assert.deepEqual(swiftSemanticAdapter.capabilities("swift"), SWIFT_CAPABILITIES);
  for (const capability of ["moduleImport", "directCall", "declaredType", "constructorType", "parameterFlow"] as const) {
    assert.notEqual(SWIFT_CAPABILITIES[capability], "full", capability);
  }
  const outcome = swiftFactExtractor.extract({ ...input, language: "go" });
  assert.equal(outcome.kind, "infrastructure_failure");
});

test("Swift floor exercises warm memo reuse and budget exhaustion", async () => {
  const outcome = swiftFactExtractor.extract(input);
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const fixture = {
    name: "swift-controls",
    cases: [{ filePath, source, language: "swift" as const }],
    sites: outcome.facts.members.filter((item) => item.receiverId).map((item) => ({
      sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: filePath, language: "swift" as const },
      localId: item.localId,
    })),
  };
  const cold = await runFixtureThroughResolver(fixture, [outcome.facts], swiftSemanticAdapter);
  const warm = await runFixtureThroughResolver(fixture, [outcome.facts], swiftSemanticAdapter, "warm", true, cold.resolverState);
  const budgeted = await runFixtureThroughResolver(fixture, [outcome.facts], swiftSemanticAdapter, "cold", false, undefined, { candidateExpansions: 0 });
  assert.deepEqual(warm.decisions, cold.decisions);
  assert.strictEqual(warm.resolverState, cold.resolverState);
  assert.ok(warm.resolverState.memoHitCount > 0);
  assert.ok(budgeted.decisions.some((decision) => decision.status === "budget_exhausted"));
  assert.equal(cold.usedSourceSemanticFallback, false);
});

test("Swift extraction is deterministic and malformed ASTs stay unsupported", () => {
  const first = swiftFactExtractor.extract(input);
  const second = swiftFactExtractor.extract(input);
  assert.deepEqual(first, second);
  const malformed = swiftFactExtractor.extract(factExtractorInput({ filePath: "bad.swift", source: "class Broken {", language: "swift" }));
  assert.equal(malformed.kind, "facts");
  if (malformed.kind !== "facts") return;
  assert.equal(malformed.facts.parseStatus, "deterministic_partial");
  const evidence = swiftSemanticAdapter.normalizeFile(malformed.facts, {
    generationId: "swift-uncertain",
    repositoryIdentity: { id: "repo", identityKey: "repo", rootPath: "/repo", displayName: "repo" },
    sourceUnit: { repositoryId: "repo", relativePath: "bad.swift", language: "swift" },
    resolutionVersion: "14b-2",
  });
  assert.ok(evidence.diagnostics.some((item) => item.code === "parse_uncertain"));
  assert.ok(evidence.diagnostics.some((item) => item.code === "language_capability_unsupported"));
});
