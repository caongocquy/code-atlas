import chalk from "chalk";
import figures from "figures";

import type { ProgressKind } from "../../core/progress/progress.types.js";

export type { ProgressKind } from "../../core/progress/progress.types.js";

export const cliTheme = {
  active: chalk.cyan,
  success: chalk.green,
  error: chalk.red,
  warning: chalk.yellow,
  info: chalk.blue,
  muted: chalk.gray,
  vector: chalk.cyan,
  graph: chalk.magenta,
  metric: chalk.white,
  value: chalk.bold.white,
};

export const cliIcons = {
  success: figures.tick,
  error: figures.cross,
  warning: figures.warning,
  info: figures.info,
  arrow: figures.arrowRight,
  bullet: figures.bullet,
  pointer: figures.pointer,
};

export function colorForKind(kind: ProgressKind) {
  if (kind === "graph") {
    return cliTheme.graph;
  }

  if (kind === "vector") {
    return cliTheme.vector;
  }

  return cliTheme.active;
}
