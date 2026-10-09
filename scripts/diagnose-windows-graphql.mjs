#!/usr/bin/env node
// Read-only parser/framework diagnostic. Does not change Phase 17 contracts.
import assert from "node:assert/strict";
import { nestjsAdapter } from "../src/core/framework/adapters/nestjs.js";
import { resolveFrameworkEvidence } from "../src/core/framework/framework-registry.js";
import { extractParsedFacts } from "../src/core/facts/facts-extractor.js";
import { FACTS_SCHEMA_VERSION, FACTS_VERSION, FRAMEWORK_RESOLUTION_VERSION } from "../src/core/repository/index-version.js";

const source = 'import * as G from "@nestjs/graphql"; import { Resolver, Query } from "@nestjs/graphql"; @Resolver("User") class R { @Query() users() {} @G.ResolveField() name() {} }';
const iterations = 32;
let completed = 0;

for (let i = 0; i < iterations; i += 1) {
  const outcome = extractParsedFacts({
    source, filePath: "src/resolver.ts", language: "typescript",
    contentHash: "fixture", factsVersion: FACTS_VERSION, factsSchemaVersion: FACTS_SCHEMA_VERSION,
  });
  assert.equal(outcome.kind, "facts", outcome.kind === "infrastructure_failure" ? outcome.error.message : undefined);
  if (outcome.kind !== "facts") break;

  const facts = outcome.facts;
  const relativePath = "src/resolver.ts";
  const graph = {
    nodes: facts.symbols.filter((s) => s.kind === "class" || s.kind === "method").map((s) => ({
      id: `graph:${s.localId}`, type: s.kind, name: s.name,
      qualifiedName: s.declaredQualifiedName ?? s.name, file: relativePath,
      startLine: s.range.startLine, endLine: s.range.endLine,
    })),
    edges: [],
  };
  const base = { repositoryId: "repo", facts: [{ relativePath, facts }], graph, config: [] };
  const ctx = {
    ...base, generationId: "gen", frameworkResolutionVersion: FRAMEWORK_RESOLUTION_VERSION,
    detections: nestjsAdapter.detect(base), analyzePaths: new Set([relativePath]), maxObservations: 100,
  };
  const evidence = nestjsAdapter.analyze(ctx).evidence;
  const materialization = resolveFrameworkEvidence(ctx, evidence);
  const accepted = materialization.entities.length === 1;
  const unsupported = materialization.diagnostics.some((item) => item.outcome === "unsupported");

  if (!accepted || !unsupported) {
    // Preserve raw fixture facts and candidate reasons for CI triage, not a pass-by-retry.
    process.stderr.write(JSON.stringify({
      iteration: i, accepted, unsupported, entityCount: materialization.entities.length,
      imports: facts.imports, symbols: facts.symbols, bindingSeeds: facts.bindingSeeds,
      syntaxComplete: facts.frameworkSyntax?.complete,
      annotations: facts.frameworkSyntax?.nodes.filter((item) => item.kind === "annotation" || item.kind === "identifier"),
      evidence: evidence.map((item) => ({
        strategy: item.strategy, state: item.state, supported: item.supported,
        entities: item.entities, refs: item.refs,
      })),
      diagnostics: materialization.diagnostics,
    }, null, 2) + "\n");
    process.exitCode = 1;
    break;
  }
  completed += 1;
}

process.stdout.write(`NestJS GraphQL namespace fixture: ${completed}/${iterations} iterations passed on ${process.platform}/${process.arch} Node ${process.version}\n`);
