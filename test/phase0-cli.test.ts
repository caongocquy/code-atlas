import { execFileSync } from "node:child_process";
import test from "node:test";
import assert from "node:assert/strict";

import {
  formatIncrementalSync,
  formatNotice,
  formatProgress,
  formatSummary,
  formatTaskTitle,
} from "../src/adapters/cli/cli-output.js";
import { createProgressTask } from "../src/adapters/cli/cli-progress-reporter.js";

test("CLI format contracts cover running, success, error, summaries, and progress", () => {
  assert.match(formatTaskTitle("Running"), /Running/);
  assert.match(formatNotice("Done", "1 file", "info"), /Done/);
  assert.match(formatNotice("Failed", "boom", "error"), /Failed/);
  assert.match(formatSummary("Graph indexed", [{ label: "Nodes", value: 3 }], "graph"), /Graph indexed/);
  assert.match(formatSummary("Vector indexed", [{ label: "Points", value: 0 }], "vector"), /0/);
  assert.match(formatIncrementalSync(0, 0, 0), /\+0 added.*~0 changed.*-0 deleted/);
  assert.match(formatProgress(2, 4, "graph"), /50%\s+2\/4/);
  assert.match(formatProgress(0, 0, "vector"), /0\/0/);

  const task = createProgressTask("Index", () => undefined, "graph");
  assert.match(task.title, /Index/);
  assert.equal(typeof task.task, "function");
});

test("CLI format helpers emit no ANSI escape sequences with NO_COLOR", () => {
  const output = execFileSync(
    process.execPath,
    [
      "--import",
      "tsx/esm",
      "--input-type=module",
      "-e",
      'import { formatNotice, formatProgress } from "./src/adapters/cli/cli-output.ts"; console.log(formatNotice("Failed", "boom", "error")); console.log(formatProgress(1, 2, "graph"));',
    ],
    {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
      encoding: "utf8",
    },
  );

  assert.doesNotMatch(output, /\u001b\[/);
});
