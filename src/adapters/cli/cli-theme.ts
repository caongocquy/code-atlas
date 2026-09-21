import figures from "figures";
import picocolors from "picocolors";

import type { ProgressKind } from "../../core/progress/progress.types.js";
import { getTerminalCapabilities } from "./cli-presentation.js";

export type { ProgressKind } from "../../core/progress/progress.types.js";

type ThemeColor = (value: string) => string;

function themeColor(style: "blue" | "bold" | "cyan" | "gray" | "green" | "magenta" | "red" | "white" | "yellow"): ThemeColor {
  return (value) => {
    const colors = picocolors.createColors(getTerminalCapabilities().color);
    return colors[style](value);
  };
}

export const cliTheme: Record<string, ThemeColor> = {
  active: themeColor("cyan"),
  success: themeColor("green"),
  error: themeColor("red"),
  warning: themeColor("yellow"),
  info: themeColor("blue"),
  muted: themeColor("gray"),
  vector: themeColor("cyan"),
  graph: themeColor("magenta"),
  metric: themeColor("white"),
  value: (value) => {
    const colors = picocolors.createColors(getTerminalCapabilities().color);
    return colors.bold(colors.white(value));
  },
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
