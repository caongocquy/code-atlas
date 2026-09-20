import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { LANGUAGE_CONFIGS } from "../src/core/graph/parsers/languages.js";
import { loadCorpus, sha256File, validateCorpusIntegrity } from "../eval/context/corpus/load-corpus.js";
import { parseCorpusManifest, parseGoldenBaseline, parseQualityPolicy } from "../eval/context/schemas.js";

const policy = {
  policyVersion: "context-eval-policy-v1",
  aggregate: {
    maxEstimatedTokensIncreasePct: 10,
    maxReturnedBytesIncreasePct: 10,
    maxSelectedItemsIncreasePct: 10,
    maxRequiredHitRateDecreasePp: 0,
    maxSupportingHitRateDecreasePp: 5,
  },
  catastrophic: {
    maxEstimatedTokensMultiplier: 2,
    maxReturnedBytesMultiplier: 2,
    selectedItemsFormula: "baselineSelectedItems + max(3, baselineSelectedItems)",
    requiredTargetsMayDisappear: false,
  },
};

function syntheticCases() {
  return LANGUAGE_CONFIGS.flatMap(({ language }) => ["exact-target", "relationship/change", "incomplete/ambiguity"].map((syntheticClass) => ({
    caseId: `${language}-${syntheticClass}`,
    kind: "synthetic",
    language,
    syntheticClass,
    workspaceRef: `synthetic/${language}/${syntheticClass}`,
    task: "Evaluate context",
    anchors: [{ kind: "file", path: "src/app.ts" }],
    changedPaths: [],
    truth: { requiredSubjects: [{ kind: "file", path: "src/app.ts" }], supportingSubjects: [], forbiddenRequiredSubjects: [] },
  })));
}

function parsedInputs(cases: Array<{ caseId: string }> = syntheticCases(), snapshots: unknown[] = []) {
  const normalizedSnapshots = snapshots.map((value) => {
    const snapshot = value as { includedPaths: string[]; sourceContentSha256?: Record<string, string>; snapshotContentSha256?: Record<string, string> };
    const fallback = Object.fromEntries(snapshot.includedPaths.map((includedPath) => [includedPath, "0".repeat(64)]));
    return {
      ...snapshot,
      sourceContentSha256: snapshot.sourceContentSha256 ?? fallback,
      snapshotContentSha256: snapshot.snapshotContentSha256 ?? fallback,
    };
  });
  const manifest = parseCorpusManifest({ corpusVersion: "context-eval-v1", cases, snapshots: normalizedSnapshots });
  const baseline = parseGoldenBaseline({
    corpusVersion: "context-eval-v1",
    baselineVersion: "context-eval-baseline-v1",
    policyVersion: "context-eval-policy-v1",
    entries: cases.map((value) => ({ caseId: value.caseId, selectedItems: 1, estimatedTokens: 10, returnedBytes: 20, requiredHitRate: 1, supportingHitRate: 0 })),
  });
  return { manifest, baseline, policy: parseQualityPolicy(policy) };
}

async function paths(root: string) {
  const corpus = path.join(root, "manifest.json");
  const baseline = path.join(root, "baseline.json");
  const qualityPolicy = path.join(root, "policy.json");
  await Promise.all([writeFile(corpus, "{}"), writeFile(baseline, "{}"), writeFile(qualityPolicy, "{}")]);
  return { manifestPath: corpus, baselinePath: baseline, policyPath: qualityPolicy };
}

test("hashes raw file bytes before parsing", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-digest-"));
  try {
    const file = path.join(root, "raw.json");
    const bytes = Buffer.from([0x7b, 0x0d, 0x0a, 0x7d, 0x0a]);
    await writeFile(file, bytes);
    assert.equal(await sha256File(file), createHash("sha256").update(bytes).digest("hex"));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("rejects snapshot bytes that differ from recorded content digests", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-snapshot-digest-"));
  try {
    const snapshotRoot = path.join(root, "snapshots", "sample");
    await mkdir(path.join(snapshotRoot, "src"), { recursive: true });
    const sourcePath = path.join(snapshotRoot, "src", "app.ts");
    await writeFile(sourcePath, "export const value = 1;\n");
    const digest = await sha256File(sourcePath);
    const snapshotCase = {
      caseId: "snapshot-content-digest",
      kind: "snapshot",
      language: "typescript",
      workspaceRef: "snapshots/sample",
      task: "Evaluate snapshot content",
      anchors: [{ kind: "file", path: "src/app.ts" }],
      changedPaths: [],
      truth: { requiredSubjects: [{ kind: "file", path: "src/app.ts" }], supportingSubjects: [], forbiddenRequiredSubjects: [] },
    };
    const snapshot = {
      snapshotId: "sample",
      sourceRepository: "https://example.invalid/source",
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      licenseNoticeRequired: false,
      includedPaths: ["src/app.ts"],
      sourceContentSha256: { "src/app.ts": digest },
      snapshotContentSha256: { "src/app.ts": digest },
      language: "typescript",
      inclusionReason: "Focused digest regression fixture",
    };
    const values = parsedInputs([...syntheticCases(), snapshotCase], [snapshot]);
    const valuePaths = await paths(root);
    assert.doesNotThrow(() => validateCorpusIntegrity({ ...values, ...valuePaths }));
    await writeFile(sourcePath, "export const value = 2;\n");
    assert.throws(() => validateCorpusIntegrity({ ...values, ...valuePaths }), /digest/i);
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("validates registry-derived synthetic coverage and exact corpus relationships", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-integrity-"));
  try {
    const values = parsedInputs();
    validateCorpusIntegrity({ ...values, ...await paths(root) });

    const missingClass = parsedInputs(syntheticCases().filter((value) => value.caseId !== "typescript-exact-target"));
    const missingClassPaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...missingClass, ...missingClassPaths }));

    const missingBaseline = parseGoldenBaseline({ corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: [] });
    const missingBaselinePaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ manifest: values.manifest, baseline: missingBaseline, policy: values.policy, ...missingBaselinePaths }));

    const orphanBaseline = parseGoldenBaseline({ corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: [...values.baseline.entries, { caseId: "orphan", selectedItems: 1, estimatedTokens: 1, returnedBytes: 1, requiredHitRate: 1, supportingHitRate: 1 }] });
    const orphanPaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ manifest: values.manifest, baseline: orphanBaseline, policy: values.policy, ...orphanPaths }));

    const incompatible = parseGoldenBaseline({ corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: values.baseline.entries });
    const incompatiblePaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ manifest: values.manifest, baseline: { ...incompatible, corpusVersion: "other" } as unknown as typeof incompatible, policy: values.policy, ...incompatiblePaths }));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("rejects snapshot identifiers with separators and roots outside the corpus snapshots directory", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-snapshot-root-"));
  try {
    const snapshot = {
      snapshotId: "sample",
      sourceRepository: "https://example.invalid/source",
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      licenseNoticeRequired: true,
      licenseNoticePath: "LICENSE",
      includedPaths: ["src/app.ts"],
      language: "typescript",
      inclusionReason: "Focused regression fixture",
    };
    for (const snapshotId of ["nested/sample", "sample/../../outside"]) {
      assert.throws(() => parseCorpusManifest({ corpusVersion: "context-eval-v1", cases: syntheticCases(), snapshots: [{ ...snapshot, snapshotId }] }));
    }

    await mkdir(path.join(root, "outside"), { recursive: true });
    await writeFile(path.join(root, "outside", "LICENSE"), "outside\n");
    const values = parsedInputs(syntheticCases(), [snapshot]);
    const escapedManifest = {
      ...values.manifest,
      snapshots: [{ ...values.manifest.snapshots[0]!, snapshotId: "sample/../../outside" }],
    } as typeof values.manifest;
    const escapedPaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ manifest: escapedManifest, baseline: values.baseline, policy: values.policy, ...escapedPaths }));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("rejects a snapshot case whose language differs from its provenance", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-snapshot-language-"));
  try {
    const snapshotRoot = path.join(root, "snapshots", "sample");
    await mkdir(path.join(snapshotRoot, "src"), { recursive: true });
    await writeFile(path.join(snapshotRoot, "src", "app.ts"), "export const value = 1;\n");
    const snapshotCase = {
      caseId: "snapshot-language-mismatch",
      kind: "snapshot",
      language: "python",
      workspaceRef: "snapshots/sample",
      task: "Evaluate snapshot context",
      anchors: [{ kind: "file", path: "src/app.py" }],
      changedPaths: [],
      truth: { requiredSubjects: [{ kind: "file", path: "src/app.py" }], supportingSubjects: [], forbiddenRequiredSubjects: [] },
    };
    const snapshot = {
      snapshotId: "sample",
      sourceRepository: "https://example.invalid/source",
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      licenseNoticeRequired: false,
      includedPaths: ["src/app.ts"],
      sourceContentSha256: { "src/app.ts": "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" },
      snapshotContentSha256: { "src/app.ts": "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" },
      language: "typescript",
      inclusionReason: "Focused regression fixture",
    };
    const values = parsedInputs([...syntheticCases(), snapshotCase], [snapshot]);
    const valuePaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...values, ...valuePaths }));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("requires every snapshot case to materialize its root and declared regular files", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-snapshot-files-"));
  try {
    const snapshotCase = {
      caseId: "snapshot-files",
      kind: "snapshot",
      language: "typescript",
      workspaceRef: "snapshots/sample",
      task: "Evaluate snapshot files",
      anchors: [{ kind: "file", path: "src/app.ts" }],
      changedPaths: [],
      truth: { requiredSubjects: [{ kind: "file", path: "src/app.ts" }], supportingSubjects: [], forbiddenRequiredSubjects: [] },
    };
    const snapshot = {
      snapshotId: "sample",
      sourceRepository: "https://example.invalid/source",
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      licenseNoticeRequired: false,
      includedPaths: ["src/app.ts"],
      sourceContentSha256: { "src/app.ts": "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" },
      snapshotContentSha256: { "src/app.ts": "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" },
      language: "typescript",
      inclusionReason: "Focused regression fixture",
    };
    const values = parsedInputs([...syntheticCases(), snapshotCase], [snapshot]);
    const valuePaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...values, ...valuePaths }));

    const snapshotRoot = path.join(root, "snapshots", "sample");
    await mkdir(path.join(snapshotRoot, "src"), { recursive: true });
    assert.throws(() => validateCorpusIntegrity({ ...values, ...valuePaths }));

    await writeFile(path.join(snapshotRoot, "src", "app.ts"), "export const value = 1;\n");
    assert.doesNotThrow(() => validateCorpusIntegrity({ ...values, ...valuePaths }));

    const outside = path.join(root, "outside.ts");
    await writeFile(outside, "export const outside = true;\n");
    await symlink(outside, path.join(snapshotRoot, "src", "escaped.ts"));
    const escaped = parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, includedPaths: ["src/escaped.ts"], sourceContentSha256: { "src/escaped.ts": "0".repeat(64) }, snapshotContentSha256: { "src/escaped.ts": "0".repeat(64) } }]);
    assert.throws(() => validateCorpusIntegrity({ ...escaped, ...valuePaths }));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("rejects snapshot provenance that no snapshot case references", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-orphan-snapshot-"));
  try {
    const snapshot = {
      snapshotId: "orphan",
      sourceRepository: "https://example.invalid/source",
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      licenseNoticeRequired: false,
      includedPaths: ["src/app.ts"],
      language: "typescript",
      inclusionReason: "Focused regression fixture",
    };
    const values = parsedInputs(syntheticCases(), [snapshot]);
    const valuePaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...values, ...valuePaths }));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("requires applicable notices to be regular files inside the declared snapshot root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-notice-"));
  try {
    const snapshotRoot = path.join(root, "snapshots", "sample");
    await mkdir(path.join(snapshotRoot, "src"), { recursive: true });
    await writeFile(path.join(snapshotRoot, "LICENSE"), "notice\n");
    await writeFile(path.join(snapshotRoot, "src", "app.ts"), "export const value = 1;\n");
    const snapshotCase = {
      caseId: "snapshot-license-notice",
      kind: "snapshot",
      language: "typescript",
      workspaceRef: "snapshots/sample",
      task: "Evaluate snapshot notice",
      anchors: [{ kind: "file", path: "src/app.ts" }],
      changedPaths: [],
      truth: { requiredSubjects: [{ kind: "file", path: "src/app.ts" }], supportingSubjects: [], forbiddenRequiredSubjects: [] },
    };
    const snapshot = {
      snapshotId: "sample",
      sourceRepository: "https://example.invalid/source",
      sourceCommitSha: "0123456789abcdef0123456789abcdef01234567",
      license: "MIT",
      licenseNoticeRequired: true,
      licenseNoticePath: "LICENSE",
      includedPaths: ["src/app.ts"],
      sourceContentSha256: { "src/app.ts": "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" },
      snapshotContentSha256: { "src/app.ts": "5d8f65d2774e206bc9f7a7a4ad39ca2dc563b5c31e46ab57ef4874961237ce29" },
      language: "typescript",
      inclusionReason: "Focused regression fixture",
    };
    const values = parsedInputs([...syntheticCases(), snapshotCase], [snapshot]);
    validateCorpusIntegrity({ ...values, ...await paths(root) });

    const missingNotice = parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, licenseNoticePath: "missing" }]);
    const missingNoticePaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...missingNotice, ...missingNoticePaths }));

    const optionalValid = parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, licenseNoticeRequired: false }]);
    const optionalValidPaths = await paths(root);
    assert.doesNotThrow(() => validateCorpusIntegrity({ ...optionalValid, ...optionalValidPaths }));

    const optionalMissing = parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, licenseNoticeRequired: false, licenseNoticePath: "missing" }]);
    const optionalMissingPaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...optionalMissing, ...optionalMissingPaths }));

    assert.throws(() => parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, licenseNoticePath: "../LICENSE" }]));

    const outsideNotice = path.join(root, "outside-license");
    await writeFile(outsideNotice, "outside\n");
    await symlink(outsideNotice, path.join(snapshotRoot, "ESCAPED_LICENSE"));
    const escapedSymlink = parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, licenseNoticePath: "ESCAPED_LICENSE" }]);
    const escapedSymlinkPaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...escapedSymlink, ...escapedSymlinkPaths }));

    const optionalEscapedSymlink = parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, licenseNoticeRequired: false, licenseNoticePath: "ESCAPED_LICENSE" }]);
    const optionalEscapedSymlinkPaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...optionalEscapedSymlink, ...optionalEscapedSymlinkPaths }));

    const optionalNotice = parsedInputs([...syntheticCases(), snapshotCase], [{ ...snapshot, licenseNoticeRequired: false, licenseNoticePath: undefined }]);
    const optionalNoticePaths = await paths(root);
    assert.doesNotThrow(() => validateCorpusIntegrity({ ...optionalNotice, ...optionalNoticePaths }));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("loads and validates raw corpus documents together", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-load-"));
  try {
    const cases = syntheticCases();
    const manifestPath = path.join(root, "manifest.json");
    const baselinePath = path.join(root, "baseline.json");
    const policyPath = path.join(root, "policy.json");
    await writeFile(manifestPath, JSON.stringify({ corpusVersion: "context-eval-v1", cases, snapshots: [] }));
    await writeFile(baselinePath, JSON.stringify({ corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: cases.map((value) => ({ caseId: value.caseId, selectedItems: 1, estimatedTokens: 10, returnedBytes: 20, requiredHitRate: 1, supportingHitRate: 0 })) }));
    await writeFile(policyPath, JSON.stringify(policy));

    const corpus = await loadCorpus({ manifestPath, baselinePath, policyPath });
    assert.equal(corpus.manifest.cases.length, LANGUAGE_CONFIGS.length * 3);
    assert.equal(corpus.baselineSha256, createHash("sha256").update(await (await import("node:fs/promises")).readFile(baselinePath)).digest("hex"));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});
