import assert from "node:assert/strict";
import test from "node:test";

import {
  diagnosticFor,
  MAX_DIAGNOSTIC_REASON_LENGTH,
} from "../src/core/diagnostics/resolver-diagnostics.js";
import type { ResolverDiagnostic } from "../src/core/diagnostics/coverage-diagnostics.types.js";
import {
  MAX_COMPACT_EVIDENCE,
  withProvenance,
} from "../src/core/graph/resolver/provenance.js";
import type {
  EdgeResolutionProvenance,
  ResolutionDecision,
} from "../src/core/graph/resolution.types.js";
import type { GraphEdge } from "../src/core/graph/types.js";

function edgeWithProvenance(
  input: Pick<EdgeResolutionProvenance, "strategy" | "confidence" | "resolutionVersion">
    & Partial<Pick<EdgeResolutionProvenance, "sourceLogicalIdentity" | "targetLogicalIdentity">>,
): GraphEdge {
  return withProvenance(
    { from: "sqlite-source", to: "sqlite-target", type: "calls" },
    {
      ...input,
      evidence: Array.from({ length: MAX_COMPACT_EVIDENCE + 2 }, (_, index) => ({
        kind: index % 2 === 0 ? "member" : "receiver",
        sourceUnit: index === 0 ? "z.ts" : "a.ts",
        startLine: index + 1,
        endLine: index + 2,
        evidenceId: `evidence-${index}`,
      })),
      sourceLogicalIdentity: input.sourceLogicalIdentity ?? "source-key",
      targetLogicalIdentity: input.targetLogicalIdentity ?? "target-key",
    },
  );
}

function resolveWeakFixture(): { edges: GraphEdge[]; diagnostics: ResolverDiagnostic[] } {
  const decision = {
    status: "weak_evidence_dropped",
    language: "typescript",
    edgeKind: "calls",
    strategy: "name-only",
    reason: "name-only evidence is not accepted",
  } as const satisfies ResolutionDecision;

  return {
    edges: [],
    diagnostics: [diagnosticFor(decision, "main.ts", "typescript")],
  };
}

test("accepted edge provenance is categorical and bounded", () => {
  const edge = edgeWithProvenance({ strategy: "receiver-member", confidence: "strong", resolutionVersion: "1.0.0" });
  assert.equal(edge.resolution?.confidence, "strong");
  assert.equal(typeof edge.confidence, "undefined");
  assert.equal(edge.resolution?.evidence.length, MAX_COMPACT_EVIDENCE);
  assert.deepEqual(edge.resolution?.evidence.slice(0, 2).map((item) => item.sourceUnit), ["a.ts", "a.ts"]);
  assert.equal(edge.resolution?.sourceLogicalIdentity, "source-key");
  assert.equal(edge.resolution?.targetLogicalIdentity, "target-key");
  assert.equal(edge.from, "sqlite-source");
  assert.equal(edge.to, "sqlite-target");
});

test("weak evidence produces a diagnostic and no accepted edge", () => {
  const result = resolveWeakFixture();
  assert.equal(result.edges.length, 0);
  assert.equal(result.diagnostics[0]?.kind, "weakEvidenceDropped");
  assert.throws(() => edgeWithProvenance({
    strategy: "name-only",
    confidence: "weak" as never,
    resolutionVersion: "1.0.0",
  }), /cannot use weak confidence/);
});

test("diagnostic reasons are bounded and decision kinds map deterministically", () => {
  const reason = "x".repeat(MAX_DIAGNOSTIC_REASON_LENGTH + 20);
  const statuses = [
    ["resolved", "resolved"],
    ["ambiguous", "ambiguous"],
    ["unknown", "unknown"],
    ["unsupported", "unsupported"],
    ["budget_exhausted", "budgetExhausted"],
    ["weak_evidence_dropped", "weakEvidenceDropped"],
    ["candidate_overflow", "candidateOverflow"],
  ] as const;

  for (const [status, kind] of statuses) {
    const decision = {
      status,
      language: "typescript",
      reason,
    } as const satisfies ResolutionDecision;
    const diagnostic = diagnosticFor(decision, "main.ts", "typescript");
    assert.equal(diagnostic.kind, kind);
    assert.equal(diagnostic.count, 1);
    assert.equal(diagnostic.reason?.length, MAX_DIAGNOSTIC_REASON_LENGTH);
  }
});

test("legacy graph evidence remains readable without categorical provenance", () => {
  const edge: GraphEdge = {
    from: "source",
    to: "target",
    type: "calls",
    confidence: 1,
    evidenceKind: "INFERRED",
    resolutionSource: { file: "main.ts", line: 4 },
  };
  assert.equal(edge.resolution, undefined);
  assert.equal(edge.confidence, 1);
  assert.equal(edge.evidenceKind, "INFERRED");
  assert.deepEqual(edge.resolutionSource, { file: "main.ts", line: 4 });
});
