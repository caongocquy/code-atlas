import assert from "node:assert/strict";
import { mkdtemp, readFile, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import { LANGUAGE_CONFIGS } from "../src/core/graph/parsers/languages.js";
import { loadCorpus, validateCorpusWorkspaceRefs } from "../eval/context/corpus/load-corpus.js";
import { parseCorpusManifest } from "../eval/context/schemas.js";
import { importSnapshot } from "../eval/context/corpus/maintain-snapshots.js";

const exec = promisify(execFile);

const root = path.resolve("eval/context");

test("committed Phase15D corpus has one reviewed synthetic case per language and class", async () => {
  const corpus = await loadCorpus({
    manifestPath: path.join(root, "corpus/manifest.json"),
    baselinePath: path.join(root, "baselines/context-eval-v1.json"),
    policyPath: path.join(root, "baselines/context-eval-policy-v1.json"),
  });

  const expected = LANGUAGE_CONFIGS.flatMap(({ language }) =>
    ["exact-target", "relationship/change", "incomplete/ambiguity"].map((syntheticClass) => `${language}:${syntheticClass}`),
  );
  const actual = corpus.manifest.cases.filter(({ kind }) => kind === "synthetic").map(({ language, syntheticClass }) => `${language}:${syntheticClass}`);
  assert.deepEqual(actual.sort(), expected.sort());
  assert.equal(new Set(corpus.manifest.cases.map(({ caseId }) => caseId)).size, corpus.manifest.cases.length);
  assert.equal(new Set(corpus.manifest.cases.map(({ workspaceRef }) => workspaceRef)).size, corpus.manifest.cases.length);
  for (const evalCase of corpus.manifest.cases) {
    assert.ok(evalCase.truth.requiredSubjects.length > 0, `${evalCase.caseId} needs reviewed required truth`);
    assert.ok(evalCase.task.trim(), `${evalCase.caseId} needs a reviewed task`);
  }
  validateCorpusWorkspaceRefs({ manifest: corpus.manifest, corpusRoot: path.join(root, "corpus") });
});

test("committed snapshots carry reviewable provenance, bounded files, and required notices", async () => {
  const corpus = await loadCorpus({
    manifestPath: path.join(root, "corpus/manifest.json"),
    baselinePath: path.join(root, "baselines/context-eval-v1.json"),
    policyPath: path.join(root, "baselines/context-eval-policy-v1.json"),
  });

  assert.ok(corpus.manifest.snapshots.length >= 4);
  for (const snapshot of corpus.manifest.snapshots) {
    assert.match(snapshot.sourceRepository, /^(https?:\/\/|git@)/);
    assert.match(snapshot.sourceCommitSha, /^[0-9a-f]{40}$/i);
    assert.ok(snapshot.license.trim());
    assert.ok(snapshot.inclusionReason.trim());
    assert.ok(snapshot.includedPaths.every((value) => value === path.posix.normalize(value) && !value.startsWith("../") && !value.includes("/../")));
    if (snapshot.licenseNoticeRequired) {
      assert.ok(snapshot.licenseNoticePath);
      await readFile(path.join(root, "corpus/snapshots", snapshot.snapshotId, snapshot.licenseNoticePath!));
    }
  }
});

test("schema permits metadata-only provenance when a license notice is not required", async () => {
  const manifest = JSON.parse(await readFile(path.join(root, "corpus/manifest.json"), "utf8")) as { corpusVersion: string; cases: unknown[]; snapshots: Array<Record<string, unknown>> };
  const snapshot: Record<string, unknown> = { ...manifest.snapshots[0], licenseNoticeRequired: false };
  delete snapshot.licenseNoticePath;
  assert.doesNotThrow(() => parseCorpusManifest({ ...manifest, cases: [], snapshots: [snapshot] }));
});

test("snapshot maintenance imports only declared local files after verifying the declared commit", async () => {
  const sourceRoot = await mkdtemp(path.join(tmpdir(), "phase15d-source-"));
  const outputRoot = await mkdtemp(path.join(tmpdir(), "phase15d-output-"));
  try {
    await exec("git", ["init", "-q", sourceRoot]);
    await exec("git", ["-C", sourceRoot, "config", "user.email", "phase15d@example.invalid"]);
    await exec("git", ["-C", sourceRoot, "config", "user.name", "Phase15D Test"]);
    await writeFile(path.join(sourceRoot, "main.js"), "export const value = 1;\n");
    await writeFile(path.join(sourceRoot, "LICENSE"), "MIT notice\n");
    await exec("git", ["-C", sourceRoot, "add", "main.js", "LICENSE"]);
    await exec("git", ["-C", sourceRoot, "commit", "-qm", "fixture"]);
    const sha = String((await exec("git", ["-C", sourceRoot, "rev-parse", "HEAD"])).stdout).trim();

    const provenance = await importSnapshot({
      sourceRoot,
      sourceRepository: "https://example.com/reviewed/source.git",
      sourceCommitSha: sha,
      license: "MIT",
      language: "javascript",
      includedPaths: ["main.js"],
      licenseNoticeRequired: true,
      licenseNoticeSourcePath: "LICENSE",
      outputRoot,
    });
    assert.equal(provenance.sourceCommitSha, sha);
    assert.equal(await readFile(path.join(outputRoot, "main.js"), "utf8"), "export const value = 1;\n");
    assert.equal(await readFile(path.join(outputRoot, "LICENSE"), "utf8"), "MIT notice\n");
    await assert.rejects(() => importSnapshot({
      sourceRoot,
      sourceRepository: "https://example.com/reviewed/source.git",
      sourceCommitSha: "0".repeat(40),
      license: "MIT",
      language: "javascript",
      includedPaths: ["main.js"],
      licenseNoticeRequired: false,
      outputRoot: path.join(outputRoot, "mismatch"),
    }), /commit/i);
  } finally {
    await (await import("node:fs/promises")).rm(sourceRoot, { recursive: true, force: true });
    await (await import("node:fs/promises")).rm(outputRoot, { recursive: true, force: true });
  }
});
