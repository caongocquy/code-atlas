import assert from "node:assert/strict";
import test from "node:test";

import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { normalizeScipIndex } from "../src/core/indexing/scip-normalizer.js";
import { encodeScipDocument, encodeScipIndex, type ScipFixtureOccurrence } from "./helpers/phase16b-scip-fixture.js";

const targetSymbol = "scip-typescript npm fixture 1.0.0 src/dep.ts/target().";

function unit(relativePath: string, language: "typescript" | "tsx" | "javascript", source: string) {
  const extracted = extractParsedFacts({
    source,
    language,
    filePath: relativePath,
    repositoryId: "repo-id",
    contentHash: "fixture-hash",
  });
  assert.equal(extracted.kind, "facts");
  return { relativePath, source, facts: extracted.facts };
}

function occurrenceFor(source: string, line: number, token: string, symbol: string, roles: number): ScipFixtureOccurrence {
  const text = source.split("\n")[line];
  assert.ok(text);
  const start = text.indexOf(token);
  assert.notEqual(start, -1);
  return { range: [line, start, start + token.length], symbol, roles };
}

test("SCIP binds TS/TSX/JS occurrences to internal parser symbols using UTF-16 ranges", () => {
  for (const [relativePath, language, extension] of [
    ["consumer.ts", "typescript", "ts"],
    ["consumer.tsx", "tsx", "tsx"],
    ["consumer.js", "javascript", "js"],
  ] as const) {
    const declaration = unit(`dep.${extension}`, language, "export function target() { return true; }\n");
    const source = 'import { target as local } from "./dep.js";\nexport function consumer() { return "🚀", local(); }\n';
    const consumer = unit(relativePath, language, source);
    const definition = occurrenceFor(declaration.source, 0, "target", targetSymbol, 1);
    const reference = occurrenceFor(source, 1, "local", targetSymbol, 8);
    const index = encodeScipIndex([
      encodeScipDocument(declaration.relativePath, [definition]),
      encodeScipDocument(relativePath, [reference]),
    ]);
    const factsBefore = structuredClone([declaration.facts, consumer.facts]);

    const evidence = normalizeScipIndex(index, {
      repositoryId: "repo-id",
      units: [declaration, consumer],
    });

    const call = consumer.facts.callSites.find((item) => item.calleeText === "local");
    assert.ok(call);
    const binding = evidence.find((item) => item.sourceUnit.relativePath === relativePath && item.siteLocalId === call.localId);
    assert.ok(binding, `${language} call should bind to SCIP target`);
    assert.equal(binding.target.relativePath, declaration.relativePath);
    assert.equal(binding.target.discriminator, declaration.facts.symbols.find((item) => item.name === "target")?.localId);
    assert.equal(binding.range.startLine, 2);
    assert.match(binding.evidenceId, /^scip:/);
    assert.deepEqual([declaration.facts, consumer.facts], factsBefore);
  }
});

test("SCIP UTF-8 and UTF-32 offsets normalize to parser columns", () => {
  const declaration = unit("dep.ts", "typescript", "export function target() { return true; }\n");
  const source = 'export function consumer() { return "🚀", local(); }\n';
  const consumer = unit("consumer.ts", "typescript", source);
  const line = source.split("\n")[0]!;
  const start = line.indexOf("local");
  const target = occurrenceFor(declaration.source, 0, "target", targetSymbol, 1);

  for (const [encoding, startOffset, tokenLength] of [
    [1, Buffer.byteLength(line.slice(0, start)), Buffer.byteLength("local")],
    [3, [...line.slice(0, start)].length, [..."local"].length],
  ] as const) {
    const reference = { range: [0, startOffset, startOffset + tokenLength], symbol: targetSymbol, roles: 8 };
    const evidence = normalizeScipIndex(encodeScipIndex([
      encodeScipDocument("./dep.ts", [target]),
      encodeScipDocument("consumer.ts", [reference], encoding),
    ]), { repositoryId: "repo-id", units: [declaration, consumer] });
    const parsedReference = consumer.facts.references.find((item) => item.name === "local");
    assert.ok(parsedReference);
    assert.deepEqual(evidence[0]?.range, parsedReference.range);
  }

  const unknownEncoding = normalizeScipIndex(encodeScipIndex([
    encodeScipDocument("dep.ts", [target]),
    encodeScipDocument("consumer.ts", [{ range: [0, start, start + "local".length], symbol: targetSymbol, roles: 8 }], 4),
  ]), { repositoryId: "repo-id", units: [declaration, consumer] });
  assert.deepEqual(unknownEncoding, []);
});

test("SCIP typed ranges bind across import aliases and re-export files", () => {
  const declaration = unit("dep.ts", "typescript", "export function target() { return true; }\n");
  const barrel = unit("barrel.ts", "typescript", 'export { target as renamed } from "./dep.js";\n');
  const callerSource = 'import { renamed } from "./barrel.js";\nrenamed();\n';
  const caller = unit("caller.ts", "typescript", callerSource);
  const definitionStart = declaration.source.indexOf("target");
  const aliasStart = barrel.source.indexOf("target");
  const referenceLine = callerSource.split("\n")[1]!;
  const referenceStart = referenceLine.indexOf("renamed");
  const index = encodeScipIndex([
    encodeScipDocument("dep.ts", [{
      singleLineRange: { line: 0, startCharacter: definitionStart, endCharacter: definitionStart + 6 },
      symbol: targetSymbol,
      roles: 1,
    }]),
    encodeScipDocument("barrel.ts", [{
      range: [0, 0, 1],
      singleLineRange: { line: 0, startCharacter: aliasStart, endCharacter: aliasStart + 6 },
      symbol: targetSymbol,
      roles: 8,
    }]),
    encodeScipDocument("caller.ts", [{
      multiLineRange: { startLine: 1, startCharacter: referenceStart, endLine: 1, endCharacter: referenceStart + 7 },
      symbol: targetSymbol,
      roles: 8,
    }]),
  ]);

  const evidence = normalizeScipIndex(index, { repositoryId: "repo-id", units: [declaration, barrel, caller] });
  const call = caller.facts.callSites.find((item) => item.calleeText === "renamed");
  assert.ok(call);
  const binding = evidence.find((item) => item.sourceUnit.relativePath === "caller.ts" && item.siteLocalId === call.localId);
  assert.equal(binding?.target.relativePath, "dep.ts");
});

test("SCIP drops external targets and occurrences without a unique parser site", () => {
  const source = "export function consumer() { return external(); }\n";
  const consumer = unit("consumer.ts", "typescript", source);
  const external = occurrenceFor(source, 0, "external", "scip-typescript npm external 1.0.0 pkg/external().", 8);
  const evidence = normalizeScipIndex(encodeScipIndex([
    encodeScipDocument("consumer.ts", [external]),
    encodeScipDocument("../outside.ts", [occurrenceFor(source, 0, "consumer", targetSymbol, 1)]),
  ]), { repositoryId: "repo-id", units: [consumer] });

  assert.deepEqual(evidence, []);
});

test("nested same-name calls associate each SCIP target only with its exact callee site", () => {
  const first = unit("first.ts", "typescript", "export function foo() { return 1; }\n");
  const second = unit("second.ts", "typescript", "export function foo() { return 2; }\n");
  const source = "export function caller() { return foo(foo()); }\n";
  const caller = unit("caller.ts", "typescript", source);
  const outer = occurrenceFor(source, 0, "foo", "scip-typescript npm first 1.0.0 src/first.ts/foo().", 8);
  const inner = { ...outer, range: [0, source.lastIndexOf("foo"), source.lastIndexOf("foo") + 3], symbol: "scip-typescript npm second 1.0.0 src/second.ts/foo()." };
  const index = encodeScipIndex([
    encodeScipDocument("first.ts", [occurrenceFor(first.source, 0, "foo", outer.symbol, 1)]),
    encodeScipDocument("second.ts", [occurrenceFor(second.source, 0, "foo", inner.symbol, 1)]),
    encodeScipDocument("caller.ts", [outer, inner]),
  ]);
  const evidence = normalizeScipIndex(index, { repositoryId: "repo-id", units: [first, second, caller] });
  const calls = caller.facts.callSites.filter((item) => item.calleeText === "foo").sort((left, right) => left.range.startColumn! - right.range.startColumn!);

  assert.equal(calls.length, 2);
  assert.deepEqual(evidence.filter((item) => item.siteLocalId === calls[0]?.localId).map((item) => item.target.relativePath), ["first.ts"]);
  assert.deepEqual(evidence.filter((item) => item.siteLocalId === calls[1]?.localId).map((item) => item.target.relativePath), ["second.ts"]);
});

test("receiver references do not become the target binding for a member call", () => {
  const receiver = unit("receiver.ts", "typescript", "export function obj() { return {}; }\n");
  const method = unit("method.ts", "typescript", "export function foo() { return true; }\n");
  const source = "export function caller() { return obj.foo(); }\n";
  const caller = unit("caller.ts", "typescript", source);
  const receiverSymbol = "scip-typescript npm fixture 1.0.0 src/receiver.ts/obj().";
  const methodSymbol = "scip-typescript npm fixture 1.0.0 src/method.ts/foo().";
  const index = encodeScipIndex([
    encodeScipDocument("receiver.ts", [occurrenceFor(receiver.source, 0, "obj", receiverSymbol, 1)]),
    encodeScipDocument("method.ts", [occurrenceFor(method.source, 0, "foo", methodSymbol, 1)]),
    encodeScipDocument("caller.ts", [
      occurrenceFor(source, 0, "obj", receiverSymbol, 8),
      occurrenceFor(source, 0, "foo", methodSymbol, 8),
    ]),
  ]);
  const evidence = normalizeScipIndex(index, { repositoryId: "repo-id", units: [receiver, method, caller] });
  const call = caller.facts.callSites.find((item) => item.calleeText === "obj.foo");
  assert.ok(call);
  assert.equal(evidence.some((item) => item.siteLocalId === call.localId && item.target.relativePath === "receiver.ts"), false);
  assert.equal(evidence.some((item) => item.siteLocalId === call.localId && item.target.relativePath === "method.ts"), true);
});
