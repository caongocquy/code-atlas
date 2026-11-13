import { mkdir, mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";

import { buildFileGraphs } from "../src/core/graph/build-file-updates.js";
import { buildCodeGraph } from "../src/core/graph/build-graph.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
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
    const dbPath = path.join(repoPath, "atlas.db");
    const targetFile = path.join("src", "target.ts");
    const importerFile = path.join("src", "importer.ts");
    const store = new AtlasStore(dbPath);

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
      const currentFiles = new Set([targetFile, importerFile]);
      const updates = await buildFileGraphs(
        repoPath,
        repoId,
        [targetFile, importerFile],
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
        [importerFile],
        new Set([importerFile]),
        synced,
      );
      store.applyFileUpdates(
        repoId,
        await Promise.all(afterDelete.map(async (update) => ({
          ...update,
          fileHash: createFileHash(await readFile(path.join(repoPath, update.file), "utf8")),
        }))),
        [targetFile],
      );

      const deleted = store.loadGraph(repoId);
      assert.equal(deleted.nodes.some((node) => node.file === targetFile), false);
      assert.equal(deleted.edges.some((edge) => edge.type === "calls"), false);
      assert.equal(canonicalGraph(deleted), canonicalGraph(await buildCodeGraph(repoPath)));
    } finally {
      store.close();
    }
  });
});

test("incremental graph resolves imports from Windows-style relative paths", async () => {
  await withRepo(async (repoPath) => {
    const repoId = getRepoId(repoPath);
    const initial = await buildCodeGraph(repoPath);
    assert.deepEqual(
      initial.nodes.filter((node) => node.type === "file").map((node) => node.file).sort(),
      ["src/importer.ts", "src/target.ts"],
    );

    await writeFile(path.join(repoPath, "src", "target.ts"), "export function newTarget() {}\\n");
    await writeFile(
      path.join(repoPath, "src", "importer.ts"),
      'import { newTarget } from "./target.js";\\nexport function run() { newTarget(); }\\n',
    );

    const posixFiles = ["src/target.ts", "src/importer.ts"];
    const windowsFiles = [path.win32.join("src", "target.ts"), path.win32.join("src", "importer.ts")];
    const posix = await buildFileGraphs(repoPath, repoId, posixFiles, new Set(posixFiles), initial);
    const windows = await buildFileGraphs(repoPath, repoId, windowsFiles, new Set(windowsFiles), initial);

    assert.deepEqual(windows, posix);
    assert.deepEqual(windows.map((update) => update.file).sort(), [...posixFiles].sort());
    assert.equal(windows.flatMap((update) => update.edges).filter((edge) => edge.type === "imports").length, 1);
    assert.equal(windows.flatMap((update) => update.edges).filter((edge) => edge.type === "calls").length, 1);
    assert.equal(windows.some((update) => update.nodes.some((node) => node.file.includes("\\\\"))), false);
  });
});
