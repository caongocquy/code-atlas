import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import assert from "node:assert/strict";

import { canonicalRepositoryPath, getRepositoryIdentity } from "../src/core/repository/repository-identity.js";
import { getWorkspaceIdentity } from "../src/core/context/context-identity.js";

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync("git", args, { cwd, encoding: "utf8" });
}

async function gitRepository(): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-identity-"));
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@example.test"]);
  await git(root, ["config", "user.name", "CodeAtlas Tests"]);
  await writeFile(path.join(root, "source.ts"), "export const value = 1;\n");
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);
  return root;
}

test("workspace identity shares the existing repository identity across Git worktrees", async () => {
  const root = await gitRepository();
  const worktree = path.join(path.dirname(root), `${path.basename(root)}-worktree`);
  try {
    await git(root, ["worktree", "add", "-q", "-b", "phase15a-worktree", worktree]);

    const primary = getWorkspaceIdentity(root);
    const secondary = getWorkspaceIdentity(worktree);

    assert.notEqual(getRepositoryIdentity(root).identityKey, getRepositoryIdentity(worktree).identityKey);
    assert.equal(primary.repositoryIdentity, `git-common-v1:${primary.gitCommonDirectory}`);
    assert.equal(primary.repositoryIdentity, secondary.repositoryIdentity);
    assert.notEqual(primary.workspaceIdentity, secondary.workspaceIdentity);
    assert.equal(primary.gitCommonDirectory, secondary.gitCommonDirectory);
    assert.equal(primary.canonicalPath, canonicalRepositoryPath(root));
    assert.equal(secondary.canonicalPath, canonicalRepositoryPath(worktree));
  } finally {
    await git(root, ["worktree", "remove", "--force", worktree]).catch(() => undefined);
    await rm(root, { recursive: true, force: true });
    await rm(worktree, { recursive: true, force: true });
  }
});

test("workspace identity uses canonical root and never content hashes for non-Git directories", async () => {
  const parent = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-nongit-"));
  const first = path.join(parent, "first");
  const second = path.join(parent, "second");
  try {
    await mkdir(first);
    await mkdir(second);
    await writeFile(path.join(first, "same.ts"), "export const same = true;\n");
    await writeFile(path.join(second, "same.ts"), "export const same = true;\n");

    const firstIdentity = getWorkspaceIdentity(first);
    const secondIdentity = getWorkspaceIdentity(second);

    assert.equal(firstIdentity.source, "filesystem");
    assert.notEqual(firstIdentity.repositoryIdentity, secondIdentity.repositoryIdentity);
    assert.notEqual(firstIdentity.workspaceIdentity, secondIdentity.workspaceIdentity);
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("ambiguous or malformed Git metadata fails safe", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15a-malformed-"));
  try {
    await writeFile(path.join(root, ".git"), "gitdir: /missing/worktree\n");
    assert.throws(() => getWorkspaceIdentity(root), /identity|Git|worktree/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
