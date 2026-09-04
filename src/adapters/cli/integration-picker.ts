import type { IntegrationId } from "../../core/integration/integration.types.js";

export type IntegrationPickerRow = {
  id: IntegrationId;
  displayName: string;
  state: string;
  selectable: boolean;
  selected: boolean;
};

export type IntegrationPickerState = {
  rows: IntegrationPickerRow[];
  cursor: number;
};

export type PickerKey = "up" | "down" | "space" | "a" | "enter" | "escape" | "ctrl-c";

export type PickerResult =
  | { kind: "updated"; state: IntegrationPickerState }
  | { kind: "confirmed"; selected: IntegrationId[] }
  | { kind: "cancelled"; exitCode?: 130 };

export type PickerStdin = Pick<NodeJS.ReadStream, "isTTY" | "setRawMode" | "resume" | "pause" | "setEncoding" | "on" | "off">;
export type PickerStdout = Pick<NodeJS.WriteStream, "isTTY" | "write">;

export function createPickerState(rows: readonly IntegrationPickerRow[]): IntegrationPickerState {
  const copiedRows = rows.map((row) => ({ ...row, selected: row.selectable && row.selected }));
  return { rows: copiedRows, cursor: findSelectable(copiedRows, -1, 1) ?? 0 };
}

export function applyPickerKey(state: IntegrationPickerState, key: PickerKey): PickerResult {
  if (key === "enter") {
    return {
      kind: "confirmed",
      selected: state.rows.filter((row) => row.selected).map((row) => row.id),
    };
  }
  if (key === "escape") return { kind: "cancelled" };
  if (key === "ctrl-c") return { kind: "cancelled", exitCode: 130 };

  const next = { rows: state.rows.map((row) => ({ ...row })), cursor: state.cursor };
  if (key === "space") {
    const row = next.rows[next.cursor];
    if (row?.selectable) row.selected = !row.selected;
  } else if (key === "a") {
    const selectable = next.rows.filter((row) => row.selectable);
    const selected = selectable.length > 0 && selectable.every((row) => row.selected);
    next.rows = next.rows.map((row) => row.selectable ? { ...row, selected: !selected } : row);
  } else {
    const direction = key === "up" ? -1 : 1;
    next.cursor = findSelectable(next.rows, next.cursor, direction) ?? next.cursor;
  }
  return { kind: "updated", state: next };
}

export function renderPicker(title: string, state: IntegrationPickerState): string {
  return [
    title,
    "",
    "Select integrations:",
    "",
    ...state.rows.map((row, index) => {
      const cursor = index === state.cursor ? "❯" : " ";
      const marker = row.selected ? "◉" : "◯";
      const label = row.displayName.padEnd(12);
      const stateLabel = row.selectable ? row.state : `${row.state} (unavailable)`;
      return `${cursor} ${marker} ${label} ${stateLabel}`;
    }),
    "",
    "Space toggle · A select all detected · Enter confirm · Esc cancel",
  ].join("\n");
}

export async function runIntegrationPicker(options: {
  title: string;
  rows: readonly IntegrationPickerRow[];
  stdin?: PickerStdin;
  stdout?: PickerStdout;
}): Promise<Exclude<PickerResult, { kind: "updated" }>> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("The integration selector requires an interactive terminal.");
  }

  let state = createPickerState(options.rows);
  const render = (): void => { stdout.write(`\x1b[2J\x1b[H${renderPicker(options.title, state)}`); };
  render();

  return new Promise((resolve) => {
    let done = false;
    const finish = (result: Exclude<PickerResult, { kind: "updated" }>): void => {
      if (done) return;
      done = true;
      stdin.off("data", onData);
      stdin.setRawMode?.(false);
      stdin.pause();
      stdout.write("\n");
      resolve(result);
    };
    const onData = (chunk: string): void => {
      const inputs: PickerKey[] = chunk === "\u0003"
        ? ["ctrl-c"]
        : chunk === "\u001b[A"
          ? ["up"]
          : chunk === "\u001b[B"
            ? ["down"]
            : chunk === " "
              ? ["space"]
              : chunk.toLowerCase() === "a"
                ? ["a"]
                : chunk === "\r" || chunk === "\n"
                  ? ["enter"]
                  : chunk === "\u001b"
                    ? ["escape"]
                    : [];
      for (const input of inputs) {
        const result = applyPickerKey(state, input);
        if (result.kind === "updated") {
          state = result.state;
          render();
        } else {
          finish(result);
          return;
        }
      }
    };
    stdin.setEncoding("utf8");
    stdin.setRawMode?.(true);
    stdin.on("data", onData);
    stdin.resume();
  });
}

function findSelectable(rows: readonly IntegrationPickerRow[], start: number, direction: -1 | 1): number | undefined {
  let index = start + direction;
  while (index >= 0 && index < rows.length) {
    if (rows[index].selectable) return index;
    index += direction;
  }
  return undefined;
}
