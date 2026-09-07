import fs from "node:fs/promises";
import path from "node:path";

import type { GraphDeltaContext } from "../change/graph-delta.service.js";
import type { GitSourceState } from "../../infrastructure/git/git-change-reader.js";

export type CodeAtlasConfigSourceKind = "git_revision" | "git_index" | "working_tree" | "absent";

export type CodeAtlasConfigSource = {
  configured: boolean;
  source: {
    path: string;
    kind: CodeAtlasConfigSourceKind;
    revision?: string;
  };
  content?: Buffer;
};

export type CodeAtlasConfigSnapshotPair = {
  path: string;
  baseline: CodeAtlasConfigSource;
  target: CodeAtlasConfigSource;
  fileChanged: boolean;
  changeKind: "unchanged" | "added" | "removed" | "modified";
};

function sourceKind(state: GitSourceState): CodeAtlasConfigSourceKind {
  if (state.kind === "revision") return "git_revision";
  if (state.kind === "index") return "git_index";
  if (state.kind === "working") return "working_tree";
  return "absent";
}

export function validateRepositoryConfigPath(repoPath: string, explicitPath?: string): string {
  const relative = (explicitPath ?? "codeatlas.config.json").replaceAll("\\", "/");
  if (!relative || path.posix.isAbsolute(relative) || relative.split("/").includes("..")) {
    throw new Error("CodeAtlas config path must be a repository-relative path.");
  }
  const absolute = path.resolve(repoPath, relative);
  const relativeCheck = path.relative(path.resolve(repoPath), absolute);
  if (relativeCheck.startsWith("..") || path.isAbsolute(relativeCheck)) throw new Error("CodeAtlas config path must remain inside the repository.");
  return relative;
}

async function validateWorkingConfigBoundary(repoPath: string, configPath: string): Promise<void> {
  const root = await fs.realpath(repoPath);
  const absolute = path.join(repoPath, configPath);
  let resolved: string;
  try {
    resolved = await fs.realpath(absolute);
  } catch {
    let parent = path.dirname(absolute);
    while (true) {
      try {
        resolved = await fs.realpath(parent);
        break;
      } catch {
        const next = path.dirname(parent);
        if (next === parent) throw new Error("CodeAtlas config path could not be resolved safely.");
        parent = next;
      }
    }
  }
  const relative = path.relative(root, resolved);
  if (relative.startsWith("..") || path.isAbsolute(relative)) throw new Error("CodeAtlas config path must remain inside the repository.");
}

function source(state: GitSourceState, content: Buffer | undefined, configPath: string): CodeAtlasConfigSource {
  return content
    ? { configured: true, source: { path: configPath, kind: sourceKind(state), ...(state.kind === "revision" ? { revision: state.revision } : {}) }, content }
    : { configured: false, source: { path: configPath, kind: "absent" } };
}

export async function loadCodeAtlasConfigSnapshots(
  repoPath: string,
  context: GraphDeltaContext,
  explicitPath?: string,
): Promise<CodeAtlasConfigSnapshotPair> {
  const configPath = validateRepositoryConfigPath(repoPath, explicitPath);
  if (context.targetState.kind === "working") await validateWorkingConfigBoundary(repoPath, configPath);
  const baseline = source(context.baselineState, context.beforeSnapshot.files.get(configPath), configPath);
  const target = source(context.targetState, context.afterSnapshot.files.get(configPath), configPath);
  const fileChanged = context.changes.files.some((file) => file.path === configPath || file.oldPath === configPath);
  return {
    path: configPath,
    baseline,
    target,
    fileChanged,
    changeKind: !fileChanged
      ? "unchanged"
      : !baseline.configured && target.configured
        ? "added"
        : baseline.configured && !target.configured
          ? "removed"
          : "modified",
  };
}
