import { CANCEL_SYMBOL, cancel, isCancel, multiselect } from "@clack/prompts";

import type { IntegrationId } from "../../core/integration/integration.types.js";

export type IntegrationPickerRow = {
  id: IntegrationId;
  displayName: string;
  state: string;
  selectable: boolean;
  selected: boolean;
};

export type PickerStdin = NodeJS.ReadStream;
export type PickerStdout = NodeJS.WriteStream;

export type PickerResult =
  | { kind: "confirmed"; selected: IntegrationId[] }
  | { kind: "cancelled"; exitCode?: 130 };

export async function runIntegrationPicker(options: {
  title: string;
  rows: readonly IntegrationPickerRow[];
  stdin?: PickerStdin;
  stdout?: PickerStdout;
}): Promise<PickerResult> {
  const stdin = options.stdin ?? process.stdin;
  const stdout = options.stdout ?? process.stdout;
  if (stdin.isTTY !== true || stdout.isTTY !== true) {
    throw new Error("The integration selector requires an interactive terminal.");
  }

  let interrupted = false;
  const onSigint = (): void => {
    interrupted = true;
  };
  const keypressStream = stdin as unknown as {
    on(event: "keypress", listener: (_input: string, key: { ctrl?: boolean; name?: string }) => void): void;
    off(event: "keypress", listener: (_input: string, key: { ctrl?: boolean; name?: string }) => void): void;
  };
  const onKeypress = (_input: string, key: { ctrl?: boolean; name?: string }): void => {
    if (key.ctrl && key.name === "c") interrupted = true;
  };
  keypressStream.on("keypress", onKeypress);
  process.on("SIGINT", onSigint);

  let result: IntegrationId[] | typeof CANCEL_SYMBOL;
  const firstSelectable = options.rows.find((row) => row.selectable);
  try {
    result = await multiselect<IntegrationId>({
      message: options.title,
      options: options.rows.map((row) => ({
        value: row.id,
        label: row.displayName,
        hint: row.state,
        disabled: !row.selectable,
      })),
      initialValues: options.rows.filter((row) => row.selectable && row.selected).map((row) => row.id),
      ...(firstSelectable ? { cursorAt: firstSelectable.id } : {}),
      input: stdin,
      output: stdout,
      required: false,
    });
  } finally {
    process.off("SIGINT", onSigint);
    keypressStream.off("keypress", onKeypress);
  }

  if (isCancel(result)) {
    cancel("Integration selection cancelled", { output: stdout });
    return { kind: "cancelled", ...(interrupted ? { exitCode: 130 as const } : {}) };
  }

  const selected = new Set(result);
  return {
    kind: "confirmed",
    selected: options.rows.filter((row) => row.selectable && selected.has(row.id)).map((row) => row.id),
  };
}
