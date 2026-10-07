import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";
import { summarizeFrameworkCoverage } from "../src/core/framework/framework-coverage.js";
import { projectFrameworkGraph } from "../src/core/graph/query/framework-query.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { getRepositoryStatusReadOnly } from "../src/core/repository/repository-status.service.js";
import { createDefaultProviders } from "../src/infrastructure/provider-defaults.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

test("fatal framework candidate skips semantic provider and preserves active generation", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-framework-fail-fast-"));
  try {
    await writeFile(path.join(root, "App.tsx"), "export function App() { return <div />; }\n");
    const first = await indexRepository(root, { skipGit: true });
    assert.equal(first.kind, "published", first.kind === "failed" ? first.failure.message : undefined);

    await writeFile(path.join(root, "App.tsx"), "import { Missing } from './Missing';\nexport function App() { return <Missing />; }\n");
    let providerCalls = 0;
    const failed = await indexRepository(root, {
      skipGit: true,
      includeSemantic: true,
      diagnosticTimings: true,
      semanticProviders: {
        embeddingProvider: {
          id: "test", version: "v1", dimensions: 3,
          isAvailable: async () => { providerCalls += 1; return true; },
          embedBatch: async (texts) => { providerCalls += 1; return texts.map(() => [0.1, 0.2, 0.3]); },
        },
        vectorStore: createDefaultProviders(root).vectorStore,
      },
    });
    assert.equal(failed.kind, "failed");
    if (failed.kind !== "failed") return;
    assert.match(failed.failure.message, /Candidate framework materialization is incomplete/);
    assert.match(failed.failure.message, /framework_target_unknown/);
    assert.equal(providerCalls, 0);
    assert.equal(failed.phaseTimingsMs?.semanticBuild, undefined);

    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      assert.equal(store.getActiveGenerationId(repository.id), first.kind === "published" ? first.generationId : undefined);
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("known dynamic JSX publishes partial framework and runs semantic once", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-framework-dynamic-"));
  try {
    await writeFile(path.join(root, "package.json"), '{"dependencies":{"react":"19.0.0"}}\n');
    await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"jsx":"react-jsx"}}\n');
    await writeFile(path.join(root, "App.tsx"), "export function App({ Icon }: { Icon: () => null }) { return <Icon />; }\n");
    let availabilityCalls = 0;
    let embeddingCalls = 0;
    const result = await indexRepository(root, {
      skipGit: true,
      includeSemantic: true,
      diagnosticTimings: true,
      semanticProviders: {
        embeddingProvider: {
          id: "test", version: "v1", dimensions: 3,
          isAvailable: async () => { availabilityCalls += 1; return true; },
          embedBatch: async (texts) => { embeddingCalls += 1; return texts.map(() => [0.1, 0.2, 0.3]); },
        },
        vectorStore: createDefaultProviders(root).vectorStore,
      },
    });
    assert.equal(result.kind, "published", result.kind === "failed" ? result.failure.message : undefined);
    assert.equal(availabilityCalls, 1);
    assert.equal(embeddingCalls, 1);
    assert.ok(result.phaseTimingsMs?.semanticBuild !== undefined);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      const framework = store.loadFramework(repository.id);
      assert.equal(framework?.complete, false);
      assert.equal(framework?.relationships.length, 0);
      assert.deepEqual(framework?.diagnostics.map((item) => [item.code, item.strategy]), [["framework_construct_unsupported", "jsx-dynamic-component-usage"]]);
      const coverage = summarizeFrameworkCoverage(framework, CURRENT_INDEX_VERSION_DOMAINS.frameworkResolutionVersion!);
      assert.equal(coverage.mayBeIncomplete, true);
      assert.equal(coverage.authoritativeNegativeResults, false);
      const projection = projectFrameworkGraph(store.loadGraph(repository.id), framework);
      assert.equal(projection.mayBeIncomplete, true);
      assert.equal(projection.edges.filter((item) => item.kind === "framework").length, 0);
    } finally { store.close(); }
    const status = await getRepositoryStatusReadOnly(root);
    assert.equal(status.capabilities.graph.state, "ready");
    assert.equal(status.graph.status, "ready");
    assert.equal(status.framework.mayBeIncomplete, true);
    assert.equal(status.framework.authoritativeNegativeResults, false);
    assert.equal(status.framework.diagnostics.length, 1);
    await writeFile(path.join(root, "tsconfig.json"), '{"compilerOptions":{"jsx":"preserve"}}\n');
    const changedConfigStatus = await getRepositoryStatusReadOnly(root);
    assert.equal(changedConfigStatus.capabilities.graph.state, "stale");
    assert.equal(changedConfigStatus.graph.status, "stale");
    assert.equal(changedConfigStatus.capabilities.lexical.state, "ready");
  } finally { await rm(root, { recursive: true, force: true }); }
});

test("changed dynamic JSX source invalidates its partial framework evidence", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-framework-dynamic-sync-"));
  try {
    await writeFile(path.join(root, "App.tsx"), "export function App({ Icon }: { Icon: () => null }) { return <Icon />; }\n");
    const first = await indexRepository(root, { skipGit: true });
    assert.equal(first.kind, "published", first.kind === "failed" ? first.failure.message : undefined);
    await writeFile(path.join(root, "App.tsx"), "function Icon() { return null; }\nexport function App() { return <Icon />; }\n");
    const second = await indexRepository(root, { skipGit: true });
    assert.equal(second.kind, "published", second.kind === "failed" ? second.failure.message : undefined);
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(root));
      const framework = store.loadFramework(repository.id);
      assert.equal(framework?.complete, true);
      assert.equal(framework?.diagnostics.length, 0);
      assert.equal(framework?.relationships.length, 1);
    } finally { store.close(); }
  } finally { await rm(root, { recursive: true, force: true }); }
});
