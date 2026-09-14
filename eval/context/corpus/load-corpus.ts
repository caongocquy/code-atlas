import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { realpathSync, statSync } from "node:fs";
import path from "node:path";

import { LANGUAGE_CONFIGS } from "../../../src/core/graph/parsers/languages.js";
import { BASELINE_VERSION, CORPUS_VERSION, POLICY_VERSION, type CorpusManifest, type GoldenBaseline, type QualityPolicy } from "../types.js";
import { parseCorpusManifest, parseGoldenBaseline, parseQualityPolicy } from "../schemas.js";

export type CorpusPaths = {
  manifestPath: string;
  baselinePath: string;
  policyPath: string;
};

export type LoadedCorpus = CorpusPaths & {
  manifest: CorpusManifest;
  baseline: GoldenBaseline;
  policy: QualityPolicy;
  manifestSha256: string;
  baselineSha256: string;
  policySha256: string;
};

export async function sha256File(filePath: string): Promise<string> {
  return createHash("sha256").update(await readFile(filePath)).digest("hex");
}

function parseJson(bytes: Buffer, label: string): unknown {
  try {
    return JSON.parse(bytes.toString("utf8")) as unknown;
  } catch (error) {
    throw new Error(`Invalid ${label} JSON: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function ensureUnique(values: readonly string[], label: string): void {
  if (new Set(values).size !== values.length) throw new Error(`Corpus integrity failure: duplicate ${label}`);
}

function isSnapshotIdentifier(value: string): boolean {
  return /^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value);
}

function isChildPath(root: string, value: string): boolean {
  const relative = path.relative(root, value);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function snapshotRoot(manifestPath: string, snapshotId: string): { snapshotsRoot: string; root: string } {
  if (!isSnapshotIdentifier(snapshotId)) throw new Error(`Corpus integrity failure: invalid snapshot ID ${snapshotId}`);
  const snapshotsRoot = path.resolve(path.dirname(manifestPath), "snapshots");
  const root = path.resolve(snapshotsRoot, snapshotId);
  if (!isChildPath(snapshotsRoot, root)) throw new Error(`Corpus integrity failure: snapshot ${snapshotId} escapes the corpus snapshots root`);
  return { snapshotsRoot, root };
}

function validateLicenseNotice(manifestPath: string, snapshot: CorpusManifest["snapshots"][number]): void {
  const { snapshotsRoot, root } = snapshotRoot(manifestPath, snapshot.snapshotId);
  if (!snapshot.licenseNoticeRequired && !snapshot.licenseNoticePath) return;
  if (!snapshot.licenseNoticePath) throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} requires a license notice path`);

  const notice = path.resolve(root, snapshot.licenseNoticePath);
  if (!isChildPath(root, notice)) {
    throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} license notice escapes its snapshot root`);
  }

  let resolvedSnapshotsRoot: string;
  let resolvedRoot: string;
  let resolvedNotice: string;
  try {
    resolvedSnapshotsRoot = realpathSync(snapshotsRoot);
    resolvedRoot = realpathSync(root);
    resolvedNotice = realpathSync(notice);
  } catch (error) {
    throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} license notice is missing`, { cause: error });
  }
  if (!isChildPath(resolvedSnapshotsRoot, resolvedRoot) || !isChildPath(resolvedRoot, resolvedNotice)) {
    throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} license notice escapes its snapshot root`);
  }
  const details = statSync(resolvedNotice);
  if (!details.isFile()) throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} license notice is not a regular file`);
}

export function validateCorpusIntegrity(input: {
  manifest: CorpusManifest;
  baseline: GoldenBaseline;
  policy: QualityPolicy;
  manifestPath: string;
  baselinePath: string;
  policyPath: string;
}): void {
  const { manifest, baseline, policy } = input;
  if (manifest.corpusVersion !== CORPUS_VERSION) throw new Error(`Corpus integrity failure: expected corpusVersion ${CORPUS_VERSION}`);
  if (baseline.corpusVersion !== manifest.corpusVersion || baseline.baselineVersion !== BASELINE_VERSION || baseline.policyVersion !== policy.policyVersion || policy.policyVersion !== POLICY_VERSION) {
    throw new Error("Corpus integrity failure: incompatible corpus, baseline, or policy versions");
  }

  ensureUnique(manifest.cases.map(({ caseId }) => caseId), "case IDs");
  ensureUnique(manifest.snapshots.map(({ snapshotId }) => snapshotId), "snapshot IDs");
  ensureUnique(baseline.entries.map(({ caseId }) => caseId), "baseline case IDs");

  const baselineIds = new Set(baseline.entries.map(({ caseId }) => caseId));
  const caseIds = new Set(manifest.cases.map(({ caseId }) => caseId));
  const missingBaselines = manifest.cases.map(({ caseId }) => caseId).filter((caseId) => !baselineIds.has(caseId));
  if (missingBaselines.length > 0) throw new Error(`Corpus integrity failure: missing baseline cases: ${missingBaselines.join(", ")}`);
  const orphanBaselines = baseline.entries.map(({ caseId }) => caseId).filter((caseId) => !caseIds.has(caseId));
  if (orphanBaselines.length > 0) throw new Error(`Corpus integrity failure: orphan baseline cases: ${orphanBaselines.join(", ")}`);

  const syntheticCoverage = new Set(manifest.cases.filter(({ kind }) => kind === "synthetic").map(({ language, syntheticClass }) => `${language}:${syntheticClass}`));
  for (const { language } of LANGUAGE_CONFIGS) {
    for (const syntheticClass of ["exact-target", "relationship/change", "incomplete/ambiguity"] as const) {
      if (!syntheticCoverage.has(`${language}:${syntheticClass}`)) throw new Error(`Corpus integrity failure: missing synthetic ${syntheticClass} coverage for ${language}`);
    }
  }

  const snapshots = new Map(manifest.snapshots.map((snapshot) => [snapshot.snapshotId, snapshot]));
  for (const value of manifest.cases.filter(({ kind }) => kind === "snapshot")) {
    const snapshotId = path.posix.basename(value.workspaceRef);
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot || value.workspaceRef !== `snapshots/${snapshotId}`) {
      throw new Error(`Corpus integrity failure: snapshot case ${value.caseId} has no matching snapshot provenance`);
    }
    if (snapshot.language !== value.language) throw new Error(`Corpus integrity failure: snapshot case ${value.caseId} language does not match snapshot ${snapshotId}`);
  }
  for (const snapshot of manifest.snapshots) validateLicenseNotice(input.manifestPath, snapshot);
}

export async function loadCorpus(paths: CorpusPaths): Promise<LoadedCorpus> {
  const [manifestBytes, baselineBytes, policyBytes] = await Promise.all([
    readFile(paths.manifestPath),
    readFile(paths.baselinePath),
    readFile(paths.policyPath),
  ]);
  const manifest = parseCorpusManifest(parseJson(manifestBytes, "manifest"));
  const baseline = parseGoldenBaseline(parseJson(baselineBytes, "baseline"));
  const policy = parseQualityPolicy(parseJson(policyBytes, "policy"));
  validateCorpusIntegrity({ ...paths, manifest, baseline, policy });
  return {
    ...paths,
    manifest,
    baseline,
    policy,
    manifestSha256: createHash("sha256").update(manifestBytes).digest("hex"),
    baselineSha256: createHash("sha256").update(baselineBytes).digest("hex"),
    policySha256: createHash("sha256").update(policyBytes).digest("hex"),
  };
}
