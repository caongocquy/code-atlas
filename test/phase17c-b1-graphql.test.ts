import assert from "node:assert/strict";
import test from "node:test";

import { nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { springAdapter } from "../src/core/framework/adapters/spring.js";
import { decodeFrameworkGraphqlOperationIdentity, decodeFrameworkRouteIdentity, frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import type { FrameworkAnalysisContext, FrameworkEntity, FrameworkProvenance, FrameworkRelationship, FrameworkSemanticAdapter, FrameworkSnapshot } from "../src/core/framework/framework.types.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { buildRepositoryEntryCatalog, filterRepositoryEntries } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import { projectFrameworkGraph } from "../src/core/graph/query/framework-query.service.js";
import type { CodeGraph, GraphNode } from "../src/core/graph/types.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION } from "../src/core/repository/index-version.js";

function sourceCase(language: "typescript" | "java" | "kotlin", source: string, adapter: FrameworkSemanticAdapter) {
  const relativePath = `src/Users.${language === "typescript" ? "ts" : language === "java" ? "java" : "kt"}`;
  const extracted = extractParsedFacts({ source, filePath: relativePath, language, contentHash: "fixture", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
  assert.equal(extracted.kind, "facts");
  if (extracted.kind !== "facts") throw new Error("fixture facts failed");
  const facts = extracted.facts;
  const graph: CodeGraph = { nodes: facts.symbols.filter((symbol) => symbol.kind === "class" || symbol.kind === "method")
    .map((symbol): GraphNode => ({ id: `graph:${symbol.localId}`, type: symbol.kind as "class" | "method", name: symbol.name,
      qualifiedName: symbol.declaredQualifiedName ?? symbol.name, file: relativePath,
      startLine: symbol.range.startLine, endLine: symbol.range.endLine })), edges: [] };
  const base = { repositoryId: "repo", facts: [{ relativePath, facts }], graph, config: [] };
  const ctx: FrameworkAnalysisContext = { ...base, generationId: "generation", frameworkResolutionVersion: "1.1.0",
    detections: adapter.detect(base), analyzePaths: new Set([relativePath]), maxObservations: 100 };
  const evidence = adapter.analyze(ctx).evidence;
  const materialization = resolveFrameworkEvidence(ctx, evidence);
  const snapshot: FrameworkSnapshot = { ...materialization, repositoryId: "repo", generationId: "generation" };
  return { facts, graph, ctx, evidence, materialization, projection: projectFrameworkGraph(graph, snapshot) };
}

const nestSource = (decorators: string, methods: string) => [
  'import { Resolver, Query, Mutation } from "@nestjs/graphql";',
  decorators, "class UsersResolver {", methods, "}", "",
].join("\n");

const springSource = (language: "java" | "kotlin", imports: string, methods: string) => language === "java"
  ? `${imports}\n@Controller class Users { ${methods} }\n`
  : `${imports}\n@Controller class Users { ${methods} }\n`;

test("GraphQL key is canonical, kind-specific, stable across owner/location, and separate from HTTP", () => {
  const query = { framework: "nestjs" as const, kind: "graphql_operation" as const, logicalKey: JSON.stringify(["root", "query", "users"]) };
  const mutation = { ...query, logicalKey: JSON.stringify(["root", "mutation", "users"]) };
  assert.deepEqual(decodeFrameworkGraphqlOperationIdentity(query), ["root", "query", "users"]);
  assert.notEqual(frameworkEntityKey(query), frameworkEntityKey(mutation));
  assert.equal(frameworkEntityKey(query), frameworkEntityKey({ ...query }));
  assert.equal(decodeFrameworkRouteIdentity(query), undefined);
  const route = { framework: "nestjs" as const, kind: "route" as const, logicalKey: JSON.stringify(["root", "http", "/users", "GET", [], null]) };
  assert.deepEqual(decodeFrameworkRouteIdentity(route), ["root", "http", "/users", "GET", [], null]);
  for (const key of [
    ["root", "query"], ["/root", "query", "users"], ["root", "subscription", "users"],
    ["root", "query", ""], ["root", "query", "bad-name"], ["root", "query", 1],
    ["root", "query", "users", "owner"],
  ]) assert.throws(() => frameworkEntityKey({ ...query, logicalKey: JSON.stringify(key) }));
  assert.throws(() => frameworkEntityKey({ ...query, logicalKey: '["root", "query", "users"]' }));
});

test("Nest Query and Mutation forms keep callback types out of field names", () => {
  const forms = [
    ["@Query()", "users", "query"],
    ['@Query("lookup")', "lookup", "query"],
    ["@Query(() => String)", "users", "query"],
    ['@Query(() => String, { name: "lookup" })', "lookup", "query"],
    ["@Mutation()", "users", "mutation"],
    ['@Mutation("change")', "change", "mutation"],
    ["@Mutation(() => String)", "users", "mutation"],
    ['@Mutation(() => String, { name: "change" })', "change", "mutation"],
  ] as const;
  for (const [decorator, name, kind] of forms) {
    const result = sourceCase("typescript", nestSource("@Resolver()", `${decorator} users() {}`), nestjsAdapter);
    assert.deepEqual(result.materialization.entities.map((entity) => decodeFrameworkGraphqlOperationIdentity(entity.ref)), [["root", kind, name]], decorator);
    assert.equal(result.materialization.relationships[0]?.relationKind, "graphql_resolver", decorator);
    assert.equal(result.materialization.relationships[0]?.source.kind, "language", decorator);
    assert.equal(result.materialization.relationships[0]?.target.kind, "framework", decorator);
  }
  const both = sourceCase("typescript", nestSource("@Resolver()", "@Query() users() {} @Mutation() change() {}"), nestjsAdapter);
  assert.deepEqual(both.materialization.entities.map((entity) => decodeFrameworkGraphqlOperationIdentity(entity.ref)?.[1]).sort(), ["mutation", "query"]);
});

test("Nest rejects unproven decorator imports, owner, dynamic names, and duplicate operation owners", () => {
  const wrong = sourceCase("typescript", 'import { Resolver } from "@nestjs/graphql"; import { Query } from "other"; @Resolver() class Users { @Query() users() {} }', nestjsAdapter);
  assert.equal(wrong.materialization.entities.length, 0);
  const owner = sourceCase("typescript", nestSource("", "@Query() users() {}"), nestjsAdapter);
  assert.equal(owner.materialization.entities.length, 0);
  assert.ok(owner.materialization.diagnostics.length > 0);
  const dynamic = sourceCase("typescript", nestSource("@Resolver()", "@Query(() => String, { name: dynamicName }) users() {}"), nestjsAdapter);
  assert.equal(dynamic.materialization.entities.length, 0);
  assert.ok(dynamic.materialization.diagnostics.length > 0);
  const duplicate = sourceCase("typescript", [
    'import { Resolver, Query } from "@nestjs/graphql";',
    "@Resolver() class First { @Query() users() {} }",
    "@Resolver() class Second { @Query() users() {} }",
  ].join("\n"), nestjsAdapter);
  assert.equal(new Set(duplicate.evidence.flatMap((item) => item.entities.map((entity) => frameworkEntityKey(entity.ref)))).size, 1);
  assert.equal(duplicate.materialization.entities.length, 0);
  assert.ok(duplicate.materialization.diagnostics.some((item) => item.code === "framework_entity_identity_collision"));
});

test("Spring Java and Kotlin Query/Mutation mappings use proven imports and literal names", () => {
  for (const language of ["java", "kotlin"] as const) {
    const separator = language === "java" ? ";" : "";
    const imports = [
      `import org.springframework.stereotype.Controller${separator}`,
      `import org.springframework.graphql.data.method.annotation.QueryMapping${separator}`,
      `import org.springframework.graphql.data.method.annotation.MutationMapping${separator}`,
    ].join("\n");
    const forms = language === "java" ? [
      ["@QueryMapping String users() { return \"ok\"; }", "query", "users"],
      ["@QueryMapping(name=\"lookup\") String users() { return \"ok\"; }", "query", "lookup"],
      ["@MutationMapping String change() { return \"ok\"; }", "mutation", "change"],
      ["@MutationMapping(value=\"save\") String change() { return \"ok\"; }", "mutation", "save"],
    ] : [
      ["@QueryMapping fun users(): String = \"ok\"", "query", "users"],
      ["@QueryMapping(name=\"lookup\") fun users(): String = \"ok\"", "query", "lookup"],
      ["@MutationMapping fun change(): String = \"ok\"", "mutation", "change"],
      ["@MutationMapping(value=\"save\") fun change(): String = \"ok\"", "mutation", "save"],
    ];
    for (const [method, kind, name] of forms) {
      const result = sourceCase(language, springSource(language, imports, method!), springAdapter);
      assert.deepEqual(result.materialization.entities.map((entity) => decodeFrameworkGraphqlOperationIdentity(entity.ref)), [["root", kind, name]], `${language}: ${method}`);
    }
  }
});

test("Spring ignores MVC and unproven GraphQL imports and fails closed on Kotlin aliases", () => {
  const mvc = sourceCase("java", 'import org.springframework.stereotype.Controller;\nimport org.springframework.web.bind.annotation.GetMapping;\n@Controller class Users { @GetMapping String users() { return "ok"; } }', springAdapter);
  assert.equal(mvc.materialization.entities.filter((entity) => entity.ref.kind === "graphql_operation").length, 0);
  const missing = sourceCase("java", 'import org.springframework.stereotype.Controller;\n@Controller class Users { @QueryMapping String users() { return "ok"; } }', springAdapter);
  assert.equal(missing.materialization.entities.length, 0);
  const alias = sourceCase("kotlin", 'import org.springframework.stereotype.Controller\nimport org.springframework.graphql.data.method.annotation.QueryMapping as GraphQuery\n@Controller class Users { @GraphQuery fun users(): String = "ok" }', springAdapter);
  assert.equal(alias.materialization.entities.length, 0);
  const duplicate = sourceCase("java", 'import org.springframework.stereotype.Controller;\nimport org.springframework.graphql.data.method.annotation.QueryMapping;\n@Controller class First { @QueryMapping String users() { return "ok"; } }\n@Controller class Second { @QueryMapping String users() { return "ok"; } }', springAdapter);
  assert.equal(new Set(duplicate.evidence.flatMap((item) => item.entities.map((entity) => frameworkEntityKey(entity.ref)))).size, 1);
  assert.equal(duplicate.materialization.entities.length, 0);
  assert.ok(duplicate.materialization.diagnostics.some((item) => item.code === "framework_entity_identity_collision"));
});

function graphqlProjection() {
  const ref = { framework: "nestjs" as const, kind: "graphql_operation" as const, logicalKey: JSON.stringify(["root", "query", "users"]) };
  const provenance: FrameworkProvenance = { origin: "framework_inferred", framework: "nestjs", capability: "nestjs.graphql", adapterId: "nestjs",
    adapterVersion: "1.1.0", strategy: "resolver.operation", confidence: "exact", evidenceIds: ["query"], refs: [{ relativePath: "src/users.ts", inputKey: "facts:src/users.ts" }] };
  const entity: FrameworkEntity = { ref, displayName: "query.users", provenance };
  const relation = (nodeId: string): FrameworkRelationship => ({ outputKind: "relationship", source: { kind: "language", nodeId }, target: { kind: "framework", entity: ref }, relationKind: "graphql_resolver", provenance });
  const graph: CodeGraph = { nodes: [
    { id: "resolver", type: "method", name: "users", file: "src/users.ts" },
    { id: "other", type: "method", name: "users", file: "src/other.ts" },
    { id: "service", type: "method", name: "list", file: "src/service.ts" },
  ], edges: [{ from: "resolver", to: "service", type: "calls" }] };
  const projection = (relationships: FrameworkRelationship[], entities = [entity]) => projectFrameworkGraph(graph, {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", entities, relationships,
    classifications: [], diagnostics: [], coverage: [], config: [], detections: [], dependencies: [], complete: true,
  });
  return { ref, entity, relation, graph, projection };
}

test("catalog and execution_flow share the GraphQL ID, retain provenance, and traverse existing calls", () => {
  const fixture = graphqlProjection();
  const framework = fixture.projection([fixture.relation("resolver")]);
  const catalog = buildRepositoryEntryCatalog(framework);
  assert.equal(catalog.entries.length, 1);
  const entry = catalog.entries[0]!;
  assert.equal(entry.kind, "graphql");
  assert.equal(entry.id, frameworkEntityKey(fixture.ref));
  assert.equal("path" in entry, false);
  assert.equal("method" in entry, false);
  assert.deepEqual(entry.bindings.map((item) => [item.subjectId, item.bindingKind]), [["resolver", "callable"]]);
  assert.deepEqual(entry.bindings[0]?.provenance, fixture.entity.provenance);
  assert.equal(catalog.mayBeIncomplete, true);
  assert.ok(catalog.diagnostics.some((item) => item.code === "schema_unverified"));
  const flow = discoverExecutionFlow(fixture.graph, framework, { kind: "graphql", id: entry.id });
  assert.equal(flow.status, "resolved");
  assert.deepEqual(flow.edges.map((item) => item.kind), ["framework_entry", "call"]);
  assert.equal(flow.edges[0]?.kind === "framework_entry" && flow.edges[0].relation, "graphql_resolver");
  assert.equal(flow.mayBeIncomplete, true);
  assert.ok(flow.diagnostics.some((item) => item.code === "schema_unverified"));
  assert.deepEqual(filterRepositoryEntries(catalog.entries, { kind: "graphql", framework: "nestjs" }), catalog.entries);
  assert.deepEqual(filterRepositoryEntries(catalog.entries, { path: "/users" }), []);
  assert.deepEqual(filterRepositoryEntries(catalog.entries, { method: "GET" }), []);
});

test("GraphQL missing, ambiguous, and malformed selectors fail closed", () => {
  const fixture = graphqlProjection();
  const missing = fixture.projection([]);
  assert.equal(buildRepositoryEntryCatalog(missing).entries.length, 0);
  const missingFlow = discoverExecutionFlow(fixture.graph, missing, { kind: "graphql", id: frameworkEntityKey(fixture.ref) });
  assert.equal(missingFlow.status, "resolved");
  assert.ok(missingFlow.diagnostics.some((item) => item.code === "graphql_binding_missing"));
  const ambiguous = fixture.projection([fixture.relation("resolver"), fixture.relation("other")]);
  assert.equal(buildRepositoryEntryCatalog(ambiguous).entries.length, 0);
  assert.ok(buildRepositoryEntryCatalog(ambiguous).diagnostics.some((item) => item.code === "ambiguous_binding"));
  assert.equal(discoverExecutionFlow(fixture.graph, ambiguous, { kind: "graphql", id: frameworkEntityKey(fixture.ref) }).status, "ambiguous");
  assert.equal(discoverExecutionFlow(fixture.graph, ambiguous, { kind: "graphql", id: "bad-id" }).status, "not_found");
  const capabilitiesOnly = projectFrameworkGraph({ nodes: [], edges: [] }, {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.1.0", entities: [], relationships: [],
    classifications: [], diagnostics: [], coverage: [], config: [], dependencies: [], complete: false,
    detections: [{ framework: "nestjs", scope: "root", configured: true, observed: true, capabilities: ["nestjs.graphql"], refs: [], complete: true }],
  });
  assert.equal(buildRepositoryEntryCatalog(capabilitiesOnly).entries.length, 0);
  assert.equal(buildRepositoryEntryCatalog(capabilitiesOnly).mayBeIncomplete, true);
});

test("GraphQL catalog ordering and exact filters are stable across projection order", () => {
  const fixture = graphqlProjection();
  const mutationRef = { ...fixture.ref, logicalKey: JSON.stringify(["root", "mutation", "users"]) };
  const mutation: FrameworkEntity = { ...fixture.entity, ref: mutationRef, displayName: "mutation.users" };
  const mutationBinding: FrameworkRelationship = { ...fixture.relation("other"), target: { kind: "framework", entity: mutationRef } };
  const queryBinding = fixture.relation("resolver");
  const first = buildRepositoryEntryCatalog(fixture.projection([queryBinding, mutationBinding], [fixture.entity, mutation]));
  const second = buildRepositoryEntryCatalog(fixture.projection([mutationBinding, queryBinding], [mutation, fixture.entity]));
  assert.deepEqual(first, second);
  assert.deepEqual(first.entries.map((entry) => entry.kind === "graphql" ? [entry.operationKind, entry.fieldName] : []), [["mutation", "users"], ["query", "users"]]);
  assert.equal(filterRepositoryEntries(first.entries, { framework: "spring" }).length, 0);
  assert.equal(filterRepositoryEntries(first.entries, { kind: "graphql", framework: "nestjs" }).length, 2);
});
