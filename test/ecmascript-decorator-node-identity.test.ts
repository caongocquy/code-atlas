import assert from "node:assert/strict";
import test from "node:test";
import type Parser from "tree-sitter";
import { parseSource } from "../src/core/graph/parsers/code-parser.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION } from "../src/core/repository/index-version.js";

test("decorator owners survive rematerialized native node wrappers", () => {
  const source = '@Resolver() class R { @Subscription("changed") @Trace() updates() {} @Subscription() other() {} }';
  const parsed = parseSource(source, "src/resolver.ts", "typescript");
  assert.ok(parsed);
  let prototype: object | null = Object.getPrototypeOf(parsed.tree.rootNode);
  while (prototype && !Object.getOwnPropertyDescriptor(prototype, "namedChildren")) {
    prototype = Object.getPrototypeOf(prototype);
  }
  assert.ok(prototype);
  const descriptor = Object.getOwnPropertyDescriptor(prototype, "namedChildren");
  assert.ok(descriptor?.get);
  const getter = descriptor.get;
  let rematerialized = 0;
  Object.defineProperty(prototype, "namedChildren", {
    ...descriptor,
    get(this: Parser.SyntaxNode): Parser.SyntaxNode[] {
      const children = Reflect.apply(getter, this, []) as Parser.SyntaxNode[];
      if (this.type !== "class_body") return children;
      // Native wrapper identity is not the identity of the underlying AST node.
      return children.map((child) => {
        const copy = Object.create(Object.getPrototypeOf(child), Object.getOwnPropertyDescriptors(child)) as Parser.SyntaxNode;
        assert.notEqual(copy, child);
        assert.equal(copy.id, child.id);
        rematerialized++;
        return copy;
      });
    },
  });
  try {
    const result = extractParsedFacts({ source, filePath: "src/resolver.ts", language: "typescript",
      contentHash: "decorator-node-identity", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
    assert.equal(result.kind, "facts");
    const annotations = result.facts.frameworkSyntax?.nodes.filter((node) => node.kind === "annotation");
    assert.ok(annotations);
    assert.deepEqual(annotations.map((node) => [node.name,
      result.facts.symbols.find((symbol) => symbol.localId === node.ownerSymbolId)?.name]),
    [["Resolver", "R"], ["Subscription", "updates"], ["Trace", "updates"], ["Subscription", "other"]]);
    assert.ok(rematerialized > 0);
  } finally {
    Object.defineProperty(prototype, "namedChildren", descriptor);
  }
});
