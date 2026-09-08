import assert from "node:assert/strict";
import test from "node:test";

import type { ParsedFactsBlob } from "../src/core/facts/facts.types.js";
import type { CodeGraph } from "../src/core/graph/types.js";
import {
  createCandidateResolutionInput,
  type CandidateResolutionInput,
} from "../src/core/indexing/resolution-scope.js";
import type { IndexedSourceUnit } from "../src/core/indexing/indexing.types.js";

function units(...paths: string[]): IndexedSourceUnit[] {
  return paths.map((relativePath) => ({
    relativePath,
    source: "",
    facts: {} as ParsedFactsBlob,
  }));
}

const graph: CodeGraph = { nodes: [], edges: [] };

test("candidate resolution input retains every unit while selecting a bounded work set", () => {
  const input = createCandidateResolutionInput(units("a.ts", "b.ts", "c.ts"), {
    mode: "bounded",
    paths: ["a.ts", "b.ts"],
    reasons: ["changed_source"],
  }, "generation-1", graph);

  assert.deepEqual(input.allUnits.map((unit) => unit.relativePath), ["a.ts", "b.ts", "c.ts"]);
  assert.deepEqual(input.scope.paths, ["a.ts", "b.ts"]);
  assert.equal(input.previousGenerationId, "generation-1");
  assert.equal(input.previousGraph, graph);
});

test("repository resolution normalizes scope paths to every sorted unit", () => {
  const input = createCandidateResolutionInput(units("b.ts", "a.ts"), {
    mode: "repository",
    paths: ["stale.ts"],
    reasons: ["resolution_version"],
  }, undefined, undefined);

  assert.deepEqual(input.allUnits.map((unit) => unit.relativePath), ["a.ts", "b.ts"]);
  assert.deepEqual(input.scope.paths, ["a.ts", "b.ts"]);
});

test("bounded resolution rejects paths outside the current units", () => {
  assert.throws(
    () => createCandidateResolutionInput(units("a.ts"), {
      mode: "bounded",
      paths: ["missing.ts"],
      reasons: ["changed_source"],
    }, undefined, undefined),
    /resolution scope contains an unknown path/,
  );
});

test("candidate input owns its unit and path collections", () => {
  const sourceUnits = units("b.ts", "a.ts");
  const scopePaths = ["b.ts"];
  const input: CandidateResolutionInput = createCandidateResolutionInput(sourceUnits, {
    mode: "bounded",
    paths: scopePaths,
    reasons: ["changed_source"],
  }, undefined, undefined);

  sourceUnits.pop();
  scopePaths.push("a.ts");

  assert.deepEqual(input.allUnits.map((unit) => unit.relativePath), ["a.ts", "b.ts"]);
  assert.deepEqual(input.scope.paths, ["b.ts"]);
});
