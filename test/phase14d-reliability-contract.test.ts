import assert from "node:assert/strict";
import test from "node:test";

import {
  canonicalReliabilityScope,
  reliabilityOutputKey,
  reliabilityScopeKey,
  reliabilityOwnerKey,
} from "../src/core/reliability/reliability-identity.js";
import {
  normalizeEvidenceRefs,
  fromFrameworkEvidenceRef,
  fromParsedFactRef,
  fromResolutionEvidence,
} from "../src/core/reliability/reliability-normalize.js";
import { aggregateReliability } from "../src/core/reliability/reliability-aggregator.js";
import type { ReliabilityContribution } from "../src/core/reliability/reliability.types.js";

test("normalizes evidence refs and scopes deterministically", () => {
  const refs = normalizeEvidenceRefs([
    {
      origin: "framework_inferred",
      sourcePath: "src/routes.ts",
      inputKey: "route",
      ownerKey: "owner-b",
    },
    {
      origin: "extracted",
      sourcePath: "src/routes.ts",
      inputKey: "route",
      ownerKey: "owner-a",
    },
  ]);

  assert.deepEqual(refs.map((ref) => ref.origin), ["extracted", "framework_inferred"]);

  const first = canonicalReliabilityScope({
    capability: "route_binding",
    framework: "next",
    selectorKey: "users",
  });
  const second = canonicalReliabilityScope({
    selectorKey: "users",
    framework: "next",
    capability: "route_binding",
  });
  assert.equal(reliabilityScopeKey(first), reliabilityScopeKey(second));
});

test("semantic keys exclude generation and checkout identity", () => {
  const first = reliabilityOutputKey({
    kind: "classification",
    subject: { kind: "language", nodeId: "module:src/a.ts" },
    classificationKind: "execution_boundary",
  });
  const second = reliabilityOutputKey({
    kind: "classification",
    subject: { kind: "language", nodeId: "module:src/a.ts" },
    classificationKind: "execution_boundary",
  });

  assert.equal(first, second);
  assert.doesNotMatch(first, /worktrees|generation|timestamp/i);
  assert.equal(
    reliabilityOwnerKey({ sourcePath: "src/a.ts", inputKey: "facts", capability: "imports" }),
    reliabilityOwnerKey({ sourcePath: "src/a.ts", inputKey: "facts", capability: "imports" }),
  );
});

test("rejects absolute and traversal filesystem paths", () => {
  assert.equal(canonicalReliabilityScope({ capability: "x", selectorKey: "/route/users" }).selectorKey, "/route/users");
  assert.throws(() => reliabilityOwnerKey({ sourcePath: "../src/a.ts", inputKey: "facts" }), /canonical|relative/i);
  assert.throws(() => reliabilityOwnerKey({ sourcePath: "/tmp/repo/src/a.ts", inputKey: "facts" }), /canonical|relative/i);
});

test("maps existing evidence shapes to explicit reliability origins", () => {
  const frameworkRef = fromFrameworkEvidenceRef({
    relativePath: "src/routes.ts",
    inputKey: "route:/users",
    localId: "route-1",
  }, "owner-framework");
  const extractedRef = fromParsedFactRef("src/routes.ts", "facts:imports", {
    startLine: 2,
    endLine: 2,
  }, "owner-facts");
  const inferredRef = fromResolutionEvidence({
    evidenceKind: "INFERRED",
    resolutionMethod: "import_binding",
    source: { file: "src/routes.ts", line: 4 },
  }, "owner-resolution");

  assert.equal(frameworkRef.origin, "framework_inferred");
  assert.equal(extractedRef.origin, "extracted");
  assert.equal(inferredRef.origin, "language_inferred");
  assert.equal(frameworkRef.sourcePath, extractedRef.sourcePath);
  assert.equal(inferredRef.range?.startLine, 4);
});

function contribution(overrides: Partial<ReliabilityContribution> = {}): ReliabilityContribution {
  return {
    ownerKey: "owner-a",
    scope: canonicalReliabilityScope({ capability: "route_binding", framework: "next" }),
    outputKey: "output-a",
    outcome: "accepted",
    complete: true,
    stale: false,
    origin: "framework_inferred",
    evidence: [{ origin: "framework_inferred", sourcePath: "src/routes.ts", inputKey: "route", ownerKey: "owner-a" }],
    diagnostics: [],
    coverage: { applicable: true, supported: true, attempted: true, resolved: true, ambiguous: false, unknown: false, unsupported: false, budgetExhausted: false },
    ...overrides,
  };
}

test("aggregates accepted evidence without making incomplete negatives authoritative", () => {
  const scope = canonicalReliabilityScope({ capability: "route_binding", framework: "next" });
  const accepted = aggregateReliability([contribution()], scope);
  assert.equal(accepted.outcome, "accepted");
  assert.equal(accepted.authoritative, true);
  assert.equal(accepted.authoritativeNegative, true);
  assert.equal(accepted.coverage.resolved, 1);

  const incomplete = aggregateReliability([contribution({ outcome: "unknown", complete: false, coverage: { ...contribution().coverage, resolved: false, unknown: true } })], scope);
  assert.equal(incomplete.outcome, "unknown");
  assert.equal(incomplete.complete, false);
  assert.equal(incomplete.authoritativeNegative, false);
  assert.equal(incomplete.coverage.resolved, 0);
  assert.equal(incomplete.coverage.unknown, 1);
});

test("conflicts remove resolved coverage and merge duplicate evidence deterministically", () => {
  const scope = canonicalReliabilityScope({ capability: "route_binding", framework: "next" });
  const first = contribution();
  const conflict = contribution({ ownerKey: "owner-b", outcome: "ambiguous", complete: false, coverage: { ...first.coverage, resolved: false, ambiguous: true } });
  const result = aggregateReliability([first, conflict, { ...first, ownerKey: "owner-c" }], scope);
  assert.equal(result.outcome, "ambiguous");
  assert.equal(result.coverage.resolved, 0);
  assert.equal(result.coverage.ambiguous, 1);
  assert.equal(result.evidenceSummary.total, 1);
});
