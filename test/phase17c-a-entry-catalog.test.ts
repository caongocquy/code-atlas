import assert from "node:assert/strict";
import test from "node:test";

import { decodeFrameworkRouteIdentity, frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import type { FrameworkEntity, FrameworkId, FrameworkProvenance, FrameworkRelationship, FrameworkSnapshot } from "../src/core/framework/framework.types.js";
import { projectFrameworkGraph } from "../src/core/graph/query/framework-query.service.js";
import type { FrameworkQueryProjection } from "../src/core/graph/query/framework-query.types.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import type { GraphNode } from "../src/core/graph/types.js";
import type { ReliabilityProjection } from "../src/core/reliability/reliability.types.js";
import { buildRepositoryEntryCatalog, filterRepositoryEntries } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";

function provenance(framework: FrameworkId, name: string): FrameworkProvenance {
  return {
    origin: "framework_inferred", framework, capability: `${framework}.routes`, adapterId: framework,
    adapterVersion: "1.0.0", strategy: name, confidence: "exact", evidenceIds: [name],
    refs: [{ relativePath: `${framework}/route.ts`, inputKey: `facts:${name}` }],
  };
}

function route(framework: FrameworkId, path: string, method: string | null, kind: "route" | "layout" = "route"): FrameworkEntity {
  const router = framework === "spring" ? "mvc" : framework === "next" ? "app" : "http";
  const logicalKey = JSON.stringify(["root", router, path, method, [], null]);
  return { ref: { framework, kind, logicalKey }, displayName: path, provenance: provenance(framework, `${framework}:${path}`) };
}

function binding(entity: FrameworkEntity, subjectId: string, relationKind: "controller_route" | "route_binding"): FrameworkRelationship {
  return {
    outputKind: "relationship", source: { kind: "language", nodeId: subjectId },
    target: { kind: "framework", entity: entity.ref }, relationKind,
    provenance: provenance(entity.ref.framework, `binding:${subjectId}`),
  };
}

function projection(nodes: GraphNode[], entities: FrameworkEntity[], relationships: FrameworkRelationship[], mayBeIncomplete = false): FrameworkQueryProjection {
  return {
    nodes: [...nodes.map((node) => ({ kind: "language" as const, node })), ...entities.map((entity) => ({ kind: "framework" as const, entity }))],
    edges: relationships.map((relationship) => ({ kind: "framework" as const, relationship })),
    classifications: [], diagnostics: [], coverage: [], mayBeIncomplete,
  };
}

test("accepted Nest and Spring controller methods become HTTP entries; Next remains a file-bound web route", () => {
  const nest = route("nestjs", "/z-users", "GET");
  const spring = route("spring", "/a-users", "POST");
  const page = route("next", "/users", null);
  const routeFile = route("next", "/api/users", null);
  const layout = route("next", "/users", null, "layout");
  const flutter = route("flutter", "/mobile", null);
  const nodes: GraphNode[] = [
    { id: "nest-handler", type: "method", name: "list", file: "nest/users.ts" },
    { id: "spring-handler", type: "method", name: "create", file: "spring/Users.java" },
    { id: "next-page", type: "file", name: "page.tsx", file: "app/users/page.tsx" },
    { id: "next-route", type: "file", name: "route.ts", file: "app/api/users/route.ts" },
    { id: "next-layout", type: "file", name: "layout.tsx", file: "app/users/layout.tsx" },
    { id: "flutter-screen", type: "method", name: "screen", file: "lib/screen.dart" },
  ];
  const entities = [routeFile, flutter, spring, layout, page, nest];
  const relationships = [
    binding(page, "next-page", "route_binding"), binding(nest, "nest-handler", "controller_route"),
    binding(layout, "next-layout", "route_binding"), binding(flutter, "flutter-screen", "route_binding"),
    binding(routeFile, "next-route", "route_binding"), binding(spring, "spring-handler", "controller_route"),
  ];
  const framework = projection(nodes, entities, relationships);
  const catalog = buildRepositoryEntryCatalog(framework);
  assert.deepEqual(catalog.entries.map((entry) => [entry.kind, entry.framework, entry.path, entry.method]), [
    ["http", "nestjs", "/z-users", "GET"], ["http", "spring", "/a-users", "POST"],
    ["web_route", "next", "/api/users", null], ["web_route", "next", "/users", null],
  ]);
  assert.deepEqual(catalog.entries.map((entry) => [entry.bindings[0]?.subjectId, entry.bindings[0]?.bindingKind]), [
    ["nest-handler", "callable"], ["spring-handler", "callable"],
    ["next-route", "file_boundary"], ["next-page", "file_boundary"],
  ]);
  assert.equal(catalog.entries[0]?.id, frameworkEntityKey(nest.ref));
  assert.deepEqual(catalog.entries[0]?.frameworkEntity, nest.ref);
  assert.deepEqual(catalog.entries[0]?.provenance, nest.provenance);
  assert.deepEqual(catalog.entries[0]?.bindings[0]?.provenance, relationships[1]?.provenance);
  assert.deepEqual(buildRepositoryEntryCatalog(projection([...nodes].reverse(), [...entities].reverse(), [...relationships].reverse())), catalog);

  for (const entry of catalog.entries.slice(0, 2)) {
    const flow = discoverExecutionFlow({ nodes, edges: [] }, framework, {
      kind: "route", framework: entry.framework, path: entry.path, method: entry.method,
      scope: entry.scope, router: entry.router, owner: entry.owner, conditions: [...entry.conditions],
    });
    assert.equal(flow.status, "resolved");
    assert.equal(flow.edges[0]?.kind, "framework_entry");
  }
  const nextFlow = discoverExecutionFlow({ nodes, edges: [] }, framework, { kind: "route", framework: "next", path: "/users", method: null });
  assert.ok(nextFlow.diagnostics.some((item) => item.code === "file_bound_route"));
  assert.equal(nextFlow.edges.some((edge) => edge.kind === "call"), false);
});

test("exact filters retain semantic order and never invent a Next HTTP method", () => {
  const nest = route("nestjs", "/users", "GET");
  const next = route("next", "/users", null);
  const entries = buildRepositoryEntryCatalog(projection(
    [{ id: "handler", type: "function", name: "handler", file: "nest/users.ts" }, { id: "page", type: "file", name: "page", file: "app/users/page.tsx" }],
    [next, nest], [binding(next, "page", "route_binding"), binding(nest, "handler", "controller_route")],
  )).entries;
  assert.deepEqual(filterRepositoryEntries(entries, { kind: "http", path: "/users", method: "get" }).map((entry) => entry.framework), ["nestjs"]);
  assert.deepEqual(filterRepositoryEntries(entries, { framework: "next", method: "GET" }), []);
  assert.deepEqual(filterRepositoryEntries(entries, { kind: "web_route", framework: "next", path: "/users" }).map((entry) => entry.framework), ["next"]);
  assert.deepEqual(filterRepositoryEntries(entries, { path: "/missing" }), []);
});

test("missing, unsupported, and multiple bindings are diagnosed without guessing a callable", () => {
  const ambiguous = route("nestjs", "/ambiguous", "GET");
  const missing = route("spring", "/missing", "GET");
  const wrongType = route("nestjs", "/class", "GET");
  const next = route("next", "/bad-next", null);
  const nodes: GraphNode[] = [
    { id: "b", type: "method", name: "b", file: "nest/b.ts" },
    { id: "a", type: "method", name: "a", file: "nest/a.ts" },
    { id: "class", type: "class", name: "class", file: "nest/class.ts" },
    { id: "next-method", type: "method", name: "GET", file: "app/bad-next/route.ts" },
  ];
  const catalog = buildRepositoryEntryCatalog(projection(nodes, [ambiguous, missing, wrongType, next], [
    binding(ambiguous, "b", "controller_route"), binding(ambiguous, "a", "controller_route"),
    binding(wrongType, "class", "controller_route"), binding(next, "next-method", "route_binding"),
  ]));
  assert.deepEqual(catalog.entries.map((entry) => entry.path), ["/ambiguous"]);
  assert.deepEqual(catalog.entries[0]?.bindings.map((item) => item.subjectId), ["a", "b"]);
  assert.ok(catalog.diagnostics.some((item) => item.code === "ambiguous_binding" && item.entityId === frameworkEntityKey(ambiguous.ref)));
  assert.ok(catalog.diagnostics.some((item) => item.code === "binding_missing" && item.entityId === frameworkEntityKey(missing.ref)));
  assert.ok(catalog.diagnostics.some((item) => item.code === "unsupported_binding" && item.entityId === frameworkEntityKey(wrongType.ref)));
  assert.ok(catalog.diagnostics.some((item) => item.code === "unsupported_binding" && item.entityId === frameworkEntityKey(next.ref)));
  assert.equal(catalog.mayBeIncomplete, true);
});

test("detection capabilities alone cannot create entries; framework incompleteness and reliability propagate", () => {
  const snapshot: FrameworkSnapshot = {
    repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0",
    entities: [], relationships: [], classifications: [], diagnostics: [], coverage: [], config: [], dependencies: [], complete: true,
    detections: [{ framework: "nestjs", scope: "root", configured: true, observed: true, capabilities: ["nestjs.routes"], refs: [], complete: true }],
  };
  const capabilityOnly = buildRepositoryEntryCatalog(projectFrameworkGraph({ nodes: [], edges: [] }, snapshot));
  assert.deepEqual(capabilityOnly.entries, []);
  assert.equal(capabilityOnly.mayBeIncomplete, true);

  const nest = route("nestjs", "/health", "GET");
  const reliability = {
    scope: { scopeKey: "test", capability: "framework_repository" }, outcome: "unknown", complete: false, stale: true,
    authoritative: false, authoritativeNegative: false,
    coverage: { applicable: 1, supported: 1, attempted: 1, resolved: 0, ambiguous: 0, unknown: 1, unsupported: 0, budgetExhausted: 0 },
    diagnosticCodes: [], evidenceSummary: { total: 0, origins: [] },
  } satisfies ReliabilityProjection;
  const incomplete = { ...projection([{ id: "handler", type: "method", name: "health", file: "nest/health.ts" }], [nest], [binding(nest, "handler", "controller_route")], true), reliability };
  const catalog = buildRepositoryEntryCatalog(incomplete);
  assert.equal(catalog.entries.length, 1);
  assert.equal(catalog.mayBeIncomplete, true);
  assert.deepEqual(catalog.frameworkReliability, reliability);
  assert.equal(buildRepositoryEntryCatalog(undefined).mayBeIncomplete, true);
});

test("shared route decoder requires the existing canonical six-field identity", () => {
  const ref = route("nestjs", "/health", "GET").ref;
  assert.deepEqual(decodeFrameworkRouteIdentity(ref), ["root", "http", "/health", "GET", [], null]);
  assert.deepEqual(decodeFrameworkRouteIdentity(route("next", "/users", null).ref), ["root", "app", "/users", null, [], null]);
  for (const invalid of [
    ["root", "http", "/health", "GET", []],
    ["/root", "http", "/health", "GET", [], null],
    ["root", "../http", "/health", "GET", [], null],
    ["root", "http", "/bad//path", "GET", [], null],
    ["root", "http", "/health", "", [], null],
    ["root", "http", "/health", "GET", ["z", "a"], null],
    ["root", "http", "/health", "GET", ["a", "a"], null],
    ["root", "http", "/health", "GET", [], 1],
  ]) {
    assert.equal(decodeFrameworkRouteIdentity({ ...ref, logicalKey: JSON.stringify(invalid) }), undefined);
  }
});
