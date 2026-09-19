import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");

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
  assert.equal(scripts.test, "node --import tsx/esm --test test/*.test.ts");
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
