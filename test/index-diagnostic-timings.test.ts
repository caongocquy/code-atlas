import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { indexRepository } from "../src/core/indexing/index-pipeline.service.js";

test("index phase timings are opt-in and report the bounded pipeline phases", async () => {
  const repoPath = await mkdtemp(path.join(tmpdir(), "code-atlas-phase-timings-"));

  try {
    await writeFile(path.join(repoPath, "source.ts"), "export function source() { return true; }\n");

    const ordinary = await indexRepository(repoPath, { skipGit: true });
    assert.equal(ordinary.kind, "published");
    assert.equal("phaseTimingsMs" in ordinary, false);

    await rm(path.join(repoPath, ".codeatlas"), { recursive: true, force: true });
    const measured = await indexRepository(repoPath, { skipGit: true, diagnosticTimings: true });
    assert.equal(measured.kind, "published");
    if (measured.kind !== "published") return;

    assert.deepEqual(Object.keys(measured.phaseTimingsMs ?? {}).sort(), [
      "frameworkDetection",
      "frameworkMaterialization",
      "frameworkPersistence",
      "generationPublish",
      "metadataFileStates",
      "transactionCommit",
      "graphAssembly",
      "graphPersistence",
      "hash",
      "lexicalBuild",
      "lexicalPersistence",
      "parseFacts",
      "publishFinalize",
      "resolutionPreparation",
      "resolveIndexedUnits",
      "scan",
      "total",
      "unattributed",
    ].sort());
    for (const elapsedMs of Object.values(measured.phaseTimingsMs ?? {})) {
      assert.equal(Number.isFinite(elapsedMs) && elapsedMs >= 0, true);
    }
  } finally {
    await rm(repoPath, { recursive: true, force: true });
  }
});
