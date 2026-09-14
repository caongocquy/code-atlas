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

function parsedInputs(cases = syntheticCases(), snapshots: unknown[] = []) {
  const manifest = parseCorpusManifest({ corpusVersion: "context-eval-v1", cases, snapshots });
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
    assert.throws(() => validateCorpusIntegrity({ manifest: values.manifest, baseline: { ...incompatible, corpusVersion: "other" } as typeof incompatible, policy: values.policy, ...incompatiblePaths }));
  } finally {
    await (await import("node:fs/promises")).rm(root, { recursive: true, force: true });
  }
});

test("requires applicable notices to be regular files inside the declared snapshot root", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-phase15d-notice-"));
  try {
    const snapshotRoot = path.join(root, "snapshots", "sample");
    await mkdir(snapshotRoot, { recursive: true });
    await writeFile(path.join(snapshotRoot, "LICENSE"), "notice\n");
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
    const values = parsedInputs(syntheticCases(), [snapshot]);
    validateCorpusIntegrity({ ...values, ...await paths(root) });

    const missingNotice = parsedInputs(syntheticCases(), [{ ...snapshot, licenseNoticePath: "missing" }]);
    const missingNoticePaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...missingNotice, ...missingNoticePaths }));

    assert.throws(() => parsedInputs(syntheticCases(), [{ ...snapshot, licenseNoticePath: "../LICENSE" }]));

    const outsideNotice = path.join(root, "outside-license");
    await writeFile(outsideNotice, "outside\n");
    await symlink(outsideNotice, path.join(snapshotRoot, "ESCAPED_LICENSE"));
    const escapedSymlink = parsedInputs(syntheticCases(), [{ ...snapshot, licenseNoticePath: "ESCAPED_LICENSE" }]);
    const escapedSymlinkPaths = await paths(root);
    assert.throws(() => validateCorpusIntegrity({ ...escapedSymlink, ...escapedSymlinkPaths }));

    const optionalNotice = parsedInputs(syntheticCases(), [{ ...snapshot, licenseNoticeRequired: false, licenseNoticePath: undefined }]);
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
