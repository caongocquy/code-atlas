import fs from "node:fs/promises";
import path from "node:path";

import { getRepositoryStatus } from "../../core/repository/repository-status.service.js";
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
  const body = await guidanceBody(repoPath);
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

async function guidanceBody(repoPath: string): Promise<string> {
  const capabilities = await capabilitySummary(repoPath);
  const graphGuidance = capabilities.graphReady
    ? [
      "When graph is ready, use `find_callers`, `find_callees`, `find_imports`, `find_imported_by`, `impact`, and `trace` for structural relationships and blast-radius questions.",
      "Use graph tools for shared, unfamiliar, structural, or cross-module changes; they are not required for trivial or isolated edits.",
    ]
    : [];
  return [
    "## CodeAtlas — Code Intelligence",
    "",
    "This repository is indexed by CodeAtlas.",
    "",
    "Current capabilities:",
    `- graph: ${capabilities.graphState}`,
    `- lexical: ${capabilities.lexicalState}`,
    "",
    "Use `repository_status` for freshness and capability checks.",
    "Use `search_code` and `get_symbol` for precise navigation.",
    ...graphGuidance,
    ...(capabilities.needsIndex
      ? ["No index is available; run `code-atlas index`."]
      : []),
    ...(capabilities.needsSync
      ? ["A capability is stale; run `code-atlas sync` before relying on graph or lexical results."]
      : []),
    ...(!capabilities.graphReady
      ? ["Graph tools are unavailable until graph is ready; use direct source inspection when needed."]
      : []),
    "",
    "Safety:",
    "- `mayBeIncomplete=true` means CodeAtlas evidence is incomplete.",
    "- `risk=unknown` means CodeAtlas cannot safely classify the change because graph evidence is incomplete.",
    "- When `mayBeIncomplete=true`, negative results such as no callers or no impact are not authoritative.",
    "- For risky changes with incomplete coverage, combine CodeAtlas evidence with direct source verification.",
    "- Do not treat `risk=low` as authoritative when coverage is incomplete.",
    "- If CodeAtlas is unavailable, fall back to direct source inspection.",
  ].join("\n");
}

async function capabilitySummary(repoPath: string): Promise<{
  graphState: string;
  lexicalState: string;
  graphReady: boolean;
  needsIndex: boolean;
  needsSync: boolean;
}> {
  try {
    await fs.access(path.join(repoPath, ".codeatlas", "atlas.db"));
    const status = await getRepositoryStatus(repoPath);
    const needsIndex = status.graph.status === "not-indexed";
    const graphState = needsIndex ? "not-indexed" : status.capabilities.graph.state;
    const lexicalState = needsIndex && status.capabilities.lexical.indexedFiles === 0
      ? "not-indexed"
      : status.capabilities.lexical.state;
    return {
      graphState,
      lexicalState,
      graphReady: status.capabilities.graph.state === "ready",
      needsIndex,
      needsSync: graphState === "stale" || lexicalState === "stale",
    };
  } catch {
    return {
      graphState: "not-indexed",
      lexicalState: "not-indexed",
      graphReady: false,
      needsIndex: true,
      needsSync: false,
    };
  }
}
