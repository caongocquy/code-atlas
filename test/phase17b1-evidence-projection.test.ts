import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { buildRepositoryMap } from "../src/core/graph/intelligence/repository-map.service.js";
import { emptyResolutionCoverage } from "../src/core/graph/resolution.types.js";
import type { CodeGraph } from "../src/core/graph/types.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { parseArchitecturePolicy } from "../src/core/architecture/architecture-policy.js";
import { buildRepositoryEvidenceState } from "../src/core/repository/repository-evidence-state.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { exactProjectionCount, projectKnownCollection } from "../src/core/projection/known-collection.js";
import { GRAPH_INDEX_VERSION } from "../src/config/constants.js";
import { createMcpServer, projectRepositoryMapResponse } from "../src/adapters/mcp/mcp-server.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("freshness and completeness remain independent for ready, stale, and unknown status", () => {
  const coverage = emptyResolutionCoverage();
  const ready = buildRepositoryEvidenceState("repo", "generation", { status: "ready", resolutionCoverage: coverage, updatedAt: "2026-01-01" }, false);
  assert.equal(ready.freshness, "current");
  assert.equal(ready.mayBeIncomplete, false);
  assert.deepEqual(ready.reasons, []);
  assert.equal(ready.updatedAt, "2026-01-01");

  const currentIncomplete = buildRepositoryEvidenceState("repo", "generation", { status: "ready", resolutionCoverage: { ...coverage, mayBeIncomplete: true } }, false);
  assert.equal(currentIncomplete.freshness, "current");
  assert.equal(currentIncomplete.mayBeIncomplete, true);
  assert.deepEqual(currentIncomplete.reasons, ["graph_resolution_incomplete"]);

  const staleComplete = buildRepositoryEvidenceState("repo", "generation", { status: "stale", resolutionCoverage: coverage }, false);
  assert.equal(staleComplete.freshness, "stale");
  assert.equal(staleComplete.capabilityState, "stale");
  assert.equal(staleComplete.mayBeIncomplete, false);
  assert.deepEqual(staleComplete.reasons, ["graph_stale"]);

  const staleIncomplete = buildRepositoryEvidenceState("repo", "generation", { status: "stale", resolutionCoverage: coverage }, true);
  assert.equal(staleIncomplete.freshness, "stale");
  assert.equal(staleIncomplete.mayBeIncomplete, true);
  assert.deepEqual(staleIncomplete.reasons, ["graph_stale", "framework_incomplete"]);

  const unknown = buildRepositoryEvidenceState("repo", undefined, { status: "not_indexed", resolutionCoverage: coverage }, false);
  assert.equal(unknown.freshness, "unknown");
  assert.equal(unknown.generationId, undefined);
  assert.deepEqual(unknown.reasons, ["graph_freshness_unknown", "generation_unavailable"]);
});

test("indexed graph exposes the published generation and current source freshness", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17b1-evidence-"));
  try {
    await writeFile(path.join(repoPath, "flow.c"), "int source() { return 1; }\n");
    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));

    const loaded = await loadIndexedGraphReadOnly(repoPath);
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
    const generationId = store.getActiveGenerationId(loaded.repoId);
    store.close();
    assert.ok(generationId);
    assert.equal(loaded.evidenceState?.repositoryId, loaded.repoId);
    assert.equal(loaded.evidenceState?.generationId, generationId);
    assert.equal(loaded.evidenceState?.freshness, "current");
    assert.equal(loaded.evidenceState?.capabilityState, "ready");

    await writeFile(path.join(repoPath, "flow.c"), "int source() { return 2; }\n");
    const stale = await loadIndexedGraphReadOnly(repoPath);
    assert.equal(stale.evidenceState.freshness, "stale");
    assert.equal(stale.evidenceState.generationId, generationId);
    assert.equal(stale.mayBeIncomplete, true);

    const republished = await indexRepository(repoPath, { skipGit: true });
    assert.equal(republished.kind, "published", JSON.stringify(republished));
    const refreshed = await loadIndexedGraphReadOnly(repoPath);
    assert.notEqual(refreshed.evidenceState.generationId, generationId);
    assert.equal(refreshed.evidenceState.generationId, republished.generationId);
    assert.equal(refreshed.evidenceState.freshness, "current");
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("legacy graph evidence reports unavailable generation without manufacturing an identity", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17b1-legacy-"));
  const source = "export function source() { return true; }\n";
  try {
    await writeFile(path.join(repoPath, "source.ts"), source);
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"));
    const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
    store.replaceGraph(repository.id, {
      nodes: [{ id: "source", type: "function", name: "source", file: "source.ts" }],
      edges: [],
    }, new Map([["source.ts", createFileHash(source)]]), GRAPH_INDEX_VERSION);
    store.close();

    const loaded = await loadIndexedGraphReadOnly(repoPath);
    assert.equal(loaded.graph.nodes[0]?.id, "source");
    assert.equal(loaded.evidenceState.generationId, undefined);
    assert.ok(loaded.evidenceState.reasons.includes("generation_unavailable"));
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("repository map reports exact area, relation, file, and diagnostic path omissions", () => {
  const nodes: CodeGraph["nodes"] = [
    { id: "a1", type: "function", name: "a1", file: "src/a/one.ts" },
    { id: "a2", type: "function", name: "a2", file: "src/a/two.ts" },
    { id: "b1", type: "function", name: "b1", file: "src/b/one.ts" },
    { id: "b2", type: "function", name: "b2", file: "src/b/two.ts" },
    { id: "c1", type: "function", name: "c1", file: "src/c/one.ts" },
    { id: "shared", type: "function", name: "shared", file: "src/shared/mix.ts" },
    ...Array.from({ length: 22 }, (_, index) => ({ id: `orphan${index}`, type: "function" as const, name: `orphan${index}`, file: `src/orphan/${String(index).padStart(2, "0")}.ts` })),
  ];
  const graph: CodeGraph = { nodes, edges: [
    { from: "a1", to: "b1", type: "calls" },
    { from: "a2", to: "b2", type: "imports" },
    { from: "a2", to: "c1", type: "imports" },
    { from: "b1", to: "c1", type: "references" },
  ] };
  const policy = parseArchitecturePolicy({ version: 1, architecture: { groups: [
    { id: "a", include: ["src/a/**", "src/shared/**"] },
    { id: "b", include: ["src/b/**", "src/shared/**"] },
    { id: "c", include: ["src/c/**"] },
  ] } });
  const map = buildRepositoryMap(graph, policy);
  const compact = projectRepositoryMapResponse(map, "compact", { maxAreas: 2, maxFilesPerArea: 1, maxRelations: 1 });
  const full = projectRepositoryMapResponse(map, "full", { maxAreas: 3, maxFilesPerArea: 100, maxRelations: 3 });

  assert.deepEqual(compact.projection?.areas, { total: 3, returned: 2, omitted: 1, truncated: true });
  assert.deepEqual(compact.projection?.relations, { total: 3, returned: 1, omitted: 2, truncated: true });
  assert.deepEqual((compact.relations as Array<{ projection?: { representativeEdges: unknown } }>)[0]?.projection?.representativeEdges,
    { total: 2, returned: 1, omitted: 1, truncated: true });
  assert.deepEqual((compact.areas as Array<{ id: string; projection: { files: unknown } }>).map((area) => [area.id, area.projection.files]), [
    ["a", { total: 2, returned: 1, omitted: 1, truncated: true }],
    ["b", { total: 2, returned: 1, omitted: 1, truncated: true }],
  ]);
  const compactDiagnostics = compact.diagnostics as { ambiguousFiles: { projection: unknown }; unclassifiedFiles: { projection: unknown } };
  assert.deepEqual(compactDiagnostics.ambiguousFiles.projection, { total: 1, returned: 1, omitted: 0, truncated: false });
  assert.deepEqual(compactDiagnostics.unclassifiedFiles.projection, { total: 22, returned: 20, omitted: 2, truncated: true });
  for (const count of [compact.projection?.areas, compact.projection?.relations, compactDiagnostics.ambiguousFiles.projection, compactDiagnostics.unclassifiedFiles.projection]) {
    const value = count as { total: number; returned: number; omitted: number; truncated: boolean };
    assert.equal(value.returned + value.omitted, value.total);
    assert.equal(value.truncated, value.omitted > 0);
  }

  assert.deepEqual(full.projection?.areas, { total: 3, returned: 3, omitted: 0, truncated: false });
  assert.deepEqual(full.projection?.relations, { total: 3, returned: 3, omitted: 0, truncated: false });
  assert.deepEqual((full.relations as Array<{ projection?: { representativeEdges: unknown } }>)[0]?.projection?.representativeEdges,
    { total: 2, returned: 2, omitted: 0, truncated: false });
  assert.deepEqual((full.diagnostics as { unclassifiedFiles: { projection: unknown } }).unclassifiedFiles.projection, { total: 22, returned: 22, omitted: 0, truncated: false });
  assert.deepEqual((full.areas as Array<{ id: string }>).map((area) => area.id), ["a", "b", "c"]);
  assert.deepEqual((full.relations as Array<{ sourceAreaId: string; targetAreaId: string }>).map((relation) => [relation.sourceAreaId, relation.targetAreaId]), [["a", "b"], ["a", "c"], ["b", "c"]]);
  assert.deepEqual((compact.relations as Array<{ sourceAreaId: string; targetAreaId: string }>).map((relation) => [relation.sourceAreaId, relation.targetAreaId]), [["a", "b"]]);
  assert.deepEqual((compact.areas as Array<{ id: string; fileCount: number; symbolCount: number }>).map(({ id, fileCount, symbolCount }) => [id, fileCount, symbolCount]),
    (full.areas as Array<{ id: string; fileCount: number; symbolCount: number }>).slice(0, 2).map(({ id, fileCount, symbolCount }) => [id, fileCount, symbolCount]));
});

test("known collection projection distinguishes semantic order from canonical sort", () => {
  const source = ["z", "a", "m"];
  const preserved = projectKnownCollection(source, 2, { kind: "preserve" });
  const sorted = projectKnownCollection(source, 2, { kind: "canonical-sort", compare: (left, right) => left.localeCompare(right) });
  assert.deepEqual(preserved.items, ["z", "a"]);
  assert.deepEqual(sorted.items, ["a", "m"]);
  assert.deepEqual(source, ["z", "a", "m"]);
  assert.deepEqual(preserved.count, { total: 3, returned: 2, omitted: 1, truncated: true });
  assert.deepEqual(exactProjectionCount(3, 3), { total: 3, returned: 3, omitted: 0, truncated: false });
  assert.throws(() => exactProjectionCount(2, 3), RangeError);
});

test("future continuation identity binds generation, normalized input, operation, ordering, and projection version", async () => {
  const { buildContinuationIdentity } = await import("../src/core/projection/continuation-identity.js");
  const input = {
    repositoryId: "repo-1",
    generationId: "generation-1",
    operation: "repository_map",
    normalizedSemanticInput: '{"groups":["api"]}',
    orderingIdentity: "preserve/area-v1",
    projectionVersion: "repository-map-v1",
  };
  const identity = buildContinuationIdentity(input);
  assert.deepEqual(identity, input);
  assert.deepEqual(buildContinuationIdentity({ ...input }), identity);
  for (const change of [
    { generationId: "generation-2" },
    { normalizedSemanticInput: '{"groups":["service"]}' },
    { operation: "execution_flow" },
    { orderingIdentity: "canonical-sort/area-v1" },
    { projectionVersion: "repository-map-v2" },
  ]) {
    assert.notDeepEqual(buildContinuationIdentity({ ...input, ...change }), identity);
  }
  assert.equal(buildContinuationIdentity({ ...input, generationId: undefined }), undefined);
});

test("execution flow and repository map expose the same generation evidence without inventing flow totals", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase17b1-mcp-"));
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase17b1-evidence-client", version: "1.0.0" });
  try {
    await writeFile(path.join(repoPath, "flow.c"), [
      "int service() { return 1; }",
      "int handler() { return service(); }",
    ].join("\n"));
    const first = await indexRepository(repoPath, { skipGit: true });
    assert.equal(first.kind, "published", JSON.stringify(first));
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listed = await client.listTools();
    for (const toolName of ["execution_flow", "repository_map"]) {
      const tool = listed.tools.find((item) => item.name === toolName);
      assert.ok(tool);
      assert.equal("cursor" in (tool.inputSchema.properties ?? {}), false);
    }

    const call = async (name: string, args: Record<string, unknown>) => {
      const result = await client.callTool({ name, arguments: { repoPath, ...args } });
      assert.ok(result.structuredContent && typeof result.structuredContent === "object");
      return result.structuredContent as Record<string, unknown>;
    };
    const flow = await call("execution_flow", { entry: "handler", maxNodes: 1, detail: "compact" });
    const map = await call("repository_map", { maxAreas: 1, detail: "compact" });
    assert.ok(flow.evidenceState);
    assert.ok(map.evidenceState);
    assert.deepEqual(flow.evidenceState, map.evidenceState);
    assert.equal((flow.evidenceState as { generationId: string }).generationId, first.generationId);
    assert.equal((flow.evidenceState as { freshness: string }).freshness, "current");
    assert.equal(flow.truncated, true);
    assert.deepEqual(flow.truncatedBy, ["maxNodes"]);
    assert.ok((flow.knownOmittedNodes as number) > 0);
    assert.equal("projection" in flow, false);
    assert.equal("totalNodeCount" in flow, false);
    assert.equal((map.projection as { areas: { total: number; returned: number; omitted: number } }).areas.total >= 1, true);

    const depthBound = await call("execution_flow", { entry: "handler", maxDepth: 0, maxNodes: 10 });
    assert.deepEqual(depthBound.truncatedBy, ["maxDepth"]);
    assert.equal("projection" in depthBound, false);

    const full = await call("execution_flow", { entry: "handler", maxNodes: 1, detail: "full" });
    assert.deepEqual((flow.nodes as Array<{ id: string }>).map((node) => node.id), (full.nodes as Array<{ id: string }>).map((node) => node.id));
    assert.deepEqual(flow.truncatedBy, full.truncatedBy);

    await writeFile(path.join(repoPath, "flow.c"), [
      "int service() { return 2; }",
      "int handler() { return service(); }",
    ].join("\n"));
    const staleFlow = await call("execution_flow", { entry: "handler" });
    const staleMap = await call("repository_map", {});
    assert.deepEqual(staleFlow.evidenceState, staleMap.evidenceState);
    assert.equal((staleFlow.evidenceState as { freshness: string }).freshness, "stale");
    assert.equal(staleFlow.mayBeIncomplete, true);
    assert.equal(staleMap.mayBeIncomplete, true);
    assert.equal((staleFlow.evidenceState as { generationId: string }).generationId, first.generationId);

    const second = await indexRepository(repoPath, { skipGit: true });
    assert.equal(second.kind, "published", JSON.stringify(second));
    const refreshedFlow = await call("execution_flow", { entry: "handler" });
    const refreshedMap = await call("repository_map", {});
    assert.deepEqual(refreshedFlow.evidenceState, refreshedMap.evidenceState);
    assert.equal((refreshedFlow.evidenceState as { generationId: string }).generationId, second.generationId);
    assert.notEqual(second.generationId, first.generationId);
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
