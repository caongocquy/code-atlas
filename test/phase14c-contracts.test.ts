import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeFrameworkAcceptedOutput,
  frameworkEntityKey,
  frameworkSubjectKey,
} from "../src/core/framework/framework-identity.js";
import type {
  FrameworkClassification,
  FrameworkCoverage,
  FrameworkDiagnosticCode,
  FrameworkDiagnostic,
  FrameworkEntity,
  FrameworkEvidenceRef,
  FrameworkEntityRef,
  FrameworkProvenance,
  FrameworkRelationship,
  FrameworkSubjectRef,
} from "../src/core/framework/framework.types.js";
import type { FrameworkQueryProjection } from "../src/core/graph/query/framework-query.types.js";
import type { GraphEdge, GraphNode } from "../src/core/graph/types.js";

const entityRef = (scope: string): FrameworkEntityRef => ({
  framework: "next",
  kind: "route",
  logicalKey: JSON.stringify([scope, "app", "/users", "GET", [], null]),
});

const provenance = (
  confidence: "exact" | "strong" | "weak",
  refs: FrameworkProvenance["refs"] = [{ relativePath: "app/users/page.tsx", inputKey: "facts:1" }],
  evidenceIds: FrameworkProvenance["evidenceIds"] = ["evidence:1"],
): FrameworkProvenance => ({
  origin: "framework_inferred",
  framework: "next",
  adapterId: "next-conventions",
  adapterVersion: "1.0.0",
  strategy: "app-router-page",
  confidence: confidence as "exact" | "strong",
  evidenceIds,
  refs,
});

const languageNode: GraphNode = {
  id: "node:1",
  type: "file",
  name: "page.tsx",
  file: "app/users/page.tsx",
};

const languageEdge: GraphEdge = { from: "node:1", to: "node:2", type: "contains" };

const invalidClassification: FrameworkClassification = {
  outputKind: "classification",
  subject: { kind: "language", nodeId: "node:1" },
  classificationKind: "execution_boundary",
  classificationValue: "client",
  provenance: provenance("exact"),
  // @ts-expect-error Accepted classifications are unary and have no target.
  target: { kind: "language", nodeId: "node:2" },
};
void invalidClassification;

test("framework entity keys preserve application scope", () => {
  assert.notEqual(
    frameworkEntityKey(entityRef("app-a")),
    frameworkEntityKey(entityRef("app-b")),
  );
  assert.equal(
    frameworkEntityKey(entityRef("app-a")),
    JSON.stringify(["next", "route", JSON.stringify(["app-a", "app", "/users", "GET", [], null])]),
  );
});

test("framework entity keys reject malformed and noncanonical logical tuples", () => {
  const malformedKeys = [
    "not-json",
    JSON.stringify(["app-a", "app", "/users", "GET", ["z", "a"], null]),
    '["app-a", "app", "/users", "GET", [], null]',
    JSON.stringify(["app-a", "app", "/users", "GET", [], null, "extra"]),
    JSON.stringify(["../app-a", "app", "/users", "GET", [], null]),
    JSON.stringify(["app-a", "../app", "/users", "GET", [], null]),
    JSON.stringify(["app\\a", "app", "/users", "GET", [], null]),
    JSON.stringify(["app/.", "app", "/users", "GET", [], null]),
    JSON.stringify(["app//a", "app", "/users", "GET", [], null]),
  ];

  for (const logicalKey of malformedKeys) {
    assert.throws(
      () => frameworkEntityKey({ framework: "next", kind: "route", logicalKey }),
      TypeError,
    );
  }
});

test("framework subject keys are deterministic and variant-safe", () => {
  const language: FrameworkSubjectRef = { kind: "language", nodeId: "node:1" };
  const framework: FrameworkSubjectRef = { kind: "framework", entity: entityRef("app-a") };

  assert.equal(frameworkSubjectKey(language), frameworkSubjectKey(language));
  assert.notEqual(frameworkSubjectKey(language), frameworkSubjectKey(framework));
  assert.equal(frameworkSubjectKey(language), JSON.stringify(["language", "node:1"]));
  assert.equal(
    frameworkSubjectKey(framework),
    JSON.stringify(["framework", "next", "route", JSON.stringify(["app-a", "app", "/users", "GET", [], null])]),
  );
});

test("accepted relationship contracts require both endpoints", () => {
  const relationship: FrameworkRelationship = {
    outputKind: "relationship",
    source: { kind: "language", nodeId: "node:1" },
    target: { kind: "framework", entity: entityRef("app-a") },
    relationKind: "route_binding",
    provenance: provenance("strong"),
  };

  assert.equal(decodeFrameworkAcceptedOutput(relationship)?.outputKind, "relationship");
  assert.equal(
    decodeFrameworkAcceptedOutput({ ...relationship, target: undefined }),
    undefined,
  );
});

test("classifications are unary records without targets", () => {
  const classification: FrameworkClassification = {
    outputKind: "classification",
    subject: { kind: "language", nodeId: "node:1" },
    classificationKind: "execution_boundary",
    classificationValue: "client",
    provenance: provenance("exact"),
  };

  assert.equal(decodeFrameworkAcceptedOutput(classification)?.outputKind, "classification");
  assert.equal(
    decodeFrameworkAcceptedOutput({ ...classification, target: classification.subject }),
    undefined,
  );
});

test("weak provenance cannot cross the accepted-output decoding boundary", () => {
  const relationship = {
    outputKind: "relationship",
    source: { kind: "language", nodeId: "node:1" },
    target: { kind: "language", nodeId: "node:2" },
    relationKind: "component_usage",
    provenance: provenance("weak"),
  };

  assert.equal(decodeFrameworkAcceptedOutput(relationship), undefined);
  assert.equal(
    decodeFrameworkAcceptedOutput(JSON.stringify({ ...relationship, provenance: provenance("exact") }))?.outputKind,
    "relationship",
  );
});

test("accepted provenance rejects empty or oversized evidence and invalid ranges", () => {
  const relationship = {
    outputKind: "relationship",
    source: { kind: "language", nodeId: "node:1" },
    target: { kind: "language", nodeId: "node:2" },
    relationKind: "component_usage",
    provenance: provenance("exact"),
  };

  assert.equal(
    decodeFrameworkAcceptedOutput({ ...relationship, provenance: provenance("exact", [], []) }),
    undefined,
  );
  assert.equal(
    decodeFrameworkAcceptedOutput({
      ...relationship,
      provenance: provenance(
        "exact",
        Array.from({ length: 33 }, (_, index) => ({
          relativePath: `app/${index}.tsx`,
          inputKey: `facts:${index}`,
        })),
      ),
    }),
    undefined,
  );
  assert.equal(
    decodeFrameworkAcceptedOutput({
      ...relationship,
      provenance: provenance("exact", [{
        relativePath: "app/users/page.tsx",
        inputKey: "facts:1",
        range: { startLine: 0, endLine: 1 },
      }]),
    }),
    undefined,
  );
});

test("accepted provenance rejects unknown and oversized payload fields", () => {
  const relationship = {
    outputKind: "relationship",
    source: { kind: "language", nodeId: "node:1" },
    target: { kind: "language", nodeId: "node:2" },
    relationKind: "component_usage",
    provenance: provenance("exact"),
  };
  const validRef = relationship.provenance.refs[0];
  const extraPayload = "x".repeat(1_000_000);

  assert.deepEqual(
    decodeFrameworkAcceptedOutput(relationship)?.provenance.refs[0],
    validRef,
  );
  assert.equal(
    decodeFrameworkAcceptedOutput({
      ...relationship,
      provenance: provenance("exact", [{ ...validRef, extra: "unexpected" } as unknown as FrameworkEvidenceRef]),
    }),
    undefined,
  );
  assert.equal(
    decodeFrameworkAcceptedOutput({
      ...relationship,
      provenance: provenance("exact", [{
        ...validRef,
        range: { startLine: 1, endLine: 1, extra: extraPayload } as unknown as NonNullable<FrameworkEvidenceRef["range"]>,
      } as FrameworkEvidenceRef]),
    }),
    undefined,
  );
});

test("framework projection is additive to the language graph", () => {
  const entity: FrameworkEntity = {
    ref: entityRef("app-a"),
    displayName: "/users",
    provenance: provenance("exact"),
  };
  const relationship: FrameworkRelationship = {
    outputKind: "relationship",
    source: { kind: "language", nodeId: languageNode.id },
    target: { kind: "framework", entity: entity.ref },
    relationKind: "route_binding",
    provenance: provenance("exact"),
  };
  const projection: FrameworkQueryProjection = {
    nodes: [
      { kind: "language", node: languageNode },
      { kind: "framework", entity },
    ],
    edges: [
      { kind: "language", edge: languageEdge },
      { kind: "framework", relationship },
    ],
    classifications: [],
    diagnostics: [],
    coverage: [],
    mayBeIncomplete: false,
  };

  assert.equal(projection.nodes.length, 2);
  assert.equal(projection.edges.length, 2);
  assert.equal(projection.classifications.length, 0);
});

test("diagnostic vocabulary covers semantic and infrastructure outcomes", () => {
  const codes: readonly FrameworkDiagnosticCode[] = [
    "framework_construct_unsupported",
    "framework_target_ambiguous",
    "framework_target_unknown",
    "framework_budget_exhausted",
    "framework_config_incomplete",
    "framework_adapter_failed",
    "framework_entity_identity_collision",
    "framework_subject_ambiguous",
    "framework_subject_unknown",
    "framework_classification_conflict",
  ];
  assert.equal(new Set(codes).size, 10);

  const adapterFailure: FrameworkDiagnostic = {
    code: "framework_adapter_failed",
    outcome: "adapter_failed",
    framework: "next",
    capability: "app-router",
    relativePath: "app/users/page.tsx",
    strategy: "next-conventions",
    evidenceIds: ["evidence:1"],
    refs: [{ relativePath: "app/users/page.tsx", inputKey: "facts:1" }],
    reason: "adapter infrastructure failed",
  };
  assert.equal(adapterFailure.outcome, "adapter_failed");
});

test("coverage kind is paired with its output kind", () => {
  const relationshipCoverage: FrameworkCoverage = {
    framework: "next",
    capability: "route-binding",
    relativePath: "app/users/page.tsx",
    strategy: "app-router-page",
    outputKind: "relationship",
    kind: "route_binding",
    applicable: 1,
    supported: 1,
    attempted: 1,
    resolved: 1,
    ambiguous: 0,
    unknown: 0,
    unsupported: 0,
    budgetExhausted: 0,
    weakDropped: 0,
  };
  const classificationCoverage: FrameworkCoverage = {
    ...relationshipCoverage,
    outputKind: "classification",
    kind: "execution_boundary",
  };
  // @ts-expect-error A relationship kind cannot be paired with classification output.
  const invalidClassificationCoverage: FrameworkCoverage = {
    ...relationshipCoverage,
    outputKind: "classification",
    kind: "route_binding",
  };
  void invalidClassificationCoverage;

  assert.equal(relationshipCoverage.kind, "route_binding");
  assert.equal(classificationCoverage.kind, "execution_boundary");
});

test("identity rejects empty logical keys", () => {
  assert.throws(
    () => frameworkEntityKey({ framework: "next", kind: "route", logicalKey: "" }),
    TypeError,
  );
  assert.throws(
    () => frameworkSubjectKey({ kind: "language", nodeId: "" }),
    TypeError,
  );
});

// @ts-expect-error Framework entities are not language GraphNodes.
const invalidGraphNode: GraphNode = entityRef("app-a");
void invalidGraphNode;
