import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runB4bEval } from "../eval/retrieval/b4b.js";

test("B4B report contains only frozen extension cases and production lexical tie evidence", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-b4b-test-"));
  try {
    const { report, jsonPath, markdownPath } = await runB4bEval({ repoRoot: process.cwd(), outputDirectory });
    assert.equal(report.caseCount, 8);
    assert.equal(report.fixtureFamilies.length, 4);
    assert.equal(report.deterministic, true);
    assert.deepEqual(Object.keys(report.aggregates).sort(), ["graphOnly", "hybrid", "hybridGraphExpansion", "lexical", "semantic"]);
    assert.ok(report.cases.every((item) => item.id.startsWith("b4b-") && item.semanticLimitation === "no frozen semantic candidates in extension"));
    assert.ok(report.cases.every((item) => item.stages.semantic.candidates.length === 0));
    assert.ok(report.cases.every((item) => item.lexicalEvidence.every((candidate) => candidate.rank >= candidate.effectiveRank)));
    assert.equal(report.taskContextSummary.totalRelevant, 8);
    assert.equal(report.taskContextSummary.admittedRelevant, report.cases.reduce((sum, item) => sum + item.taskContextAdmission.admittedRelevant, 0));
    assert.match(await readFile(markdownPath, "utf8"), /B4B-only stage metrics/);
    const digest = createHash("sha256").update(await readFile(jsonPath)).digest("hex");
    assert.equal(digest, createHash("sha256").update(`${JSON.stringify(report, null, 2)}\n`).digest("hex"));
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
  }
});
