import { execFileSync } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

/** Prepare a clean, local-only Git history for copied retrieval fixtures. */
export async function initializeRetrievalFixtureGit(root: string): Promise<void> {
  const gitDir = path.join(root, ".git");
  // Refuse an existing repository instead of modifying its configuration or history.
  await mkdir(gitDir);
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.toUpperCase().startsWith("GIT_")));
  Object.assign(env, {
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: path.join(gitDir, "unused-global-config"),
    GIT_AUTHOR_DATE: "2000-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2000-01-01T00:00:00Z",
  });
  const git = (args: string[]) => execFileSync("git", args, { cwd: root, env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  git(["init", "--quiet", "--template="]);
  git(["config", "--local", "core.autocrlf", "false"]);
  await mkdir(path.join(gitDir, "info"), { recursive: true });
  // Generated indexes are not source changes and must not enter Git snapshots.
  await writeFile(path.join(gitDir, "info", "exclude"), "/.codeatlas/\n/.code-rag/\n");
  git(["add", "--all", "--", "."]);
  git(["-c", "user.name=Code Atlas Retrieval Eval", "-c", "user.email=code-atlas-eval@example.invalid", "commit", "--quiet", "--no-gpg-sign", "-m", "Retrieval fixture"]);
  if (git(["status", "--porcelain=v1", "--untracked-files=all"]).trim()) {
    throw new Error("Retrieval fixture must have a clean Git working tree");
  }
}
