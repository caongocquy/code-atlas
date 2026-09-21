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
  const mcpRows = capabilities.graphReady
    ? [
      "| Check index freshness/capabilities | `repository_status` |",
      "| Find code or symbols | `search_code`, `get_symbol` |",
      "| Find callers/callees | `find_callers`, `find_callees` |",
      "| Inspect module dependencies | `find_imports`, `find_imported_by` |",
      "| Assess blast radius | `impact` |",
      "| Trace execution paths | `trace` |",
      "| Explain incomplete evidence | `explain_incomplete` |",
      "| Compare structural changes | `graph_delta` |",
      "| Check architecture drift | `architecture_drift` |",
      "| Evaluate change policy | `change_gate` |",
    ]
    : [
      "| Check index freshness/capabilities | `repository_status` |",
      "| Find code or symbols | `search_code`, `get_symbol` |",
      "| Explain incomplete evidence | `explain_incomplete` |",
      "| Compare structural changes | `graph_delta` |",
      "| Check architecture drift | `architecture_drift` |",
      "| Evaluate change policy | `change_gate` |",
    ];
  const graphWorkflow = capabilities.graphReady
    ? [
      "Use graph tools for shared, unfamiliar, structural, or cross-module changes when useful. They are not required for trivial or isolated edits.",
    ]
    : [];
  return [
    "## CodeAtlas — Code Intelligence",
    "",
    capabilities.needsIndex
      ? `This repository is not indexed by CodeAtlas yet; repository name: **${capabilities.repositoryName}**.`
      : `This repository is indexed by CodeAtlas as **${capabilities.repositoryName}**${capabilities.statistics ? ` (${capabilities.statistics})` : ""}.`,
    "",
    "Current capabilities:",
    `- graph: ${capabilities.graphState}`,
    `- lexical: ${capabilities.lexicalState}`,
    "",
    "### MCP tools",
    "",
    "| Task | Use |",
    "| --- | --- |",
    ...mcpRows,
    "",
    ...graphWorkflow,
    ...(graphWorkflow.length > 0 ? [""] : []),
    "### CLI",
    "",
    "| Task | Command |",
    "| --- | --- |",
    "| Check repository/index status | `code-atlas status` |",
    "| Refresh changed files | `code-atlas sync` |",
    "| Rebuild the full index | `code-atlas index` |",
    ...(capabilities.needsIndex
      ? ["", "No index is available; run `code-atlas index`."]
      : []),
    ...(capabilities.needsSync
      ? ["", "A capability is stale; run `code-atlas sync` before relying on graph or lexical results."]
      : []),
    ...(!capabilities.graphReady
      ? ["", "Graph tools are unavailable until graph is ready; use direct source inspection when needed."]
      : []),
    "",
    "### Safety",
    "",
    "- `mayBeIncomplete=true` means CodeAtlas evidence is incomplete.",
    "- `risk=unknown` means CodeAtlas cannot safely classify the change because graph evidence is incomplete.",
    "- When `mayBeIncomplete=true`, negative results such as no callers or no impact are not authoritative.",
    "- For risky changes with incomplete coverage, combine CodeAtlas evidence with direct source verification.",
    "- Do not treat `risk=low` as authoritative when coverage is incomplete.",
    "- If CodeAtlas is unavailable, fall back to direct source inspection.",
    "",
    "### Reporting",
    "",
    "- When CodeAtlas materially contributes to a task, briefly report the relevant findings in the final task report.",
    "- If relevant CodeAtlas analysis is unavailable, briefly state why and which fallback was used.",
    "- When `mayBeIncomplete=true` materially affects confidence, mention the incomplete graph evidence and any direct source verification performed.",
    "- Do not add CodeAtlas used boilerplate to trivial tasks where it was not relevant; keep final reports concise.",
  ].join("\n");
}

async function capabilitySummary(repoPath: string): Promise<{
  repositoryName: string;
  statistics?: string;
  graphState: string;
  lexicalState: string;
  graphReady: boolean;
  needsIndex: boolean;
  needsSync: boolean;
}> {
  try {
    await fs.access(path.join(repoPath, ".codeatlas", "atlas.db"));
    const status = await getRepositoryStatus(repoPath);
    const needsIndex = status.graph.status === "not_indexed";
    const graphState = needsIndex ? "not-indexed" : guidanceState(status.capabilities.graph.state);
    const lexicalState = needsIndex && status.capabilities.lexical.indexedFiles === 0
      ? "not-indexed"
      : guidanceState(status.capabilities.lexical.state);
    const statistics = graphState === "ready" || graphState === "stale"
      ? [
        status.graph.indexedFiles > 0 ? `${status.graph.indexedFiles} files` : undefined,
        status.graph.nodes > 0 ? `${status.graph.nodes} symbols` : undefined,
        status.graph.edges > 0 ? `${status.graph.edges} relationships` : undefined,
      ].filter((value): value is string => value !== undefined).join(", ") || undefined
      : undefined;
    return {
      repositoryName: path.basename(status.repository.path),
      statistics,
      graphState,
      lexicalState,
      graphReady: status.capabilities.graph.state === "ready",
      needsIndex,
      needsSync: graphState === "stale" || lexicalState === "stale",
    };
  } catch {
    return {
      repositoryName: path.basename(path.resolve(repoPath)),
      statistics: undefined,
      graphState: "not-indexed",
      lexicalState: "not-indexed",
      graphReady: false,
      needsIndex: true,
      needsSync: false,
    };
  }
}

function guidanceState(state: string): string {
  return state === "not_indexed" ? "not-indexed" : state;
}
