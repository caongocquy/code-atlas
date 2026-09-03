import type {
  ProgressReporter,
  ProgressRunner,
  ProgressTask,
} from "../cli/types.js";

const silentReporter: ProgressReporter = {
  update() {},
  setProgress() {},
};

export const silentProgressRunner: ProgressRunner = {
  async run<T>(
    _title: string,
    work: (reporter: ProgressReporter) => Promise<T> | T,
  ): Promise<T> {
    return work(silentReporter);
  },

  async runAll(tasks: readonly ProgressTask[]): Promise<void> {
    for (const task of tasks) {
      await task.work(silentReporter);
    }
  },
};
