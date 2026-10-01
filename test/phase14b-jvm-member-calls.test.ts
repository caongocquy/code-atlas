import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { DatabaseSync } from "node:sqlite";

import { javaFactExtractor } from "../src/core/facts/extractors/java.js";
import { buildCodeGraphWithResolutionFromFacts } from "../src/core/graph/build-graph.js";
import { loadIndexedGraphReadOnly } from "../src/core/graph/indexed-graph.service.js";
import { buildPipelineResolverContext, indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { jvmSemanticAdapter } from "../src/core/graph/resolver/adapters/jvm.js";
import { factExtractorInput } from "./helpers/phase14b-language-fixtures.js";

async function indexJvmSource(language: "java" | "kotlin", source: string) {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-jvm-member-call-"));
  await mkdir(path.join(repoPath, "src"));
  await writeFile(path.join(repoPath, "src", `UsersResolver.${language === "java" ? "java" : "kt"}`), source);
  const indexed = await indexRepository(repoPath, { skipGit: true });
  assert.equal(indexed.kind, "published", JSON.stringify(indexed));
  const loaded = await loadIndexedGraphReadOnly(repoPath);
  return { repoPath, graph: loaded.graph, generationId: loaded.evidenceState.generationId };
}

test("an old JVM resolution version re-resolves unchanged facts", async () => {
  const source = 'class UsersService { String list() { return "ok"; } }\nclass UsersResolver { UsersService service; String users() { return service.list(); } }\n';
  const { repoPath, generationId } = await indexJvmSource("java", source);
  try {
    assert.ok(generationId);
    const db = new DatabaseSync(path.join(repoPath, ".codeatlas", "atlas.db"));
    try {
      const row = db.prepare("SELECT versions_json FROM index_manifests WHERE generation_id = ?").get(generationId) as { versions_json: string };
      db.prepare("UPDATE index_manifests SET versions_json = ? WHERE generation_id = ?")
        .run(JSON.stringify({ ...JSON.parse(row.versions_json), resolutionVersion: "1.0.0" }), generationId);
    } finally { db.close(); }
    const synced = await syncRepository(repoPath, { skipGit: true });
    assert.equal(synced.kind, "published", JSON.stringify(synced));
    if (synced.kind !== "published") return;
    assert.notEqual(synced.generationId, generationId);
    assert.equal(synced.counters.filesParsed, 0);
    assert.equal(synced.counters.filesResolved, 1, JSON.stringify(synced));
    assert.ok(synced.plan.reasons.includes("resolution_version_changed"));
    const graph = (await loadIndexedGraphReadOnly(repoPath)).graph;
    assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.resolution?.resolutionVersion === CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion));
  } finally { await rm(repoPath, { recursive: true, force: true }); }
});

for (const [language, source] of [
  ["java", 'class UsersService { String list() { return "ok"; } }\nclass UsersResolver { UsersService service; String users() { return service.list(); } }\n'],
  ["kotlin", 'class UsersService { fun list(): String = "ok" }\nclass UsersResolver(private val service: UsersService) { fun users(): String = service.list() }\n'],
] as const) {
  test(`${language} resolves a typed cross-class member call to the service callable`, async () => {
    const { repoPath, graph } = await indexJvmSource(language, source);
    try {
      const caller = graph.nodes.find((node) => node.type === "method" && node.name === "users");
      const callee = graph.nodes.find((node) => node.type === "method" && node.name === "list");
      assert.ok(caller && callee);
      const edge = graph.edges.find((item) => item.type === "calls" && item.from === caller.id && item.to === callee.id);
      assert.ok(edge, JSON.stringify({ nodes: graph.nodes, edges: graph.edges }));
      assert.equal(edge.resolution?.strategy, "receiver-member");
      assert.equal(edge.resolution?.confidence, "strong");
      assert.ok(edge.resolution.evidence.some((item) => item.kind === "resolver"));
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
}

test("Spring-style Java resolver source has a real service call edge", async () => {
  const source = [
    "import org.springframework.stereotype.Controller;",
    "import org.springframework.graphql.data.method.annotation.QueryMapping;",
    'class UsersService { public String list() { return "ok"; } }',
    "@Controller",
    "public class UsersResolver {",
    "  UsersService service;",
    "  @QueryMapping",
    "  public String users() { return service.list(); }",
    "}",
    "",
  ].join("\n");
  const filePath = "src/UsersResolver.java";
  const outcome = javaFactExtractor.extract(factExtractorInput({ filePath, source, language: "java" }));
  assert.equal(outcome.kind, "facts");
  if (outcome.kind !== "facts") return;
  const repositoryIdentity = getRepositoryIdentity("/repo");
  const context = buildPipelineResolverContext({ generationId: "spring-source", repositoryIdentity,
    facts: [outcome.facts], adapters: [jvmSemanticAdapter], resolutionVersion: CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion,
    relativePaths: [filePath] });
  const built = await buildCodeGraphWithResolutionFromFacts("/repo", [{ relativePath: filePath, source, facts: outcome.facts }],
    undefined, repositoryIdentity.id, [filePath], context);
  const { graph } = built;
  const caller = graph.nodes.find((node) => node.type === "method" && node.name === "users");
  const callee = graph.nodes.find((node) => node.type === "method" && node.name === "list");
  assert.ok(caller && callee);
  assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.from === caller.id && edge.to === callee.id));
  const decision = built.resolutionByFile.get(filePath)?.decisions.find((item) => item.status === "resolved"
    && item.edgeKind === "calls" && item.strategy === "receiver-member");
  assert.equal(decision?.status, "resolved");
  if (decision?.status === "resolved") {
    assert.equal(decision.confidence, "strong");
    assert.ok(decision.evidenceIds.some((item) => item.includes(":member:")));
  }
});

for (const [language, source] of [
  ["java", 'class UsersService { String list() { return "a"; } String list(int n) { return "b"; } }\nclass UsersResolver { UsersService service; String users() { return service.list(); } }\n'],
  ["kotlin", 'class UsersService { fun list(): String = "a"; fun list(n: Int): String = "b" }\nclass UsersResolver(private val service: UsersService) { fun users(): String = service.list() }\n'],
] as const) {
  test(`${language} overload ambiguity does not emit a guessed call edge`, async () => {
    const { repoPath, graph } = await indexJvmSource(language, source);
    try {
      assert.equal(graph.edges.filter((edge) => edge.type === "calls").length, 0);
      const db = new DatabaseSync(path.join(repoPath, ".codeatlas", "atlas.db"), { readOnly: true });
      try {
        const resolution = db.prepare("SELECT calls, resolved_calls, unresolved_calls, ambiguous_calls FROM generation_graph_resolution_files").get() as {
          calls: number; resolved_calls: number; unresolved_calls: number; ambiguous_calls: number;
        };
        assert.equal(resolution.calls, 1);
        assert.equal(resolution.resolved_calls, 0);
        assert.equal(resolution.unresolved_calls + resolution.ambiguous_calls, 1);
      } finally { db.close(); }
    } finally { await rm(repoPath, { recursive: true, force: true }); }
  });
}

for (const [language, source] of [
  ["java", 'class UsersResolver { String list() { return "ok"; } String users() { return this.list(); } }\n'],
  ["kotlin", 'class UsersResolver { fun list(): String = "ok"; fun users(): String = this.list() }\n'],
] as const) {
  test(`${language} resolves this.member() within the owning class`, async () => {
    const { repoPath, graph } = await indexJvmSource(language, source);
    try {
      const caller = graph.nodes.find((node) => node.type === "method" && node.name === "users");
      const callee = graph.nodes.find((node) => node.type === "method" && node.name === "list");
      assert.ok(caller && callee);
      assert.ok(graph.edges.some((edge) => edge.type === "calls" && edge.from === caller.id && edge.to === callee.id));
    } finally {
      await rm(repoPath, { recursive: true, force: true });
    }
  });
}

for (const [language, source] of [
  ["java", 'class Other { String list() { return "ok"; } }\nclass UsersResolver { Missing service; String users() { return service.list(); } }\n'],
  ["kotlin", 'class Other { fun list(): String = "ok" }\nclass UsersResolver(private val service: Missing) { fun users(): String = service.list() }\n'],
] as const) {
  test(`${language} does not guess an unrelated same-name method for an unknown receiver`, async () => {
    const { repoPath, graph } = await indexJvmSource(language, source);
    try { assert.equal(graph.edges.filter((edge) => edge.type === "calls").length, 0); }
    finally { await rm(repoPath, { recursive: true, force: true }); }
  });
}

for (const [language, source] of [
  ["java", 'class First { String list() { return "first"; } }\nclass Second { String list() { return "second"; } }\nclass UsersResolver { Second service; String users() { return service.list(); } }\n'],
  ["kotlin", 'class First { fun list(): String = "first" }\nclass Second { fun list(): String = "second" }\nclass UsersResolver(private val service: Second) { fun users(): String = service.list() }\n'],
] as const) {
  test(`${language} drops a target whose graph identity collides with another class method`, async () => {
    const { repoPath, graph } = await indexJvmSource(language, source);
    try { assert.equal(graph.edges.filter((edge) => edge.type === "calls").length, 0); }
    finally { await rm(repoPath, { recursive: true, force: true }); }
  });
}
