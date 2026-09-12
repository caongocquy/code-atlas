import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

import {
  canonicalRepositoryPath,
  getRepositoryIdentity,
} from "../repository/repository-identity.js";
import type { ContextSession, ContextSubject } from "./context.types.js";

export type WorkspaceIdentity = {
  repositoryIdentity: string;
  workspaceIdentity: string;
  canonicalPath: string;
  source: "git" | "filesystem";
  gitCommonDirectory?: string;
};

function stableJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.entries(value as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => `${JSON.stringify(key)}:${stableJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function assertText(value: unknown, name: string): asserts value is string {
  if (typeof value !== "string" || value.length === 0) throw new TypeError(`${name} is required`);
}

function assertSafePath(value: unknown): asserts value is string {
  assertText(value, "path");
  if (value.startsWith("/") || value.includes("\\") || value.split("/").some((segment) => !segment || segment === "." || segment === "..")) {
    throw new TypeError("path must be repository-relative");
  }
}

export function validateContextSubject(value: unknown): ContextSubject {
  if (!value || typeof value !== "object") throw new TypeError("subject is required");
  const subject = value as Record<string, unknown>;
  assertText(subject.kind, "subject.kind");
  assertSafePath(subject.path);
  if (subject.kind === "file") return { kind: "file", path: subject.path };
  if (subject.kind === "symbol") {
    assertText(subject.symbolId, "symbolId");
    assertText(subject.selectorVersion, "selectorVersion");
    return { kind: "symbol", path: subject.path, symbolId: subject.symbolId, selectorVersion: subject.selectorVersion };
  }
  throw new TypeError("unsupported context subject");
}

export function validateContextSession(value: unknown): ContextSession {
  if (!value || typeof value !== "object") throw new TypeError("session is required");
  const session = value as Record<string, unknown>;
  for (const key of ["sessionId", "repositoryIdentity", "workspaceIdentity", "createdAt", "lastSeenAt", "contextGeneration"] as const) assertText(session[key], key);
  if (typeof session.schemaVersion !== "number" || !Number.isInteger(session.schemaVersion) || session.schemaVersion < 1) throw new TypeError("schemaVersion is required");
  return value as ContextSession;
}

export function canonicalSubjectIdentity(repositoryIdentity: string, workspaceIdentity: string, subject: ContextSubject): string {
  return stableJson({ repositoryIdentity, workspaceIdentity, ...validateContextSubject(subject) });
}

export function canonicalProjectionIdentity(name: string, descriptor: Record<string, unknown>): string {
  assertText(name, "projection name");
  return stableJson({ name, ...descriptor });
}

function gitValue(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
}

export function getWorkspaceIdentity(inputPath: string): WorkspaceIdentity {
  const canonicalPath = canonicalRepositoryPath(path.resolve(inputPath));
  const gitMarker = path.join(canonicalPath, ".git");
  let isGit = false;
  try {
    isGit = gitValue(canonicalPath, ["rev-parse", "--is-inside-work-tree"]) === "true";
  } catch (error) {
    if (fs.existsSync(gitMarker)) throw new Error(`Unable to validate Git workspace identity for ${canonicalPath}`, { cause: error });
  }

  if (!isGit) {
    return {
      repositoryIdentity: getRepositoryIdentity(canonicalPath).identityKey,
      workspaceIdentity: `filesystem-v1:${canonicalPath}`,
      canonicalPath,
      source: "filesystem",
    };
  }

  const root = canonicalRepositoryPath(gitValue(canonicalPath, ["rev-parse", "--show-toplevel"]));
  const gitCommonDirectory = canonicalRepositoryPath(gitValue(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]));
  return {
    repositoryIdentity: `git-common-v1:${gitCommonDirectory}`,
    workspaceIdentity: `git-worktree-v1:${canonicalPath}`,
    canonicalPath,
    source: "git",
    gitCommonDirectory,
  };
}
