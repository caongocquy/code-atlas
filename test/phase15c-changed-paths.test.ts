import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { readCurrentChangedPaths } from "../src/core/context/task-context-lifecycle-changes.js";

const execFile = promisify(execFileCallback);

async function git(repoPath: string, args: string[]): Promise<void> {
  await execFile("git", args, { cwd: repoPath });
}

test("captures normalized sorted working-tree changed paths", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15c-changes-"));
  try {
    await mkdir(path.join(repoPath, "src"), { recursive: true });
    await writeFile(path.join(repoPath, "src/z.ts"), "export const z = 1;\n");
    await git(repoPath, ["init", "-q"]);
    await git(repoPath, ["config", "user.email", "test@example.com"]);
    await git(repoPath, ["config", "user.name", "CodeAtlas Test"]);
    await git(repoPath, ["add", "."]);
    await git(repoPath, ["commit", "-qm", "initial"]);

    await writeFile(path.join(repoPath, "src/z.ts"), "export const z = 2;\n");
    await writeFile(path.join(repoPath, "src/a.txt"), "untracked\n");

    assert.deepEqual(await readCurrentChangedPaths(repoPath), ["src/a.txt", "src/z.ts"]);
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
