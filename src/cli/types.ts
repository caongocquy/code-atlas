import type { ProgressKind } from "./theme.js";

export type ProgressReporter = {
  setTitle?(title: string): void;
  update(message: string): void;
  setProgress(current: number, total: number): void;
};

export type ProgressTask = {
  title: string;
  kind?: ProgressKind;
  work: (reporter: ProgressReporter) => void | Promise<void>;
};

export type ProgressRunner = {
  run<T>(
    title: string,
    work: (reporter: ProgressReporter) => Promise<T> | T,
    kind?: ProgressKind,
  ): Promise<T>;
  runAll(tasks: readonly ProgressTask[]): Promise<void>;
};
