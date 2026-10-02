import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createMcpServer } from "../src/adapters/mcp/mcp-server.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { buildRepositoryEntryCatalog } from "../src/core/graph/intelligence/repository-entry-catalog.service.js";
import { discoverExecutionFlow } from "../src/core/graph/query/execution-flow.service.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION, FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";
import { RESOLUTION_VERSION } from "../src/config/constants.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

async function indexedSource(source: string, extension = "ts") {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "code-atlas-ts-member-maintenance-"));
  try {
    await mkdir(path.join(repoPath, "src"));
    await writeFile(path.join(repoPath, "src", `resolver.${extension}`), source + "\n");
    const indexed = await indexRepository(repoPath, { skipGit: true });
    assert.equal(indexed.kind, "published", JSON.stringify(indexed));
    const loaded = await loadIndexedGraphReadOnly(repoPath);
    return { repoPath, loaded };
  } catch (error) { await rm(repoPath, { recursive: true, force: true }); throw error; }
}
const source = 'class UsersService { list() { return "ok"; } }\nconst service: UsersService = new UsersService();\nclass UsersResolver { users() { return service.list(); } }';

for (const [extension, input] of [["ts", source], ["tsx", source], ["js", source.replace(": UsersService", "")]] as const) {
  test(`${extension} source resolves a caller/member local-ID mismatch to the exact service method`, async () => {
    const { repoPath, loaded } = await indexedSource(input, extension);
    try {
      const parsed = extractParsedFacts({ source: input, language: extension === "ts" ? "typescript" : extension === "js" ? "javascript" : "tsx", filePath: `src/resolver.${extension}`, contentHash: "fixture" });
      assert.equal(parsed.kind, "facts");
      if (parsed.kind !== "facts") return;
      const call = parsed.facts.callSites.find((item) => item.calleeText === "service.list")!;
      const member = parsed.facts.members.find((item) => item.memberName === "list")!;
      assert.notEqual(call.localId, member.localId);
      assert.ok(call.range.endColumn! > member.range.endColumn!);
      const caller = loaded.graph.nodes.find((node) => node.name === "users")!;
      const target = loaded.graph.nodes.find((node) => node.name === "list")!;
      const calls = loaded.graph.edges.filter((edge) => edge.type === "calls");
      assert.equal(calls.length, 1, JSON.stringify(loaded.graph));
      assert.equal(calls[0]!.from, caller.id); assert.equal(calls[0]!.to, target.id);
      assert.equal(calls[0]!.resolution?.strategy, "receiver-member");
      assert.equal(calls[0]!.resolution?.confidence, "strong");
      assert.ok(calls[0]!.resolution?.evidence.every((item) => item.kind === "resolver"));
    } finally { await rm(repoPath, { recursive: true, force: true }); }
  });
}

for (const [name, input] of [
  ["unknown receiver", 'class Other { list() {} } class R { users() { return unknown.list(); } }'],
  ["untyped shadow", 'class S { list() {} } const service: S = new S(); class R { users(service: unknown) { return service.list(); } }'],
  ["overloads", 'class S { list(): string; list(n: number): string; list(n?: number) { return "ok"; } } const service: S = new S(); class R { users() { return service.list(); } }'],
  ["duplicate owner types", 'class S { list() {} } class S { list() {} } const service: S = new S(); class R { users() { return service.list(); } }'],
  ["duplicate bindings", 'class S { list() {} } const service: S = new S(); const service: S = new S(); class R { users() { return service.list(); } }'],
  ["unrelated same-name method", 'class A { list() {} } class B { list() {} } const service: B = new B(); class R { users() { return service.list(); } }'],
  ["dynamic computed member", 'class S { list() {} } const service: S = new S(); class R { users() { return service[field](); } }'],
  ["optional receiver", 'class S { list() {} } const service: S | undefined = undefined; class R { users() { return service?.list(); } }'],
] as const) test(`TypeScript unique-or-drop rejects ${name}`, async () => {
  const { repoPath, loaded } = await indexedSource(input);
  try { assert.equal(loaded.graph.edges.filter((edge) => edge.type === "calls").length, 0, JSON.stringify(loaded.graph)); }
  finally { await rm(repoPath, { recursive: true, force: true }); }
});

test("resolution 1.1.0 re-resolves unchanged TypeScript facts without changing facts/framework domains", async () => {
  assert.equal(RESOLUTION_VERSION, "1.2.0"); assert.equal(FACTS_VERSION, "3.1.0"); assert.equal(FACTS_SCHEMA_VERSION, "3.0.0"); assert.equal(FRAMEWORK_RESOLUTION_VERSION, "1.4.0");
  const { repoPath, loaded } = await indexedSource(source);
  try {
    const generationId = loaded.evidenceState.generationId;
    const db = new DatabaseSync(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const row = db.prepare("SELECT versions_json FROM index_manifests WHERE generation_id = ?").get(generationId) as { versions_json: string };
      db.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?").run(JSON.stringify({ ...JSON.parse(row.versions_json), resolutionVersion: "1.1.0" }), generationId);
    } finally { db.close(); }
    const renewed = await syncRepository(repoPath, { skipGit: true });
    assert.equal(renewed.kind, "published", JSON.stringify(renewed));
    if (renewed.kind !== "published") return;
    assert.equal(renewed.counters.filesParsed, 0);
    assert.equal(renewed.counters.filesResolved, 1);
    assert.ok(renewed.plan.reasons.includes("resolution_version_changed"));
    const fresh = await loadIndexedGraphReadOnly(repoPath);
    assert.notEqual(fresh.evidenceState.generationId, generationId);
    assert.equal(fresh.graph.edges.find((edge) => edge.type === "calls")?.resolution?.resolutionVersion, "1.2.0");
  } finally { await rm(repoPath, { recursive: true, force: true }); }
});

test("accepted B1 Nest Query reaches Atlas list_entries and same-ID execution_flow with resolver service calls", async () => {
  const input = 'import { Resolver, Query } from "@nestjs/graphql";\n' + source.replace('class UsersResolver { users()', '@Resolver() class UsersResolver { @Query() users()');
  const { repoPath, loaded } = await indexedSource(input);
  const server = createMcpServer(); const client = new Client({ name: "ts-member-proof", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  try {
    const catalog = buildRepositoryEntryCatalog(loaded.framework);
    assert.equal(catalog.entries.length, 1);
    const entry = catalog.entries[0]!;
    assert.equal(entry.kind === "graphql" && entry.operationKind, "query");
    const store = new AtlasStore(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
    try {
      const persisted = store.loadFramework(loaded.repoId, loaded.evidenceState.generationId);
      assert.ok(persisted); assert.equal(persisted.frameworkResolutionVersion, FRAMEWORK_RESOLUTION_VERSION);
      assert.equal(persisted.entities.length, 1); assert.equal(persisted.relationships.length, 1);
    } finally { store.close(); }
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
    const listing = await client.callTool({ name: "list_entries", arguments: { repoPath, kind: "graphql", detail: "full" } });
    assert.deepEqual((listing.structuredContent as { entries: unknown }).entries, catalog.entries);
    const direct = discoverExecutionFlow(loaded.graph, loaded.framework, { kind: "graphql", id: entry.id });
    const flow = await client.callTool({ name: "execution_flow", arguments: { repoPath, entry: { kind: "graphql", id: entry.id }, detail: "full" } });
    const actual = flow.structuredContent as { status: string; edges: unknown; evidenceState: { generationId: string } };
    assert.equal(actual.status, "resolved"); assert.deepEqual(actual.edges, direct.edges);
    assert.equal(actual.evidenceState.generationId, loaded.evidenceState.generationId);
    assert.equal(direct.edges.filter((edge) => edge.kind === "call").length, 1);
    const target = direct.nodes.find((node) => node.subject.kind === "language" && node.subject.node.name === "list");
    assert.ok(target);
    assert.ok(direct.edges.some((edge) => edge.kind === "call" && edge.to === target.id));
  } finally { await client.close(); await server.close(); await rm(repoPath, { recursive: true, force: true }); }
});
