import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";

import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import { planFrameworkInvalidation } from "../src/core/framework/framework-invalidation.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

test("real Spring source reaches persisted GraphQL list_entries and same-ID execution_flow", async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-phase17c-b1-source-"));
  const server = createMcpServer();
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: "phase17c-b1-client", version: "1.0.0" });
  try {
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "UsersResolver.java"), [
      "import org.springframework.stereotype.Controller;",
      "import org.springframework.graphql.data.method.annotation.QueryMapping;",
      "@Controller",
      "public class UsersResolver {",
      "  @QueryMapping",
      "  public String users() { return listUsers(); }",
      '  public String listUsers() { return "ok"; }',
      "}",
      "",
    ].join("\n"));

    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    const loaded = await loadIndexedGraphReadOnly(repoPath);
    const generationId = loaded.evidenceState.generationId;
    assert.equal(typeof generationId, "string");
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
    try {
      const snapshot = store.loadFramework(getRepositoryIdentity(repoPath).id, generationId);
      assert.ok(snapshot);
      assert.equal(snapshot.frameworkResolutionVersion, FRAMEWORK_RESOLUTION_VERSION);
      assert.equal(snapshot.entities.length, 1);
      assert.equal(snapshot.relationships.length, 1);
      assert.equal(snapshot.relationships[0]?.relationKind, "graphql_resolver");
      assert.equal(snapshot.relationships[0]?.target.kind, "framework");
      assert.equal(snapshot.relationships[0]?.source.kind, "language");
      assert.deepEqual(snapshot.relationships[0]?.target.kind === "framework" ? snapshot.relationships[0].target.entity : undefined, snapshot.entities[0]?.ref);
      assert.deepEqual(snapshot.relationships[0]?.provenance, snapshot.entities[0]?.provenance);
    } finally {
      store.close();
    }

    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const result = payload(await client.callTool({ name: "list_entries", arguments: { repoPath, kind: "graphql", detail: "full" } }));
    const entries = result.entries as Array<Record<string, unknown>>;
    assert.equal(entries.length, 1, JSON.stringify(result));
    const entry = entries[0]!;
    assert.equal(entry.kind, "graphql");
    assert.equal(entry.framework, "spring");
    assert.equal(entry.operationKind, "query");
    assert.equal(entry.fieldName, "users");
    assert.equal(entry.exposure, "declared_mapping");
    assert.equal("path" in entry, false);
    assert.equal("method" in entry, false);
    assert.equal(entry.id, frameworkEntityKey(entry.frameworkEntity as Parameters<typeof frameworkEntityKey>[0]));
    const bindings = entry.bindings as Array<{ subjectId: string; bindingKind: string; provenance: { origin: string } }>;
    assert.equal(bindings.length, 1);
    assert.equal(bindings[0]?.bindingKind, "callable");
    assert.equal(bindings[0]?.provenance.origin, "framework_inferred");
    assert.equal(loaded.graph.nodes.find((node) => node.id === bindings[0]?.subjectId)?.name, "users");
    assert.equal((result.evidenceState as { generationId: string }).generationId, generationId);
    assert.deepEqual((result.projection as { entries: unknown }).entries, { total: 1, returned: 1, omitted: 0, truncated: false });
    assert.equal(result.mayBeIncomplete, true);
    assert.ok((result.diagnostics as Array<{ code: string }>).some((item) => item.code === "schema_unverified"));

    const flow = payload(await client.callTool({ name: "execution_flow", arguments: {
      repoPath, entry: { kind: "graphql", id: entry.id }, detail: "full",
    } }));
    assert.equal(flow.status, "resolved", JSON.stringify(flow));
    assert.equal((flow.evidenceState as { generationId: string }).generationId, generationId);
    assert.equal(frameworkEntityKey((flow.resolution as { entity: { ref: Parameters<typeof frameworkEntityKey>[0] } }).entity.ref), entry.id);
    assert.equal((flow.edges as Array<{ kind: string; relation?: string; provenance?: { origin: string } }>)[0]?.relation, "graphql_resolver");
    assert.equal((flow.edges as Array<{ provenance?: { origin: string } }>)[0]?.provenance?.origin, "framework_inferred");
    assert.ok((flow.terminals as Array<{ reason: string }>).some((item) => item.reason === "no_calls"));
    assert.equal(flow.mayBeIncomplete, true);

    const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
    const database = new DatabaseSync(databasePath);
    try {
      const entityRow = database.prepare("SELECT entity_key, payload_json FROM generation_framework_entities WHERE generation_id = ?").get(generationId) as { entity_key: string; payload_json: string };
      const relationRow = database.prepare("SELECT output_key, payload_json FROM generation_framework_relationships WHERE generation_id = ?").get(generationId) as { output_key: string; payload_json: string };
      assert.equal(entityRow.entity_key, entry.id);
      const reloaded = () => {
        const readOnly = new AtlasStore(databasePath, { readOnly: true });
        try { return readOnly.loadFramework(getRepositoryIdentity(repoPath).id, generationId); }
        finally { readOnly.close(); }
      };
      database.prepare("UPDATE generation_framework_entities SET payload_json = ? WHERE generation_id = ? AND entity_key = ?")
        .run(JSON.stringify({ ...JSON.parse(entityRow.payload_json), ref: { framework: "spring", kind: "graphql_operation", logicalKey: '["root","subscription","users"]' } }), generationId, entityRow.entity_key);
      assert.equal(reloaded(), undefined);
      database.prepare("UPDATE generation_framework_entities SET payload_json = ? WHERE generation_id = ? AND entity_key = ?")
        .run(entityRow.payload_json, generationId, entityRow.entity_key);
      database.prepare("UPDATE generation_framework_relationships SET payload_json = ? WHERE generation_id = ? AND output_key = ?")
        .run(JSON.stringify({ ...JSON.parse(relationRow.payload_json), relationKind: "untrusted_relation" }), generationId, relationRow.output_key);
      assert.equal(reloaded(), undefined);
      database.prepare("UPDATE generation_framework_relationships SET payload_json = ? WHERE generation_id = ? AND output_key = ?")
        .run(relationRow.payload_json, generationId, relationRow.output_key);
      database.prepare("UPDATE generation_framework_relationships SET payload_json = ? WHERE generation_id = ? AND output_key = ?")
        .run(JSON.stringify({ ...JSON.parse(relationRow.payload_json), source: { kind: "framework", entity: entry.frameworkEntity } }), generationId, relationRow.output_key);
      assert.equal(reloaded(), undefined);
      database.prepare("UPDATE generation_framework_relationships SET payload_json = ? WHERE generation_id = ? AND output_key = ?")
        .run(relationRow.payload_json, generationId, relationRow.output_key);
      assert.ok(reloaded());
      const generation = database.prepare("SELECT versions_json FROM index_generations WHERE id = ?").get(generationId) as { versions_json: string };
      database.prepare("UPDATE index_generations SET versions_json = ? WHERE id = ?")
        .run(JSON.stringify({ ...JSON.parse(generation.versions_json), frameworkResolutionVersion: "1.2.0" }), generationId);
      database.prepare("UPDATE generation_framework_state SET framework_resolution_version = '1.2.0' WHERE generation_id = ?").run(generationId);
    } finally {
      database.close();
    }
    const previousStore = new AtlasStore(databasePath, { readOnly: true });
    try {
      const previous = previousStore.loadFramework(getRepositoryIdentity(repoPath).id, generationId);
      assert.equal(previous?.frameworkResolutionVersion, "1.2.0");
      const invalidation = planFrameworkInvalidation({ paths: [], allPaths: ["src/UsersResolver.java"],
        changedInputKeys: new Set(), changedLookupKeys: new Set(), previous,
        frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION, topologyComplete: true });
      assert.ok(invalidation.reasons.includes("framework_resolution_version_changed"));
      assert.deepEqual(invalidation.analyzePaths, ["src/UsersResolver.java"]);
    } finally {
      previousStore.close();
    }
    const renewed = await syncRepository(repoPath, { skipGit: true });
    assert.equal(renewed.kind, "published", JSON.stringify(renewed));
    if (renewed.kind === "published") {
      assert.notEqual(renewed.generationId, generationId);
      assert.ok(renewed.counters.frameworkFilesResolved > 0, JSON.stringify(renewed.counters));
      const refreshed = await loadIndexedGraphReadOnly(repoPath);
      assert.equal(refreshed.evidenceState.generationId, renewed.generationId);
      const readOnly = new AtlasStore(databasePath, { readOnly: true });
      try { assert.equal(readOnly.loadFramework(getRepositoryIdentity(repoPath).id, renewed.generationId)?.frameworkResolutionVersion, "1.3.0"); }
      finally { readOnly.close(); }
    }
  } finally {
    await client.close();
    await server.close();
    await rm(repoPath, { recursive: true, force: true });
  }
});
