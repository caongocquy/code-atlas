import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { decodeFrameworkGraphqlFieldIdentity, frameworkEntityKey } from "../src/core/framework/framework-identity.js";
import { buildRepositoryEntryCatalog } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { FACTS_VERSION, FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";
import { RESOLUTION_VERSION } from "../src/config/constants.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

const fixtures = {
  nestjs: {
    "service.ts": `export function userLabel() { return "user"; }
export function productLabel() { return "product"; }
export async function* stream(): AsyncIterable<string> { yield "event"; }`,
    "types.ts": `import { ObjectType } from "@nestjs/graphql";
@ObjectType("Person") export class User {}`,
    "user.ts": `import { Resolver as R, ResolveField as F } from "@nestjs/graphql";
import { User as Person } from "./types";
class UserService { userLabel() { return "user"; } }
const service: UserService = new UserService();
@R(() => Person) export class UserResolver {
  @F() name() { return service.userLabel(); }
}`,
    "product.ts": `import { Resolver, ResolveField } from "@nestjs/graphql";
class ProductService { productLabel() { return "product"; } }
const service: ProductService = new ProductService();
@Resolver("Product") export class ProductResolver {
  @ResolveField() name() { return service.productLabel(); }
}`,
    "events.ts": `import { Resolver, Subscription } from "@nestjs/graphql";
class EventsService { async *stream() { yield "event"; } }
const service: EventsService = new EventsService();
@Resolver() export class EventsResolver {
  @Subscription(() => String, { name: "updates" }) events() { return service.stream(); }
}`,
  },
  spring: {
    "UserResolver.java": `import org.springframework.stereotype.Controller;
import org.springframework.graphql.data.method.annotation.SchemaMapping;
class UserNameService { public String userLabel() { return "user"; } }
@Controller @SchemaMapping(typeName="User") public class UserResolver {
  private UserNameService service;
  @SchemaMapping(field="name")
  public String userName() { return service.userLabel(); }
}`,
    "BatchResolver.java": `import org.springframework.stereotype.Controller;
import org.springframework.graphql.data.method.annotation.BatchMapping;
class BatchUser {}
class BatchService { public java.util.Map<BatchUser, String> batchLabels() { return java.util.Map.of(); } }
@Controller public class BatchResolver {
  private BatchService service;
  @BatchMapping(typeName="User", field="labels") public java.util.Map<BatchUser, String> labels() { return service.batchLabels(); }
}`,
    "EventsResolver.java": `import org.springframework.stereotype.Controller;
import org.springframework.graphql.data.method.annotation.SubscriptionMapping;
import reactor.core.publisher.Flux;
class EventsService { public Flux<String> stream() { return Flux.empty(); } }
@Controller public class EventsResolver {
  private EventsService service;
  @SubscriptionMapping(name="updates") public Flux<String> events() { return service.stream(); }
}`,
  },
};
function payload(result: { structuredContent?: unknown }): Record<string, unknown> {
  assert.ok(result.structuredContent && typeof result.structuredContent === "object");
  return result.structuredContent as Record<string, unknown>;
}

for (const framework of ["nestjs", "spring"] as const) test(`B2 real ${framework} source persists IDs and traverses service calls through direct and MCP surfaces`, async () => {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), `code-atlas-phase17c-b2-${framework}-`));
  const server = createMcpServer();
  const client = new Client({ name: "phase17c-b2", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const count = 3;
  try {
    await mkdir(path.join(repoPath, "src"));
    for (const [file, source] of Object.entries(fixtures[framework])) await writeFile(path.join(repoPath, "src", file), source + "\n");
    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    let loaded = await loadIndexedGraphReadOnly(repoPath);
    const catalog = buildRepositoryEntryCatalog(loaded.framework);
    assert.equal(catalog.entries.length, 1, JSON.stringify(catalog));
    const entities = loaded.framework!.nodes.flatMap((node) => node.kind === "framework" ? [node.entity] : []);
    assert.equal(entities.length, count);
    assert.equal(new Set(entities.map((entity) => frameworkEntityKey(entity.ref))).size, count);
    const expected = framework === "nestjs" ? [["root", "Person", "name"], ["root", "Product", "name"], ["root", "subscription", "updates"]]
      : [["root", "User", "name"], ["root", "User", "labels"], ["root", "subscription", "updates"]];
    assert.deepEqual(entities.map((entity) => frameworkEntityKey(entity.ref)).sort(), expected.map((key) => frameworkEntityKey({ framework, kind: key[1] === "subscription" ? "graphql_operation" : "graphql_field", logicalKey: JSON.stringify(key) })).sort());
    const databasePath = path.join(repoPath, ".codeatlas", "atlas.db");
    const snapshot = () => {
      const store = new AtlasStore(databasePath, { readOnly: true });
      try { return store.loadFramework(loaded.repoId, loaded.evidenceState.generationId); }
      finally { store.close(); }
    };
    const persisted = snapshot();
    assert.ok(persisted);
    assert.equal(persisted.frameworkResolutionVersion, FRAMEWORK_RESOLUTION_VERSION);
    assert.equal(persisted.entities.length, count);
    assert.equal(persisted.relationships.filter((rel) => rel.relationKind === "graphql_resolver").length, count);
    assert.deepEqual(persisted.entities.map((entry) => frameworkEntityKey(entry.ref)).sort(), entities.map((entity) => frameworkEntityKey(entity.ref)).sort());
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const tools = await client.listTools();
    assert.match(tools.tools.find((item) => item.name === "execution_flow")!.description!, /nested field/);
    assert.match(tools.tools.find((item) => item.name === "list_entries")!.description!, /subscription/);
    const listing = payload(await client.callTool({ name: "list_entries", arguments: { repoPath, kind: "graphql", detail: "full" } }));
    assert.deepEqual(listing.entries, catalog.entries);
    assert.deepEqual(listing.projection && (listing.projection as { entries: unknown }).entries, { total: 1, returned: 1, omitted: 0, truncated: false });
    assert.equal((listing.evidenceState as { generationId: string }).generationId, loaded.evidenceState.generationId);
    for (const entity of entities) {
      const id = frameworkEntityKey(entity.ref);
      assert.equal(entity.provenance.origin, "framework_inferred");
      assert.equal(entity.provenance.confidence, "exact");
      assert.equal(entity.provenance.adapterVersion, "1.4.0");
      assert.ok(entity.provenance.refs.every((ref) => !!ref.range));
      const bindings = persisted.relationships.filter((rel) => rel.target.kind === "framework" && frameworkEntityKey(rel.target.entity) === id);
      assert.equal(bindings.length, 1);
      const binding = bindings[0]!;
      assert.equal(binding.source.kind, "language");
      if (binding.source.kind !== "language") throw new Error("expected callable binding");
      const callable = binding.source.nodeId;
      const calls = loaded.graph.edges.filter((edge) => edge.from === callable && edge.type === "calls");
      assert.equal(calls.length, 1, JSON.stringify({ entity, calls, graph: loaded.graph }));
      const service = loaded.graph.nodes.find((node) => node.id === calls[0]!.to)!;
      assert.ok(["userLabel", "productLabel", "batchLabels", "stream"].includes(service.name), JSON.stringify(service));
      if (framework === "spring") assert.equal(calls[0]!.resolution?.strategy, "receiver-member");
      const direct = discoverExecutionFlow(loaded.graph, loaded.framework, { kind: "graphql", id });
      assert.equal(direct.status, "resolved");
      assert.equal(direct.mayBeIncomplete, true);
      assert.ok(direct.diagnostics.some((item) => item.code === "schema_unverified"));
      assert.equal(direct.nodes.filter((node) => node.subject.kind === "framework").length, 1);
      const flow = payload(await client.callTool({ name: "execution_flow", arguments: { repoPath, entry: { kind: "graphql", id }, detail: "full" } }));
      assert.equal(flow.status, direct.status);
      assert.deepEqual(flow.edges, direct.edges);
      assert.equal((flow.evidenceState as { generationId: string }).generationId, loaded.evidenceState.generationId);
      const callableNode = direct.nodes.find((node) => node.subject.kind === "language" && node.subject.node.id === callable);
      const serviceNode = direct.nodes.find((node) => node.subject.kind === "language" && node.subject.node.id === service.id);
      assert.ok(callableNode && serviceNode);
      assert.ok(direct.edges.some((edge) => edge.kind === "framework_entry" && edge.to === callableNode.id));
      assert.ok(direct.edges.some((edge) => edge.kind === "call" && edge.to === serviceNode.id));
      assert.equal(frameworkEntityKey((flow.resolution as { entity: { ref: Parameters<typeof frameworkEntityKey>[0] } }).entity.ref), id);
    }
    const firstIds = catalog.entries.map((entry) => entry.id);
    const reindexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(reindexed.kind, "published", JSON.stringify(reindexed));
    loaded = await loadIndexedGraphReadOnly(repoPath);
    assert.deepEqual(buildRepositoryEntryCatalog(loaded.framework).entries.map((entry) => entry.id), firstIds);

    if (framework === "nestjs") {
      await writeFile(path.join(repoPath, "src", "types.ts"), fixtures.nestjs["types.ts"].replace('"Person"', '"Account"') + "\n");
      const synced = await syncRepository(repoPath, { skipGit: true });
      assert.equal(synced.kind, "published", JSON.stringify(synced));
      loaded = await loadIndexedGraphReadOnly(repoPath);
      const changed = buildRepositoryEntryCatalog(loaded.framework).entries;
      assert.equal(changed.length, 1);
      const fields = loaded.framework!.nodes.flatMap((node) => node.kind === "framework" ? [decodeFrameworkGraphqlFieldIdentity(node.entity.ref)] : []);
      assert.ok(fields.some((field) => field?.[1] === "Account"));
      assert.ok(!fields.some((field) => field?.[1] === "Person"));
    }

    const database = new DatabaseSync(databasePath);
    try {
      const generationId = loaded.evidenceState.generationId;
      const row = database.prepare("SELECT entity_key, payload_json FROM generation_framework_entities WHERE generation_id = ?").all(generationId) as Array<{ entity_key: string; payload_json: string }>;
      const nested = row.find((item) => JSON.parse(item.payload_json).ref.kind === "graphql_field")!;
      const original = JSON.parse(nested.payload_json);
      for (const logicalKey of ['["root","User"]', '["root","","name"]', '["root","bad-type","name"]']) {
        database.prepare("UPDATE generation_framework_entities SET payload_json = ? WHERE generation_id = ? AND entity_key = ?").run(JSON.stringify({ ...original, ref: { ...original.ref, logicalKey } }), generationId, nested.entity_key);
        assert.equal(snapshot(), undefined);
      }
      database.prepare("UPDATE generation_framework_entities SET payload_json = ? WHERE generation_id = ? AND entity_key = ?").run(nested.payload_json, generationId, nested.entity_key);
      assert.ok(snapshot());
      const generation = database.prepare("SELECT versions_json FROM index_generations WHERE id = ?").get(generationId) as { versions_json: string };
      database.prepare("UPDATE index_generations SET versions_json = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(generation.versions_json), frameworkResolutionVersion: "1.3.0" }), generationId);
      const manifest = database.prepare("SELECT versions_json FROM index_manifests WHERE generation_id = ?").get(generationId) as { versions_json: string };
      database.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?").run(JSON.stringify({ ...JSON.parse(manifest.versions_json), frameworkResolutionVersion: "1.3.0" }), generationId);
      database.prepare("UPDATE generation_framework_state SET framework_resolution_version = '1.3.0' WHERE generation_id = ?").run(generationId);
    } finally { database.close(); }
    const beforeUpgrade = buildRepositoryEntryCatalog(loaded.framework).entries.map((entry) => entry.id);
    const upgraded = await syncRepository(repoPath, { skipGit: true });
    assert.equal(upgraded.kind, "published", JSON.stringify(upgraded));
    if (upgraded.kind === "published") {
      assert.ok(upgraded.counters.frameworkFilesResolved > 0, JSON.stringify(upgraded.counters));

      loaded = await loadIndexedGraphReadOnly(repoPath);
      assert.deepEqual(buildRepositoryEntryCatalog(loaded.framework).entries.map((entry) => entry.id), beforeUpgrade);
      assert.equal(snapshot()?.frameworkResolutionVersion, FRAMEWORK_RESOLUTION_VERSION);
    }
  } finally {
    await client.close(); await server.close(); await rm(repoPath, { recursive: true, force: true });
  }
});

test("B2 changes only framework materialization version", () => {
  assert.equal(FACTS_VERSION, "3.1.0");
  assert.equal(RESOLUTION_VERSION, "1.2.0");
  assert.equal(FRAMEWORK_RESOLUTION_VERSION, "1.6.0");
});
