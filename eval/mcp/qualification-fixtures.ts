import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { AtlasStore } from "../../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../../src/core/repository/repository-identity.js";
import { GRAPH_INDEX_VERSION } from "../../src/config/constants.js";
import { indexRepository } from "../../src/core/indexing/index-pipeline.service.js";
import { loadIndexedGraphReadOnly } from "../../src/core/graph/indexed-graph.service.js";

export async function createDeepWorkload(): Promise<string> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "ca01-deep-"));
  try {
    const source = Array.from({ length: 24 }, (_, i) => `export function deep${i}() { return ${i ? `deep${i - 1}()` : "true"}; }`).join("\n");
    await writeFile(path.join(repoPath, "chain.ts"), source);
    const store = new AtlasStore(path.join(repoPath, ".codeatlas/atlas.db"));
    try {
      const repository = store.ensureRepository(getRepositoryIdentity(repoPath));
      // Declared graph fixture: qualify SQL hydration/traversal, independently of parser inference.
      store.replaceGraph(repository.id, {
        nodes: Array.from({ length: 24 }, (_, i) => ({ id: `deep-${i}`, name: `deep${i}`, type: "function" as const, file: "chain.ts", startLine: i + 1, endLine: i + 1 })),
        edges: Array.from({ length: 23 }, (_, i) => ({ from: `deep-${i + 1}`, to: `deep-${i}`, type: "calls" as const })),
      }, new Map([["chain.ts", createHash("sha256").update(source).digest("hex")]]), GRAPH_INDEX_VERSION);
    } finally { store.close(); }
    const loaded = await loadIndexedGraphReadOnly(repoPath);
    assert.equal(loaded.graph.edges.filter(edge => edge.type === "calls").length, 23);
    return repoPath;
  } catch (error) { await rm(repoPath, { recursive: true, force: true }); throw error; }
}

export async function createReactWorkload(root: string): Promise<string> {
  const repoPath = await mkdtemp(path.join(os.tmpdir(), "ca01-react-"));
  try {
    await cp(path.join(root, "web/src"), path.join(repoPath, "web"), { recursive: true });
    const outcome = await indexRepository(repoPath, { skipGit: true, includeSemantic: false });
    assert.equal(outcome.kind, "published", JSON.stringify(outcome));
    return repoPath;
  } catch (error) { await rm(repoPath, { recursive: true, force: true }); throw error; }
}
