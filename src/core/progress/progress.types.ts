export type ProgressKind = "default" | "graph" | "vector";

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
  update?(message: string): void;
  run<T>(
    title: string,
    work: (reporter: ProgressReporter) => Promise<T> | T,
    kind?: ProgressKind,
  ): Promise<T>;
  runAll(tasks: readonly ProgressTask[]): Promise<void>;
};
