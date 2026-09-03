export type ProgressReporter = {
  setTitle?(title: string): void;
  update(message: string): void;
  setProgress(current: number, total: number): void;
};
