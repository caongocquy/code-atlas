import assert from "node:assert/strict";
import { PassThrough, Writable } from "node:stream";
import test from "node:test";

import {
  runIntegrationPicker,
  type IntegrationPickerRow,
} from "../src/adapters/cli/integration-picker.js";

const rows: IntegrationPickerRow[] = [
  { id: "codex", displayName: "Codex", state: "connected", selectable: true, selected: false },
  { id: "opencode", displayName: "OpenCode", state: "installed", selectable: true, selected: false },
  { id: "claude", displayName: "Claude Code", state: "not detected", selectable: false, selected: false },
];

test("integration picker requires a TTY for human selection", async () => {
  await assert.rejects(
    runIntegrationPicker({ title: "Connect CodeAtlas", rows }),
    /requires an interactive terminal/,
  );
});

test("Clack multiselect keeps selected ids ordered and excludes disabled integrations", async () => {
  const { stdin, stdout, output } = createTTY();
  const picker = runIntegrationPicker({
    title: "Connect CodeAtlas",
    rows: rows.map((row) => row.id !== "claude" ? { ...row, selected: true } : row),
    stdin,
    stdout,
  });
  setTimeout(() => stdin.write("\r"), 10);

  assert.deepEqual(await picker, { kind: "confirmed", selected: ["codex", "opencode"] });
  const rendered = output.join("");
  assert.match(rendered, /Codex[\s\S]*OpenCode[\s\S]*Claude Code[\s\S]*not detected/);
  assert.equal((rendered.match(/\u001b\[\?25l/g) ?? []).length, (rendered.match(/\u001b\[\?25h/g) ?? []).length);
  assert.doesNotMatch(rendered, /\u001b\[2J/);
});

test("arrow navigation and Space select a selectable row", async () => {
  const { stdin, stdout } = createTTY();
  const picker = runIntegrationPicker({ title: "Connect CodeAtlas", rows, stdin, stdout });
  setTimeout(() => stdin.write("\u001b[B \r"), 10);

  assert.deepEqual(await picker, { kind: "confirmed", selected: ["opencode"] });
});

test("A selects and deselects all enabled integrations", async () => {
  const { stdin, stdout } = createTTY();
  const picker = runIntegrationPicker({ title: "Connect CodeAtlas", rows, stdin, stdout });
  setTimeout(() => stdin.write("a\r"), 10);

  assert.deepEqual(await picker, { kind: "confirmed", selected: ["codex", "opencode"] });

  const next = createTTY();
  const deselect = runIntegrationPicker({ title: "Connect CodeAtlas", rows, stdin: next.stdin, stdout: next.stdout });
  setTimeout(() => next.stdin.write("aa\r"), 10);
  assert.deepEqual(await deselect, { kind: "confirmed", selected: [] });
});

test("Escape cancels without setting a failure exit code", async () => {
  const { stdin, stdout } = createTTY();
  const picker = runIntegrationPicker({ title: "Connect CodeAtlas", rows, stdin, stdout });
  setTimeout(() => stdin.write("\u001b"), 100);

  assert.deepEqual(await picker, { kind: "cancelled" });
});

test("Ctrl+C cancels with exit code 130 and Clack restores the terminal cursor", async () => {
  const { stdin, stdout, output } = createTTY();
  const picker = runIntegrationPicker({ title: "Connect CodeAtlas", rows, stdin, stdout });
  setTimeout(() => stdin.write("\u0003"), 10);

  assert.deepEqual(await picker, { kind: "cancelled", exitCode: 130 });
  assert.match(output.join(""), /\u001b\[\?25h/);
});

function createTTY() {
  const input = new PassThrough();
  Object.assign(input, { isTTY: true, setRawMode: () => input });
  const stdin = input as unknown as NodeJS.ReadStream;
  const output: string[] = [];
  const stdout = Object.assign(new Writable({
    write(chunk, _encoding, callback) {
      output.push(String(chunk));
      callback();
    },
  }), { isTTY: true, columns: 80 }) as unknown as NodeJS.WriteStream;
  return { stdin, stdout, output };
}
