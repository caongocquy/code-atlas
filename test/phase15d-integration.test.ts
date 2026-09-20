import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

const root = path.resolve(import.meta.dirname, "..");
const execFileAsync = promisify(execFile);
const tsxLoader = process.env.CODE_ATLAS_TSX_LOADER ?? "tsx/esm";

async function readJson(relativePath: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(path.join(root, relativePath), "utf8")) as Record<string, unknown>;
}

test("defines internal evaluator scripts without replacing existing package scripts", async () => {
  const packageJson = await readJson("package.json");
  const scripts = packageJson.scripts as Record<string, string>;

  assert.equal(typeof scripts["eval:context"], "string");
  assert.equal(typeof scripts["eval:context:update-baseline"], "string");
  assert.match(scripts["eval:context"], /runContextEval/);
  assert.match(scripts["eval:context:update-baseline"], /updateContextBaseline/);
  assert.match(scripts["eval:context:update-baseline"], /-e .* --/);
  assert.equal(scripts.test, "node --import tsx/esm --test test/*.test.ts");
});

test("keeps immutable snapshot sources outside the application lint boundary", async () => {
  const eslintConfig = await readFile(path.join(root, "eslint.config.js"), "utf8");
  assert.match(eslintConfig, /eval\/context\/corpus\/snapshots\/\*\*/);
});

test("ignores only transient Phase15D evaluation artifacts", async () => {
  const gitignore = await readFile(path.join(root, ".gitignore"), "utf8");

  assert.match(gitignore, /^artifacts\/context-eval-report\.json$/m);
  assert.match(gitignore, /^artifacts\/phase15d-preflight-baseline\.json$/m);
});

test("has an offline CI gate that preserves both baseline and policy data", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/context-eval.yml"), "utf8");

  assert.match(workflow, /ubuntu-latest/);
  assert.match(workflow, /pnpm install --frozen-lockfile/);
  assert.match(workflow, /CODE_ATLAS_EVAL_OFFLINE:\s*["']?1/);
  assert.match(workflow, /pnpm run eval:context/);
  assert.match(workflow, /eval\/context\/baselines/);
  assert.match(workflow, /context-eval-report\.json/);
  assert.match(workflow, /actions\/upload-artifact@v4/);
  assert.doesNotMatch(workflow, /continue-on-error\s*:\s*true/);
});

test("protects every tracked corpus truth path in both worktree and staged diffs", async () => {
  const workflow = await readFile(path.join(root, ".github/workflows/context-eval.yml"), "utf8");

  for (const protectedPath of [
    "eval/context/corpus/manifest.json",
    "eval/context/corpus/synthetic",
    "eval/context/corpus/snapshots",
    "eval/context/baselines/context-eval-v1.json",
    "eval/context/baselines/context-eval-policy-v1.json",
  ]) {
    assert.match(workflow, new RegExp(protectedPath));
  }

  assert.match(workflow, /protected_paths=\(/);
  assert.match(workflow, /git diff --exit-code -- "\$\{protected_paths\[@\]\}"/);
  assert.match(workflow, /git diff --cached --exit-code -- "\$\{protected_paths\[@\]\}"/);
});

test("propagates a failing evaluator process through a fail-fast CI-style shell step", async () => {
  const tempRoot = await mkdtemp(path.join(os.tmpdir(), "phase15d-ci-failure-"));
  const marker = path.join(tempRoot, "after-evaluator");
  const reportPath = path.join(tempRoot, "artifacts/context-eval-report.json");
  const scriptPath = path.join(tempRoot, "ci-step.sh");
  const evaluatorPath = path.join(tempRoot, "failing-evaluator.mjs");
  const evaluator = `
    import { runContextEval } from ${JSON.stringify(path.join(root, "eval/context/run.ts"))};
    const result = await runContextEval({ cwd: ${JSON.stringify(tempRoot)}, reportPath: ${JSON.stringify(reportPath)} });
    process.exitCode = result.exitCode;
  `;

  try {
    await mkdir(path.dirname(reportPath), { recursive: true });
    await writeFile(evaluatorPath, evaluator);
    await writeFile(scriptPath, `#!/usr/bin/env bash
set -euo pipefail
node --import ${JSON.stringify(tsxLoader)} ${JSON.stringify(evaluatorPath)}
touch ${JSON.stringify(marker)}
`);

    let childError: { code?: number; stdout?: string; stderr?: string } | undefined;
    try {
      await execFileAsync("bash", [scriptPath], { cwd: root });
    } catch (error) {
      childError = error as { code?: number; stdout?: string; stderr?: string };
    }
    assert.equal(childError?.code, 1, childError?.stderr);
    await assert.rejects(() => readFile(marker));
    let report: string;
    try {
      report = await readFile(reportPath, "utf8");
    } catch (error) {
      assert.fail(`${childError?.stdout ?? ""}${childError?.stderr ?? ""}\n${error}`);
    }
    const machineReport = JSON.parse(report!) as { gateDecisions?: { corpusIntegrity?: boolean } };
    assert.equal(machineReport.gateDecisions?.corpusIntegrity, false);
  } finally {
    await rm(tempRoot, { recursive: true, force: true });
  }
});

test("keeps runtime evaluation free of corpus clone or fetch subprocesses", async () => {
  const runtimeFiles = [
    "eval/context/run.ts",
    "eval/context/corpus/load-corpus.ts",
    "eval/context/corpus/materialize-workspace.ts",
  ];
  const contents = await Promise.all(runtimeFiles.map((file) => readFile(path.join(root, file), "utf8")));
  const runtimeSource = contents.join("\n");

  assert.doesNotMatch(runtimeSource, /git[^\n]*(?:clone|fetch|pull|remote)/i);
  assert.doesNotMatch(runtimeSource, /(?:spawn|exec|execFile)\s*\([^\n]*\b(?:clone|fetch|pull|remote)\b/i);
});
