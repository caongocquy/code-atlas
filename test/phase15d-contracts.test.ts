import assert from "node:assert/strict";
import test from "node:test";

import { BASELINE_VERSION, CORPUS_VERSION, POLICY_VERSION, REPORT_SCHEMA_VERSION } from "../eval/context/types.js";
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

function caseRecord(overrides: Record<string, unknown> = {}) {
  return {
    caseId: "typescript-exact-target",
    kind: "synthetic",
    language: "typescript",
    syntheticClass: "exact-target",
    workspaceRef: "synthetic/typescript/exact-target",
    task: "Find the target",
    anchors: [{ kind: "symbol", path: "src/app.ts", name: "target" }],
    changedPaths: ["src/app.ts"],
    truth: {
      requiredSubjects: [{ kind: "symbol", path: "src/app.ts", symbolId: "symbol:target", selectorVersion: "1" }],
      supportingSubjects: [{ kind: "file", path: "src/support.ts" }],
      forbiddenRequiredSubjects: [{ kind: "file", path: "src/forbidden.ts" }],
    },
    ...overrides,
  };
}

function baselineRecord(caseId = "typescript-exact-target", overrides: Record<string, unknown> = {}) {
  return {
    caseId,
    selectedItems: 2,
    estimatedTokens: 100,
    returnedBytes: 200,
    requiredHitRate: 1,
    supportingHitRate: 0.5,
    ...overrides,
  };
}

test("exports the locked Phase15D version literals", () => {
  assert.equal(REPORT_SCHEMA_VERSION, "context-eval-report-v1");
  assert.equal(CORPUS_VERSION, "context-eval-v1");
  assert.equal(BASELINE_VERSION, "context-eval-baseline-v1");
  assert.equal(POLICY_VERSION, "context-eval-policy-v1");
});

test("parses the exact declarative corpus, baseline, and policy shapes", () => {
  const manifest = parseCorpusManifest({ corpusVersion: "context-eval-v1", cases: [caseRecord()], snapshots: [] });
  const baseline = parseGoldenBaseline({ corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: [baselineRecord()] });

  assert.equal(manifest.cases[0]?.truth.requiredSubjects[0]?.kind, "symbol");
  assert.equal(manifest.cases[0]?.lifecycle, undefined);
  assert.equal(baseline.entries[0]?.requiredHitRate, 1);
  assert.equal(parseQualityPolicy(policy).catastrophic.requiredTargetsMayDisappear, false);
});

test("accepts only declared lifecycle scenario discriminants", () => {
  const parsed = parseCorpusManifest({
    corpusVersion: "context-eval-v1",
    cases: [caseRecord({
      lifecycle: {
        primitives: [
          { kind: "start" },
          { kind: "refresh", expectedModeSequence: ["unchanged"] },
          { kind: "mutate", files: { "src/app.ts": "export const target = 2;\n" } },
          { kind: "restart" },
        ],
        expectedModes: ["full", "unchanged", "delta", "rehydrate"],
      },
    })],
    snapshots: [],
  });

  assert.equal(parsed.cases[0]?.lifecycle?.primitives.length, 4);
  assert.throws(() => parseCorpusManifest({ corpusVersion: "context-eval-v1", cases: [caseRecord({ lifecycle: { primitives: [{ kind: "delete" }], expectedModes: [] } })], snapshots: [] }));
  assert.throws(() => parseCorpusManifest({ corpusVersion: "context-eval-v1", cases: [caseRecord({ lifecycle: { primitives: [{ kind: "start", files: {} }], expectedModes: [] } })], snapshots: [] }));
});

test("rejects unknown versions, invalid subjects, duplicate ids, and malformed metrics", () => {
  assert.throws(() => parseCorpusManifest({ corpusVersion: "context-eval-v2", cases: [caseRecord()], snapshots: [] }));
  assert.throws(() => parseCorpusManifest({ corpusVersion: "context-eval-v1", cases: [caseRecord({ language: "elixir" })], snapshots: [] }));
  assert.throws(() => parseCorpusManifest({ corpusVersion: "context-eval-v1", cases: [caseRecord({ truth: { requiredSubjects: [{ kind: "file", path: "../escape.ts" }], supportingSubjects: [], forbiddenRequiredSubjects: [] } })], snapshots: [] }));
  assert.throws(() => parseCorpusManifest({ corpusVersion: "context-eval-v1", cases: [caseRecord(), caseRecord()], snapshots: [] }));
  assert.throws(() => parseGoldenBaseline({ corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: [baselineRecord("one"), baselineRecord("one")] }));
  assert.throws(() => parseGoldenBaseline({ corpusVersion: "context-eval-v1", baselineVersion: "context-eval-baseline-v1", policyVersion: "context-eval-policy-v1", entries: [baselineRecord("one", { returnedBytes: -1 })] }));
  assert.throws(() => parseQualityPolicy({ ...policy, catastrophic: { ...policy.catastrophic, selectedItemsFormula: "anything else" } }));
});
