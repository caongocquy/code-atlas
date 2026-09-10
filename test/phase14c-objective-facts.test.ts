import assert from "node:assert/strict";
import test from "node:test";
import Parser from "tree-sitter";

import { decodeFacts, encodeFacts } from "../src/core/facts/facts-codec.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { factBlobKey } from "../src/core/facts/facts-identity.js";
import type { ObjectiveSyntax } from "../src/core/facts/objective-syntax.types.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION } from "../src/core/repository/index-version.js";

function extractSyntax(input: {
  language: "typescript" | "tsx" | "java" | "kotlin" | "dart";
  filePath: string;
  source: string;
}): ObjectiveSyntax {
  const result = extractParsedFacts({
    ...input,
    contentHash: input.language + "-syntax",
    factsVersion: FACTS_VERSION,
    factsSchemaVersion: FACTS_SCHEMA_VERSION,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") throw result.error;
  assert.ok(result.facts.frameworkSyntax);
  return result.facts.frameworkSyntax;
}

const fixtures = [
  {
    language: "tsx" as const,
    filePath: "src/users.tsx",
    source: '"use client";\nconst app = new App();\n@Controller("users")\nclass Users { @Get({ path: "/:id", roles: ["admin"] }) handler(@Param("id") id: string) { return <Layout.Header title={id} />; } }\n',
    expected: ["directive", "annotation", "jsx", "object", "array", "property", "construct"] as const,
  },
  {
    language: "java" as const,
    filePath: "src/Users.java",
    source: '@Controller("users") class Users { @Bean String routes() { return "routes"; } }\n',
    expected: ["annotation", "literal", "return"] as const,
  },
  {
    language: "kotlin" as const,
    filePath: "src/Users.kt",
    source: '@Controller("users") class Users { @Bean fun routes(): String = "routes" }\n',
    expected: ["annotation", "literal"] as const,
  },
  {
    language: "dart" as const,
    filePath: "lib/screen.dart",
    source: 'class Screen { Widget build(BuildContext context) { return MaterialApp(routes: {"/": (context) => Home()}, home: Provider<Foo>(create: (context) => Foo())); } }\n',
    expected: ["call", "object", "lambda"] as const,
  },
];

test("all framework languages materialize linked objective syntax from their parsed tree", () => {
  for (const fixture of fixtures) {
    const result = extractParsedFacts({
      ...fixture,
      contentHash: `${fixture.language}-objective`,
      factsVersion: FACTS_VERSION,
      factsSchemaVersion: FACTS_SCHEMA_VERSION,
    });

    assert.equal(result.kind, "facts", fixture.language);
    if (result.kind !== "facts") continue;

    const syntax = result.facts.frameworkSyntax;
    assert.ok(syntax, `${fixture.language} exposes objective syntax`);
    assert.equal(syntax.complete, result.facts.parseStatus === "complete");
    for (const kind of fixture.expected) {
      assert.ok(syntax.nodes.some((node) => node.kind === kind), `${fixture.language} includes ${kind}`);
    }
    for (const node of syntax.nodes) {
      assert.match(node.id, /^syntax:[1-9]\d*$/);
      assert.ok(node.range.startLine >= 1);
      for (const childId of node.children) assert.ok(syntax.nodes.some((child) => child.id === childId));
    }
  }
});

test("objective syntax round-trips and malformed linked observations miss the cache", () => {
  const result = extractParsedFacts({
    source: '@Controller("users") class Users {}\n',
    filePath: "src/users.ts",
    language: "typescript",
    contentHash: "objective-codec",
    factsVersion: FACTS_VERSION,
    factsSchemaVersion: FACTS_SCHEMA_VERSION,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  const facts = result.facts;
  assert.ok(facts.frameworkSyntax?.nodes.some((node) => node.kind === "annotation" && node.name === "Controller"));
  const expected = {
    key: factBlobKey(facts),
    contentHash: facts.contentHash,
    language: facts.language,
    parserIdentity: facts.parserIdentity,
    factsVersion: facts.factsVersion,
    factsSchemaVersion: facts.factsSchemaVersion,
  };
  const decoded = decodeFacts(encodeFacts(facts), expected);
  assert.equal(decoded.kind, "hit");
  if (decoded.kind === "hit") assert.equal(encodeFacts(decoded.facts), encodeFacts(facts));

  const malformed = JSON.parse(encodeFacts(facts)) as { frameworkSyntax?: { nodes: Array<{ children: string[] }> } };
  assert.ok(malformed.frameworkSyntax);
  malformed.frameworkSyntax.nodes[0]!.children.push("syntax:999");
  assert.deepEqual(
    decodeFacts(JSON.stringify(malformed), expected),
    { kind: "miss", reason: "schema_mismatch" },
  );

  type EncodedFacts = {
    frameworkSyntax?: {
      complete: boolean;
      nodes: Array<{
        id: string;
        kind: string;
        range: { startLine: number; endLine: number; startColumn?: number; endColumn?: number };
        children: string[];
        arguments: Array<{ name?: string; valueId: string }>;
        receiverId?: string;
        typeArguments: string[];
      }>;
    };
  };
  const rejectMutation = (mutate: (value: EncodedFacts) => void): void => {
    const value = JSON.parse(encodeFacts(facts)) as EncodedFacts;
    assert.ok(value.frameworkSyntax);
    mutate(value);
    assert.deepEqual(
      decodeFacts(JSON.stringify(value), expected),
      { kind: "miss", reason: "schema_mismatch" },
    );
  };

  rejectMutation((value) => {
    const node = value.frameworkSyntax!.nodes[0]!;
    node.children.push(node.id);
  });
  rejectMutation((value) => {
    const [first, second] = value.frameworkSyntax!.nodes;
    assert.ok(first && second);
    first.children = [second.id];
    second.children = [first.id];
  });
  rejectMutation((value) => {
    value.frameworkSyntax = { complete: true, nodes: [] };
  });
  rejectMutation((value) => {
    value.frameworkSyntax!.complete = false;
  });

  const partial = JSON.parse(encodeFacts(facts)) as EncodedFacts;
  partial.frameworkSyntax = {
    complete: false,
    nodes: [{
      id: "syntax:1",
      kind: "unknown",
      range: { startLine: 1, endLine: 1, startColumn: 0, endColumn: 1 },
      children: [],
      arguments: [],
      typeArguments: [],
    }],
  };
  assert.equal(decodeFacts(JSON.stringify(partial), expected).kind, "hit");
});

test("ecmascript decorators link to their declared class and method owners", () => {
  const result = extractParsedFacts({
    language: "typescript",
    filePath: "src/users.ts",
    source: '@Controller("users") export class Users { @Get() list() {} }',
    contentHash: "ecmascript-decorator-owners",
    factsVersion: FACTS_VERSION,
    factsSchemaVersion: FACTS_SCHEMA_VERSION,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;

  const syntax = result.facts.frameworkSyntax;
  assert.ok(syntax);
  for (const [annotationName, symbolName] of [["Controller", "Users"], ["Get", "list"]] as const) {
    const annotation = syntax.nodes.find((node) => node.kind === "annotation" && node.name === annotationName);
    assert.ok(annotation?.ownerSymbolId, annotationName);
    assert.equal(result.facts.symbols.find((symbol) => symbol.localId === annotation.ownerSymbolId)?.name, symbolName);
  }
});

test("objective syntax never emits self-linked children or arguments", () => {
  const syntax = extractSyntax({
    language: "typescript",
    filePath: "src/props.ts",
    source: "const value = 1; const props = { value };",
  });

  for (const node of syntax.nodes) {
    assert.ok(!node.children.includes(node.id), `${node.id} child self-link`);
    assert.ok(!node.arguments.some((argument) => argument.valueId === node.id), `${node.id} argument self-link`);
  }
});

test("ecmascript materializes directive, receiver, type, property, spread, lambda return, and JSX links", () => {
  const syntax = extractSyntax({
    language: "tsx",
    filePath: "src/users.tsx",
    source: "\"use client\";\n"
      + "const notDirective = \"use server\";\n"
      + "const view = service.make<Foo>({ path: \"/users\\n\", nested: [1, ...items], [dynamic]: fallback }, value => value);\n"
      + "const jsx = <Layout.Header title={view} />;",
  });
  const byId = new Map(syntax.nodes.map((node) => [node.id, node]));

  const directives = syntax.nodes.filter((node) => node.kind === "directive");
  assert.deepEqual(directives.map((node) => node.name), ["use client"]);

  const call = syntax.nodes.find((node) => node.kind === "call" && node.name === "make");
  assert.ok(call?.receiverId);
  assert.equal(byId.get(call.receiverId)?.name, "service");
  assert.deepEqual(call.typeArguments.map((id) => byId.get(id)?.name), ["Foo"]);
  assert.deepEqual(call.arguments.map((argument) => byId.get(argument.valueId)?.kind), ["object", "lambda"]);

  const path = syntax.nodes.find((node) => node.kind === "property" && node.name === "path");
  assert.ok(path);
  assert.equal(path.children.length, 1);
  assert.equal(byId.get(path.children[0]!)?.value, "/users\n");
  assert.ok(syntax.nodes.some((node) => node.kind === "spread"));
  assert.ok(syntax.nodes.some((node) => node.kind === "unknown" && node.name === "computed"));

  const lambda = syntax.nodes.find((node) => node.kind === "lambda");
  assert.ok(lambda?.children.some((id) => byId.get(id)?.kind === "return"));
  assert.ok(syntax.nodes.some((node) => node.kind === "jsx" && node.name === "Layout.Header"));
  assert.ok(syntax.nodes.some((node) => node.name === "service" && node.factId?.startsWith("reference:")));
});

test("JVM annotations retain ownership, named arguments, parameter links, and Bean return types", () => {
  const cases = [
    {
      language: "java" as const,
      filePath: "src/Users.java",
      source: '@Controller(path = "/users") class Users { @Bean Foo bean(@Qualifier("main") Service service) { return new Foo(); } }',
    },
    {
      language: "kotlin" as const,
      filePath: "src/Users.kt",
      source: '@Controller(path = "/users") class Users { @Bean fun bean(@Qualifier("main") service: Service): Foo = Foo() }',
    },
  ];

  for (const input of cases) {
    const result = extractParsedFacts({
      ...input,
      contentHash: input.language + "-annotations",
      factsVersion: FACTS_VERSION,
      factsSchemaVersion: FACTS_SCHEMA_VERSION,
    });
    assert.equal(result.kind, "facts", input.language);
    if (result.kind !== "facts") continue;
    const syntax = result.facts.frameworkSyntax;
    assert.ok(syntax, input.language);
    const byId = new Map(syntax.nodes.map((node) => [node.id, node]));
    const controller = syntax.nodes.find((node) => node.kind === "annotation" && node.name === "Controller");
    assert.ok(controller?.ownerSymbolId, input.language + " Controller owner");
    assert.equal(result.facts.symbols.find((symbol) => symbol.localId === controller.ownerSymbolId)?.name, "Users");
    assert.equal(controller.arguments[0]?.name, "path");
    assert.equal(byId.get(controller.arguments[0]!.valueId)?.value, "/users");

    const qualifier = syntax.nodes.find((node) => node.kind === "annotation" && node.name === "Qualifier");
    assert.ok(qualifier?.factId?.startsWith("parameter:"), input.language + " parameter link");
    const bean = syntax.nodes.find((node) => node.kind === "annotation" && node.name === "Bean");
    assert.ok(bean?.ownerSymbolId, input.language + " Bean owner");
    assert.equal(result.facts.returns.find((item) => item.ownerSymbolId === bean.ownerSymbolId)?.typeText, "Foo");
  }
});

test("Dart materializes named widget arguments, generic provider types, and build returns", () => {
  const result = extractParsedFacts({
    language: "dart",
    filePath: "lib/screen.dart",
    source: 'class Screen { Widget build(BuildContext context) { return Provider<Foo>(create: (context) => Foo(), child: MaterialApp(routes: {"/": (context) => Home()})); } }',
    contentHash: "dart-widget-syntax",
    factsVersion: FACTS_VERSION,
    factsSchemaVersion: FACTS_SCHEMA_VERSION,
  });
  assert.equal(result.kind, "facts");
  if (result.kind !== "facts") return;
  const syntax = result.facts.frameworkSyntax;
  assert.ok(syntax);
  const byId = new Map(syntax.nodes.map((node) => [node.id, node]));
  const provider = syntax.nodes.find((node) => ["call", "construct"].includes(node.kind) && node.name === "Provider");
  assert.ok(provider);
  assert.deepEqual(provider.typeArguments.map((id) => byId.get(id)?.name), ["Foo"]);
  assert.deepEqual(provider.arguments.map((argument) => argument.name), ["create", "child"]);
  const buildId = result.facts.symbols.find((symbol) => symbol.name === "build")?.localId;
  assert.ok(syntax.nodes.some((node) => node.kind === "return" && node.ownerSymbolId === buildId));
});

test("Dart preserves member selectors and invocation syntax without constructor guessing", () => {
  const syntax = extractSyntax({
    language: "dart",
    filePath: "lib/navigation.dart",
    source: "void navigate(BuildContext context, Route route, Widget widget) { Navigator.push(context, route); widget.title; Home(); new Home(); }",
  });
  const byId = new Map(syntax.nodes.map((node) => [node.id, node]));

  const pushMember = syntax.nodes.find((node) => node.kind === "property" && node.name === "push");
  assert.ok(pushMember?.receiverId);
  assert.equal(byId.get(pushMember.receiverId)?.name, "Navigator");
  const pushCall = syntax.nodes.find((node) => node.kind === "call" && node.name === "push");
  assert.ok(pushCall?.receiverId);
  assert.equal(pushCall.arguments.length, 2);
  assert.equal(byId.get(pushCall.receiverId)?.id, pushMember.id);

  const title = syntax.nodes.find((node) => node.kind === "property" && node.name === "title");
  assert.ok(title?.receiverId);
  assert.equal(byId.get(title.receiverId)?.name, "widget");
  assert.ok(syntax.nodes.some((node) => node.kind === "call" && node.name === "Home"));
  assert.ok(syntax.nodes.some((node) => node.kind === "construct" && node.name === "Home"));
});

test("objective syntax IDs and links repeat deterministically", () => {
  const input = {
    language: "tsx" as const,
    filePath: "src/repeat.tsx",
    source: '@Controller("users") class Users { view() { return <Page title="Users" />; } }',
  };

  assert.deepEqual(extractSyntax(input), extractSyntax(input));
});

test("materialization parses once, marks malformed syntax partial, and leaves unsupported families unavailable", () => {
  const original = Parser.prototype.parse;
  let parseCount = 0;
  Object.defineProperty(Parser.prototype, "parse", {
    configurable: true,
    value(this: Parser, ...args: Parameters<Parser["parse"]>) {
      parseCount += 1;
      return original.apply(this, args);
    },
  });
  try {
    const malformed = extractParsedFacts({
      language: "typescript",
      filePath: "src/broken.ts",
      source: "const broken = {",
      contentHash: "malformed-objective",
      factsVersion: FACTS_VERSION,
      factsSchemaVersion: FACTS_SCHEMA_VERSION,
    });
    assert.equal(malformed.kind, "facts");
    if (malformed.kind === "facts") {
      assert.equal(malformed.facts.parseStatus, "deterministic_partial");
      assert.equal(malformed.facts.frameworkSyntax?.complete, false);
      assert.ok(malformed.facts.frameworkSyntax?.nodes.some((node) => node.kind === "unknown"));
    }
    assert.equal(parseCount, 1);
  } finally {
    Object.defineProperty(Parser.prototype, "parse", { configurable: true, value: original });
  }

  const unsupported = extractParsedFacts({
    language: "c",
    filePath: "src/plain.c",
    source: "int main(void) { return 0; }",
    contentHash: "unsupported-objective",
    factsVersion: FACTS_VERSION,
    factsSchemaVersion: FACTS_SCHEMA_VERSION,
  });
  assert.equal(unsupported.kind, "facts");
  if (unsupported.kind === "facts") assert.equal(unsupported.facts.frameworkSyntax, undefined);
});
