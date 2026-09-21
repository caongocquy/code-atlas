import assert from "node:assert/strict";
import test from "node:test";
import { collectSpringBeanEvidence } from "../src/core/framework/adapters/spring.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";

test("links an explicit Spring bean factory owner to its method", () => {
  const context = { repositoryId: "repo", generationId: "generation", frameworkResolutionVersion: "1.0.0", detections: [], analyzePaths: new Set(["Config.java"]), maxObservations: 20, config: [], graph: { nodes: [{ id: "config", type: "class", name: "Config", file: "Config.java", startLine: 1, endLine: 5 }, { id: "repo", type: "method", name: "repo", file: "Config.java", startLine: 3, endLine: 3 }], edges: [{ from: "config", to: "repo", type: "contains" }] }, facts: [{ relativePath: "Config.java", facts: { imports: [{ moduleSpecifier: "org.springframework.context.annotation.Bean" }], frameworkSyntax: { complete: true, nodes: [{ id: "bean", kind: "annotation", name: "Bean", ownerSymbolId: "repo", range: { startLine: 2, endLine: 2 }, children: [], arguments: [], typeArguments: [] }] } } as never }] } as never;
  const result = collectSpringBeanEvidence(context);
  const materialized = resolveFrameworkEvidence(context, result.evidence);
  assert.equal(materialized.relationships[0]?.relationKind, "bean_relationship");
  assert.notEqual(materialized.relationships[0]?.source, materialized.relationships[0]?.target);
});
