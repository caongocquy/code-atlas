import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { FACTS_VERSION, FACTS_SCHEMA_VERSION } from "../src/core/repository/index-version.js";
import { reactNextAdapter } from "../src/core/framework/adapters/react-next.js";
import { planFrameworkInvalidation } from "../src/core/framework/framework-invalidation.js";
import { analyzeFramework } from "../src/core/framework/framework-registry.js";
import type { FrameworkAnalysisContext, FrameworkSnapshot } from "../src/core/framework/framework.types.js";
import { indexRepository, syncRepository, reindexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";

const owners = ["src/distributor/AuditEventDetail.tsx", "src/insurer/AuditEventDetail.tsx"];
const barrel = "src/common/index.ts", target = "src/common/StatusBadge.tsx";
function context(): FrameworkAnalysisContext {
  const sources = [...owners.map(file => [file, "import { StatusBadge } from '../common';\nexport function AuditEventDetail() { return <StatusBadge />; }"]), [barrel, "export { StatusBadge } from './StatusBadge';"], [target, "export function StatusBadge() { return null; }"]];
  const facts = sources.map(([file, source]) => {
    const r = extractParsedFacts({ filePath: file!, language: file!.endsWith("tsx") ? "tsx" : "typescript", source: source!, contentHash: file!, factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION });
    assert.equal(r.kind, "facts"); if (r.kind !== "facts") throw r.error;
    return { relativePath: file!, facts: r.facts };
  });
  const nodes = facts.flatMap(unit => [{ id: unit.relativePath, type: "file" as const, name: unit.relativePath, file: unit.relativePath }, ...unit.facts.symbols.map(s => ({ id: `${unit.relativePath}:${s.localId}`, type: s.kind, name: s.name, qualifiedName: s.declaredQualifiedName ?? s.name, file: unit.relativePath, startLine: s.range.startLine, endLine: s.range.endLine }))]);
  const edges = nodes.filter(n => n.type !== "file").map(n => ({ from: n.file, to: n.id, type: "contains" as const }));
  return { repositoryId: "repo", generationId: "new", frameworkResolutionVersion: "1.1.0", detections: [], analyzePaths: new Set(sources.map(s => s[0]!)), maxObservations: 100, config: [], facts, graph: { nodes, edges } };
}
test("both AuditEventDetail StatusBadge targets survive scoped analysis with unchanged lookup facts", () => {
  const ctx = context(); const full = analyzeFramework(ctx, [reactNextAdapter]);
  assert.equal(full.relationships.length, 2); assert.equal(full.diagnostics.length, 0);
  const previous: FrameworkSnapshot = { ...full, repositoryId: "repo", generationId: "old", frameworkResolutionVersion: ctx.frameworkResolutionVersion, config: [], detections: [] };
  const seen: string[] = [];
  const incremental = analyzeFramework({ ...ctx, previousFramework: previous, analyzePaths: new Set(owners) }, [{ ...reactNextAdapter, analyze(c) { seen.push(...c.facts.map(f => f.relativePath)); return reactNextAdapter.analyze(c); } }]);
  assert.deepEqual(seen, owners);
  assert.deepEqual(incremental.relationships, full.relationships);
  assert.deepEqual(incremental.diagnostics, full.diagnostics);
  assert.deepEqual(incremental.dependencies, full.dependencies);
  const reused = analyzeFramework({ ...ctx, previousFramework: previous, analyzePaths: new Set([owners[0]!]) }, [{ ...reactNextAdapter, analyze(c) {
    assert.deepEqual(c.facts.map(f => f.relativePath), [owners[0]]);
    assert.equal(c.lookupFacts?.find(f => f.relativePath === barrel), ctx.facts.find(f => f.relativePath === barrel));
    return reactNextAdapter.analyze(c);
  } }]);
  assert.deepEqual(reused.relationships, full.relationships);
  const invalidation = planFrameworkInvalidation({ paths: [target], allPaths: ctx.facts.map(f => f.relativePath), changedInputKeys: new Set([`facts:${target}`]), changedLookupKeys: new Set(), previous, frameworkResolutionVersion: ctx.frameworkResolutionVersion, topologyComplete: true });
  assert.ok(owners.every(p => invalidation.analyzePaths.includes(p)));
  const deleted = analyzeFramework({ ...ctx, facts: ctx.facts.filter(f => f.relativePath !== target), graph: { nodes: ctx.graph.nodes.filter(n => n.file !== target), edges: ctx.graph.edges.filter(e => !e.from.startsWith(target)) }, previousFramework: previous, analyzePaths: new Set(invalidation.analyzePaths) }, [reactNextAdapter]);
  assert.equal(deleted.relationships.length, 0);
  assert.equal(deleted.diagnostics.filter(d => d.code === "framework_target_unknown").length, 2);
});

function framework(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try { return store.loadFramework(getRepositoryIdentity(root).id); } finally { store.close(); }
}
test("changed aliased barrel binding invalidates its consumer and matches full rebuild", async () => {
  const root = await fs.mkdtemp(path.join(tmpdir(), "atlas-framework-lookup-"));
  try {
    await fs.mkdir(path.join(root, "common"));
    await fs.writeFile(path.join(root, "App.tsx"), "import { Badge } from './common'; export function App() { return <Badge />; }");
    await fs.writeFile(path.join(root, "common/index.ts"), "export { StatusBadge as Badge } from './StatusBadge';");
    await fs.writeFile(path.join(root, "common/StatusBadge.tsx"), "export function StatusBadge() { return null; } export function OtherBadge() { return null; }");
    assert.equal((await indexRepository(root, { skipGit: true })).kind, "published");
    await fs.writeFile(path.join(root, "common/index.ts"), "export { OtherBadge as Badge } from './StatusBadge';");
    const delta = await syncRepository(root, { skipGit: true }); assert.equal(delta.kind, "published");
    const current = framework(root)!;
    assert.equal(current.diagnostics.length, 0);
    const before = current.relationships;
    assert.equal((await reindexRepository(root, { skipGit: true })).kind, "published");
    assert.deepEqual(framework(root)!.relationships, before);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
