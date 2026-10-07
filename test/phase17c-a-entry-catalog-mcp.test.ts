import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer, projectRepositoryEntryCatalogResponse } from "../src/adapters/mcp/mcp-server.js";
import { GRAPH_INDEX_VERSION } from "../src/config/constants.js";
import type { FrameworkId, FrameworkMaterialization, FrameworkProvenance } from "../src/core/framework/framework.types.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { createCandidateGeneration } from "../src/core/indexing/index-manifest.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import type { RepositoryEntryCatalog } from "../src/core/graph/intelligence/repository-entry-catalog.types.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

test("entry projection counts the filtered collection exactly and preserves order across detail modes", () => {
  const entries = [
    { id: "nest", kind: "http", framework: "nestjs", path: "/a", method: "GET" },
    { id: "spring", kind: "http", framework: "spring", path: "/b", method: "POST" },
    { id: "next", kind: "web_route", framework: "next", path: "/c", method: null },
  ] as RepositoryEntryCatalog["entries"];
  const catalog: RepositoryEntryCatalog = { entries, diagnostics: [], frameworkDiagnostics: [], mayBeIncomplete: false };
  const compact = projectRepositoryEntryCatalogResponse(catalog, {}, "compact", 2);
  const full = projectRepositoryEntryCatalogResponse(catalog, {}, "full");
  assert.deepEqual((compact.entries as typeof entries).map((entry) => entry.id), ["nest", "spring"]);
  assert.deepEqual((full.entries as typeof entries).map((entry) => entry.id), ["nest", "spring", "next"]);
  assert.deepEqual((compact.projection as { entries: unknown }).entries, { total: 3, returned: 2, omitted: 1, truncated: true });
  assert.deepEqual((full.projection as { entries: unknown }).entries, { total: 3, returned: 3, omitted: 0, truncated: false });
  assert.equal(compact.mayBeIncomplete, true);
  assert.equal(full.mayBeIncomplete, false);
  for (const [filters, ids] of [
    [{ kind: "http" as const }, ["nest", "spring"]],
    [{ framework: "next" as const }, ["next"]],
    [{ path: "/b" }, ["spring"]],
    [{ method: "get" }, ["nest"]],
    [{ method: "DELETE" }, []],
  ] as const) {
    const result = projectRepositoryEntryCatalogResponse(catalog, filters, "compact");
    assert.deepEqual((result.entries as typeof entries).map((entry) => entry.id), ids);
    assert.equal((result.projection as { entries: { total: number } }).entries.total, ids.length);
  }
});

test("list_entries carries evidence from its IndexedGraph without inventing entries", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-phase17c-entry-"));
  await writeFile(path.join(repoPath, "source.ts"), "export function source() { return 1; }\n");
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase17c-entry-client", version: "1.0.0" });
  try {
    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    const tool = listed.tools.find((item) => item.name === "list_entries");
    assert.ok(tool);
    assert.deepEqual(tool.annotations, { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false });
    assert.equal("cursor" in (tool.inputSchema.properties ?? {}), false);
    const result = payload(await client.callTool({ name: "list_entries", arguments: { repoPath, framework: "next", detail: "full" } }));
    assert.deepEqual(result.entries, []);
    assert.deepEqual((result.projection as { entries: unknown }).entries, { total: 0, returned: 0, omitted: 0, truncated: false });
    assert.equal(typeof (result.evidenceState as { generationId?: unknown }).generationId, "string");
    const method = payload(await client.callTool({ name: "list_entries", arguments: { repoPath, framework: "next", method: "GET" } }));
    assert.deepEqual(method.entries, []);
    assert.deepEqual((method.projection as { entries: unknown }).entries, { total: 0, returned: 0, omitted: 0, truncated: false });
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("list_entries reads persisted Next file and Nest callable routes through IndexedGraph", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-phase17c-persisted-entry-"));
  const files = {
    "app/users/page.tsx": "export default function Page() { return null; }\n",
    "src/health.ts": "export function health() { return true; }\n",
  };
  const provenance = (framework: FrameworkId, relativePath: string): FrameworkProvenance => ({
    origin: "framework_inferred", framework, capability: `${framework}.routes`, adapterId: `${framework}-fixture`,
    adapterVersion: "1.0.0", strategy: "accepted-route", confidence: "exact", evidenceIds: [`evidence:${framework}`],
    refs: [{ relativePath, inputKey: `facts:${relativePath}` }],
  });
  const nextRef = { framework: "next" as const, kind: "route" as const, logicalKey: JSON.stringify(["root", "app", "/users", null, [], null]) };
  const nestRef = { framework: "nestjs" as const, kind: "route" as const, logicalKey: JSON.stringify(["root", "http", "/health", "GET", [], null]) };
  const framework: FrameworkMaterialization = {
    frameworkResolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion!, complete: true,
    entities: [
      { ref: nextRef, displayName: "/users", provenance: provenance("next", "app/users/page.tsx") },
      { ref: nestRef, displayName: "/health", provenance: provenance("nestjs", "src/health.ts") },
    ],
    relationships: [
      { outputKind: "relationship", source: { kind: "language", nodeId: "next-file" }, target: { kind: "framework", entity: nextRef }, relationKind: "route_binding", provenance: provenance("next", "app/users/page.tsx") },
      { outputKind: "relationship", source: { kind: "language", nodeId: "nest-handler" }, target: { kind: "framework", entity: nestRef }, relationKind: "controller_route", provenance: provenance("nestjs", "src/health.ts") },
    ],
    classifications: [], diagnostics: [], coverage: [], config: [], detections: [], dependencies: [],
  };
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase17c-persisted-entry-client", version: "1.0.0" });
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repoPath, relativePath)), { recursive: true });
      await writeFile(path.join(repoPath, relativePath), content);
    }
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    const generation = createCandidateGeneration(repository.id, undefined, CURRENT_INDEX_VERSION_DOMAINS, []);
    try {
      store.beginCandidateGeneration(generation);
      store.writeCandidateManifest(generation.manifest);
      store.writeCandidateGraph(generation.id, { nodes: [
        { id: "next-file", type: "file", name: "page.tsx", file: "app/users/page.tsx" },
        { id: "nest-handler", type: "function", name: "health", file: "src/health.ts" },
      ], edges: [] }, new Map(Object.entries(files).map(([file, content]) => [file, createFileHash(content)])));
      store.writeCandidateFramework(generation.id, framework);
      store.publishCandidateGeneration(generation.id, {
        requireGraph: true, graphStaged: true, frameworkStaged: true,
        versions: { graph: GRAPH_INDEX_VERSION },
        fileStates: Object.entries(files).map(([file, content]) => ({
          file, capability: "graph" as const,
          input: { version: GRAPH_INDEX_VERSION, state: "ready" as const, itemCount: 1, fileHash: createFileHash(content) },
        })),
      });
      assert.equal(store.getActiveGenerationId(repository.id), generation.id);
    } finally {
      store.close();
    }
    const loaded = await loadIndexedGraphReadOnly(repoPath);
    assert.equal(loaded.evidenceState.generationId, generation.id);
    assert.equal(loaded.framework?.nodes.filter((item) => item.kind === "framework").length, 2);
    assert.equal(loaded.framework?.edges.filter((item) => item.kind === "framework").length, 2);

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = payload(await client.callTool({ name: "list_entries", arguments: { repoPath, detail: "full" } }));
    assert.equal((result.evidenceState as { generationId: string }).generationId, generation.id);
    assert.deepEqual((result.projection as { entries: unknown }).entries, { total: 2, returned: 2, omitted: 0, truncated: false });
    const entries = result.entries as Array<Record<string, unknown>>;
    assert.deepEqual(entries.map((entry) => [entry.kind, entry.framework, entry.path]), [
      ["http", "nestjs", "/health"], ["web_route", "next", "/users"],
    ]);
    const [nest, next] = entries;
    assert.equal(nest?.method, "GET");
    assert.deepEqual((nest?.bindings as Array<{ subjectId: string; bindingKind: string }>).map(({ subjectId, bindingKind }) => [subjectId, bindingKind]), [["nest-handler", "callable"]]);
    assert.equal(next?.method, null);
    assert.deepEqual((next?.bindings as Array<{ subjectId: string; bindingKind: string }>).map(({ subjectId, bindingKind }) => [subjectId, bindingKind]), [["next-file", "file_boundary"]]);
    const routeSelector = (entry: Record<string, unknown>) => ({
      kind: "route", framework: entry.framework, path: entry.path, method: entry.method,
      scope: entry.scope, router: entry.router, owner: entry.owner, conditions: entry.conditions,
    });
    const nestFlow = payload(await client.callTool({ name: "execution_flow", arguments: { repoPath, entry: routeSelector(nest!) } }));
    assert.equal(nestFlow.status, "resolved");
    assert.ok((nestFlow.edges as Array<{ kind: string }>).some((edge) => edge.kind === "framework_entry"));
    const nextFlow = payload(await client.callTool({ name: "execution_flow", arguments: { repoPath, entry: routeSelector(next!) } }));
    assert.ok((nextFlow.diagnostics as Array<{ code: string }>).some((item) => item.code === "file_bound_route"));
    assert.equal((nextFlow.edges as Array<{ kind: string }>).some((edge) => edge.kind === "call"), false);
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
