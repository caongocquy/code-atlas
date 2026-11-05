import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";

const workflow = readFileSync(new URL("../.github/workflows/v170-native-qualification.yml", import.meta.url), "utf8");

test("legacy parity compares the candidate with the pinned frozen target", () => {
  assert.ok(workflow.includes("CA01_FROZEN_SHA: d2570bd789095d82442ff332beb36a5ddd998194"));
  assert.ok(workflow.includes('eval/mcp/legacy-parity.ts "$GITHUB_WORKSPACE/.frozen"'));
  assert.ok(!workflow.includes('eval/mcp/legacy-parity.ts "$GITHUB_WORKSPACE/.approved-base"'));
});

test("Windows checkouts restore pinned sources with Git byte conversion disabled", () => {
  assert.match(workflow, /core\.autocrlf false/);
  assert.match(workflow, /core\.eol lf/);
  assert.match(workflow, /git -C "\$root" reset --hard HEAD/);
  assert.match(workflow, /for root in \.harness \.approved-base \.candidate \.frozen/);
});

test("focused contract output explicitly uses Node's TAP reporter", () => {
  assert.match(workflow, /node --import "\$loader_url" --test --test-reporter=tap test\/ca01-mcp-response\.test\.ts/);
});

test("pinned input digest checks remain enabled", () => {
  assert.ok(workflow.includes("CA01_CONTRACT_SHA256: d35f63583d7d7cb0ee094c6c87903d326c19162d4b746172796ca135b96b1e64"));
  assert.ok(workflow.includes("verify-ca01-v170-inputs.mjs"));
});
