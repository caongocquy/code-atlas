import { open } from "node:fs/promises";
import path from "node:path";
import { getRepositoryIdentity } from "../repository/repository-identity.js";
import { checkWorkspaceDeadline, reserveWorkspaceRead } from "../../storage/atlas/workspace-metadata.reader.js";
import { WORKSPACE_BOUNDS, WorkspaceMapError, type WorkspaceMapInput, type WorkspaceReadBudget } from "./workspace.types.js";

function object(raw: unknown, keys: string[]): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw) || Object.keys(raw).some(key => !keys.includes(key))) throw new WorkspaceMapError("invalid_arguments", "Invalid workspace object or unsupported field.");
  return raw as Record<string, unknown>;
}
function text(raw: unknown): string {
  if (typeof raw !== "string" || !raw.trim() || raw.length > WORKSPACE_BOUNDS.maxPathLength || raw.includes("\0")) throw new WorkspaceMapError("invalid_arguments", "Workspace paths must be non-empty bounded strings.");
  return raw;
}
function paths(raw: unknown): string[] {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > WORKSPACE_BOUNDS.maxRepositories) throw new WorkspaceMapError("invalid_arguments", "Select between 1 and 16 repositories.");
  return raw.map(text);
}
export async function resolveWorkspaceMembership(input: WorkspaceMapInput, cwd: string, budget: WorkspaceReadBudget) {
  if ((input.repositories !== undefined) === (input.workspacePath !== undefined)) throw new WorkspaceMapError("invalid_arguments", "Choose exactly one of repositories or workspacePath.");
  let repositories: string[];
  let name: string | undefined;
  let base = cwd;
  if (input.workspacePath !== undefined) {
    const configPath = path.resolve(cwd, text(input.workspacePath));
    base = path.dirname(configPath);
    let raw: unknown;
    try {
      const handle = await open(configPath, "r");
      try {
        const size = (await handle.stat()).size;
        if (size > WORKSPACE_BOUNDS.maxConfigBytes || size > budget.remainingBytes) throw new Error("Workspace config is too large.");
        const buffer = Buffer.alloc(Math.min(WORKSPACE_BOUNDS.maxConfigBytes, budget.remainingBytes) + 1);
        let length = 0;
        while (length < buffer.length) {
          checkWorkspaceDeadline(budget);
          const read = await handle.read(buffer, length, buffer.length - length, null);
          if (read.bytesRead === 0) break;
          length += read.bytesRead;
        }
        if (length > WORKSPACE_BOUNDS.maxConfigBytes) throw new Error("Workspace config is too large.");
        reserveWorkspaceRead(budget, 0, length);
        raw = JSON.parse(buffer.subarray(0, length).toString("utf8"));
      } finally { await handle.close(); }
    } catch (error) {
      throw new WorkspaceMapError("invalid_arguments", `Unable to read workspace config: ${error instanceof Error ? error.message : String(error)}`);
    }
    const config = object(raw, ["version", "name", "repositories"]);
    if (config.version !== 1) throw new WorkspaceMapError("invalid_arguments", "Workspace config version must be 1.");
    if (config.name !== undefined) { name = text(config.name); if (name.length > 256) throw new WorkspaceMapError("invalid_arguments", "Workspace name is too long."); }
    if (!Array.isArray(config.repositories)) throw new WorkspaceMapError("invalid_arguments", "Workspace repositories must be an array.");
    repositories = paths(config.repositories.map(member => text(object(member, ["path"]).path)));
  } else repositories = paths(input.repositories);
  const identities = repositories.map(repo => getRepositoryIdentity(path.resolve(base, repo)));
  if (new Set(identities.map(identity => identity.rootPath)).size !== identities.length || new Set(identities.map(identity => identity.id)).size !== identities.length) throw new WorkspaceMapError("invalid_arguments", "Duplicate canonical repository path or namespace.");
  identities.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  return { identities, workspace: { version: 1 as const, ...(name !== undefined ? { name } : {}) } };
}
