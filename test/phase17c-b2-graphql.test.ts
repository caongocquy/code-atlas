import assert from "node:assert/strict";
import test from "node:test";
import { nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { springAdapter } from "../src/core/framework/adapters/spring.js";
import { decodeFrameworkGraphqlFieldIdentity, decodeFrameworkGraphqlOperationIdentity, frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import { planFrameworkInvalidation } from "../src/core/framework/framework-invalidation.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import type { FrameworkAnalysisContext, FrameworkSemanticAdapter } from "../src/core/framework/framework.types.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { projectFrameworkGraph } from "../src/core/graph/query/framework-query.service.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import { buildRepositoryMap } from "../src/core/graph/intelligence/repository-map.service.js";
import { defaultArchitecturePolicy } from "../src/core/architecture/architecture-policy.js";
import { buildRepositoryEntryCatalog } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION, FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";

function sourceCase(language: "typescript" | "java" | "kotlin", source: string, partial = false) {
  const relativePath = language === "java" ? "src/Resolver.java" : language === "kotlin" ? "src/Resolver.kt" : "src/resolver.ts";
  const extracted = extractParsedFacts({ source, filePath: relativePath, language, contentHash: "fixture", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") throw new Error("fixture extraction failed");
  const facts = extracted.facts;
  if (partial && facts.frameworkSyntax) facts.frameworkSyntax = { ...facts.frameworkSyntax, complete: false };
  const graph: CodeGraph = { nodes: facts.symbols.filter((s) => s.kind === "class" || s.kind === "method").map((s): GraphNode => ({
    id: `graph:${s.localId}`, type: s.kind as "class" | "method", name: s.name, qualifiedName: s.declaredQualifiedName ?? s.name, file: relativePath,
    startLine: s.range.startLine, endLine: s.range.endLine,
  })), edges: [] };
  const adapter: FrameworkSemanticAdapter = language === "typescript" ? nestjsAdapter : springAdapter;
  const base = { repositoryId: "repo", facts: [{ relativePath, facts }], graph, config: [] };
  const ctx: FrameworkAnalysisContext = { ...base, generationId: "gen", frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION,
    detections: adapter.detect(base), analyzePaths: new Set([relativePath]), maxObservations: 100 };
  const evidence = adapter.analyze(ctx).evidence;
  const materialization = resolveFrameworkEvidence(ctx, evidence);
  const catalog = buildRepositoryEntryCatalog(projectFrameworkGraph(graph, { ...materialization, repositoryId: "repo", generationId: "gen" }));
  return { materialization, catalog, ctx, evidence, projection: projectFrameworkGraph(graph, { ...materialization, repositoryId: "repo", generationId: "gen" }) };
}
const nest = (body: string) => 'import { Resolver, Subscription, ResolveField, ObjectType } from "@nestjs/graphql";\n' + body;
const spring = (body: string) => ["Controller", "SubscriptionMapping", "SchemaMapping", "BatchMapping"].map((name) =>
  `import ${name === "Controller" ? "org.springframework.stereotype" : "org.springframework.graphql.data.method.annotation"}.${name};`).join("\n") + "\n" + body;
const keys = (result: ReturnType<typeof sourceCase>) => result.materialization.entities.map((e) => decodeFrameworkGraphqlFieldIdentity(e.ref) ?? decodeFrameworkGraphqlOperationIdentity(e.ref));

test("B2 root subscription identities preserve B1 and validate nested parent semantics", () => {
  const key = (value: unknown[], kind: "graphql_operation" | "graphql_field" = "graphql_operation") => frameworkEntityKey({ framework: "nestjs", kind, logicalKey: JSON.stringify(value) });
  assert.equal(new Set(["query", "mutation", "subscription"].map((kind) => key(["root", kind, "foo"]))).size, 3);
  assert.notEqual(key(["root", "User", "name"], "graphql_field"), key(["root", "Product", "name"], "graphql_field"));
  for (const value of [["root", "field", "name"], ["root", "field", "name", ""], ["root", "field", "name", "bad-type"], ["root", "subscription", "foo", "User"], ["root", "batch", "foo", "User"]]) assert.throws(() => key(value));
});

test("Nest Subscription default, static override, and aliased decorators", () => {
  for (const [decorator, field] of [["@Subscription()", "updates"], ['@Subscription("changed")', "changed"], ['@Subscription(() => String, { name: "changed" })', "changed"]]) {
    const result = sourceCase("typescript", nest(`@Resolver() class R { ${decorator} updates() {} }`));
    assert.deepEqual(keys(result), [["root", "subscription", field]]);
    assert.equal(result.catalog.entries[0]?.kind === "graphql" && result.catalog.entries[0].operationKind, "subscription");
  }
  const aliased = sourceCase("typescript", 'import { Resolver as R, Subscription as S } from "@nestjs/graphql"; @R() class Events { @S() updates() {} }');
  assert.deepEqual(keys(aliased), [["root", "subscription", "updates"]]);
});

test("Nest ResolveField preserves distinct parents, static names, and code-first ObjectType names", () => {
  const forms = [
    ['@Resolver("User")', "", "@ResolveField()", "name", "User"],
    ['@Resolver("User")', "", '@ResolveField("label")', "label", "User"],
    ['@Resolver("User")', "", '@ResolveField("label", () => String)', "label", "User"],
    ['@Resolver("User")', "", '@ResolveField(() => String, { name: "label" })', "label", "User"],
    ["@Resolver(() => User)", "@ObjectType() class User {}", "@ResolveField()", "name", "User"],
    ["@Resolver(() => User)", '@ObjectType("Person") class User {}', "@ResolveField()", "name", "Person"],
  ];
  for (const [resolver, parent, field, expectedName, expectedType] of forms) {
    const result = sourceCase("typescript", nest(`${parent} ${resolver} class R { ${field} name() {} }`));
    assert.deepEqual(keys(result), [["root", expectedType, expectedName]], `${resolver} ${field}`);
    assert.equal(result.catalog.entries.length, 0);
    assert.equal(result.materialization.entities[0]?.ref.kind, "graphql_field");
  }
  const two = sourceCase("typescript", nest('@Resolver("User") class U { @ResolveField("name") userName() {} } @Resolver("Product") class P { @ResolveField("name") productName() {} }'));
  assert.equal(two.catalog.entries.length, 0);
  assert.equal(new Set(two.materialization.entities.map((entry) => frameworkEntityKey(entry.ref))).size, 2);
  const alias = sourceCase("typescript", 'import { Resolver as R, ResolveField as F } from "@nestjs/graphql"; @R("User") class U { @F("label") name() {} }');
  assert.deepEqual(keys(alias), [["root", "User", "label"]]);
});

test("Nest rejects dynamic, unresolved, shadowed, ambiguous, malformed, and partial declarations", () => {
  const cases = [
    '@Resolver() class R { @ResolveField() name() {} }',
    '@Resolver(dynamicType) class R { @ResolveField() name() {} }',
    '@Resolver(() => Missing) class R { @ResolveField() name() {} }',
    'class User {} @Resolver(() => User) class R { @ResolveField() name() {} }',
    '@ObjectType(dynamicName) class User {} @Resolver(() => User) class R { @ResolveField() name() {} }',
    '@Resolver("User") class R { @ResolveField(dynamicName) name() {} }',
    '@Resolver("User") class R { @ResolveField(() => String, { name: dynamicName }) name() {} }',
    '@Resolver() class R { @Subscription(() => String, { ...options }) name() {} }',
    '@Resolver() class R { @Subscription(() => String, { name: "a", name: "b" }) name() {} }',
    '@Resolver() class R { @Subscription(1) name() {} }',
    'function Subscription() {} @Resolver() class R { @Subscription() name() {} }',
    '@Resolver("User") class R { name(ResolveField: any) { @ResolveField() class Local {} } }',
    '@Resolver("User") @Resolver("Product") class R { @ResolveField() name() {} }',
  ];
  for (const body of cases) assert.equal(sourceCase("typescript", nest(body)).materialization.entities.length, 0, body);
  for (const decorator of ["Subscription", "ResolveField"]) {
    const wrong = sourceCase("typescript", `import { Resolver } from "@nestjs/graphql"; import { ${decorator} } from "other"; @Resolver("User") class R { @${decorator}() name() {} }`);
    assert.equal(wrong.materialization.entities.length, 0);
    const duplicateImport = sourceCase("typescript", `import { Resolver, ${decorator} } from "@nestjs/graphql"; import { ${decorator} } from "other"; @Resolver("User") class R { @${decorator}() name() {} }`);
    assert.equal(duplicateImport.materialization.entities.length, 0);
  }
  const partial = sourceCase("typescript", nest('@Resolver("User") class R { @ResolveField() name() {} }'), true);
  assert.equal(partial.materialization.entities.length, 0);
  assert.ok(partial.materialization.diagnostics.length > 0);
});

test("Nest duplicate nested mappings are dropped rather than selecting an owner", () => {
  const result = sourceCase("typescript", nest('@Resolver("User") class A { @ResolveField() name() {} } @Resolver("User") class B { @ResolveField() name() {} }'));
  assert.equal(result.materialization.entities.length, 0);
  assert.ok(result.materialization.diagnostics.some((d) => d.code === "framework_entity_identity_collision"));
});

test("Spring SubscriptionMapping derives default and name/value aliases", () => {
  for (const [annotation, field] of [["@SubscriptionMapping", "updates"], ['@SubscriptionMapping("changed")', "changed"], ['@SubscriptionMapping(name="changed")', "changed"], ['@SubscriptionMapping(value="changed")', "changed"]]) {
    const result = sourceCase("java", spring(`@Controller class R { ${annotation} String updates() { return "ok"; } }`));
    assert.deepEqual(keys(result), [["root", "subscription", field]]);
  }
});

test("Spring SchemaMapping supports field/value aliases, class defaults, method overrides and source type", () => {
  const cases = [
    ['@Controller class R { @SchemaMapping(typeName="User", field="label") String name() { return "ok"; } }', "User", "label"],
    ['@Controller class R { @SchemaMapping(typeName="User", value="label") String name() { return "ok"; } }', "User", "label"],
    ['@Controller @SchemaMapping(typeName="User") class R { @SchemaMapping String name() { return "ok"; } }', "User", "name"],
    ['@Controller @SchemaMapping(typeName="User") class R { @SchemaMapping(typeName="Product") String name() { return "ok"; } }', "Product", "name"],
    ['class User {} @Controller class R { @SchemaMapping String name(User source) { return "ok"; } }', "User", "name"],
    ['@Controller class R { @SchemaMapping(typeName="User", field="label", value="label") String name() { return "ok"; } }', "User", "label"],
  ];
  for (const [body, parent, name] of cases) assert.deepEqual(keys(sourceCase("java", spring(body!))), [["root", parent, name]], body);
});

test("Spring BatchMapping preserves batch provenance and parent identity", () => {
  for (const body of [
    '@Controller class R { @BatchMapping(typeName="User", field="name") String names() { return "ok"; } }',
    '@Controller @SchemaMapping(typeName="User") class R { @BatchMapping(value="name") String names() { return "ok"; } }',
    'class User {} @Controller class R { @BatchMapping String name(java.util.List<User> users) { return "ok"; } }',
  ]) {
    const result = sourceCase("java", spring(body));
    assert.deepEqual(keys(result), [["root", "User", "name"]]);
    assert.equal(result.catalog.entries.length, 0);
    assert.match(result.materialization.entities[0]!.provenance.strategy, /batch/);
  }
});

test("Spring rejects unresolved, dynamic, malformed, ambiguous aliases, wrong origins and partial facts", () => {
  for (const annotation of [
    '@SchemaMapping', '@SchemaMapping(typeName=TYPE)', '@SchemaMapping(typeName="User", field=NAME)',
    '@SchemaMapping(typeName="User", field="a", value="b")', '@SchemaMapping(typeName="User", unknown="x")',
    '@SchemaMapping(typeName="User", typeName="Product")', '@BatchMapping', '@SubscriptionMapping(name=NAME)',
  ]) {
    const result = sourceCase("java", spring(`@Controller class R { ${annotation} String name() { return "ok"; } }`));
    assert.equal(result.materialization.entities.length, 0, annotation);
    assert.ok(result.materialization.diagnostics.length > 0, annotation);
  }
  for (const name of ["SubscriptionMapping", "SchemaMapping", "BatchMapping"]) {
    const source = `import org.springframework.stereotype.Controller; import other.${name}; @Controller class R { @${name}(typeName="User") String name() { return "ok"; } }`;
    assert.equal(sourceCase("java", source).materialization.entities.length, 0);
    const shadow = spring(`@interface ${name} {} @Controller class R { @${name}(typeName="User") String name() { return "ok"; } }`);
    assert.equal(sourceCase("java", shadow).materialization.entities.length, 0);
  }
  const partial = sourceCase("java", spring('@Controller class R { @SchemaMapping(typeName="User") String name() { return "ok"; } }'), true);
  assert.equal(partial.materialization.entities.length, 0);
});

test("Spring duplicates including schema/batch conflicts share a slot and are dropped", () => {
  const result = sourceCase("java", spring('@Controller class R { @SchemaMapping(typeName="User") String name() { return "a"; } @BatchMapping(typeName="User", field="name") String other() { return "b"; } }'));
  assert.equal(result.materialization.entities.length, 0);
  assert.ok(result.materialization.diagnostics.some((d) => d.code === "framework_entity_identity_collision"));
});

test("B2 ordering and entity identity are stable across declaration order and source positions", () => {
  const a = '@Resolver("User") class U { @ResolveField("name") userName() {} }';
  const b = '@Resolver("Product") class P { @ResolveField("name") productName() {} }';
  const first = sourceCase("typescript", nest(a + b));
  const second = sourceCase("typescript", nest("\n\n" + b + a));
  assert.equal(first.catalog.entries.length, 0);
  assert.equal(first.materialization.entities.length, 2);
  assert.deepEqual(first.materialization.entities.map((e) => frameworkEntityKey(e.ref)), second.materialization.entities.map((e) => frameworkEntityKey(e.ref)));
});

 test("Spring explicit root SchemaMapping stays a root while BatchMapping cannot claim a root", () => {
  for (const [parent, operation] of [["Query", "query"], ["Mutation", "mutation"], ["Subscription", "subscription"]]) {
    const result = sourceCase("java", spring(`@Controller class R { @SchemaMapping(typeName="${parent}") String name() { return "ok"; } }`));
    assert.deepEqual(keys(result), [["root", operation, "name"]]);
    assert.equal(result.catalog.entries.length, 1);
    const batch = sourceCase("java", spring(`@Controller class R { @BatchMapping(typeName="${parent}") String name() { return "ok"; } }`));
    assert.equal(batch.materialization.entities.length, 0);
    assert.equal(batch.catalog.mayBeIncomplete, true);
  }
});

test("B2 nested-only discovery and unsupported decorator origins remain incomplete", () => {
  const nested = sourceCase("typescript", nest('@Resolver("User") class R { @ResolveField() name() {} }'));
  assert.equal(nested.catalog.entries.length, 0);
  assert.equal(nested.catalog.mayBeIncomplete, true);
  assert.equal(nested.projection.mayBeIncomplete, true);
  for (const body of [
    '@Resolver() class R { @Subscription(dynamicName) updates() {} }',
    '@Resolver() class R { @ResolveField() name() {} }',
  ]) {
    const result = sourceCase("typescript", nest(body));
    assert.equal(result.catalog.mayBeIncomplete, true);
    assert.ok(result.materialization.diagnostics.length > 0);
  }
  const namespace = sourceCase("typescript", 'import * as G from "@nestjs/graphql"; import { Resolver, Query } from "@nestjs/graphql"; @Resolver("User") class R { @Query() users() {} @G.ResolveField() name() {} }');
  assert.equal(namespace.materialization.entities.length, 1);
  assert.equal(namespace.projection.mayBeIncomplete, true);
  assert.ok(namespace.materialization.diagnostics.some((item) => item.outcome === "unsupported"));
});

test("B2 nested keys reject malformed canonical payloads independently of root keys", () => {
  for (const key of [
    ["root", "User"], ["root", "User", "name", "owner"], ["root", "", "name"],
    ["root", "User", ""], ["root", "bad-type", "name"], ["root", "User", "bad-field"],
    ["/root", "User", "name"], ["root", 1, "name"],
  ]) assert.throws(() => frameworkEntityKey({ framework: "nestjs", kind: "graphql_field", logicalKey: JSON.stringify(key) }));
  assert.throws(() => frameworkEntityKey({ framework: "nestjs", kind: "graphql_field", logicalKey: '["root", "User", "name"]' }));
});

test("B2 Spring alias and MVC origins cannot prove nested mapping", () => {
  const alias = sourceCase("kotlin", 'import org.springframework.stereotype.Controller\nimport org.springframework.graphql.data.method.annotation.SchemaMapping as FieldMapping\n@Controller class R { @FieldMapping(typeName="User") fun name(): String = "ok" }');
  assert.equal(alias.materialization.entities.length, 0);
  assert.equal(alias.catalog.mayBeIncomplete, true);
  const mvc = sourceCase("java", 'import org.springframework.stereotype.Controller; import org.springframework.web.bind.annotation.SchemaMapping; @Controller class R { @SchemaMapping(typeName="User") String name() { return "ok"; } }');
  assert.equal(mvc.materialization.entities.length, 0);
});

test("B2 exact nested selector is isolated, fails closed, and leaves repository map entries unchanged", () => {
  const result = sourceCase("typescript", nest('@Resolver("User") class U { @ResolveField("name") userName() {} }\n@Resolver("Admin") class A { @ResolveField("name") adminName() {} }'));
  const entity = result.materialization.entities[0]!;
  const id = frameworkEntityKey(entity.ref);
  const flow = discoverExecutionFlow(result.ctx.graph, result.projection, { kind: "graphql", id });
  assert.equal(flow.status, "resolved");
  assert.equal(flow.nodes.filter((node) => node.subject.kind === "framework").length, 1);
  assert.equal(flow.edges.length, 1);
  assert.equal(flow.mayBeIncomplete, true);
  assert.equal(discoverExecutionFlow(result.ctx.graph, result.projection, { kind: "graphql", id: "invalid" }).status, "not_found");
  const missing = { ...result.projection, edges: [] };
  assert.ok(discoverExecutionFlow(result.ctx.graph, missing, { kind: "graphql", id }).diagnostics.some((item) => item.code === "graphql_binding_missing"));
  const relation = result.materialization.relationships.find((item) => item.target.kind === "framework" && frameworkEntityKey(item.target.entity) === id)!;
  const other = result.ctx.graph.nodes.find((node) => node.type === "method" && node.id !== (relation.source.kind === "language" && relation.source.nodeId))!;
  const ambiguous = { ...result.projection, edges: [...result.projection.edges, { kind: "framework" as const, relationship: { ...relation, source: { kind: "language" as const, nodeId: other.id } } }] };
  assert.equal(discoverExecutionFlow(result.ctx.graph, ambiguous, { kind: "graphql", id }).status, "ambiguous");
  const policy = defaultArchitecturePolicy();
  const withFields = buildRepositoryMap(result.ctx.graph, policy, result.projection);
  const withoutFields = buildRepositoryMap(result.ctx.graph, policy);
  assert.ok(withFields.areas.every((area) => area.executionEntryBindingCount === 0));
  assert.ok(withFields.areas.some((area) => area.frameworkIds.includes("nestjs")));
  assert.deepEqual(withFields.relations, withoutFields.relations);
  assert.deepEqual(withFields.areas.map(({ frameworkIds, ...area }) => area), withoutFields.areas.map(({ frameworkIds, ...area }) => area));
});

test("B2 framework version invalidation widens framework work independently of language paths", () => {
  const result = sourceCase("typescript", nest('@Resolver("User") class R { @ResolveField() name() {} }'));
  const previous = { ...result.materialization, repositoryId: "repo", generationId: "old", frameworkResolutionVersion: "1.3.0" };
  const plan = planFrameworkInvalidation({ paths: [], allPaths: ["src/resolver.ts"], changedInputKeys: new Set(), changedLookupKeys: new Set(), previous, frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION, topologyComplete: true });
  assert.equal(plan.widened, true);
  assert.deepEqual(plan.analyzePaths, ["src/resolver.ts"]);
  assert.ok(plan.reasons.includes("framework_resolution_version_changed"));
});

test("B2 malformed scope whitespace and class-level BatchMapping fail closed", () => {
  for (const kind of ["graphql_operation", "graphql_field"] as const) {
    assert.throws(() => frameworkEntityKey({ framework: "spring", kind, logicalKey: JSON.stringify([" root ", kind === "graphql_field" ? "User" : "query", "name"]) }));
  }
  const result = sourceCase("java", spring('@Controller @BatchMapping(typeName="User") class R { @SubscriptionMapping String events() { return "ok"; } }'));
  assert.equal(result.materialization.entities.length, 1);
  assert.ok(result.materialization.diagnostics.length > 0);
});
