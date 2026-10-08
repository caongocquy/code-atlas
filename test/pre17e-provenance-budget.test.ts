import assert from "node:assert/strict";
import test from "node:test";
import fs from "node:fs/promises";
import path from "node:path";
import { tmpdir } from "node:os";
import { indexRepository, syncRepository, reindexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { createBudgetLedger } from "../src/core/graph/resolver/budgets.js";
import { lookupImports } from "../src/core/graph/resolver/type-environment.js";
import type { SemanticEvidenceBatch } from "../src/core/graph/resolver/types.js";

const budgets = { candidateExpansions: 1, bindingHops: 10, returnDepth: 10, inheritanceDepth: 10, memberCandidates: 10, expressionNodes: 10, propagationRounds: 10 };
test("undefined module paths do not match unrelated import queries", () => {
  const imports = ["one", "two"].map((specifier) => ({ specifier, evidenceId: specifier }));
  const result = lookupImports([{ imports, diagnostics: [] } as unknown as SemanticEvidenceBatch], { repositoryId: "repo", normalizedName: "other" }, createBudgetLedger(budgets));
  assert.equal(result.status, "unknown");
  assert.deepEqual(result.evidenceIds, []);
});

async function fixture() {
  const root = await fs.mkdtemp(path.join(tmpdir(), "atlas-provenance-"));
  await fs.writeFile(path.join(root, "a.ts"), 'import "./theme.css"; import data from "./data.json"; export function a() { return 1; }');
  await fs.writeFile(path.join(root, "b.ts"), "export function b() { return 1; }");
  return root;
}
function published<T extends { kind: string }>(result: T): asserts result is T & { kind: "published" } { assert.equal(result.kind, "published"); }
function snapshot(root: string) {
  const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
  try { const id = getRepositoryIdentity(root).id; const g = store.loadGraph(id); return JSON.stringify({ nodes: g.nodes.sort((a,b) => a.id.localeCompare(b.id)), edges: g.edges.sort((a,b) => JSON.stringify(a).localeCompare(JSON.stringify(b))), diagnostics: store.getGraphResolutionDiagnostics(id) }); }
  finally { store.close(); }
}
test("CSS/JSON terminal identity keeps source delta bounded and detects deletion/appearance", async () => {
  const root = await fixture();
  try {
    await fs.writeFile(path.join(root, "theme.css"), "body { color: red; }");
    await fs.writeFile(path.join(root, "data.json"), '{"value":1}');
    const first = await indexRepository(root, { skipGit: true }); published(first);
    await fs.writeFile(path.join(root, "b.ts"), "export function b() { return 2; }");
    const delta = await syncRepository(root, { skipGit: true }); published(delta); if (delta.kind !== "published") return;
    assert.deepEqual(delta.plan.resolvePaths, ["b.ts"]);
    assert.equal(delta.plan.fullGraphResolution, false);
    const graph = snapshot(root);
    assert.equal((await reindexRepository(root, { skipGit: true })).kind, "published");
    assert.equal(snapshot(root), graph);
    await fs.rename(path.join(root, "theme.css"), path.join(root, "renamed.css"));
    const removed = await syncRepository(root, { skipGit: true }); published(removed); if (removed.kind !== "published") return;
    assert.ok(removed.plan.resolvePaths.includes("a.ts"));
    assert.ok(removed.plan.reasons.includes("unresolved_import_ownership"));
    await fs.rename(path.join(root, "renamed.css"), path.join(root, "theme.css"));
    const appeared = await syncRepository(root, { skipGit: true }); published(appeared); if (appeared.kind !== "published") return;
    assert.deepEqual(appeared.plan.resolvePaths, ["a.ts"]);
    assert.equal(appeared.counters.filesParsed, 0);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
    try { assert.ok(!store.loadGraph(getRepositoryIdentity(root).id).nodes.some(n => /\.(css|json)$/.test(n.file))); } finally { store.close(); }
    await fs.writeFile(path.join(root, "data.json"), '{"value":2}');
    const assetEdit = await syncRepository(root, { skipGit: true }); published(assetEdit); if (assetEdit.kind !== "published") return;
    assert.deepEqual(assetEdit.plan.resolvePaths, ["a.ts"]);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
test("missing ownership outside dirty closure stays incomplete without poisoning it", async () => {
  const root = await fixture();
  try {
    published(await indexRepository(root, { skipGit: true }));
    await fs.writeFile(path.join(root, "b.ts"), "export function b() { return 2; }");
    const unrelated = await syncRepository(root, { skipGit: true }); published(unrelated); if (unrelated.kind !== "published") return;
    assert.deepEqual(unrelated.plan.resolvePaths, ["b.ts"]);
    await fs.writeFile(path.join(root, "a.ts"), 'import "./theme.css"; export function a() { return 2; }');
    const affected = await syncRepository(root, { skipGit: true }); published(affected); if (affected.kind !== "published") return;
    assert.equal(affected.plan.fullGraphResolution, true);
    assert.ok(affected.plan.reasons.includes("unresolved_import_ownership"));
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});

test("root budgets keep pathological imports independent of traversal order", async () => {
  const { extractParsedFacts } = await import("../src/core/facts/facts-extractor.js");
  const { runFixtureThroughResolver, factExtractorInput } = await import("./helpers/phase14b-language-fixtures.js");
  const { ecmascriptSemanticAdapter } = await import("../src/core/graph/resolver/adapters/ecmascript.js");
  const cases = [
    { filePath: "bad.ts", language: "typescript" as const, source: `import { ${Array.from({ length: 30 }, (_, i) => `f${i}`).join(",")} } from "bad"; export function bad() { return f0(); }` },
    { filePath: "good.ts", language: "typescript" as const, source: "class Service { run(): Service { return this; } } const s: Service = new Service(); s.run();" },
  ];
  const facts = cases.map(item => { const r = extractParsedFacts(factExtractorInput(item)); assert.equal(r.kind, "facts"); if (r.kind !== "facts") throw r.error; return r.facts; });
  const sites = [
    { sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: "bad.ts", language: "typescript" as const }, localId: facts[0]!.imports[0]!.localId },
    { sourceUnit: { repositoryId: "phase14b-fixtures", relativePath: "good.ts", language: "typescript" as const }, localId: facts[1]!.members.find(m => m.memberName === "run")!.localId },
  ];
  const forward = await runFixtureThroughResolver({ name: "root-budget", cases, sites }, facts, ecmascriptSemanticAdapter, "cold", false, undefined, { candidateExpansions: 20 });
  const reverse = await runFixtureThroughResolver({ name: "root-budget", cases: [...cases].reverse(), sites: [...sites].reverse() }, [...facts].reverse(), ecmascriptSemanticAdapter, "cold", false, undefined, { candidateExpansions: 20 });
  assert.equal(forward.decisions[0]?.status, "budget_exhausted");
  assert.equal(forward.decisions[1]?.status, "resolved");
  assert.deepEqual(reverse.decisions, [...forward.decisions].reverse());
});

test("symlink terminal ambiguity and unsupported extensions remain unresolved", async () => {
  const { readTerminalDependency, isTerminalSpecifier } = await import("../src/core/indexing/terminal-dependencies.js");
  const root = await fs.mkdtemp(path.join(tmpdir(), "atlas-terminal-ambiguity-"));
  try {
    await fs.writeFile(path.join(root, "real.css"), "body {}");
    await fs.symlink("real.css", path.join(root, "alias.css"));
    assert.equal((await readTerminalDependency(root, "a.ts", "./alias.css")).state, "ambiguous");
    assert.equal((await readTerminalDependency(root, "a.ts", "./missing.json")).state, "missing");
    assert.equal(isTerminalSpecifier("./unknown.bin"), false);
  } finally { await fs.rm(root, { recursive: true, force: true }); }
});
