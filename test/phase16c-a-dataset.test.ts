import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import { validateRetrievalDataset } from "../eval/retrieval/types.js";

const datasetPath = path.resolve("eval/retrieval/dataset.json");

test("retrieval dataset has a family-level development and held-out corpus with required query classes", async () => {
  const dataset = validateRetrievalDataset(JSON.parse(await readFile(datasetPath, "utf8")) as unknown);
  const familySplits = new Map(dataset.cases.map((item) => [item.fixture, item.split]));
  assert.ok(dataset.cases.length >= 30 && dataset.cases.length <= 40);
  assert.ok(familySplits.size >= 4);
  assert.ok([...familySplits.values()].filter((split) => split === "held-out").length >= 2);
  assert.ok(dataset.cases.filter((item) => item.split === "held-out").length >= 10);
  assert.equal(dataset.cases.find((item) => item.queryClass === "semantic-disabled")?.profile, "disabled");
  assert.equal(dataset.cases.find((item) => item.queryClass === "semantic-unavailable")?.profile, "unavailable");
  assert.ok(dataset.cases.filter((item) => item.semanticVectors).length >= 4);
  assert.ok(dataset.cases.filter((item) => item.scipPair).length >= 3);
});

test("retrieval dataset rejects fixture families split across development and held-out", async () => {
  const source = JSON.parse(await readFile(datasetPath, "utf8")) as { cases: Array<Record<string, unknown>> };
  source.cases[0] = { ...source.cases[0], split: "held-out" };
  assert.throws(() => validateRetrievalDataset(source), /crosses dataset splits/);
  const wrongDimensions = JSON.parse(await readFile(datasetPath, "utf8")) as { cases: Array<Record<string, unknown>> };
  const semanticCase = wrongDimensions.cases.find((item) => item.queryClass === "semantic-paraphrase")!;
  const vectors = semanticCase.semanticVectors as { candidates: Array<{ vector: number[] }> };
  vectors.candidates[0]!.vector = [1, 0, 0];
  assert.throws(() => validateRetrievalDataset(wrongDimensions), /Mismatched semantic vector dimensions/);
});

test("zero-relevant cases require an explicit no-promotion expectation and negative judgments", async () => {
  const source = JSON.parse(await readFile(datasetPath, "utf8")) as { cases: Array<Record<string, unknown>> };
  assert.doesNotThrow(() => validateRetrievalDataset(source));

  const missingExpectation = structuredClone(source);
  const noPromotion = missingExpectation.cases.find((item) => item.id === "pricing-ambiguous")!;
  delete noPromotion.expectation;
  assert.throws(() => validateRetrievalDataset(missingExpectation), /explicit expectation/);

  const insufficientJudgments = structuredClone(source);
  insufficientJudgments.cases.find((item) => item.id === "pricing-ambiguous")!.forbidden = [
    { kind: "symbol", path: "orders.ts", name: "findById", symbolKind: "function" },
  ];
  assert.throws(() => validateRetrievalDataset(insufficientJudgments), /at least two forbidden selectors/);
});

test("retrieval dataset rejects duplicate query cases within the same family and profile", async () => {
  const source = JSON.parse(await readFile(datasetPath, "utf8")) as { cases: Array<Record<string, unknown>> };
  const duplicate = { ...source.cases[0]!, id: "duplicate-query-case" };
  source.cases.push(duplicate);
  assert.throws(() => validateRetrievalDataset(source), /Duplicate retrieval query/);
});
