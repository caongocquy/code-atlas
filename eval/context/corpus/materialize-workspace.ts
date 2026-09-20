import { lstat, mkdir, mkdtemp, readdir, rm, copyFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { execFile } from "../offline-guard.js";
import type { EvalCase } from "../types.js";

const execFileAsync = promisify(execFile);
const excludedFixtureEntries = new Set([".codeatlas", ".git"]);

async function copyFixture(source: string, destination: string): Promise<void> {
  for (const entry of await readdir(source, { withFileTypes: true })) {
    if (excludedFixtureEntries.has(entry.name)) continue;
    const sourcePath = path.join(source, entry.name);
    const destinationPath = path.join(destination, entry.name);
    if (entry.isDirectory()) {
      await mkdir(destinationPath, { recursive: true });
      await copyFixture(sourcePath, destinationPath);
    } else if (entry.isFile()) {
      await copyFile(sourcePath, destinationPath);
    } else {
      throw new Error(`Phase15D fixture contains unsupported entry: ${sourcePath}`);
    }
  }
}

async function initializeGit(root: string): Promise<void> {
  await execFileAsync("git", ["init", "--quiet"], { cwd: root });
  await execFileAsync("git", ["config", "user.email", "phase15d-eval@example.invalid"], { cwd: root });
  await execFileAsync("git", ["config", "user.name", "CodeAtlas Phase15D Eval"], { cwd: root });
}

function requiresGit(value: EvalCase): boolean {
  return value.kind === "snapshot";
}

export async function materializeWorkspace(
  input: { case: EvalCase; fixtureRoot: string },
  createTempRoot: typeof mkdtemp = mkdtemp,
): Promise<{ root: string; cleanup: () => Promise<void>; git: boolean }> {
  const fixture = await lstat(input.fixtureRoot);
  if (!fixture.isDirectory()) throw new Error(`Phase15D fixture root must be a directory: ${input.fixtureRoot}`);

  const root = await createTempRoot(path.join(tmpdir(), "code-atlas-context-eval-"));
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    await rm(root, { recursive: true, force: true });
    cleaned = true;
  };

  try {
    await copyFixture(input.fixtureRoot, root);
    const git = requiresGit(input.case);
    if (git) await initializeGit(root);
    return { root, cleanup, git };
  } catch (error) {
    await cleanup();
    throw error;
  }
}
