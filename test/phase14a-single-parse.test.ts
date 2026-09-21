import assert from "node:assert/strict";
import test from "node:test";
import Parser from "tree-sitter";

import { buildCodeGraphWithResolutionFromFacts } from "../src/core/graph/build-graph.js";
import { extractExtendsFactEvidence } from "../src/core/graph/extends.js";
import { maskSourceSyntax } from "../src/core/graph/source-mask.js";
import { toLexicalDocumentsFromFacts } from "../src/core/lexical/lexical-index.service.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { codeChunksFromFacts, type IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";

function unit(relativePath: string, source: string): IndexedSourceUnit {
  const extracted = extractParsedFacts({
    source,
    language: "typescript",
    contentHash: `${relativePath}:${source}`,
    factsVersion: CURRENT_INDEX_VERSION_DOMAINS.factsVersion,
    factsSchemaVersion: CURRENT_INDEX_VERSION_DOMAINS.factsSchemaVersion,
  });
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") throw extracted.error;
  return { relativePath, source, facts: extracted.facts };
}

test("one materialized fact unit feeds graph and lexical consumers without another extraction", async () => {
  const source = "export function answer() { return 42; }\n";
  const indexed = unit("answer.ts", source);
  const graph = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const documents = toLexicalDocumentsFromFacts("repo", indexed);

  assert.ok(graph.graph.nodes.some((node) => node.qualifiedName === "answer"));
  assert.equal(documents.length, indexed.facts.symbols.length);
  assert.match(documents[0]?.content ?? "", /return 42/);
});

test("parser calls equal cold and modified fact misses, while unchanged units reuse facts", async () => {
  const originalParse = Parser.prototype.parse;
  let parserCalls = 0;
  Parser.prototype.parse = function (...args: Parameters<typeof originalParse>) {
    parserCalls += 1;
    return originalParse.apply(this, args);
  };

  try {
    const first = unit("first.ts", "export function first() { return 1; }\n");
    const second = unit("second.ts", "export function second() { return 2; }\n");
    assert.equal(parserCalls, 2);

    await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [first, second]);
    toLexicalDocumentsFromFacts("repo", first);
    assert.equal(parserCalls, 2);

    const unchanged = [first, second];
    assert.equal(unchanged.length, 2);
    assert.equal(parserCalls, 2);

    unit("second.ts", "export function second() { return 3; }\n");
    assert.equal(parserCalls, 3);
  } finally {
    Parser.prototype.parse = originalParse;
  }
});

test("facts graph does not parse again for member and extends resolution", async () => {
  const originalParse = Parser.prototype.parse;
  let parserCalls = 0;
  Parser.prototype.parse = function (...args: Parameters<typeof originalParse>) {
    parserCalls += 1;
    return originalParse.apply(this, args);
  };

  try {
    const source = `
      class Parent { work() {} }
      class Child extends Parent {
        constructor(private parent: Parent) {}
        run() { this.parent.work(); }
      }
    `;
    const indexed = unit("child.ts", source);
    assert.equal(parserCalls, 1);

    const result = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);

    assert.equal(parserCalls, 1);
    assert.equal(result.graph.edges.filter((edge) => edge.type === "extends").length, 1);
    assert.equal(result.graph.edges.filter((edge) => edge.type === "calls").length, 1);
  } finally {
    Parser.prototype.parse = originalParse;
  }
});

test("facts materialization preserves columns for same-line symbols", () => {
  const indexed = unit("same-line.ts", "export const first = 1; export const second = 2;\n");
  const chunks = codeChunksFromFacts(indexed);

  assert.deepEqual(chunks.map((chunk) => chunk.content), [
    "const first = 1;",
    "const second = 2;",
  ]);
});

test("facts source evidence ignores fake member and extends syntax in comments and strings", async () => {
  const source = `
    class Real { work() {} }
    class Actual extends Real {}
    class Holder { run() { fake.work(); } }
    const text = "class Fake extends Real; const fake = new Real();";
    /* class Commented extends Real; const fake = new Real(); */
  `;
  const indexed = unit("masked.ts", source);
  const result = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const resolution = result.resolutionByFile.get("masked.ts");

  assert.equal(result.graph.edges.filter((edge) => edge.type === "extends").length, 1);
  assert.equal(result.graph.edges.filter((edge) => edge.type === "calls").length, 0);
  assert.equal(resolution?.coverage.extends, 1);
  assert.equal(resolution?.coverage.unresolvedCalls, 1);
  assert.equal(extractExtendsFactEvidence(source)[0]?.line, 3);
});

test("facts extends evidence ignores regex literal contents", async () => {
  const source = `
    class Real {}
    class Actual extends Real {}
    const pattern = /class Fake extends Real/;
  `;
  const indexed = unit("regex.ts", source);
  const result = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const resolution = result.resolutionByFile.get("regex.ts");

  assert.equal(result.graph.edges.filter((edge) => edge.type === "extends").length, 1);
  assert.equal(resolution?.coverage.extends, 1);
});

test("facts evidence masks regex literals after control-flow parentheses", async () => {
  const source = [
    "class Real {}",
    "class Actual extends Real {}",
    "function check(ok: boolean, value: string) {",
    "  if (ok) /class Fake extends Real; fake.work()/.test(value);",
    "}",
  ].join("\n");
  const indexed = unit("control-regex.ts", source);
  const result = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const resolution = result.resolutionByFile.get("control-regex.ts");
  const masked = maskSourceSyntax(source);

  assert.equal(result.graph.edges.filter((edge) => edge.type === "extends").length, 1);
  assert.equal(result.graph.edges.filter((edge) => edge.type === "calls").length, 0);
  assert.equal(resolution?.coverage.extends, 1);
  assert.equal(resolution?.coverage.unresolvedCalls, 1);
  assert.doesNotMatch(masked, /Fake extends Real/);
  assert.doesNotMatch(masked, /fake\.work/);
});

test("facts evidence masks regex character classes containing fake syntax", async () => {
  const source = [
    "class Real {}",
    "class Actual extends Real {}",
    "if (ok) /[\\/class Fake extends Real]/.test(value);",
  ].join("\n");
  const indexed = unit("regex-class.ts", source);
  const result = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const resolution = result.resolutionByFile.get("regex-class.ts");
  const masked = maskSourceSyntax(source);

  assert.equal(result.graph.edges.filter((edge) => edge.type === "extends").length, 1);
  assert.equal(resolution?.coverage.extends, 1);
  assert.doesNotMatch(masked, /Fake extends Real/);
});

test("facts member evidence preserves executable template interpolation", async () => {
  const source = [
    "class Real { work() {} }",
    "class Holder { run(instance: Real) { return `${instance.work()}`; } }",
  ].join("\n");
  const indexed = unit("template.ts", source);
  const result = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const callEdges = result.graph.edges.filter((edge) => edge.type === "calls");
  const resolution = result.resolutionByFile.get("template.ts");
  const masked = maskSourceSyntax("const value = `label ${instance.work()}`;");

  assert.match(masked, /instance\.work\(\)/);
  assert.equal(callEdges.length, 1);
  assert.equal(resolution?.coverage.resolvedCalls, 1);
});

test("facts evidence handles nested template interpolation and masks nested regex literals", async () => {
  const source = [
    "class Real { work() {} }",
    "class Actual extends Real {}",
    "class Holder {",
    "  run(instance: Real) {",
    "    return `${`inner ${/class Fake extends Real/.source} ${instance.work()}`}`;",
    "  }",
    "}",
  ].join("\n");
  const indexed = unit("nested-template.ts", source);
  const result = await buildCodeGraphWithResolutionFromFacts("/tmp/repo", [indexed]);
  const callEdges = result.graph.edges.filter((edge) => edge.type === "calls");
  const resolution = result.resolutionByFile.get("nested-template.ts");
  const masked = maskSourceSyntax("const value = `${`inner ${/class Fake extends Real/.source} ${instance.work()}`}`;");

  assert.match(masked, /instance\.work\(\)/);
  assert.doesNotMatch(masked, /class Fake extends Real/);
  assert.equal(result.graph.edges.filter((edge) => edge.type === "extends").length, 1);
  assert.equal(callEdges.length, 1);
  assert.equal(resolution?.coverage.extends, 1);
  assert.equal(resolution?.coverage.resolvedCalls, 1);
});
