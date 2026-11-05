import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import test from "node:test";

import { compareCommonHarness } from "../scripts/ca01-common-harness.mjs";
import { compareReports } from "../scripts/compare-ca01-tests.mjs";
import { compareReports as compareV170Reports } from "../scripts/ca01-v170-compare-ca01-tests.mjs";

const baseCommit = "7520618fa68e378e6c480e8f6e2ce9c6ed73a476";
const candidateCommit = "0e49b3e1e50887b1e0fc800d26e8551ca6a22a38";
const lockfileSha256 = "b".repeat(64);
const file = "test/phase11k-closure.test.ts";
const oldIdentity = { file, line: 1, column: 10, nesting: 0, name: "keeps the assertion" };
const newIdentity = { ...oldIdentity, column: 20 };
const baseSource = 'import test from "node:test";\ntest("keeps the assertion", () => { assert.equal(1, 1); });\n';
const candidateSource = 'import test from "node:test";\n// reviewed relocation\ntest("keeps the assertion", () => { assert.equal(1, 1); });\n';
const hash = value => createHash("sha256").update(value).digest("hex");
const registrationHash = source => hash(source.slice(source.indexOf("test("), source.lastIndexOf(");") + 1));

async function fixture(t) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "ca01-common-harness-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const baseRoot = path.join(dir, "base"), candidateRoot = path.join(dir, "candidate");
  const loaderPath = path.join(dir, "tsx-loader.mjs"), loaderBytes = "export {};\n";
  await writeFile(loaderPath, loaderBytes);
  const loaderSha256 = hash(loaderBytes), loaderUrl = pathToFileURL(await realpath(loaderPath)).href;
  for (const root of [baseRoot, candidateRoot]) await mkdir(path.join(root, "test"), { recursive: true });
  await symlink(path.join(process.cwd(), "node_modules"), path.join(candidateRoot, "node_modules"), "dir");
  await writeFile(path.join(baseRoot, file), baseSource);
  await writeFile(path.join(candidateRoot, file), candidateSource);
  const contract = {
    schemaVersion: 1,
    base: { commit: baseCommit, tree: "7faeaf7c2abb75b3b92a6f27926415221216238f" },
    candidate: { commit: candidateCommit, tree: "30abfc47c051582979505e8f5f5f186a10a61d15" },
    runtime: { nodes: ["22.23.3", "24.21.0"], targets: [
      { platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" },
      { platform: "linux", arch: "x64" }, { platform: "win32", arch: "x64" },
    ] },
    parser: { package: "@babel/core", version: "8.0.1" },
    dependencies: { pnpmVersion: "11.22.0", lockfileSha256 },
    execution: { tsxVersion: "4.23.13", loaderSha256 },
    source: {
      path: file,
      baseSha256: hash(baseSource),
      candidateSha256: hash(candidateSource),
      names: ["keeps the assertion"],
      registrationSha256: { "keeps the assertion": registrationHash(baseSource) },
    },
    requiredRelocationCount: 1,
    relocations: [{ from: { ...oldIdentity }, to: { ...newIdentity } }],
  };
  const baselineProcess = { exitCode: 0, signal: null, error: null, node: "v22.23.3", platform: "darwin", arch: "arm64", revision: baseCommit, tree: contract.base.tree, loaderUrl, loaderSha256, tsxVersion: "4.23.13", pnpmVersion: "11.22.0", pnpmExecutable: process.execPath, lockfileSha256 };
  const candidateProcess = { ...baselineProcess, revision: candidateCommit, tree: contract.candidate.tree };
  const record = identity => ({ type: "test:pass", identity, skip: false, todo: false, error: { $type: "undefined" } });
  const summary = { type: "test:diagnostic", message: "tests 1" };
  const count = (name, value) => ({ type: "test:diagnostic", message: `${name} ${value}` });
  const baseline = [record({ ...oldIdentity }), summary, count("pass", 1), count("fail", 0), count("cancelled", 0), count("skipped", 0), count("todo", 0)];
  const candidate = [record({ ...newIdentity }), summary, count("pass", 1), count("fail", 0), count("cancelled", 0), count("skipped", 0), count("todo", 0)];
  return { contract, baseRoot, candidateRoot, baselineProcess, candidateProcess, baseline, candidate };
}

test("explicit source-verified relocation is bijective and keeps raw identities in its result", async t => {
  const f = await fixture(t);
  const result = compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() });
  assert.equal(result.differentialPass, true);
  assert.deepEqual(result.relocations.map(item => [item.from, item.to]), [[{ ...oldIdentity }, { ...newIdentity }]]);
  assert.equal(result.baseline.tests, 1);
  assert.equal(result.candidate.tests, 1);
});

test("test-runner deserialization failures remain explicit strict missing identities", async t => {
  const f = await fixture(t);
  const transportIdentity = { file: "test/pre17e-bootstrap.test.ts", line: 1, column: 1, nesting: 0, name: "/checkout/.frozen/test/pre17e-bootstrap.test.ts" };
  const transportFailure = { type: "test:fail", identity: transportIdentity, skip: false, todo: false,
    error: { code: "ERR_TEST_FAILURE", message: "Unable to deserialize cloned data due to invalid or unsupported version.",
      stack: "Error [ERR_TEST_FAILURE]: Unable to deserialize cloned data due to invalid or unsupported version.\\n    at FileTest.parseMessage (node:internal/test_runner/runner:290:27)" } };
  const summaries = messages => messages.map(message => ({ type: "test:diagnostic", message }));
  f.baseline = [f.baseline[0], transportFailure,
    ...summaries(["tests 2", "pass 1", "fail 1", "cancelled 0", "skipped 0", "todo 0"])];
  f.candidate = [f.baseline[0],
    ...summaries(["tests 1", "pass 1", "fail 0", "cancelled 0", "skipped 0", "todo 0"])];
  const result = compareReports(f.baseline, f.candidate, {
    baseline: { root: f.baseRoot, tempRoot: os.tmpdir() }, candidate: { root: f.candidateRoot, tempRoot: os.tmpdir() },
  });
  assert.equal(result.differentialPass, false);
  assert.deepEqual(result.missingTests, [transportIdentity]);
  assert.match(JSON.stringify(result.missingTests), /pre17e-bootstrap/);
});

test("Windows temp-path normalization preserves changed failure codes and assertion values", () => {
  const identity = {
    file: "test/affected-tests.test.ts",
    line: 1,
    column: 5491,
    nesting: 0,
    name: "affected-tests CLI returns structured JSON without decoration",
  };
  const tempRoot = "C:\\Users\\RUNNER~1\\AppData\\Local\\Temp";
  const baselineRoot = "D:\\a\\repo\\.approved-base";
  const candidateRoot = "D:\\a\\repo\\.candidate";
  const failure = (root, suffix) => ({
    name: "Error",
    code: "ERR_TEST_FAILURE",
    message: `Command failed: ${root}\\node_modules\\tsx\\dist\\esm\\index.mjs ${tempRoot}\\code-atlas-affected-tests-${suffix}`,
    stack: `Error [ERR_TEST_FAILURE]: Command failed: ${root}\\node_modules\\tsx\\dist\\esm\\index.mjs ${tempRoot}\\code-atlas-affected-tests-${suffix}\n    at runCli (${root}\\test\\affected-tests.test.ts:1:1)`,
    actual: { status: 1, output: `${tempRoot}\\code-atlas-affected-tests-${suffix}` },
    expected: { status: 1 },
    cause: {
      name: "Error",
      code: "ERR_UNSUPPORTED_ESM_URL_SCHEME",
      message: "Only file, data, and node URLs are supported. Received protocol 'd:'",
    },
  });
  const records = error => [
    { type: "test:fail", identity, skip: false, todo: false, error },
    ...["tests 1", "pass 0", "fail 1", "cancelled 0", "skipped 0", "todo 0"]
      .map(message => ({ type: "test:diagnostic", message })),
  ];
  const compare = (baseError, candidateError) => compareV170Reports(records(baseError), records(candidateError), {
    baseline: { root: baselineRoot, tempRoot },
    candidate: { root: candidateRoot, tempRoot },
  });

  const baseline = failure(baselineRoot, "ABC123");
  const candidate = failure(candidateRoot, "ZYX987");
  const baselineBefore = structuredClone(baseline);
  const candidateBefore = structuredClone(candidate);
  const equivalent = compare(baseline, candidate);
  assert.equal(equivalent.differentialPass, true);
  assert.deepEqual(equivalent.equivalentFailures, [identity]);
  assert.deepEqual(baseline, baselineBefore);
  assert.deepEqual(candidate, candidateBefore);

  const changedCode = structuredClone(candidate);
  changedCode.cause.code = "ERR_INVALID_ARG_TYPE";
  const codeResult = compare(baseline, changedCode);
  assert.equal(codeResult.differentialPass, false);
  assert.equal(codeResult.changedFailures.length, 1);

  const changedValue = structuredClone(candidate);
  changedValue.actual.status = 2;
  const valueResult = compare(baseline, changedValue);
  assert.equal(valueResult.differentialPass, false);
  assert.equal(valueResult.changedFailures.length, 1);
});

test("v1.7.0 contract maps the exact captured closure-test identities", () => {
  const contract = JSON.parse(readFileSync("scripts/ca01-v170-common-harness.json", "utf8"));
  assert.equal(hash(readFileSync("scripts/ca01-v170-compare-ca01-tests.mjs")), contract.dependencies.strictComparatorSha256);
  assert.deepEqual(contract.relocations.map(({ from, to }) => [from, to]), [
    [
      { file, line: 1, column: 1060, nesting: 0, name: "init indexes graph and lexical capabilities by default" },
      { file, line: 1, column: 1116, nesting: 0, name: "init indexes graph and lexical capabilities by default" },
    ],
    [
      { file, line: 1, column: 1959, nesting: 0, name: "init --no-index skips graph and lexical indexing" },
      { file, line: 1, column: 2015, nesting: 0, name: "init --no-index skips graph and lexical indexing" },
    ],
    [
      { file, line: 1, column: 2809, nesting: 0, name: "init preserves bootstrap when indexing fails and exits non-zero" },
      { file, line: 1, column: 2865, nesting: 0, name: "init preserves bootstrap when indexing fails and exits non-zero" },
    ],
    [
      { file, line: 1, column: 3523, nesting: 0, name: "init --no-index preserves an existing graph and lexical index" },
      { file, line: 1, column: 3579, nesting: 0, name: "init --no-index preserves an existing graph and lexical index" },
    ],
  ]);
});

test("v1.7.0 workflow pins the eight native cells and preserves the frozen gate", () => {
  const workflowPath = ".github/workflows/v170-native-qualification.yml";
  const parserWorkflowPath = ".github/workflows/tree-sitter-installation.yml";
  const loadWorkflow = file => JSON.parse(execFileSync("ruby", ["-e",
    "require 'yaml'; require 'json'; puts JSON.generate(YAML.load_file(ARGV[0]))", file], { encoding: "utf8" }));
  const workflow = loadWorkflow(workflowPath);
  const text = readFileSync(workflowPath, "utf8");
  assert.equal(readFileSync(parserWorkflowPath, "utf8"), execFileSync("git", ["show", `HEAD:${parserWorkflowPath}`], { encoding: "utf8" }));
  const matrix = workflow.jobs["native-differential"].strategy.matrix;
  assert.deepEqual(matrix.node, ["22.23.3", "24.21.0"]);
  assert.deepEqual(matrix.target.map(({ platform, arch }) => `${platform}-${arch}`).sort(), [
    "darwin-arm64", "darwin-x64", "linux-x64", "win32-x64",
  ]);
  assert.match(text, /Preserve untouched frozen comparison as an independent strict failure report/);
  assert.match(text, /github\.ref_protected/);
  assert.match(text, /environments\/ca01-v170-native-qualification/);
  assert.match(text, /environment_reviewers_json/);
  assert.match(text, /solo-owner-qualification/);
  assert.match(text, /actions\/runs\/\$GITHUB_RUN_ID\/approvals/);
  assert.match(readFileSync("scripts/verify-ca01-v170-trust.mjs", "utf8"), /classification: "owner-approved"/);
  assert.deepEqual(JSON.parse(readFileSync("scripts/ca01-v170-common-harness.json", "utf8")).approval,
    { mode: "solo-owner-qualification", classification: "owner-approved" });
  assert.match(text, /aggregate-ca01-v170-receipts\.mjs/);
  assert.match(text, /write-ca01-v170-receipt\.mjs/);
  assert.match(text, /pattern: ca01-native-\*/);
  assert.match(text, /\.harness\/scripts\/ca01-v170-compare-ca01-tests\.mjs/);
  assert.doesNotMatch(text, /\.frozen\/scripts\/compare-ca01-tests\.mjs/);
  assert.doesNotMatch(text, /parser-payload|uses: \.\/\.github\/workflows\/tree-sitter-installation\.yml/);
  assert.ok(workflow.jobs["aggregate-native-receipts"].needs.includes("native-differential"));
  assert.ok(workflow.jobs["controller-tests"]);
  assert.ok(workflow.jobs["approval-gate"].environment);
  assert.ok(workflow.jobs["native-differential"].needs.includes("approval-gate"));
  assert.match(workflow.jobs["native-differential"].if, /workflow_dispatch/);
  assert.match(text, /pull_request:/);
  for (const [, action] of text.matchAll(/^\s*uses:\s*([^\s]+)$/gm)) {
    if (!action.startsWith("./")) assert.match(action, /@[a-f0-9]{40}$/);
  }
});

test("same name without the explicit mapping remains an exact-identity failure", async t => {
  const f = await fixture(t);
  const exact = compareReports(f.baseline, f.candidate, { baseline: { root: f.baseRoot, tempRoot: os.tmpdir() }, candidate: { root: f.candidateRoot, tempRoot: os.tmpdir() } });
  assert.equal(exact.differentialPass, false);
  assert.deepEqual(exact.missingTests, [oldIdentity]);
});

test("removed registration plus a replacement cannot preserve the relocation", async t => {
  const f = await fixture(t);
  const replacement = { ...newIdentity, name: "replacement with same suite count" };
  f.candidate[0].identity = replacement;
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /Candidate relocation target must occur exactly once/);
});

test("changed assertion or helper bytes fail the whole-source binding", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.candidateRoot, file), candidateSource.replace("assert.equal(1, 1)", "assert.ok(true)"));
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /candidate source digest mismatch/);
});

for (const [label, replacement] of [["empty body", "test(\"keeps the assertion\", () => {});"], ["weaker assertion", candidateSource.replace("assert.equal(1, 1)", "assert.ok(true)")]] as const) {
  test(`${label} fails even when the candidate file digest is updated`, async t => {
    const f = await fixture(t);
    await writeFile(path.join(f.candidateRoot, file), replacement);
    f.contract.source.candidateSha256 = hash(replacement);
    assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /candidate registration anchor mismatch/);
  });
}

test("unlisted source registration cannot masquerade as a relocated test", async t => {
  const f = await fixture(t);
  const expanded = `${candidateSource}test("new test", () => {});\n`;
  await writeFile(path.join(f.candidateRoot, file), expanded);
  f.contract.source.candidateSha256 = hash(expanded);
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /Invalid source registration contract/);
});

test("relocation names must cover the approved registration set exactly", async t => {
  const f = await fixture(t);
  f.contract.relocations[0].from.name = "unreviewed name";
  f.contract.relocations[0].to.name = "unreviewed name";
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /relocation names must bijectively match/i);
});

test("duplicate raw records for a relocated name are rejected even at another coordinate", async t => {
  const f = await fixture(t);
  const duplicate = { ...f.candidate[0], identity: { ...newIdentity, column: newIdentity.column + 1 } };
  f.candidate.splice(1, 0, duplicate);
  f.candidate.find(event => event.message === "tests 1").message = "tests 2";
  f.candidate.find(event => event.message === "pass 1").message = "pass 2";
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /relocated registration must occur exactly once/i);
});

test("incomplete identity coordinates and changed toolchain metadata fail closed", async t => {
  const f = await fixture(t);
  f.candidate[0].identity.column = null;
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /incomplete test identity/i);
  f.candidate[0].identity = { ...newIdentity };
  f.candidateProcess.loaderSha256 = "c".repeat(64);
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /unverified execution loader|execution toolchain does not match/i);
  f.candidateProcess.loaderSha256 = f.baselineProcess.loaderSha256;
  f.candidateProcess.pnpmVersion = "11.21.0";
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /execution toolchain does not match/i);
});

test("duplicate registrations and many-to-one mappings are rejected", async t => {
  const f = await fixture(t);
  await writeFile(path.join(f.candidateRoot, file), `${candidateSource}test("keeps the assertion", () => {});\n`);
  const { readFile } = await import("node:fs/promises");
  f.contract.source.candidateSha256 = hash(await readFile(path.join(f.candidateRoot, file), "utf8"));
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /Duplicate source registration/);
  await writeFile(path.join(f.candidateRoot, file), candidateSource);
  f.contract.source.candidateSha256 = hash(candidateSource);
  f.contract.requiredRelocationCount = 2;
  f.contract.relocations.push({ from: { ...oldIdentity, column: oldIdentity.column + 1 }, to: newIdentity });
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /Duplicate relocation target/);
  f.contract.relocations[1] = { from: oldIdentity, to: { ...newIdentity, column: newIdentity.column + 1 } };
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /Duplicate relocation source/);
});

test("wrong revision, unsupported runtime, skips and changed error trees fail closed", async t => {
  const f = await fixture(t);
  f.candidateProcess.revision = baseCommit;
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /candidate revision mismatch/);
  f.candidateProcess.revision = candidateCommit;
  f.candidateProcess.node = "v26.11.1";
  f.baselineProcess.node = "v26.11.1";
  assert.throws(() => compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() }), /Unsupported runtime/);
  f.candidateProcess.node = "v22.23.3";
  f.baselineProcess.node = "v22.23.3";
  f.candidate[0].skip = true;
  f.candidate.find(event => event.message === "pass 1").message = "pass 0";
  f.candidate.find(event => event.message === "skipped 0").message = "skipped 1";
  const skipped = compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() });
  assert.equal(skipped.differentialPass, false);
  assert.deepEqual(skipped.newSkips, [oldIdentity]);
  f.candidate[0].skip = false;
  f.candidate.find(event => event.message === "pass 0").message = "pass 1";
  f.candidate.find(event => event.message === "skipped 1").message = "skipped 0";
  f.baseline[0].type = "test:fail";
  f.candidate[0].type = "test:fail";
  f.baseline[0].error = { code: "ERR_ASSERTION", message: "baseline", stack: "baseline stack", actual: 1, expected: 1, cause: { operator: "strictEqual" } };
  f.candidate[0].error = { code: "ERR_ASSERTION", message: "changed", stack: "candidate stack", actual: 2, expected: 3, cause: { operator: "deepStrictEqual" } };
  f.baseline.find(event => event.message === "pass 1").message = "pass 0";
  f.candidate.find(event => event.message === "pass 1").message = "pass 0";
  f.baseline.find(event => event.message === "fail 0").message = "fail 1";
  f.candidate.find(event => event.message === "fail 0").message = "fail 1";
  f.baselineProcess.exitCode = 1;
  f.candidateProcess.exitCode = 1;
  const changed = compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() });
  assert.equal(changed.changedFailures.length, 1);
  assert.equal(changed.differentialPass, false);
});

test("relocation leaves actual, expected, operator, cause, stack and error code strict", async t => {
  const mutations = [
    ["actual", error => { error.actual = 2; }],
    ["expected", error => { error.expected = 2; }],
    ["operator", error => { error.operator = "deepStrictEqual"; }],
    ["cause", error => { error.cause.message = "changed cause"; }],
    ["stack", error => { error.stack = "changed stack"; }],
    ["error code", error => { error.code = "ERR_TEST_FAILURE"; }],
  ];
  for (const [label, mutate] of mutations) {
    await t.test(label, async child => {
      const f = await fixture(child);
      const failure = { code: "ERR_ASSERTION", message: "same error", stack: "same stack", actual: 1, expected: 1,
        operator: "strictEqual", cause: { code: "ERR_ASSERTION", message: "same cause", stack: "same cause stack" } };
      f.baseline[0].type = "test:fail";
      f.candidate[0].type = "test:fail";
      f.baseline[0].error = structuredClone(failure);
      f.candidate[0].error = structuredClone(failure);
      mutate(f.candidate[0].error);
      for (const records of [f.baseline, f.candidate]) {
        records.find(event => event.message === "pass 1").message = "pass 0";
        records.find(event => event.message === "fail 0").message = "fail 1";
      }
      f.baselineProcess.exitCode = 1;
      f.candidateProcess.exitCode = 1;
      const result = compareCommonHarness({ ...f, baselineRoot: f.baseRoot, candidateRoot: f.candidateRoot, tempRoot: os.tmpdir() });
      assert.equal(result.differentialPass, false);
      assert.equal(result.changedFailures.length, 1);
    });
  }
});
