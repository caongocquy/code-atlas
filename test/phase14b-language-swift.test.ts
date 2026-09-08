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
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "class" && item.name === "Point"));
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "enum" && item.name === "State"));
  assert.ok(outcome.facts.symbols.some((item) => item.kind === "interface" && item.name === "Renderable"));
  assert.ok(outcome.facts.members.some((item) => item.memberName === "reset" && item.access === "extension"));
  assert.ok(outcome.facts.constructors.some((item) => item.constructedTypeName === "Widget"));
  assert.ok(outcome.facts.symbols.some((item) => item.name === "render" && item.kind === "method"));
  assert.ok(outcome.facts.implementations.some((item) => item.relationKind === "extension" && item.targetName === expected.extensionOwnership));
  assert.ok(outcome.facts.implementations.some((item) => item.relationKind === "protocol_conformance" && item.targetName === "CustomStringConvertible"));
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
  assert.equal(result.usedSourceSemanticFallback, false);
});

test("Swift adapter exposes its capability floor and rejects non-Swift input", () => {
  assert.deepEqual(swiftSemanticAdapter.capabilities("swift"), SWIFT_CAPABILITIES);
  const outcome = swiftFactExtractor.extract({ ...input, language: "go" });
  assert.equal(outcome.kind, "infrastructure_failure");
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
