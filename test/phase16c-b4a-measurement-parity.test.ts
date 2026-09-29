import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { runRetrievalEval } from "../eval/retrieval/run.js";

const repoRoot = process.cwd();

test("B4A keeps parser-only retrieval stable and aligns TaskContext and SCIP evidence paths", async () => {
  const outputDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-b4a-"));
  const repeatedOutputDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-b4a-repeat-"));
  try {
    const { report, markdownPath } = await runRetrievalEval({ repoRoot, outputDirectory });
    const repeated = await runRetrievalEval({ repoRoot, outputDirectory: repeatedOutputDirectory });
    assert.deepEqual(repeated.report.scipEnrichedCases, report.scipEnrichedCases);
    assert.deepEqual(repeated.report.cases.map((item) => item.taskContext), report.cases.map((item) => item.taskContext));
    assert.match(await readFile(markdownPath, "utf8"), /SCIP-enriched end-to-end retrieval/);
    const parityPayload = report.cases.map((item) => ({
      id: item.id,
      profiles: Object.fromEntries(Object.entries(item.profiles).map(([name, profile]) => [name, {
        semanticState: profile.semanticState,
        vector: profile.vector,
        lexical: profile.lexical,
        hybrid: profile.hybrid,
        hybridGraphExpansion: profile.hybridGraphExpansion,
        graphExpansion: profile.graphExpansion,
      }])),
    }));
    assert.equal(createHash("sha256").update(JSON.stringify(parityPayload)).digest("hex"), "0f1cc2dfb47f1c2f887843440cf50ea415c07abee2e402fc23b42e6e04a82979");

    const synonym = report.cases.find((item) => item.id === "catalog-semantic-synonym")!;
    assert.equal(synonym.taskContext.semanticProfile, "enabled");
    assert.ok(synonym.taskContext.budget.selectedItems > 0);
    assert.equal(synonym.taskContext.admittedRelevantItems, 1);
    assert.equal(synonym.taskContext.admittedSupportingItems, 1);
    assert.equal(synonym.taskContext.reliability.capabilityStates.semantic, "ready");

    const disabled = report.cases.find((item) => item.profile === "disabled")!;
    const unavailable = report.cases.find((item) => item.profile === "unavailable")!;
    assert.equal(disabled.taskContext.semanticProfile, "disabled");
    assert.equal(disabled.taskContext.reliability.capabilityStates.semantic, "disabled");
    assert.equal(unavailable.taskContext.semanticProfile, "unavailable");
    assert.equal(unavailable.taskContext.reliability.capabilityStates.semantic, "unavailable");

    assert.equal(report.scipEnrichedCases.length, 5);
    assert.ok(report.scipEnrichedCases.every((item) => item.scipEvidenceCount >= 0));
    assert.ok(report.scipEnrichedCases.some((item) => item.scipEvidenceCount > 0));
    assert.ok(report.scipEnrichedCases.every((item) => item.graphDelta.acceptedScipEdges.length === item.scipEvidenceCount));
    assert.equal(report.scipEnrichedCases.find((item) => item.caseId === "registry-scip-cross-file")?.scipEvidenceCount, 0);
    assert.equal(createHash("sha256").update(JSON.stringify(report.scipPairs)).digest("hex"), "674db4966b5f0b33055df2d3c63573ba44a39f81ca3dc2368d014553faf61818");

    const immutablePaths = ["eval/retrieval/dataset.json", "artifacts/retrieval-eval-baseline.json", "artifacts/retrieval-eval-baseline.md"];
    const immutableHashes = await Promise.all(immutablePaths.map(async (file) => createHash("sha256").update(await readFile(path.join(repoRoot, file))).digest("hex")));
    assert.deepEqual(immutableHashes, [
      "73b671896b5dd6f06b6ec97eae479dd87d7269f82e5c8e2fb73413c255fc4fc1",
      "7a600e63ab9d1197f62f7e0f9f6c7f4ad6dda73f82d9939a5e93010c7050fc55",
      "bbe48d8f02a7095ffb0ed98e2c4845a6f8d7d2762947eee9e60d21f15a8253f1",
    ]);
  } finally {
    await rm(outputDirectory, { recursive: true, force: true });
    await rm(repeatedOutputDirectory, { recursive: true, force: true });
  }
});
