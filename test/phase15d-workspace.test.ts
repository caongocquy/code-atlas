import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, mkdir, readFile, readdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import type { EvalCase } from "../eval/context/types.js";
import { materializeWorkspace } from "../eval/context/corpus/materialize-workspace.js";

const execFile = promisify(execFileCallback);

function evalCase(overrides: Partial<EvalCase> = {}): EvalCase {
  return {
    caseId: "workspace-case",
    kind: "synthetic",
    language: "typescript",
    syntheticClass: "exact-target",
    workspaceRef: "synthetic/typescript/exact-target",
    task: "Inspect the fixture.",
    anchors: [],
    changedPaths: [],
    truth: { requiredSubjects: [], supportingSubjects: [], forbiddenRequiredSubjects: [] },
    ...overrides,
  };
}

async function git(root: string, args: string[]): Promise<string> {
  const result = await execFile("git", args, { cwd: root, encoding: "utf8" });
  return String(result.stdout).trim();
}

test("materializeWorkspace creates independent source-only synthetic roots outside the caller workspace", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-fixture-"));
  const cwdSentinel = path.join(process.cwd(), "workspace-case");
  try {
    await mkdir(path.join(fixtureRoot, "src"), { recursive: true });
    await mkdir(path.join(fixtureRoot, ".codeatlas"), { recursive: true });
    await mkdir(path.join(fixtureRoot, ".git"), { recursive: true });
    await writeFile(path.join(fixtureRoot, "src", "value.ts"), "export const value = 1;\n");
    await writeFile(path.join(fixtureRoot, ".codeatlas", "atlas.db"), "stale state");
    await writeFile(path.join(fixtureRoot, ".git", "config"), "stale Git metadata");

    const first = await materializeWorkspace({ case: evalCase(), fixtureRoot });
    const second = await materializeWorkspace({ case: evalCase(), fixtureRoot });
    try {
      assert.notEqual(first.root, second.root);
      assert.notEqual(first.root, fixtureRoot);
      assert.equal(first.git, false);
      assert.equal(await readFile(path.join(first.root, "src", "value.ts"), "utf8"), "export const value = 1;\n");
      await assert.rejects(() => access(path.join(first.root, ".codeatlas", "atlas.db")));
      await assert.rejects(() => access(path.join(first.root, ".git", "config")));
      await assert.rejects(() => access(cwdSentinel));

      await writeFile(path.join(first.root, "src", "value.ts"), "export const value = 2;\n");
      assert.equal(await readFile(path.join(second.root, "src", "value.ts"), "utf8"), "export const value = 1;\n");
    } finally {
      await first.cleanup();
      await second.cleanup();
      await first.cleanup();
    }
    await assert.rejects(() => access(first.root));
    await assert.rejects(() => access(second.root));
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("materializeWorkspace initializes snapshots as locally identified Git repositories", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-snapshot-"));
  try {
    await writeFile(path.join(fixtureRoot, "sample.ts"), "export const sample = true;\n");
    const workspace = await materializeWorkspace({
      case: evalCase({ kind: "snapshot", syntheticClass: undefined, workspaceRef: "snapshots/sample" }),
      fixtureRoot,
    });
    try {
      assert.equal(workspace.git, true);
      assert.equal(await git(workspace.root, ["rev-parse", "--is-inside-work-tree"]), "true");
      assert.equal(await git(workspace.root, ["config", "user.email"]), "phase15d-eval@example.invalid");
      assert.equal(await git(workspace.root, ["config", "user.name"]), "CodeAtlas Phase15D Eval");
    } finally {
      await workspace.cleanup();
    }
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});

test("materializeWorkspace removes its generated root when fixture copying fails", async () => {
  const fixtureRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-invalid-fixture-"));
  const before = new Set((await readdir(tmpdir())).filter((entry) => entry.startsWith("code-atlas-context-eval-")));
  try {
    await symlink(path.join(fixtureRoot, "missing.ts"), path.join(fixtureRoot, "linked.ts"));
    await assert.rejects(() => materializeWorkspace({ case: evalCase(), fixtureRoot }), /unsupported entry/i);
    const after = (await readdir(tmpdir())).filter((entry) => entry.startsWith("code-atlas-context-eval-") && !before.has(entry));
    assert.deepEqual(after, []);
  } finally {
    await rm(fixtureRoot, { recursive: true, force: true });
  }
});
