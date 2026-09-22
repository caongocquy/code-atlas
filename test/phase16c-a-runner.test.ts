import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runRetrievalEval } from "../eval/retrieval/run.js";
import { promoteReviewedBaseline } from "../eval/retrieval/promote-baseline.js";

const repoRoot = process.cwd();

test("retrieval evaluation is deterministic and measures all required stages and profiles", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-retrieval-eval-"));
  const repeatedOutputDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-retrieval-eval-repeat-"));
  try {
    const result = await runRetrievalEval({ repoRoot, outputDirectory });
    const repeated = await runRetrievalEval({ repoRoot, outputDirectory: repeatedOutputDirectory });
    const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
    assert.equal(digest(repeated.report.cases), digest(result.report.cases), "fresh temporary fixture roots should produce identical measured cases");
    assert.equal(result.report.determinism.passed, true);
    assert.equal(result.report.cases.length, 40);
    assert.ok(result.report.cases.every((item) => item.graphLookup && item.stages.lexical && item.taskContext.subjects));
    assert.ok(result.report.cases.every((item) => item.profiles.enabled && item.profiles.disabled && item.profiles.unavailable));
    const dispatchCaller = result.report.cases.find((item) => item.id === "dispatch-caller")!;
    const anonymousFunctions = [...new Set(dispatchCaller.profiles.enabled.lexical.candidates.flatMap((candidate) => candidate.identity.kind === "symbol" && candidate.identity.name.startsWith("arrow_function@") ? [candidate.identity.name] : []))].sort();
    assert.deepEqual(anonymousFunctions, ["arrow_function@154", "arrow_function@180"]);
    const tiedSemanticCandidates = result.report.cases.find((item) => item.id === "dispatch-semantic-paraphrase")!.profiles.enabled.vector.candidates;
    assert.deepEqual(tiedSemanticCandidates.slice(1).map((candidate) => candidate.identity.kind === "symbol" ? candidate.identity.name : candidate.identity.path), ["routeSearch", "searchStore"]);
    assert.equal(result.report.semanticFallbacks.deterministic, true);
    assert.ok(result.report.scipPairs.length >= 3);
    assert.ok(result.report.aggregates.bySplit.development);
    assert.ok(result.report.aggregates.bySplit["held-out"]);
    assert.ok(result.report.cases.every((item) => item.taskContext.admittedRelevantItems >= 0 && item.taskContext.admittedSupportingItems >= 0));
    assert.ok(result.report.cases.some((item) => item.ambiguity?.expectation === "no-promotion"));
    assert.ok(result.report.semanticStyles["direct-synonym"]);
    assert.ok(result.report.semanticStyles["weak-lexical-overlap"]);
    assert.ok(result.report.semanticStyles.mixed);
    assert.ok(result.report.semanticStyles["no-added-value"]);
    assert.deepEqual(result.report.scipPairs[0]?.conditions.map((condition) => condition.id), ["parser-only", "scip-enriched"]);
    assert.ok(result.report.sourceContribution.byStage.hybridGraphExpansion?.graph > 0);
    assert.ok(result.report.cases.every((item) => typeof item.taskContext.budgetEfficiency === "number" && typeof item.taskContext.coverage.relevant === "number" && typeof item.taskContext.coverage.supporting === "number"));
    assert.ok(result.report.cases.every((item) => Number.isInteger(item.taskContext.missedRelevantItems) && Number.isInteger(item.taskContext.missedSupportingItems)));
    assert.deepEqual(result.report.cases.filter((item) => item.ambiguity).map((item) => [item.id, item.ambiguity?.outcome]), [
      ["catalog-ambiguous-load", "no-promotion-observed"],
      ["catalog-context-disambiguation", "incorrect-promotion"],
      ["pricing-ambiguous", "false-promotion"],
      ["pricing-path-disambiguation", "incorrect-promotion"],
      ["workflow-ambiguous-run-task", "incorrect-promotion"],
    ]);
    assert.ok(result.report.judgmentQueue.items.every((item) => item.caseId && item.candidate && item.priority));
    assert.ok(result.report.judgmentQueue.items.every((item) => item.priority !== "top5" || item.sources.some((source) => ["hybrid", "semantic-vector", "semantic-lexical"].includes(source.source) && source.rank <= 5)));
    assert.ok(result.report.judgmentQueue.remainingTop5 >= 0 && result.report.judgmentQueue.remainingTop10 >= result.report.judgmentQueue.remainingTop5);
    const machineReport = await readFile(result.jsonPath, "utf8");
    assert.match(machineReport, /retrieval-eval-v2/);
    assert.match(machineReport, /"rrfK": 60/);
    assert.match(await readFile(result.markdownPath, "utf8"), /RRF k 60/);
    assert.match(await readFile(result.markdownPath, "utf8"), /Judged coverage @5/);
    assert.match(await readFile(result.markdownPath, "utf8"), /Development vs held-out/);
    assert.match(await readFile(result.markdownPath, "utf8"), /TaskContext admitted relevant/);
    assert.match(await readFile(result.markdownPath, "utf8"), /TaskContext missed relevant items/);
    assert.match(await readFile(result.markdownPath, "utf8"), /Unjudged @5/);
    assert.match(await readFile(result.markdownPath, "utf8"), /Unresolved judgment queue/);
    assert.match(await readFile(result.markdownPath, "utf8"), /catalog-context-disambiguation/);
    assert.match(await readFile(result.markdownPath, "utf8"), /Determinism: PASS/);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await rm(repeatedOutputDirectory, { recursive: true, force: true });
  }
});

test("reviewed baseline promotion requires explicit confirmation and refuses overwrite", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-retrieval-baseline-"));
  try {
    const candidateJsonPath = path.join(directory, "candidate.json");
    const candidateMarkdownPath = path.join(directory, "candidate.md");
    const baselineJsonPath = path.join(directory, "baseline.json");
    const baselineMarkdownPath = path.join(directory, "baseline.md");
    const { writeFile } = await import("node:fs/promises");
    await writeFile(candidateJsonPath, JSON.stringify({ schemaVersion: 1, datasetVersion: "retrieval-eval-v1" }));
    await writeFile(candidateMarkdownPath, "# Candidate\n");
    await assert.rejects(promoteReviewedBaseline({ candidateJsonPath, candidateMarkdownPath, baselineJsonPath, baselineMarkdownPath }), /explicit review confirmation/);
    await promoteReviewedBaseline({ candidateJsonPath, candidateMarkdownPath, baselineJsonPath, baselineMarkdownPath, confirmReviewed: true });
    assert.equal(await readFile(baselineMarkdownPath, "utf8"), "# Candidate\n");
    await assert.rejects(promoteReviewedBaseline({ candidateJsonPath, candidateMarkdownPath, baselineJsonPath, baselineMarkdownPath, confirmReviewed: true }), /already exists/);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
