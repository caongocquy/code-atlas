import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { resolveRepositoryExcludes, scanRepo } from "../src/core/repository/repository-files.js";
import { runInitCommand } from "../src/adapters/cli/init.command.js";
import { formatCommandHelp, formatRootHelp } from "../src/adapters/cli/cli-help.js";
import { renderBrandHeader } from "../src/adapters/cli/cli-presentation.js";
import { formatIndexResult } from "../src/adapters/cli/cli-output.js";
import { AtlasStore } from "../src/storage/atlas/atlas.store.js";
import { getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { getRepositoryStatus } from "../src/core/repository/repository-status.service.js";

async function fixture(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "codeatlas-pre17e-"));
}

test("repository excludes combine safe defaults, detected stacks, project config, and legacy gitignore", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "package.json"), "{}\n");
    await writeFile(path.join(root, ".gitignore"), "legacy-output/\n");
    await writeFile(path.join(root, "codeatlas.config.json"), JSON.stringify({
      version: 1,
      excludes: [".superpowers/**", "docs/superpowers/**", "!.git/", "!.codeatlas/"],
    }));
    for (const relative of ["src/app.ts", "dist/app.js", "legacy-output/old.ts", ".superpowers/private.ts", "docs/superpowers/plan.md", ".git/config", "node_modules/pkg/index.js"]) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "content\n");
    }

    const excludes = await resolveRepositoryExcludes(root);
    const files = await scanRepo(root);
    assert.deepEqual(excludes.stacks, ["node"]);
    assert.equal(excludes.matches(".git", true), true);
    assert.equal(excludes.matches(".codeatlas", true), true);
    assert.match(excludes.summary, /project config/);
    assert.match(excludes.summary, /\.gitignore/);
    assert.deepEqual(files.map((file) => path.relative(root, file)), ["src/app.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("common build names and CodeAtlas project exclusions are not global defaults", async () => {
  const root = await fixture();
  try {
    for (const relative of ["build/keep.ts", ".superpowers/keep.ts", "docs/superpowers/keep.md"]) {
      const target = path.join(root, relative);
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, "content\n");
    }
    const excludes = await resolveRepositoryExcludes(root);
    assert.equal(excludes.matches("build", true), false);
    assert.deepEqual((await scanRepo(root)).map((file) => path.relative(root, file)), [
      ".superpowers/keep.ts",
      "build/keep.ts",
      "docs/superpowers/keep.md",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init preserves .gitignore and writes concise idempotent managed guidance", async () => {
  const root = await fixture();
  const gitignore = "# user rules\ncustom/\n";
  const userGuidance = "# User notes\nKeep this paragraph.\n\n<!-- code-atlas:start -->\nOld generated text\n<!-- code-atlas:end -->\n";
  try {
    await writeFile(path.join(root, ".gitignore"), gitignore);
    await writeFile(path.join(root, "AGENTS.md"), userGuidance);
    await runInitCommand(["--no-index"], root);
    const first = await readFile(path.join(root, "AGENTS.md"), "utf8");
    await runInitCommand(["--no-index"], root);
    const second = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.equal(second, first);
    assert.equal((second.match(/<!-- code-atlas:start -->/g) ?? []).length, 1);
    assert.match(second, /# User notes\nKeep this paragraph\./);
    assert.doesNotMatch(second, /Old generated text/);
    assert.match(second, /validation/);
    assert.doesNotMatch(second, /\| Task \| Use \|/);
    assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), gitignore);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("repeated init indexes the final guidance once and leaves the generation current", async () => {
  const root = await fixture();
  try {
    await writeFile(path.join(root, "src.ts"), "export const value = 1;\n");
    await runInitCommand(["--json"], root);
    const repoId = getRepositoryIdentity(root).id;
    const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const firstGeneration = store.getActiveGenerationId(repoId);
    store.close();
    assert.equal((await getRepositoryStatus(root)).indexState, "current");

    await runInitCommand(["--json"], root);
    const secondStore = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"));
    const secondGeneration = secondStore.getActiveGenerationId(repoId);
    secondStore.close();
    assert.equal(secondGeneration, firstGeneration);
    assert.equal((await getRepositoryStatus(root)).indexState, "current");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reindex is listed with forced rebuild semantics", () => {
  assert.match(formatRootHelp(), /reindex/);
  assert.match(formatCommandHelp("reindex"), /forced full rebuild/i);
});

test("no-op index output is concise and leaves unconfigured semantic neutral", () => {
  const result = formatIndexResult({
    kind: "published",
    published: true,
    generationId: "generation-1",
    repositoryId: "repository-1",
    generationReused: true,
    operation: "index",
    repoPath: "/repo",
    repoId: "repository-1",
    changeDetection: "filesystem",
    changes: { addedFiles: [], changedFiles: [], deletedFiles: [], candidateFiles: [] },
    graph: { repoPath: "/repo", repoId: "repository-1", status: "current", version: "1", versionChanged: false, fullRebuild: false, files: 1, addedFiles: 0, changedFiles: 0, unchangedFiles: 1, deletedFiles: 0, impactedFiles: 0, nodes: 1, edges: 0, totalMs: 1 },
    lexical: { repoPath: "/repo", repoId: "repository-1", status: "current", version: "1", versionChanged: false, fullRebuild: false, files: 1, indexedFiles: 0, skippedFiles: 1, deletedFiles: 0, documents: 0, totalMs: 1 },
    totalMs: 1,
    frameworkConfig: [],
    plan: {} as never,
    counters: {} as never,
  });
  assert.match(result, /No source changes; existing generation reused/);
  assert.match(result, /current · reused/);
  assert.match(result, /reused when configured/);
  assert.match(result, /- not configured/);
});

test("interactive brand header begins with exactly one blank line", () => {
  const banner = renderBrandHeader("Repository indexing", { isTTY: true, interactive: true, color: false, columns: 100 });
  assert.ok(banner.startsWith("\n"));
  assert.ok(!banner.startsWith("\n\n"));
  assert.equal(renderBrandHeader("Repository indexing", { isTTY: false, interactive: false, color: false }), "");
});
