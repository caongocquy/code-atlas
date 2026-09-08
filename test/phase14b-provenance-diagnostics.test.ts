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
import { symbolIdentity, symbolIdentityKey } from "../src/core/graph/resolver/identities.js";

const sourceIdentity = symbolIdentity({
  repositoryId: "repo",
  relativePath: "source.ts",
  language: "typescript",
  kind: "function",
  qualifiedName: "source",
  discriminator: "1",
});
const targetIdentity = symbolIdentity({
  repositoryId: "repo",
  relativePath: "target.ts",
  language: "typescript",
  kind: "function",
  qualifiedName: "target",
  discriminator: "1",
});

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
      sourceLogicalIdentity: input.sourceLogicalIdentity ?? symbolIdentityKey(sourceIdentity),
      targetLogicalIdentity: input.targetLogicalIdentity ?? symbolIdentityKey(targetIdentity),
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
  assert.equal(edge.resolution?.sourceLogicalIdentity, symbolIdentityKey(sourceIdentity));
  assert.equal(edge.resolution?.targetLogicalIdentity, symbolIdentityKey(targetIdentity));
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

test("malformed logical identities are rejected", () => {
  assert.throws(() => edgeWithProvenance({
    strategy: "receiver-member",
    confidence: "strong",
    resolutionVersion: "1.0.0",
    sourceLogicalIdentity: "sqlite-source",
  }), /canonical symbol identity/);
  assert.throws(() => edgeWithProvenance({
    strategy: "receiver-member",
    confidence: "strong",
    resolutionVersion: "1.0.0",
    targetLogicalIdentity: JSON.stringify(["repo", "target.ts", "typescript", "function", " target ", "1"]),
  }), /canonical symbol identity/);
});

test("resolved diagnostic mapping accepts a complete decision", () => {
  const decision = {
    status: "resolved",
    language: "typescript",
    strategy: "receiver-member",
    confidence: "strong",
    targetLogicalIdentity: symbolIdentityKey(targetIdentity),
  } as const satisfies ResolutionDecision;
  assert.equal(diagnosticFor(decision, "main.ts", "typescript").kind, "resolved");
});

test("non-resolved diagnostic reasons are bounded and map deterministically", () => {
  const reason = "x".repeat(MAX_DIAGNOSTIC_REASON_LENGTH + 20);
  const statuses = [
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
