import { execFile } from "node:child_process";
import { cp, mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

import type { SnapshotProvenance } from "../types.js";
import type { SupportedLanguage } from "../../../src/core/graph/parsers/types.js";

const exec = promisify(execFile);

type ImportSnapshotInput = {
  sourceRoot: string;
  sourceRepository: string;
  sourceCommitSha: string;
  license: string;
  language: SupportedLanguage;
  includedPaths: readonly string[];
  licenseNoticeRequired: boolean;
  licenseNoticeSourcePath?: string;
  outputRoot: string;
};

function canonicalPath(value: string): boolean {
  return Boolean(value)
    && !path.posix.isAbsolute(value)
    && !value.includes("\\")
    && value === path.posix.normalize(value)
    && value.split("/").every((part) => part.length > 0 && part !== "." && part !== "..");
}

function childPath(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

async function regularSourceFile(sourceRoot: string, relativePath: string): Promise<string> {
  if (!canonicalPath(relativePath)) throw new Error(`Snapshot import rejected unsafe path: ${relativePath}`);
  const candidate = path.resolve(sourceRoot, relativePath);
  const resolvedRoot = await realpath(sourceRoot);
  const resolved = await realpath(candidate);
  if (!childPath(resolvedRoot, resolved) || !(await stat(resolved)).isFile()) {
    throw new Error(`Snapshot import rejected non-file path: ${relativePath}`);
  }
  return resolved;
}

export async function importSnapshot(input: ImportSnapshotInput): Promise<SnapshotProvenance> {
  if (!/^[0-9a-f]{40}$/i.test(input.sourceCommitSha)) throw new Error("Snapshot import requires a full source commit SHA");
  if (!input.sourceRepository.trim() || !input.license.trim()) throw new Error("Snapshot import requires repository and license metadata");
  const sourceRoot = await realpath(input.sourceRoot);
  const head = String((await exec("git", ["-C", sourceRoot, "rev-parse", "HEAD"])).stdout).trim();
  if (head.toLowerCase() !== input.sourceCommitSha.toLowerCase()) throw new Error(`Snapshot import commit mismatch: expected ${input.sourceCommitSha}, found ${head}`);

  const includedPaths = [...input.includedPaths];
  if (!includedPaths.length || new Set(includedPaths).size !== includedPaths.length) throw new Error("Snapshot import requires unique included paths");
  const files = await Promise.all(includedPaths.map(async (relativePath) => ({ relativePath, source: await regularSourceFile(sourceRoot, relativePath) })));
  let noticePath: string | undefined;
  let noticeSource: string | undefined;
  if (input.licenseNoticeRequired) {
    if (!input.licenseNoticeSourcePath) throw new Error("Snapshot import requires a license notice source path");
    noticePath = path.posix.basename(input.licenseNoticeSourcePath);
    noticeSource = await regularSourceFile(sourceRoot, input.licenseNoticeSourcePath);
  }

  await mkdir(input.outputRoot, { recursive: true });
  for (const file of files) {
    const destination = path.resolve(input.outputRoot, file.relativePath);
    if (!childPath(path.resolve(input.outputRoot), destination)) throw new Error(`Snapshot import rejected output path: ${file.relativePath}`);
    await mkdir(path.dirname(destination), { recursive: true });
    await cp(file.source, destination, { force: false, errorOnExist: true });
  }
  if (noticeSource && noticePath) await cp(noticeSource, path.join(input.outputRoot, noticePath), { force: false, errorOnExist: true });

  return {
    snapshotId: path.basename(path.resolve(input.outputRoot)),
    sourceRepository: input.sourceRepository,
    sourceCommitSha: input.sourceCommitSha,
    license: input.license,
    licenseNoticeRequired: input.licenseNoticeRequired,
    ...(noticePath ? { licenseNoticePath: noticePath } : {}),
    includedPaths,
    language: input.language,
    inclusionReason: "Reviewed local snapshot imported by the Phase15D maintenance workflow",
  };
}
