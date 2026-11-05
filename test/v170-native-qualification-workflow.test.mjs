import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { URL } from "node:url";

const workflow = readFileSync(new URL("../.github/workflows/v170-native-qualification.yml", import.meta.url), "utf8");
const nativeDifferential = workflow.split("\n  native-differential:\n")[1]?.split(/\n\x20{2}[a-z0-9_-]+:\n/)[0] ?? "";
const preflight = workflow.split("\n  preflight:\n")[1]?.split(/\n\x20{2}[a-z0-9_-]+:\n/)[0] ?? "";

test("legacy parity compares the candidate with the pinned frozen target", () => {
  assert.ok(workflow.includes("CA01_FROZEN_SHA: d2570bd789095d82442ff332beb36a5ddd998194"));
  assert.ok(workflow.includes('eval/mcp/legacy-parity.ts "$GITHUB_WORKSPACE/.frozen"'));
  assert.ok(!workflow.includes('eval/mcp/legacy-parity.ts "$GITHUB_WORKSPACE/.approved-base"'));
});

test("Windows byte restoration runs in native-differential before digest verification", () => {
  const restore = nativeDifferential.indexOf("- name: Preserve exact Git blob bytes on Windows checkouts");
  assert.notEqual(restore, -1);
  assert.ok(restore > nativeDifferential.indexOf("path: .frozen"));
  assert.ok(restore < nativeDifferential.indexOf("- name: Verify workflow, revisions, runtime and dependency contract"));
  assert.ok(!preflight.includes("Preserve exact Git blob bytes on Windows checkouts"));
  assert.match(nativeDifferential, /core\.autocrlf false/);
  assert.match(nativeDifferential, /core\.eol lf/);
  assert.match(nativeDifferential, /git -C "\$root" checkout-index --force --all/);
  assert.doesNotMatch(nativeDifferential, /git -C "\$root" reset --hard HEAD/);
  assert.match(nativeDifferential, /for root in \.harness \.approved-base \.candidate \.frozen/);
});

test("forced checkout-index rematerialization restores raw Git blob bytes", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca01-checkout-bytes-"));
  const git = (...args) => execFileSync("git", args, { cwd: root, stdio: "ignore" });
  const file = path.join(root, "package.json");
  const blob = Buffer.from('{\n  "name": "digest-fixture"\n}\n');
  try {
    git("init", "--quiet");
    git("config", "user.name", "CA-01 regression");
    git("config", "user.email", "ca01@example.invalid");
    await writeFile(file, blob);
    git("add", "package.json");
    git("commit", "--quiet", "-m", "fixture");

    git("config", "core.autocrlf", "true");
    await unlink(file);
    git("checkout-index", "--force", "--all");
    assert.notDeepEqual(await readFile(file), blob);

    git("config", "core.autocrlf", "false");
    git("config", "core.eol", "lf");
    git("checkout-index", "--force", "--all");
    assert.deepEqual(await readFile(file), blob);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("focused contract output explicitly uses Node's TAP reporter", () => {
  assert.match(workflow, /node --import "\$loader_url" --test --test-reporter=tap test\/ca01-mcp-response\.test\.ts/);
});

test("pinned input digest checks remain enabled", () => {
  assert.ok(workflow.includes("CA01_CONTRACT_SHA256: d35f63583d7d7cb0ee094c6c87903d326c19162d4b746172796ca135b96b1e64"));
  assert.ok(workflow.includes("verify-ca01-v170-inputs.mjs"));
});
