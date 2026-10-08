import { log, spinner, type Task } from "@clack/prompts";

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

export function createProgressTask(
  title: string,
  work: (reporter: ProgressReporter) => void | Promise<void>,
  kind: ProgressKind = "default",
): Task {
  return {
    title: formatTaskTitle(title),
    task: async (message) => {
      let currentTitle = title;
      let lastUpdate = 0;
      let lastMessage = "";

      function publish(value: string, force = false): void {
        const now = Date.now();
        if (!force && (value === lastMessage || now - lastUpdate < UPDATE_INTERVAL_MS)) return;
        lastMessage = value;
        lastUpdate = now;
        message(`${formatTaskTitle(currentTitle)} — ${value}`);
      }

      await work({
        setTitle(nextTitle) {
          currentTitle = nextTitle;
          message(formatTaskTitle(nextTitle));
        },
        update(value) {
          publish(value);
        },
        setProgress(current, total) {
          publish(formatProgress(current, total, kind), current >= total);
        },
      });

      return `${formatTaskTitle(currentTitle)} complete`;
    },
  };
}

export async function runProgressTasks(tasks: Task[]): Promise<void> {
  if (getTerminalCapabilities().interactive) {
    for (const task of tasks) {
      const taskSpinner = spinner();
      taskSpinner.start(task.title);
      try {
        const result = await task.task((message) => taskSpinner.message(message));
        taskSpinner.stop(typeof result === "string" ? result : task.title);
      } catch (error) {
        taskSpinner.error(error instanceof Error ? error.message : String(error));
        throw error;
      }
    }
    return;
  }

  for (const task of tasks) {
    log.step(task.title);
    try {
      const result = await task.task((message) => log.message(message));
      if (typeof result === "string") log.success(result);
    } catch (error) {
      log.error(error instanceof Error ? error.message : String(error));
      throw error;
    }
  }
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

export function createInlineProgressRunner(parent: ProgressReporter): ProgressRunner {
  return {
    update(message: string): void {
      parent.update(message);
    },
    async run<T>(
      title: string,
      work: (reporter: ProgressReporter) => Promise<T> | T,
      _kind?: ProgressKind,
    ): Promise<T> {
      parent.setTitle?.(title);
      try {
        return await work(parent);
      } finally {
        parent.setTitle?.("Analyzing repository");
      }
    },
    async runAll(tasks) {
      for (const task of tasks) {
        parent.setTitle?.(task.title);
        await task.work(parent);
      }
      parent.setTitle?.("Analyzing repository");
    },
  };
}

export const cliProgressRunner: ProgressRunner = {
  run: runProgressTask,
  runAll(tasks: readonly ProgressTask[]): Promise<void> {
    return runProgressTasks(
      tasks.map((task) => createProgressTask(task.title, task.work, task.kind)),
    );
  },
};
