import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildFileGraphs } from "../src/core/graph/build-file-updates.js";
import { buildCodeGraph } from "../src/core/graph/build-graph.js";
import { GraphStore } from "../src/storage/graph/graph.store.js";
import { createFileHash } from "../src/core/repository/file-hash.js";
import { getRepoId, scanRepo } from "../src/core/repository/repository-files.js";

async function withRepo(callback: (repoPath: string) => Promise<void>): Promise<void> {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-0-incremental-"));

  try {
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src", "target.ts"), "export function oldTarget() {}\n");
    await writeFile(
      path.join(repoPath, "src", "importer.ts"),
      'import { oldTarget } from "./target.js";\nexport function run() { oldTarget(); }\n',
    );
    await callback(repoPath);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
}

async function hashes(repoPath: string, files: Set<string>): Promise<Map<string, string>> {
  return new Map(
    await Promise.all(
      [...files].map(async (file) => [
        file,
        createFileHash(await readFile(path.join(repoPath, file), "utf8")),
      ] as const),
    ),
  );
}

function canonicalGraph(graph: Awaited<ReturnType<typeof buildCodeGraph>>): string {
  return JSON.stringify({
    nodes: [...graph.nodes]
      .map((node) => ({
        ...node,
        qualifiedName: node.type === "file" ? undefined : node.qualifiedName,
      }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    edges: [...graph.edges].sort((a, b) =>
      [a.from, a.to, a.type].join(":").localeCompare([b.from, b.to, b.type].join(":")),
    ),
  });
}

test("incremental sync handles unchanged, one changed importer impact, deletion, and deterministic output", async () => {
  await withRepo(async (repoPath) => {
    const repoId = getRepoId(repoPath);
    const dbPath = path.join(repoPath, ".code-rag", "graph.db");
    const store = new GraphStore(dbPath);

    try {
      const allFiles = new Set(
        (await scanRepo(repoPath)).map((file) => path.relative(repoPath, file)),
      );
      const initial = await buildCodeGraph(repoPath);
      store.replaceGraph(repoId, initial, await hashes(repoPath, allFiles));

      assert.deepEqual(
        await buildFileGraphs(repoPath, repoId, [], allFiles, initial),
        [],
      );

      await writeFile(path.join(repoPath, "src", "target.ts"), "export function newTarget() {}\n");
      await writeFile(
        path.join(repoPath, "src", "importer.ts"),
        'import { newTarget } from "./target.js";\nexport function run() { newTarget(); }\n',
      );
      const currentFiles = new Set(["src/target.ts", "src/importer.ts"]);
      const updates = await buildFileGraphs(
        repoPath,
        repoId,
        ["src/target.ts", "src/importer.ts"],
        currentFiles,
        initial,
      );
      store.applyFileUpdates(repoId, await Promise.all(updates.map(async (update) => ({
        ...update,
        fileHash: createFileHash(await readFile(path.join(repoPath, update.file), "utf8")),
      }))), []);

      const synced = store.loadGraph(repoId);
      const expected = await buildCodeGraph(repoPath);
      assert.equal(canonicalGraph(synced), canonicalGraph(expected));
      assert.equal(synced.edges.filter((edge) => edge.type === "calls").length, 1);

      await unlink(path.join(repoPath, "src", "target.ts"));
      const afterDelete = await buildFileGraphs(
        repoPath,
        repoId,
        ["src/importer.ts"],
        new Set(["src/importer.ts"]),
        synced,
      );
      store.applyFileUpdates(
        repoId,
        await Promise.all(afterDelete.map(async (update) => ({
          ...update,
          fileHash: createFileHash(await readFile(path.join(repoPath, update.file), "utf8")),
        }))),
        ["src/target.ts"],
      );

      const deleted = store.loadGraph(repoId);
      assert.equal(deleted.nodes.some((node) => node.file === "src/target.ts"), false);
      assert.equal(deleted.edges.some((edge) => edge.type === "calls"), false);
      assert.equal(canonicalGraph(deleted), canonicalGraph(await buildCodeGraph(repoPath)));
    } finally {
      store.close();
    }
  });
});
