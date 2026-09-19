import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { readFileSync, realpathSync, statSync } from "node:fs";
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

function validateSnapshotFiles(manifestPath: string, snapshot: CorpusManifest["snapshots"][number]): void {
  const { snapshotsRoot, root } = snapshotRoot(manifestPath, snapshot.snapshotId);
  let resolvedSnapshotsRoot: string;
  let resolvedRoot: string;
  try {
    resolvedSnapshotsRoot = realpathSync(snapshotsRoot);
    resolvedRoot = realpathSync(root);
  } catch (error) {
    throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} root is missing`, { cause: error });
  }
  if (!isChildPath(resolvedSnapshotsRoot, resolvedRoot) || !statSync(resolvedRoot).isDirectory()) {
    throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} root is not a safe directory`);
  }

  for (const includedPath of snapshot.includedPaths) {
    const file = path.resolve(root, includedPath);
    if (!isChildPath(root, file)) throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} included path escapes its snapshot root`);
    let resolvedFile: string;
    try {
      resolvedFile = realpathSync(file);
    } catch (error) {
      throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} included file is missing: ${includedPath}`, { cause: error });
    }
    if (!isChildPath(resolvedRoot, resolvedFile) || !statSync(resolvedFile).isFile()) {
      throw new Error(`Corpus integrity failure: snapshot ${snapshot.snapshotId} included path is not a safe regular file: ${includedPath}`);
    }
    const actualDigest = createHash("sha256").update(readFileSync(resolvedFile)).digest("hex");
    if (actualDigest !== snapshot.snapshotContentSha256[includedPath]) {
      throw new Error("Corpus integrity failure: snapshot " + snapshot.snapshotId + " content digest mismatch for " + includedPath);
    }
  }
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

export function validateCorpusWorkspaceRefs(input: { manifest: CorpusManifest; corpusRoot: string }): void {
  let resolvedCorpusRoot: string;
  try {
    resolvedCorpusRoot = realpathSync(path.resolve(input.corpusRoot));
  } catch (error) {
    throw new Error(`Corpus integrity failure: corpus root is missing: ${input.corpusRoot}`, { cause: error });
  }

  for (const evalCase of input.manifest.cases) {
    const supported = evalCase.workspaceRef.startsWith("synthetic/") || evalCase.workspaceRef.startsWith("snapshots/");
    if (!supported) throw new Error(`Corpus integrity failure: unsupported workspaceRef for ${evalCase.caseId}: ${evalCase.workspaceRef}`);
    const fixture = path.resolve(resolvedCorpusRoot, evalCase.workspaceRef);
    if (!isChildPath(resolvedCorpusRoot, fixture)) {
      throw new Error(`Corpus integrity failure: workspaceRef escapes corpus root for ${evalCase.caseId}: ${evalCase.workspaceRef}`);
    }
    let resolvedFixture: string;
    try {
      resolvedFixture = realpathSync(fixture);
    } catch (error) {
      throw new Error(`Corpus integrity failure: workspaceRef fixture is missing for ${evalCase.caseId}: ${evalCase.workspaceRef}`, { cause: error });
    }
    if (!isChildPath(resolvedCorpusRoot, resolvedFixture) || !statSync(resolvedFixture).isDirectory()) {
      throw new Error(`Corpus integrity failure: workspaceRef fixture is not a safe directory for ${evalCase.caseId}: ${evalCase.workspaceRef}`);
    }
  }
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
  const referencedSnapshotIds = new Set<string>();
  for (const value of manifest.cases.filter(({ kind }) => kind === "snapshot")) {
    const snapshotId = path.posix.basename(value.workspaceRef);
    const snapshot = snapshots.get(snapshotId);
    if (!snapshot || value.workspaceRef !== `snapshots/${snapshotId}`) {
      throw new Error(`Corpus integrity failure: snapshot case ${value.caseId} has no matching snapshot provenance`);
    }
    if (snapshot.language !== value.language) throw new Error(`Corpus integrity failure: snapshot case ${value.caseId} language does not match snapshot ${snapshotId}`);
    validateSnapshotFiles(input.manifestPath, snapshot);
    referencedSnapshotIds.add(snapshotId);
  }
  const orphanSnapshots = [...snapshots.keys()].filter((snapshotId) => !referencedSnapshotIds.has(snapshotId));
  if (orphanSnapshots.length > 0) throw new Error(`Corpus integrity failure: orphan snapshot provenance: ${orphanSnapshots.join(", ")}`);
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
