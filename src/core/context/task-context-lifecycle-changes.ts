import { readGitChanges } from "../../infrastructure/git/git-change-reader.js";
import { normalizeTaskContextInput } from "./task-context-normalizer.js";

export async function readCurrentChangedPaths(repoPath: string): Promise<string[]> {
  const changes = await readGitChanges(repoPath, { mode: "working" });
  return normalizeTaskContextInput({ task: "working-tree", changedPaths: changes.files.map((file) => file.path) }).changedPaths;
}
