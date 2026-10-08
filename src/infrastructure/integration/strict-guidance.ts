import path from "node:path";

import { readTextFile, writeConfigFile } from "./config-file.js";
import {
  hasManagedBlock,
  removeManagedBlock,
  updateManagedBlock,
} from "./managed-block.js";

export const CODE_ATLAS_GUIDANCE_START = "<!-- code-atlas:start -->";
export const CODE_ATLAS_GUIDANCE_END = "<!-- code-atlas:end -->";

export async function strictGuidanceStatus(repoPath: string): Promise<boolean> {
  const file = await readTextFile(path.join(repoPath, "AGENTS.md"));
  return hasManagedBlock(file.text, CODE_ATLAS_GUIDANCE_START, CODE_ATLAS_GUIDANCE_END);
}

export async function installStrictGuidance(repoPath: string): Promise<boolean> {
  return installGuidance(repoPath, true);
}

export async function installGuidance(repoPath: string, strict = false): Promise<boolean> {
  void strict;
  const filePath = path.join(repoPath, "AGENTS.md");
  const file = await readTextFile(filePath);
  const body = guidanceBody();
  const updated = updateManagedBlock(
    file.text,
    CODE_ATLAS_GUIDANCE_START,
    CODE_ATLAS_GUIDANCE_END,
    body,
  );
  if (updated === file.text) return false;
  await writeConfigFile(file, updated);
  return true;
}

export async function uninstallStrictGuidance(repoPath: string): Promise<boolean> {
  const filePath = path.join(repoPath, "AGENTS.md");
  const file = await readTextFile(filePath);
  const updated = removeManagedBlock(
    file.text,
    CODE_ATLAS_GUIDANCE_START,
    CODE_ATLAS_GUIDANCE_END,
  );
  if (updated === file.text) return false;
  await writeConfigFile(file, updated);
  return true;
}

function guidanceBody(): string {
  return [
    "## CodeAtlas — Code Intelligence",
    "",
    "Use CodeAtlas for structural and relationship analysis when useful. Exact text, UI literals, and small isolated changes can use grep and direct source reads.",
    "",
    "After changing indexed source or configuration:",
    "- finish implementation and run validation",
    "- sync once against the final tree, then run final structural verification",
    "- avoid repeated syncs during intermediate edits",
    "- do not knowingly finish with stale indexed evidence",
    "",
  ].join("\n");
}
