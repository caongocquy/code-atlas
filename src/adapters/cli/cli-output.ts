import { cliIcons, cliTheme, colorForKind } from "./cli-theme.js";
import type { ProgressKind } from "../../core/progress/progress.types.js";

const DEFAULT_BAR_WIDTH = 20;

type SummaryValue = string | number;

export type SummaryRow = {
  label: string;
  value: SummaryValue;
  tone?: "default" | "muted" | "warning" | "success";
};

function terminalWidth(): number {
  return process.stdout.columns ?? 80;
}

function valueTone(value: SummaryValue, tone: SummaryRow["tone"]): (text: string) => string {
  if (tone === "muted" || (typeof value === "number" && value === 0)) {
    return cliTheme.muted;
  }

  if (tone === "warning") {
    return cliTheme.warning;
  }

  if (tone === "success") {
    return cliTheme.success;
  }

  return cliTheme.value;
}

export function formatProgress(
  current: number,
  total: number,
  kind: ProgressKind = "default",
): string {
  if (total <= 0) {
    return cliTheme.muted("0/0");
  }

  const boundedCurrent = Math.max(0, Math.min(current, total));
  const percentage = Math.round((boundedCurrent / total) * 100);
  const width = Math.max(
    8,
    Math.min(DEFAULT_BAR_WIDTH, Math.floor((terminalWidth() - 34) / 2)),
  );
  const filled = Math.round((boundedCurrent / total) * width);
  const bar = `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
  const color = colorForKind(kind);

  return `${color(bar)} ${cliTheme.metric(`${percentage}%`)} ${cliTheme.muted(`${boundedCurrent}/${total}`)}`;
}

export function formatTaskTitle(title: string): string {
  return cliTheme.active(title);
}

export function formatNotice(
  title: string,
  detail: string | undefined,
  tone: "info" | "warning" | "error" = "info",
): string {
  const color = tone === "warning"
    ? cliTheme.warning
    : tone === "error"
      ? cliTheme.error
      : cliTheme.active;
  const icon = tone === "warning"
    ? cliIcons.warning
    : tone === "error"
      ? cliIcons.error
      : cliIcons.pointer;
  const lines = [`${color(icon)} ${color(title)}`];

  if (detail) {
    lines.push(`  ${cliIcons.arrow} ${cliTheme.muted(detail)}`);
  }

  return lines.join("\n");
}

export function formatIncrementalSync(
  added: number,
  changed: number,
  deleted: number,
): string {
  const colorCount = (value: number, color: (text: string) => string) =>
    value === 0 ? cliTheme.muted : color;

  return [
    colorCount(added, cliTheme.success)(`+${added} added`),
    colorCount(changed, cliTheme.warning)(`~${changed} changed`),
    colorCount(deleted, cliTheme.warning)(`-${deleted} deleted`),
  ].join(` ${cliIcons.bullet} `);
}

export function formatSummary(
  title: string,
  rows: SummaryRow[],
  tone: "success" | "vector" | "graph" = "success",
): string {
  const headingColor = tone === "graph"
    ? cliTheme.graph
    : tone === "vector"
      ? cliTheme.vector
      : cliTheme.success;
  const headingIcon = cliIcons.success;
  const labelWidth = Math.max(...rows.map((row) => row.label.length), 0);
  const lines = [`${cliTheme.success(headingIcon)} ${headingColor(title)}`];

  rows.forEach((row, index) => {
    const branch = index === rows.length - 1 ? "└─" : "├─";
    const label = cliTheme.muted(row.label.padEnd(labelWidth));
    const value = valueTone(row.value, row.tone)(String(row.value));

    lines.push(`  ${cliTheme.muted(branch)} ${label}  ${value}`);
  });

  return lines.join("\n");
}
