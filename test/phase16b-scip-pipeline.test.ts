import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import type { ScipBindingEvidence } from "../src/core/graph/resolver/scip-evidence.js";
import { symbolIdentity } from "../src/core/graph/resolver/identities.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";
import type { ScipIndexer, ScipTool } from "../src/core/indexing/scip-indexer.types.js";
import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

class FakeScipIndexer implements ScipIndexer {
  version = "0.4.0";
  fail = true;
  available = true;
  discoveryCalls = 0;
  indexCalls = 0;
  readonly tool: ScipTool;

  constructor(projectRoot: string) {
    this.tool = { executablePath: path.join(projectRoot, "fake", "scip-typescript"), source: "project-local", version: this.version };
  }

  async discover() {
    this.discoveryCalls += 1;
    if (!this.available) return { status: "unavailable" as const };
    return { status: "ready" as const, tool: { ...this.tool, version: this.version } };
  }

  async index(input: { projectRoot: string; repositoryId: string; tool: ScipTool; units: readonly IndexedSourceUnit[] }): Promise<readonly ScipBindingEvidence[]> {
    this.indexCalls += 1;
    if (this.fail) throw new Error("simulated local indexer failure");
    const target = input.units.find((unit) => unit.relativePath === "dep.ts");
    const consumer = input.units.find((unit) => unit.relativePath === "consumer.ts");
    const targetFact = target?.facts.symbols.find((fact) => fact.name === "target");
    const call = consumer?.facts.callSites.find((fact) => fact.calleeText === "target");
    const reference = consumer?.facts.references.find((fact) => fact.name === "target" && fact.range.startLine === 2);
    if (!target || !consumer || !targetFact || !call || !reference) return [];
    return [{
      sourceUnit: { repositoryId: input.repositoryId, relativePath: consumer.relativePath, language: consumer.facts.language },
      siteLocalId: call.localId,
      target: symbolIdentity({
        repositoryId: input.repositoryId,
        relativePath: target.relativePath,
        language: target.facts.language,
        kind: targetFact.kind,
        qualifiedName: targetFact.declaredQualifiedName ?? targetFact.name,
        discriminator: targetFact.localId,
      }),
      evidenceId: `scip:${input.tool.version}` as ScipBindingEvidence["evidenceId"],
      range: reference.range,
    }];
  }
}

async function fixture(): Promise<{ root: string; indexer: FakeScipIndexer }> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase16b-pipeline-"));
  await writeFile(path.join(root, "package.json"), JSON.stringify({ name: "fixture", version: "1.0.0" }));
  await writeFile(path.join(root, "tsconfig.json"), JSON.stringify({ compilerOptions: { moduleResolution: "NodeNext" } }));
  await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n");
  await writeFile(path.join(root, "dep.ts"), "export function target() { return true; }\n");
  await writeFile(path.join(root, "consumer.ts"), "import { target } from './dep.js';\nexport function caller() { return target(); }\n");
  return { root, indexer: new FakeScipIndexer(root) };
}

function graphFacts(root: string) {
  const { repositoryId, store } = { repositoryId: getRepositoryIdentity(root).id, store: new AtlasStore(path.join(root, ".codeatlas", "atlas.db")) };
  try {
    const graph = store.loadGraph(repositoryId);
    const source = graph.nodes.find((node) => node.file === "consumer.ts" && node.name === "caller");
    const target = graph.nodes.find((node) => node.file === "dep.ts" && node.name === "target");
    const edge = graph.edges.find((item) => item.type === "calls" && item.from === source?.id && item.to === target?.id);
    const manifest = store.getGenerationManifest(repositoryId);
    return { edge, manifest, graph };
  } finally {
    store.close();
  }
}

function graphSignature(root: string) {
  const { graph } = graphFacts(root);
  const names = new Map(graph.nodes.map((node) => [node.id, `${node.file}:${node.name}`]));
  return graph.edges.map((edge) => ({
    type: edge.type,
    from: names.get(edge.from),
    to: names.get(edge.to),
    resolution: edge.resolution && {
      status: edge.resolution.status,
      strategy: edge.resolution.strategy,
      provenance: edge.resolution.evidence.map((item) => item.kind).sort(),
    },
  })).sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right)));
}

test("SCIP failure publishes parser fallback, retries, then enriches without reparsing", async () => {
  const { root, indexer } = await fixture();
  try {
    const first = await indexRepository(root, { skipGit: true, scipIndexer: indexer });
    assert.equal(first.kind, "published");
    assert.equal(graphFacts(root).manifest?.versions.scipStatus, "failed");
    assert.equal(indexer.indexCalls, 1);

    const retry = await syncRepository(root, { skipGit: true, scipIndexer: indexer });
    assert.equal(retry.kind, "published");
    assert.equal(retry.counters.filesParsed, 0);
    assert.equal(retry.plan.fullGraphResolution, false);
    assert.equal(indexer.indexCalls, 2);

    indexer.fail = false;
    const recovered = await syncRepository(root, { skipGit: true, scipIndexer: indexer });
    assert.equal(recovered.kind, "published");
    assert.equal(recovered.counters.filesParsed, 0);
    assert.equal(recovered.plan.fullGraphResolution, true);
    assert.equal(graphFacts(root).manifest?.versions.scipStatus, "ready");
    assert.ok(graphFacts(root).edge?.resolution?.evidence.some((item) => item.kind === "scip"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SCIP fingerprint changes for a lockfile update re-resolve without parser reparse", async () => {
  const { root, indexer } = await fixture();
  indexer.fail = false;
  try {
    const first = await indexRepository(root, { skipGit: true, scipIndexer: indexer });
    assert.equal(first.kind, "published");
    const callsAfterIndex = indexer.indexCalls;
    const stable = await syncRepository(root, { skipGit: true, scipIndexer: indexer });
    assert.equal(stable.kind, "published");
    assert.equal(indexer.indexCalls, callsAfterIndex);
    assert.equal(indexer.discoveryCalls, 2);

    await writeFile(path.join(root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# dependency changed\n");
    indexer.version = "0.5.0";
    const changed = await syncRepository(root, { skipGit: true, scipIndexer: indexer });
    assert.equal(changed.kind, "published");
    assert.equal(changed.counters.filesParsed, 0);
    assert.equal(changed.plan.fullGraphResolution, true);
    assert.equal(indexer.indexCalls, callsAfterIndex + 1);
    assert.ok(changed.plan.reasons.includes("scip_fingerprint_changed"));
    assert.ok(graphFacts(root).edge?.resolution?.evidence.some((item) => item.kind === "scip"));

    const cold = await fixture();
    cold.indexer.fail = false;
    cold.indexer.version = "0.5.0";
    try {
      await writeFile(path.join(cold.root, "pnpm-lock.yaml"), "lockfileVersion: '9.0'\n# dependency changed\n");
      const clean = await indexRepository(cold.root, { skipGit: true, scipIndexer: cold.indexer });
      assert.equal(clean.kind, "published");
      assert.ok(clean.counters.filesParsed > 0);
      assert.deepEqual(graphSignature(root), graphSignature(cold.root));
      assert.ok(graphFacts(cold.root).edge?.resolution?.evidence.some((item) => item.kind === "scip"));
    } finally {
      await rm(cold.root, { recursive: true, force: true });
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("SCIP unavailable publishes the parser graph without attempting index generation", async () => {
  const { root, indexer } = await fixture();
  indexer.available = false;
  try {
    const outcome = await indexRepository(root, { skipGit: true, scipIndexer: indexer });
    assert.equal(outcome.kind, "published");
    assert.equal(graphFacts(root).manifest?.versions.scipStatus, "unavailable");
    assert.equal(indexer.indexCalls, 0);
    assert.ok(graphFacts(root).graph.nodes.some((node) => node.file === "consumer.ts" && node.name === "caller"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
