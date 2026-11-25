import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { initializeRetrievalFixtureGit } from "../eval/retrieval/initialize-fixture-git.js";
import { readGitChangeSources } from "../src/infrastructure/git/git-change-reader.js";

test("CA-01 retrieval fixture supplies clean source snapshots without indexing generated state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-ca01-git-fixture-"));
  try {
    const source = "export function load() { return 1; }\n";
    const file = path.join(root, "source.ts");
    await writeFile(file, source);
    await initializeRetrievalFixtureGit(root);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim();
    await mkdir(path.join(root, ".codeatlas"));
    await writeFile(path.join(root, ".codeatlas", "atlas.db"), "generated");
    const clean = await readGitChangeSources(root, { mode: "working" });
    assert.deepEqual(clean.changes.files, []);
    assert.deepEqual(clean.baseline.files, new Map([["source.ts", Buffer.from(source)]]));
    assert.deepEqual(clean.target.files, clean.baseline.files);
    await assert.rejects(initializeRetrievalFixtureGit(root), { code: "EEXIST" });
    assert.equal(execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(), head);

    const modified = source.replace("1", "2");
    await writeFile(file, modified);
    const changed = await readGitChangeSources(root, { mode: "working" });
    assert.deepEqual(changed.changes.files.map(({ path, status }) => ({ path, status })), [{ path: "source.ts", status: "modified" }]);
    assert.equal(changed.baseline.files.get("source.ts")?.toString("utf8"), source);
    assert.equal(changed.target.files.get("source.ts")?.toString("utf8"), modified);
    assert.deepEqual([...changed.target.files.keys()], ["source.ts"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
