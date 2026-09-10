import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { compareFailureNames } from "./helpers/phase14c-verification.js";

test("compares exact failure names", () => {
  assert.deepEqual(compareFailureNames(["inherited", "new"], ["inherited"]), { newFailures: ["new"], resolvedFailures: [] });
});

test("packed CLI help smoke", { skip: !process.env.PACKED_CLI_PATH }, () => {
  const cli = process.env.PACKED_CLI_PATH;
  assert.ok(cli);
  const result = spawnSync(process.execPath, [cli, "--help"], { encoding: "utf8", env: { ...process.env, CI: "true", NO_COLOR: "1" } });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /code-atlas/i);
  assert.doesNotMatch(`${result.stdout}${result.stderr}`, /\u001b\[[0-9;]*[A-Za-z]/);
});
