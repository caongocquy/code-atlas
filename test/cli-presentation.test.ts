import assert from "node:assert/strict";
import test from "node:test";

import { createCliCommandReporter } from "../src/adapters/cli/cli-command-reporter.js";
import {
  getTerminalCapabilities,
  renderBrandHeader,
  renderHeader,
  renderKeyValueRows,
  renderNextActions,
  renderResultBox,
  renderSection,
  renderStatusLine,
  type TerminalCapabilities,
} from "../src/adapters/cli/cli-presentation.js";

const tty: TerminalCapabilities = { isTTY: true, color: true, interactive: true };
const plain: TerminalCapabilities = { isTTY: false, color: false, interactive: false };

test("terminal capabilities distinguish TTY, CI, and NO_COLOR presence", () => {
  const stream = { isTTY: true } as NodeJS.WriteStream;
  assert.deepEqual(getTerminalCapabilities(stream, {}), tty);
  assert.deepEqual(getTerminalCapabilities(stream, { NO_COLOR: "" }), { isTTY: true, color: false, interactive: true });
  assert.deepEqual(getTerminalCapabilities(stream, { CI: "true" }), { isTTY: true, color: false, interactive: false });
  assert.deepEqual(getTerminalCapabilities({ isTTY: false } as NodeJS.WriteStream, {}), plain);
});

test("presentation primitives render hierarchy, alignment, and next actions", () => {
  const header = renderHeader("CODEATLAS", "Local-first change intelligence", tty);
  assert.match(header, /CODEATLAS/);
  assert.match(header, /Local-first change intelligence/);
  assert.match(renderSection("Repository", ["Files  3"], plain), /Repository\nFiles\s{2}3/);
  const rows = renderKeyValueRows([{ label: "Graph", value: "ready" }, { label: "Indexed files", value: 3 }], plain);
  assert.match(rows, /Graph\s+ready/);
  assert.match(rows, /Indexed files\s+3/);
  assert.match(renderStatusLine("Graph", "ready", "3 symbols", plain), /Graph\s+.*ready.*3 symbols/);
  assert.match(renderNextActions(["code-atlas status"], plain), /Next\n {2}code-atlas status/);
});

test("TTY result boxes color while plain output retains stable information", () => {
  const colored = renderResultBox("CodeAtlas initialized", ["Indexed files  3"], "success", tty);
  assert.match(colored, /\u001b\[/);
  assert.match(colored, /CodeAtlas initialized/);
  for (const tone of ["success", "warning", "error"] as const) {
    const output = renderResultBox("Result", [tone], tone, plain);
    assert.doesNotMatch(output, /\u001b\[/);
    assert.match(output, new RegExp(tone));
  }
});

test("result boxes stay within narrow terminal widths", () => {
  const narrow: TerminalCapabilities = { isTTY: true, color: false, interactive: true, columns: 40 };
  const output = renderResultBox("Result", ["/a/very/long/repository/path/that/needs/truncation"], "success", narrow);
  for (const line of output.split("\n")) assert.ok(line.length <= 40, line);
});

test("human command reporters render one shared brand header", () => {
  const writes: string[] = [];
  const originalWrite = process.stdout.write;
  process.stdout.write = ((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  }) as typeof process.stdout.write;
  try {
    createCliCommandReporter({ command: "status" });
    createCliCommandReporter({ command: "status", json: true });
    createCliCommandReporter({ command: "status", quiet: true });
  } finally {
    process.stdout.write = originalWrite;
  }
  assert.equal(writes.join(""), "");
});

test("brand header is responsive and stays within terminal width", () => {
  const wide = renderBrandHeader("Local-first change intelligence for coding agents", { ...tty, columns: 100 });
  assert.match(wide, /▀|█/);
  assert.match(wide, /Local-first change intelligence for coding agents/);

  const medium = renderBrandHeader("Local-first change intelligence for coding agents", { ...tty, color: false, columns: 80 });
  assert.equal(medium, "CODEATLAS\nLocal-first change intelligence for coding agents");

  const narrow = renderBrandHeader("Local-first change intelligence for coding agents", { ...tty, color: false, columns: 50 });
  assert.equal(narrow, "CODEATLAS");

  for (const output of [wide, medium, narrow]) {
    for (const line of output.split("\n")) assert.ok(line.length <= 100, line);
  }
});

test("brand header skips decorative output outside interactive TTY", () => {
  assert.equal(renderBrandHeader("Subtitle", plain), "");
  assert.equal(renderBrandHeader("Subtitle", { ...tty, interactive: false, columns: 120 }), "");
});
