import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { Buffer } from "node:buffer";
import { readFileSync, realpathSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import process from "node:process";
import { URL } from "node:url";
import { restoreCa01ExactBlobs } from "../scripts/restore-ca01-exact-blobs.mjs";
import { readPinnedPnpmVersion } from "../scripts/ca01-pnpm.mjs";

const workflow = readFileSync(new URL("../.github/workflows/v170-native-qualification.yml", import.meta.url), "utf8").replaceAll("\r\n", "\n");
const nativeDifferential = workflow.split("\n  native-differential:\n")[1]?.split(/\n\x20{2}[a-z0-9_-]+:\n/)[0] ?? "";
const preflight = workflow.split("\n  preflight:\n")[1]?.split(/\n\x20{2}[a-z0-9_-]+:\n/)[0] ?? "";

test("legacy parity compares the candidate with the pinned frozen target", () => {
  assert.ok(workflow.includes("CA01_FROZEN_SHA: d2570bd789095d82442ff332beb36a5ddd998194"));
  assert.ok(workflow.includes('eval/mcp/legacy-parity.ts "$GITHUB_WORKSPACE/.frozen"'));
  assert.ok(!workflow.includes('eval/mcp/legacy-parity.ts "$GITHUB_WORKSPACE/.approved-base"'));
});

test("Windows byte restoration runs in native-differential before digest verification", () => {
  const restore = nativeDifferential.indexOf("- name: Restore exact Git blob bytes and preserve checkout evidence");
  assert.notEqual(restore, -1);
  assert.ok(restore > nativeDifferential.indexOf("path: .frozen"));
  assert.ok(restore < nativeDifferential.indexOf("- name: Verify workflow, revisions, runtime and dependency contract"));
  assert.ok(!preflight.includes("Restore exact Git blob bytes"));
  assert.match(nativeDifferential, /restore-ca01-exact-blobs\.mjs/);
  assert.match(nativeDifferential, /checkout-materialization\.json/);
  assert.match(nativeDifferential, /\.harness \.approved-base \.candidate \.frozen/);
});

test("raw Git blob restoration repairs forced checkout-index line-ending conversion", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca01-checkout-bytes-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const file = path.join(root, "package.json");
  const blob = Buffer.from('{"name":"digest-fixture"}\n');
  try {
    git("init", "--quiet");
    git("config", "user.name", "CA-01 regression");
    git("config", "user.email", "ca01@example.invalid");
    await writeFile(path.join(root, ".gitattributes"), "package.json text eol=crlf\n");
    await writeFile(file, blob);
    git("add", ".gitattributes", "package.json");
    git("commit", "--quiet", "-m", "fixture");
    git("config", "core.autocrlf", "true");
    git("config", "core.eol", "crlf");
    await unlink(file);
    git("checkout-index", "--force", "--all");
    assert.notDeepEqual(await readFile(file), blob);
    assert.match((await readFile(file)).toString("utf8"), /\r\n/);
    const report = path.join(root, "checkout-materialization.json");
    const result = restoreCa01ExactBlobs([root], report);
    assert.deepEqual(await readFile(file), blob);
    assert.match(result.files[0].attributes, /eol: crlf/);
    assert.equal(result.files[0].afterRawBlobRestore.gitBlob, result.files[0].expectedGitBlob);
    assert.equal(JSON.parse(await readFile(report, "utf8")).files[0].expectedGitBlob, result.files[0].expectedGitBlob);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("pnpm runner uses the resolved executable and enforces the package manifest version", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca01 pinned pnpm "));
  const executable = path.join(root, process.platform === "win32" ? "pnpm.cmd" : "pnpm");
  const env = { ...process.env, PATH: root + path.delimiter + (process.env.PATH ?? "") };
  const script = version => process.platform === "win32"
    ? "@echo off\r\necho " + version + "\r\n"
    : "#!/bin/sh\nprintf '%s\\n' '" + version + "'\n";
  try {
    await writeFile(executable, script("11.22.0"));
    if (process.platform !== "win32") await import("node:fs/promises").then(({ chmod }) => chmod(executable, 0o755));
    const result = readPinnedPnpmVersion("pnpm@11.22.0", env);
    assert.equal(result.version, "11.22.0");
    const expectedExecutable = process.platform === "win32"
      ? execFileSync("where.exe", ["pnpm.cmd"], { encoding: "utf8", env }).split(/\r?\n/).map(value => value.trim()).find(Boolean)
      : realpathSync(executable);
    assert.equal(result.executable, expectedExecutable);
    await writeFile(executable, script("11.21.0"));
    assert.throws(() => readPinnedPnpmVersion("pnpm@11.22.0", env), /pnpm version mismatch/);
    assert.throws(() => readPinnedPnpmVersion("pnpm@latest", env), /exact packageManager version/);
    await writeFile(executable, process.platform === "win32" ? "@echo off\r\nexit /b 7\r\n" : "#!/bin/sh\nexit 7\n");
    if (process.platform !== "win32") await import("node:fs/promises").then(({ chmod }) => chmod(executable, 0o755));
    assert.throws(() => readPinnedPnpmVersion("pnpm@11.22.0", env), /failed with status 7/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("frozen strict failure requires the reviewed controller comparator and real evidence", () => {
  assert.match(nativeDifferential, /\.harness\/scripts\/ca01-v170-compare-ca01-tests\.mjs/);
  assert.doesNotMatch(nativeDifferential, /\.frozen\/scripts\/compare-ca01-tests\.mjs/);
  assert.match(nativeDifferential, /test -s "\$RUNNER_TEMP\/ca01-evidence\/frozen-strict-comparison\.json"/);
  assert.match(nativeDifferential, /test "\$status" -eq 1/);
  assert.match(nativeDifferential, /MODULE_NOT_FOUND/);
  assert.match(nativeDifferential, /p\.addedFailures\.length\|\|p\.changedFailures\.length/);
  const verifier = readFileSync(new URL("../scripts/verify-ca01-v170-inputs.mjs", import.meta.url), "utf8");
  assert.match(verifier, /ca01-v170-compare-ca01-tests\.mjs/);
  const contract = JSON.parse(readFileSync(new URL("../scripts/ca01-v170-common-harness.json", import.meta.url), "utf8"));
  const digest = createHash("sha256").update(readFileSync(new URL("../scripts/ca01-v170-compare-ca01-tests.mjs", import.meta.url))).digest("hex");
  assert.equal(digest, contract.dependencies.strictComparatorSha256);
  const suiteRunner = readFileSync(new URL("../scripts/run-ca01-qualified-suite.mjs", import.meta.url), "utf8");
  assert.match(suiteRunner, /--test-concurrency=1/);
  assert.match(nativeDifferential, /const expected=\[1060,1959,2809,3523\]/);
  assert.match(nativeDifferential, /JSON.stringify\(p.missingTests\)!==JSON.stringify\(expected\)/);
});

test("common and frozen comparators receive Node's actual OS temp root", () => {
  const commonStep = nativeDifferential.split("- name: Compare approved base with the explicit four source-verified relocations")[1]
    ?.split("- name: Preserve untouched frozen comparison")[0] ?? "";
  const frozenStep = nativeDifferential.split("- name: Preserve untouched frozen comparison")[1]
    ?.split("- name: Write hash-bound native cell receipt")[0] ?? "";
  assert.match(commonStep, /os_temp_root=.*node -p 'require\("node:os"\)\.tmpdir\(\)'/);
  assert.match(commonStep, /"\$GITHUB_WORKSPACE\/\.approved-base"\s+"\$GITHUB_WORKSPACE\/\.candidate"\s+"\$os_temp_root"\s+"\$CA01_CONTRACT_SHA256"/);
  assert.doesNotMatch(commonStep, /"\$GITHUB_WORKSPACE\/\.candidate"\s+"\$RUNNER_TEMP"/);
  assert.match(frozenStep, /os_temp_root=.*node -p 'require\("node:os"\)\.tmpdir\(\)'/);
  assert.match(frozenStep, /"\$GITHUB_WORKSPACE\/\.frozen"\s+"\$GITHUB_WORKSPACE\/\.candidate"\s+"\$os_temp_root"/);
  assert.doesNotMatch(frozenStep, /"\$GITHUB_WORKSPACE\/\.candidate"\s+"\$RUNNER_TEMP"/);
});

test("focused contract output explicitly uses Node's TAP reporter", () => {
  assert.match(workflow, /node --import "\$loader_url" --test --test-reporter=tap test\/ca01-mcp-response\.test\.ts/);
});

test("controller matrix runs the native path incremental regression", () => {
  assert.match(workflow, /node --import "\$loader" --test test\/ca01-common-harness\.test\.ts test\/phase0-incremental\.test\.ts/);
});

test("pinned input digest checks remain enabled", () => {
  assert.ok(workflow.includes("CA01_CONTRACT_SHA256: d35f63583d7d7cb0ee094c6c87903d326c19162d4b746172796ca135b96b1e64"));
  assert.ok(workflow.includes("verify-ca01-v170-inputs.mjs"));
});
