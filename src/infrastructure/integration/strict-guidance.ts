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
  const filePath = path.join(repoPath, "AGENTS.md");
  const file = await readTextFile(filePath);
  const body = await guidanceBody(repoPath, strict);
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

async function guidanceBody(repoPath: string, strict: boolean): Promise<string> {
  const capabilities = await capabilitySummary(repoPath);
  return [
    `## CodeAtlas guidance${strict ? " (strict, opt-in)" : ""}`,
    "",
    ...(strict
      ? [
        "Use CodeAtlas MCP before broad repository exploration when it is available:",
        "- query `repository_status` first",
        "- use `search_code` and `get_symbol` to locate relevant code",
        "- use `impact` or `trace` before making structural assumptions",
      ]
      : [
        "CodeAtlas provides local code intelligence through MCP when available:",
        "- use `repository_status` to check indexed capabilities",
        "- use `search_code` and `get_symbol` for precise navigation",
      ]),
    `- indexed capabilities: ${capabilities}`,
    "- if results report `mayBeIncomplete`, verify the relevant source files directly",
    "- fall back to direct source inspection whenever CodeAtlas is unavailable or stale",
  ].join("\n");
}

async function capabilitySummary(repoPath: string): Promise<string> {
  try {
    await fs.access(path.join(repoPath, ".codeatlas", "atlas.db"));
    const status = await getRepositoryStatus(repoPath);
    const values = Object.entries(status.capabilities)
      .filter(([, capability]) => capability.state !== "not_configured")
      .map(([name, capability]) => `${name}=${capability.state}`);
    return values.length > 0 ? values.join(", ") : "none reported; confirm with repository_status";
  } catch {
    return "not initialized; confirm with repository_status";
  }
}
