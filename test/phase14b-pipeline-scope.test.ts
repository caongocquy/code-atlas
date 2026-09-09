import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository, syncRepository } from "../src/core/indexing/index-pipeline.service.js";

test("pipeline resolves only changed file and direct importer while retaining unrelated graph state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase14b-pipeline-scope-"));
  const dependency = path.join(root, "src", "dep.ts");

  try {
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "src", "consumer.ts"), 'import { dep } from "./dep.js"; export const consumer = dep;\n');
    await writeFile(dependency, "export const dep = true;\n");
    await writeFile(path.join(root, "src", "unrelated.ts"), "export const unrelated = true;\n");

    const first = await indexRepository(root, { skipGit: true });
    assert.equal(first.kind, "published");

    await writeFile(dependency, "export const dep = false;\n");
    const result = await syncRepository(root, { skipGit: true });

    assert.equal(result.kind, "published");
    assert.deepEqual(result.plan.resolvePaths, ["src/consumer.ts", "src/dep.ts"]);
    assert.equal(result.counters.filesParsed, 1);
    assert.equal(result.counters.filesResolved, 2);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
