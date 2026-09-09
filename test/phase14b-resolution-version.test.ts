import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository, type IndexRunOutcome } from "../src/core/indexing/index-pipeline.service.js";
import { CURRENT_INDEX_VERSION_DOMAINS } from "../src/core/repository/index-version.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";

type IndexedFixture = {
  root: string;
  repositoryId: string;
  allSemanticEdgesUseVersion(version: string): Promise<boolean>;
  activeSnapshot(): Promise<unknown>;
};

async function createIndexedFixture(): Promise<IndexedFixture> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-resolution-version-"));
  await writeFile(path.join(root, "dep.ts"), "export function dep() { return true; }\n");
  await writeFile(path.join(root, "consumer.ts"), 'import { dep } from "./dep.js"; export function consumer() { return dep(); }\n');
  await writeFile(path.join(root, "other.ts"), "export function other() { return 1; }\n");
  const first = await indexRepository(root, { skipGit: true });
  assert.equal(first.kind, "published");
  const repositoryId = getRepositoryIdentity(root).id;

  return {
    root,
    repositoryId,
    async allSemanticEdgesUseVersion(version) {
      const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
      try {
        return store.loadGraph(repositoryId).edges
          .filter((edge) => edge.type === "calls" || edge.type === "extends")
          .every((edge) => edge.resolution?.resolutionVersion === version);
      } finally {
        store.close();
      }
    },
    async activeSnapshot() {
      const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
      try {
        return {
          generationId: store.getActiveGenerationId(repositoryId),
          graph: store.loadGraph(repositoryId),
          coverage: store.getGraphResolutionCoverage(repositoryId),
          diagnostics: store.getGraphResolutionDiagnostics(repositoryId),
        };
      } finally {
        store.close();
      }
    },
  };
}

async function runWithResolutionVersion(fixture: IndexedFixture, version: string): Promise<IndexRunOutcome> {
  const previous = CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion;
  CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion = version;
  try {
    return await syncRepository(fixture.root, { skipGit: true });
  } finally {
    CURRENT_INDEX_VERSION_DOMAINS.resolutionVersion = previous;
  }
}

test("resolution-version bump reuses facts and emits only current-version edges", async () => {
  const fixture = await createIndexedFixture();
  const originalWriteCandidateGraph = AtlasStore.prototype.writeCandidateGraph;
  let reusedResolutionPaths: readonly string[] | undefined;
  try {
    AtlasStore.prototype.writeCandidateGraph = function recordResolutionReuse(...args: Parameters<AtlasStore["writeCandidateGraph"]>) {
      reusedResolutionPaths = args[4];
      return originalWriteCandidateGraph.apply(this, args);
    };
    const version = "1.0.1";
    const result = await runWithResolutionVersion(fixture, version);
    assert.equal(result.kind, "published");
    assert.equal(result.counters.filesParsed, 0);
    assert.equal(result.plan.fullGraphResolution, true);
    assert.deepEqual(result.plan.resolvePaths, ["consumer.ts", "dep.ts", "other.ts"]);
    assert.equal(result.counters.filesResolved, 3);
    assert.equal(await fixture.allSemanticEdgesUseVersion(version), true);
    assert.deepEqual(reusedResolutionPaths, []);
  } finally {
    AtlasStore.prototype.writeCandidateGraph = originalWriteCandidateGraph;
    await rm(fixture.root, { recursive: true, force: true });
  }
});
