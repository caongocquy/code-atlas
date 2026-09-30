import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("ordinary Next indexing publishes framework and reliability evidence for list_entries", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-reliability-json-next-"));
  const files = {
    "package.json": JSON.stringify({ dependencies: { next: "15.0.0", react: "19.0.0" } }),
    "app/users/page.tsx": "export default function Page() { return null; }\n",
    "app/api/health/route.ts": "export function GET() { return new Response('ok'); }\n",
  };
  try {
    for (const [relativePath, content] of Object.entries(files)) {
      await mkdir(path.dirname(path.join(repoPath, relativePath)), { recursive: true });
      await writeFile(path.join(repoPath, relativePath), content);
    }

    const indexed = await indexRepository(repoPath, { skipGit: true });
    if (indexed.kind !== "published") assert.fail(JSON.stringify(indexed));
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
    let generationId: string;
    try {
      generationId = store.getActiveGenerationId(indexed.repositoryId)!;
      assert.equal(generationId, indexed.generationId);
      const snapshot = store.loadFramework(indexed.repositoryId, generationId);
      assert.ok(snapshot?.entities.some((entity) => entity.ref.framework === "next" && entity.ref.kind === "route"));
      assert.ok(snapshot?.relationships.some((relationship) => relationship.relationKind === "route_binding"));
      const contributions = store.loadReliabilityContributions(indexed.repositoryId, generationId);
      assert.ok(contributions.length > 0);
      assert.ok(contributions.every((item) => !("language" in item.scope) && !("selectorKey" in item.scope)));
    } finally {
      store.close();
    }

    const loaded = await loadIndexedGraphReadOnly(repoPath);
    assert.equal(loaded.evidenceState.generationId, generationId);
    assert.ok(loaded.framework?.nodes.some((item) => item.kind === "framework" && item.entity.ref.framework === "next"));

    const server = createMcpServer();
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    const client = new Client({ name: "phase14d-reliability-json-next", version: "1.0.0" });
    try {
      await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
      const called = await client.callTool({ name: "list_entries", arguments: { repoPath, framework: "next", detail: "full" } });
      assert.equal(called.isError, undefined, JSON.stringify(called.structuredContent));
      const value = called.structuredContent as Record<string, unknown>;
      const entries = value.entries as Array<{ kind: string; framework: string; path: string; method: string | null; bindings: Array<{ bindingKind: string }> }>;
      assert.deepEqual(entries.map((entry) => entry.path), ["/api/health", "/users"]);
      assert.ok(entries.every((entry) => entry.kind === "web_route" && entry.framework === "next" && entry.method === null));
      assert.ok(entries.every((entry) => entry.bindings.every((binding) => binding.bindingKind === "file_boundary")));
      assert.deepEqual((value.projection as { entries: unknown }).entries, { total: 2, returned: 2, omitted: 0, truncated: false });
      assert.equal((value.evidenceState as { generationId: string }).generationId, generationId);
    } finally {
      await client.close();
      await server.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
