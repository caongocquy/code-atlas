import { Listr, type ListrTask, type ListrTaskWrapper } from "listr2";

import {
  formatProgress,
  formatTaskTitle,
} from "./cli-output.js";
import { getTerminalCapabilities } from "./cli-presentation.js";
import type { ProgressKind } from "../../core/progress/progress.types.js";
import type {
  ProgressReporter,
  ProgressRunner,
  ProgressTask,
} from "../../core/progress/progress.types.js";

const UPDATE_INTERVAL_MS = 80;

function createReporter(
  title: string,
  kind: ProgressKind,
  task: ListrTaskWrapper<any, any, any>,
): ProgressReporter {
  let currentTitle = title;
  let lastUpdate = 0;
  let lastMessage = "";

  function publish(message: string, force = false): void {
    const now = Date.now();

    if (
      !force &&
      (message === lastMessage || now - lastUpdate < UPDATE_INTERVAL_MS)
    ) {
      return;
    }

    lastMessage = message;
    lastUpdate = now;
    task.title = `${formatTaskTitle(currentTitle)} — ${message}`;
  }

  return {
    setTitle(nextTitle) {
      currentTitle = nextTitle;
      task.title = formatTaskTitle(nextTitle);
    },
    update(message) {
      publish(message);
    },
    setProgress(current, total) {
      publish(formatProgress(current, total, kind), current >= total);
    },
  };
}

export function createProgressTask(
  title: string,
  work: (reporter: ProgressReporter) => void | Promise<void>,
  kind: ProgressKind = "default",
): ListrTask {
  return {
    title: formatTaskTitle(title),
    task: async (_context, task) => {
      await work(createReporter(title, kind, task));
    },
  };
}

export async function runProgressTasks(tasks: ListrTask[]): Promise<void> {
  const capabilities = getTerminalCapabilities();
  await new Listr(tasks, {
    renderer: capabilities.interactive || (process.env.LISTR_FORCE_TTY === "1" && process.env.CI !== "true")
      ? "default"
      : "simple",
    fallbackRenderer: "simple",
    rendererOptions: {
      formatOutput: "truncate",
      clearOutput: capabilities.interactive || process.env.LISTR_FORCE_TTY === "1",
      collapseSkips: true,
    },
    fallbackRendererOptions: {},
  }).run();
}

export async function runProgressTask<T>(
  title: string,
  work: (reporter: ProgressReporter) => Promise<T> | T,
  kind: ProgressKind = "default",
): Promise<T> {
  let result!: T;

  await runProgressTasks([
    createProgressTask(title, async (reporter) => {
      result = await work(reporter);
    }, kind),
  ]);

  return result;
}

export const cliProgressRunner: ProgressRunner = {
  run: runProgressTask,
  runAll(tasks: readonly ProgressTask[]): Promise<void> {
    return runProgressTasks(
      tasks.map((task) => createProgressTask(task.title, task.work, task.kind)),
    );
  },
};
