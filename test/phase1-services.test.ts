import { readFile, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { GraphStore } from "../src/graph/store.js";
import { indexGraph } from "../src/services/graph-index.js";
import { silentProgressRunner } from "../src/services/progress.js";

async function source(relativePath: string): Promise<string> {
  return readFile(new URL(`../${relativePath}`, import.meta.url), "utf8");
}

test("graph service keeps deterministic incremental behavior with silent progress", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-1-graph-"));

  try {
    await writeFile(
      path.join(repoPath, "source.ts"),
      "export function source() { return true; }\n",
    );

    const first = await indexGraph(repoPath, { progress: silentProgressRunner });
    assert.equal(first.status, "indexed");
    assert.equal(first.fullRebuild, true);
    assert.equal(first.files, 1);

    const store = new GraphStore(path.join(repoPath, ".code-rag", "graph.db"));

    try {
      const initialGraph = store.loadGraph(first.repoId);
      const second = await indexGraph(repoPath, { progress: silentProgressRunner });

      assert.equal(second.status, "current");
      assert.equal(second.unchangedFiles, 1);
      assert.deepEqual(store.loadGraph(first.repoId), initialGraph);
    } finally {
      store.close();
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});

test("Phase 1 entrypoints delegate orchestration and services keep CLI/process boundaries", async () => {
  const graphAdapter = await source("src/index-graph.ts");
  const semanticAdapter = await source("src/embed-repo.ts");
  const askAdapter = await source("src/ask-rag.ts");
  const graphService = await source("src/services/graph-index.ts");
  const semanticService = await source("src/services/semantic-index.ts");
  const progressService = await source("src/services/progress.ts");
  const inspectorService = await source("src/services/retrieval-inspector.ts");

  assert.match(graphAdapter, /indexGraph/);
  assert.doesNotMatch(graphAdapter, /GraphStore|buildFileGraphs|scanRepo|createFileHash/);
  assert.match(semanticAdapter, /indexSemantic/);
  assert.doesNotMatch(
    semanticAdapter,
    /from ["'][^"']*(?:qdrant|embedding|code-parser|copy-on-write)/,
  );
  assert.match(askAdapter, /answerCodebase/);
  assert.doesNotMatch(askAdapter, /chatStream/);

  assert.match(semanticService, /\.\.\/lib\/embedding\.js/);
  assert.match(semanticService, /\.\.\/lib\/qdrant\.js/);
  assert.match(semanticService, /runCopyOnWriteGeneration/);
  assert.match(inspectorService, /export async function inspectRetrieval/);
  assert.match(inspectorService, /export async function answerCodebase/);

  for (const serviceSource of [
    graphService,
    semanticService,
    progressService,
    inspectorService,
  ]) {
    assert.doesNotMatch(serviceSource, /listr2|chalk|figures|ora|node:child_process/);
    assert.doesNotMatch(serviceSource, /\b(?:spawn|execFile)\s*\(/);
  }
});
