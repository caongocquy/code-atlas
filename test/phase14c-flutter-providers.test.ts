import assert from "node:assert/strict";
import test from "node:test";
import { collectFlutterProviderEvidence } from "../src/core/framework/adapters/flutter.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("resolves a Provider generic to its explicit target", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["app.dart"]), maxObservations: 20, config: [], graph: { nodes: [{ id: "app", type: "function", name: "build", file: "app.dart", startLine: 1, endLine: 5 }, { id: "repo", type: "class", name: "Repo", file: "app.dart", startLine: 7, endLine: 7 }], edges: [] }, facts: [{ relativePath: "app.dart", facts: { imports: [{ moduleSpecifier: "package:provider/provider.dart" }], frameworkSyntax: { complete: true, nodes: [{ id: "repo-type", kind: "identifier", name: "Repo", range: { startLine: 1, endLine: 1 }, children: [], arguments: [], typeArguments: [] }, { id: "provider", kind: "construct", name: "Provider", typeArguments: ["repo-type"], range: { startLine: 1, endLine: 1 }, children: [], arguments: [] }] } } as never }] } as never;
  const result = collectFlutterProviderEvidence(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships[0]?.relationKind, "dependency_injection");
  assert.equal(materialized.relationships[0]?.provenance.framework, "flutter");
});
