import assert from "node:assert/strict";
import test from "node:test";

import {
  decodeFrameworkAcceptedOutput,
  frameworkEntityKey,
  frameworkSubjectKey,
} from "../src/core/framework/framework-identity.js";
import type {
  FrameworkClassification,
  FrameworkDiagnosticCode,
  FrameworkEntity,
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

const provenance = (confidence: "exact" | "strong" | "weak"): FrameworkProvenance => ({
  origin: "framework_inferred",
  framework: "next",
  adapterId: "next-conventions",
  adapterVersion: "1.0.0",
  strategy: "app-router-page",
  confidence: confidence as "exact" | "strong",
  evidenceIds: ["evidence:1"],
  refs: [{ relativePath: "app/users/page.tsx", inputKey: "facts:1" }],
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

test("diagnostic vocabulary includes unresolved framework subjects", () => {
  const code: FrameworkDiagnosticCode = "framework_subject_unknown";
  assert.equal(code, "framework_subject_unknown");
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
