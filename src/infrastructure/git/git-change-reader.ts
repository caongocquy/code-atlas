import { execFile as execFileCallback } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type {
  ChangedFile,
  ChangedHunk,
  InspectChangeInput,
  InspectChangeSource,
} from "../../core/change/change.types.js";

const execFile = promisify(execFileCallback);
const MAX_BUFFER = 16 * 1024 * 1024;

export type GitChangeSet = {
  source: InspectChangeSource;
  files: ChangedFile[];
};

export type GitSourceState =
  | { kind: "empty" }
  | { kind: "working" }
  | { kind: "index" }
  | { kind: "revision"; revision: string };

export type GitSourceSnapshot = {
  files: Map<string, Buffer>;
};

export type GitChangeSources = {
  changes: GitChangeSet;
  baseline: GitSourceSnapshot;
  target: GitSourceSnapshot;
  baselineState: GitSourceState;
  targetState: GitSourceState;
};

class GitChangeReaderError extends Error {}

async function gitOutput(repoPath: string, args: string[]): Promise<string> {
  try {
    const result = await execFile("git", args, {
      cwd: repoPath,
      encoding: "utf8",
      maxBuffer: MAX_BUFFER,
    });
    return String(result.stdout);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitChangeReaderError(`Git change inspection failed: ${message}`);
  }
}

async function gitBytes(repoPath: string, args: string[]): Promise<Buffer> {
  try {
    const result = await execFile("git", args, {
      cwd: repoPath,
      encoding: "buffer",
      maxBuffer: MAX_BUFFER,
    });
    return Buffer.isBuffer(result.stdout) ? result.stdout : Buffer.from(String(result.stdout));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GitChangeReaderError(`Git source retrieval failed: ${message}`);
  }
}

async function resolveRevision(repoPath: string, revision: string): Promise<string> {
  if (!revision.trim()) throw new GitChangeReaderError("Git revision must not be empty.");
  const resolved = (await gitOutput(repoPath, [
    "rev-parse",
    "--verify",
    "--end-of-options",
    revision,
  ])).trim();
  const type = (await gitOutput(repoPath, ["cat-file", "-t", resolved])).trim();
  if (type !== "commit") throw new GitChangeReaderError(`Git revision is not a commit: ${revision}`);
  return resolved;
}

function parseNameStatus(output: string): Array<{ status: string; path: string; oldPath?: string }> {
  const tokens = output.split("\0");
  const records: Array<{ status: string; path: string; oldPath?: string }> = [];

  for (let index = 0; index < tokens.length - 1; index += 1) {
    const status = tokens[index];
    if (!status) continue;
    const pathValue = tokens[index + 1];
    if (pathValue === undefined) break;
    if (status.startsWith("R") || status.startsWith("C")) {
      const newPath = tokens[index + 2];
      if (newPath === undefined) break;
      records.push({ status, path: newPath, oldPath: pathValue });
      index += 2;
    } else {
      records.push({ status, path: pathValue });
      index += 1;
    }
  }

  return records;
}

function parseHunkHeader(line: string): ChangedHunk | undefined {
  const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
  if (!match) return undefined;
  return {
    oldStart: Number(match[1]),
    oldLines: Number(match[2] ?? 1),
    newStart: Number(match[3]),
    newLines: Number(match[4] ?? 1),
  };
}

function patchDetails(patch: string): { hunks: ChangedHunk[][]; binaries: Set<number> } {
  const hunks: ChangedHunk[][] = [];
  const binaries = new Set<number>();
  let fileIndex = -1;

  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git ")) {
      fileIndex += 1;
      hunks[fileIndex] = [];
      continue;
    }
    if (fileIndex < 0) continue;
    if (line.startsWith("Binary files ") || line === "GIT binary patch") {
      binaries.add(fileIndex);
      continue;
    }
    const hunk = parseHunkHeader(line);
    if (hunk) hunks[fileIndex]!.push(hunk);
  }

  return { hunks, binaries };
}

function lineCount(content: string): number {
  if (!content) return 0;
  const lines = content.split(/\r?\n/);
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

function isBinary(content: Buffer): boolean {
  return content.includes(0);
}

async function untrackedFile(repoPath: string, relativePath: string): Promise<ChangedFile> {
  const absolutePath = path.join(repoPath, relativePath);
  const content = await fs.readFile(absolutePath);
  if (isBinary(content)) {
    return { path: relativePath, status: "binary", hunks: [] };
  }
  const text = content.toString("utf8");
  const additions = lineCount(text);
  return {
    path: relativePath,
    status: "added",
    additions,
    deletions: 0,
    hunks: additions > 0 ? [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: additions }] : [],
  };
}

async function untrackedPaths(repoPath: string): Promise<string[]> {
  const output = await gitOutput(repoPath, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const paths: string[] = [];
  const records = output.split("\0");
  for (const record of records) {
    if (!record.startsWith("?? ")) continue;
    const relativePath = record.slice(3).split(path.sep).join("/");
    if (relativePath) paths.push(relativePath);
  }
  return paths.sort();
}

function diffArgs(mode: InspectChangeInput["mode"], revisions: string[]): string[] {
  const common = ["--no-ext-diff", "--no-color", "--unified=0", "--find-renames", "--no-prefix"];
  if (mode === "staged") return ["diff", ...common, "--cached", ...(revisions.length > 0 ? [revisions[0]!] : []), "--"];
  return ["diff", ...common, ...revisions, "--"];
}

async function trackedChanges(
  repoPath: string,
  mode: InspectChangeInput["mode"],
  revisions: string[],
): Promise<ChangedFile[]> {
  const nameStatus = await gitOutput(repoPath, [
    "diff",
    "--no-ext-diff",
    "--no-color",
    "--find-renames",
    "--name-status",
    "-z",
    ...mode === "staged" ? ["--cached"] : [],
    ...revisions,
    "--",
  ]);
  const records = parseNameStatus(nameStatus);
  const patch = await gitOutput(repoPath, diffArgs(mode, revisions));
  const details = patchDetails(patch);

  return records.map((record, index) => {
    const hunkList = details.hunks[index] ?? [];
    const binary = details.binaries.has(index);
    const status = binary
      ? "binary"
      : record.status.startsWith("A")
        ? "added"
        : record.status.startsWith("D")
          ? "deleted"
          : record.status.startsWith("R")
            ? "renamed"
            : "modified";
    return {
      ...(record.oldPath ? { oldPath: record.oldPath } : {}),
      path: record.path,
      status,
      additions: binary ? undefined : hunkList.reduce((sum, hunk) => sum + hunk.newLines, 0),
      deletions: binary ? undefined : hunkList.reduce((sum, hunk) => sum + hunk.oldLines, 0),
      hunks: hunkList,
    };
  });
}

async function headRevision(repoPath: string): Promise<string | undefined> {
  try {
    return await resolveRevision(repoPath, "HEAD");
  } catch {
    return undefined;
  }
}

export async function readGitChanges(
  repoPath: string,
  input: InspectChangeInput = {},
): Promise<GitChangeSet> {
  const mode = input.mode ?? "working";
  if (mode === "working") {
    const head = await headRevision(repoPath);
    const tracked = head ? await trackedChanges(repoPath, mode, [head]) : await trackedChanges(repoPath, "staged", []);
    const untracked = await Promise.all((await untrackedPaths(repoPath)).map((file) => untrackedFile(repoPath, file)));
    return { source: { mode: "working" }, files: [...tracked, ...untracked].sort((left, right) => left.path.localeCompare(right.path)) };
  }

  if (mode === "staged") {
    const head = await headRevision(repoPath);
    const files = await trackedChanges(repoPath, mode, head ? [head] : []);
    return { source: { mode: "staged" }, files };
  }

  if (mode === "commit") {
    const commitInput = input as Extract<InspectChangeInput, { mode: "commit" }>;
    const commit = await resolveRevision(repoPath, commitInput.commit);
    const parents = (await gitOutput(repoPath, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/).slice(1);
    const files = parents.length > 0
      ? await trackedChanges(repoPath, "commit", [parents[0]!, commit])
      : await rootCommitChanges(repoPath, commit);
    return { source: { mode: "commit", commit: commitInput.commit }, files };
  }

  const rangeInput = input as Extract<InspectChangeInput, { mode: "range" }>;
  const base = await resolveRevision(repoPath, rangeInput.base);
  const head = await resolveRevision(repoPath, rangeInput.head);
  return { source: { mode: "range", base: rangeInput.base, head: rangeInput.head }, files: await trackedChanges(repoPath, "range", [base, head]) };
}

async function sourceRevision(repoPath: string, revision: string): Promise<GitSourceState> {
  return { kind: "revision", revision: await resolveRevision(repoPath, revision) };
}

async function sourcePaths(repoPath: string, state: GitSourceState): Promise<string[]> {
  if (state.kind === "empty") return [];
  if (state.kind === "working") {
    const tracked = (await gitOutput(repoPath, ["ls-files", "-z", "--cached"]))
      .split("\0")
      .filter(Boolean);
    return [...new Set([...tracked, ...(await untrackedPaths(repoPath))])].sort();
  }
  const args = state.kind === "index"
    ? ["ls-files", "-z", "--cached"]
    : ["ls-tree", "-r", "--name-only", "-z", state.revision];
  return (await gitOutput(repoPath, args)).split("\0").filter(Boolean).sort();
}

export async function readGitSnapshot(
  repoPath: string,
  state: GitSourceState,
): Promise<GitSourceSnapshot> {
  const files = new Map<string, Buffer>();
  if (state.kind === "empty") return { files };
  for (const relativePath of await sourcePaths(repoPath, state)) {
    try {
      const content = state.kind === "working"
        ? await fs.readFile(path.join(repoPath, relativePath))
        : await gitBytes(repoPath, state.kind === "index"
          ? ["show", `:${relativePath}`]
          : ["show", `${state.revision}:${relativePath}`]);
      files.set(relativePath, content);
    } catch {
      // A working-tree file can disappear between listing and reading.
    }
  }
  return { files };
}

export async function readGitChangeSources(
  repoPath: string,
  input: InspectChangeInput = {},
): Promise<GitChangeSources> {
  const changes = await readGitChanges(repoPath, input);
  const mode = input.mode ?? "working";
  const head = await headRevision(repoPath);

  if (mode === "working") {
    const baselineState: GitSourceState = head ? await sourceRevision(repoPath, head) : { kind: "empty" };
    return {
      changes,
      baseline: await readGitSnapshot(repoPath, baselineState),
      target: await readGitSnapshot(repoPath, { kind: "working" }),
      baselineState,
      targetState: { kind: "working" },
    };
  }

  if (mode === "staged") {
    const baselineState: GitSourceState = head ? await sourceRevision(repoPath, head) : { kind: "empty" };
    return {
      changes,
      baseline: await readGitSnapshot(repoPath, baselineState),
      target: await readGitSnapshot(repoPath, { kind: "index" }),
      baselineState,
      targetState: { kind: "index" },
    };
  }

  if (mode === "commit") {
    const commitInput = input as Extract<InspectChangeInput, { mode: "commit" }>;
    const commit = await resolveRevision(repoPath, commitInput.commit);
    const parents = (await gitOutput(repoPath, ["rev-list", "--parents", "-n", "1", commit])).trim().split(/\s+/).slice(1);
    const baselineState: GitSourceState = parents[0] ? { kind: "revision", revision: parents[0] } : { kind: "empty" };
    const targetState: GitSourceState = { kind: "revision", revision: commit };
    return {
      changes,
      baseline: await readGitSnapshot(repoPath, baselineState),
      target: await readGitSnapshot(repoPath, targetState),
      baselineState,
      targetState,
    };
  }

  const rangeInput = input as Extract<InspectChangeInput, { mode: "range" }>;
  const base = await resolveRevision(repoPath, rangeInput.base);
  const target = await resolveRevision(repoPath, rangeInput.head);
  const baselineState: GitSourceState = { kind: "revision", revision: base };
  const targetState: GitSourceState = { kind: "revision", revision: target };
  return {
    changes,
    baseline: await readGitSnapshot(repoPath, baselineState),
    target: await readGitSnapshot(repoPath, targetState),
    baselineState,
    targetState,
  };
}

async function rootCommitChanges(repoPath: string, commit: string): Promise<ChangedFile[]> {
  // The empty tree object is stable across Git repositories.
  return trackedChanges(repoPath, "commit", ["4b825dc642cb6eb9a060e54bf8d69288fbee4904", commit]);
}

export { GitChangeReaderError };
