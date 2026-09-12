import assert from "node:assert/strict";
import test from "node:test";

import {
  applyPickerKey,
  createPickerState,
  renderPicker,
  runIntegrationPicker,
  type IntegrationPickerRow,
} from "../src/adapters/cli/integration-picker.js";

const rows: IntegrationPickerRow[] = [
  { id: "codex", displayName: "Codex", state: "connected", selectable: true, selected: false },
  { id: "opencode", displayName: "OpenCode", state: "installed", selectable: true, selected: false },
  { id: "claude", displayName: "Claude Code", state: "not detected", selectable: false, selected: false },
];

test("picker starts at the first selectable row and preserves row order", () => {
  const state = createPickerState(rows);
  assert.equal(state.cursor, 0);
  assert.deepEqual(state.rows.map((row) => row.id), ["codex", "opencode", "claude"]);
});

test("picker moves up and down within selectable rows", () => {
  let state = createPickerState(rows);
  state = expectUpdate(state, "down");
  assert.equal(state.cursor, 1);
  state = expectUpdate(state, "down");
  assert.equal(state.cursor, 1);
  state = expectUpdate(state, "up");
  assert.equal(state.cursor, 0);
  state = expectUpdate(state, "up");
  assert.equal(state.cursor, 0);
});

test("space toggles selectable rows but disabled rows remain unchanged", () => {
  let state = createPickerState(rows);
  state = expectUpdate(state, "space");
  assert.equal(state.rows[0].selected, true);
  state = expectUpdate(state, "down");
  state = expectUpdate(state, "space");
  assert.equal(state.rows[1].selected, true);
  state = expectUpdate(state, "down");
  assert.equal(state.cursor, 1);
});

test("A toggles all selectable rows only", () => {
  let state = createPickerState(rows);
  state = expectUpdate(state, "a");
  assert.deepEqual(state.rows.map((row) => row.selected), [true, true, false]);
  state = expectUpdate(state, "a");
  assert.deepEqual(state.rows.map((row) => row.selected), [false, false, false]);
});

test("Enter returns selected ids in deterministic order", () => {
  let state = createPickerState(rows);
  state = expectUpdate(state, "a");
  const result = applyPickerKey(state, "enter");
  assert.deepEqual(result, { kind: "confirmed", selected: ["codex", "opencode"] });
});

test("Esc and Ctrl+C cancel with Ctrl+C exit code 130", () => {
  const state = createPickerState(rows);
  assert.deepEqual(applyPickerKey(state, "escape"), { kind: "cancelled" });
  assert.deepEqual(applyPickerKey(state, "ctrl-c"), { kind: "cancelled", exitCode: 130 });
});

test("rendered rows distinguish pending selection from connected state", () => {
  const state = createPickerState(rows);
  const rendered = renderPicker("Connect CodeAtlas", state);
  assert.match(rendered, /Codex\s+connected/);
  assert.match(rendered, /OpenCode\s+installed/);
  assert.match(rendered, /Claude Code\s+not detected/);
  assert.match(rendered, /Space toggle · A select all detected · Enter confirm · Esc cancel/);
});

test("interactive picker redraws in place and restores the terminal", async () => {
  let dataHandler: ((chunk: string) => void) | undefined;
  let resizeHandler: (() => void) | undefined;
  const writes: string[] = [];
  const stdin = {
    isTTY: true,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    setEncoding: () => stdin,
    on: (event: string, listener: (chunk: string) => void) => {
      if (event === "data") dataHandler = listener;
      return stdin;
    },
    off: (event: string) => {
      if (event === "data") dataHandler = undefined;
      return stdin;
    },
  };
  const stdout = {
    isTTY: true,
    write: (chunk: string) => {
      writes.push(chunk);
      return true;
    },
    on: (event: string, listener: () => void) => {
      if (event === "resize") resizeHandler = listener;
      return stdout;
    },
    off: (event: string) => {
      if (event === "resize") resizeHandler = undefined;
      return stdout;
    },
  };

  const picker = runIntegrationPicker({ title: "Connect CodeAtlas", rows, stdin, stdout });
  dataHandler?.("\u001b[B");
  resizeHandler?.();
  dataHandler?.("\r");
  const result = await picker;
  const output = writes.join("");

  assert.deepEqual(result, { kind: "confirmed", selected: [] });
  assert.equal((output.match(/\u001b\[\?25l/g) ?? []).length, 1);
  assert.equal((output.match(/\u001b\[\?25h/g) ?? []).length, 1);
  assert.doesNotMatch(output, /\u001b\[2J/);
  assert.match(output, /\u001b\[2K/);
});

test("interactive picker clears on SIGINT and restores the cursor", async () => {
  let dataHandler: ((chunk: string) => void) | undefined;
  const writes: string[] = [];
  const stdin = {
    isTTY: true,
    setRawMode: () => stdin,
    resume: () => stdin,
    pause: () => stdin,
    setEncoding: () => stdin,
    on: (event: string, listener: (chunk: string) => void) => {
      if (event === "data") dataHandler = listener;
      return stdin;
    },
    off: (event: string) => {
      if (event === "data") dataHandler = undefined;
      return stdin;
    },
  };
  const stdout = {
    isTTY: true,
    write: (chunk: string) => { writes.push(chunk); return true; },
  };
  const picker = runIntegrationPicker({ title: "Connect CodeAtlas", rows, stdin, stdout });
  process.emit("SIGINT");
  assert.equal(dataHandler, undefined);
  assert.deepEqual(await picker, { kind: "cancelled", exitCode: 130 });
  const output = writes.join("");
  assert.equal((output.match(/\u001b\[\?25l/g) ?? []).length, 1);
  assert.equal((output.match(/\u001b\[\?25h/g) ?? []).length, 1);
  assert.match(output, /\u001b\[2K/);
});

function expectUpdate(
  state: ReturnType<typeof createPickerState>,
  key: Parameters<typeof applyPickerKey>[1],
) {
  const result = applyPickerKey(state, key);
  assert.equal(result.kind, "updated");
  if (result.kind !== "updated") throw new Error("expected picker state update");
  return result.state;
}
