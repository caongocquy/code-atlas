import assert from "node:assert/strict";
import test from "node:test";
import { collectSpringInjectionEvidence } from "../src/core/framework/adapters/spring.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("resolves a uniquely typed Spring injection target", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["App.java"]), maxObservations: 20, config: [], graph: { nodes: [{ id: "app", type: "class", name: "App", file: "App.java", startLine: 1, endLine: 5 }, { id: "repo", type: "class", name: "Repo", file: "App.java", startLine: 7, endLine: 7 }], edges: [] }, facts: [{ relativePath: "App.java", facts: { imports: [{ moduleSpecifier: "org.springframework.beans.factory.annotation.Autowired" }], parameters: [{ localId: "param", ownerSymbolId: "app", name: "repo", typeText: "Repo", index: 0, range: { startLine: 2, endLine: 2 } }], frameworkSyntax: { complete: true, nodes: [] } } as never }] } as never;
  const result = collectSpringInjectionEvidence(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships[0]?.relationKind, "dependency_injection");
});
