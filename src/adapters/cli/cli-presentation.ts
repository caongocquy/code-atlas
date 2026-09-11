import picocolors from "picocolors";

export type TerminalCapabilities = {
  isTTY: boolean;
  color: boolean;
  interactive: boolean;
};

export type PresentationRow = {
  label: string;
  value: string | number;
  tone?: "default" | "muted" | "warning" | "success";
};

export function getTerminalCapabilities(
  stream: NodeJS.WriteStream = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): TerminalCapabilities {
  const isCI = env.CI === "true";
  const isTTY = stream.isTTY === true;
  const color = isTTY && !isCI && !("NO_COLOR" in env);
  return { isTTY, color, interactive: isTTY && !isCI };
}

function colors(capabilities: TerminalCapabilities) {
  return picocolors.createColors(capabilities.color);
}

function toneColor(tone: PresentationRow["tone"], capabilities: TerminalCapabilities): (value: string) => string {
  const pc = colors(capabilities);
  if (tone === "success") return pc.green;
  if (tone === "warning") return pc.yellow;
  if (tone === "muted") return pc.gray;
  return (value) => value;
}

export function renderHeader(
  title: string,
  subtitle?: string,
  capabilities: TerminalCapabilities = getTerminalCapabilities(),
): string {
  const pc = colors(capabilities);
  const lines = [pc.bold(pc.cyan(title))];
  if (subtitle) lines.push(pc.gray(subtitle));
  return lines.join("\n");
}

export function renderSection(
  title: string,
  body: string | readonly string[],
  capabilities: TerminalCapabilities = getTerminalCapabilities(),
): string {
  const pc = colors(capabilities);
  const lines = typeof body === "string" ? body.split("\n") : [...body];
  return [pc.bold(title), ...lines].join("\n");
}

export function renderKeyValueRows(
  rows: readonly PresentationRow[],
  capabilities: TerminalCapabilities = getTerminalCapabilities(),
): string {
  const labelWidth = Math.max(...rows.map((row) => row.label.length), 0);
  return rows.map((row) => {
    const label = colors(capabilities).gray(row.label.padEnd(labelWidth));
    return `${label}  ${toneColor(row.tone, capabilities)(String(row.value))}`;
  }).join("\n");
}

export function renderStatusLine(
  label: string,
  state: string,
  detail?: string,
  capabilities: TerminalCapabilities = getTerminalCapabilities(),
): string {
  const marker = state === "ready" || state === "success" ? "✓" : state === "error" || state === "failed" ? "✗" : "!";
  const markerColor = marker === "✓" ? colors(capabilities).green : marker === "✗" ? colors(capabilities).red : colors(capabilities).yellow;
  return `${colors(capabilities).gray(label)}  ${markerColor(marker)} ${state}${detail ? `  ${colors(capabilities).gray(detail)}` : ""}`;
}

export function renderResultBox(
  title: string,
  lines: readonly string[],
  tone: "success" | "warning" | "error" = "success",
  capabilities: TerminalCapabilities = getTerminalCapabilities(),
): string {
  const pc = colors(capabilities);
  const marker = tone === "success" ? "✓" : tone === "warning" ? "!" : "✗";
  const color = tone === "success" ? pc.green : tone === "warning" ? pc.yellow : pc.red;
  const content = [`${color(marker)} ${color(title)}`, ...lines];
  const width = Math.max(...content.map((line) => line.replace(/\u001b\[[0-9;]*m/g, "").length), 0) + 2;
  const border = `┌${"─".repeat(width)}┐`;
  return [border, ...content.map((line) => `│ ${line.padEnd(width - 1)}│`), `└${"─".repeat(width)}┘`].join("\n");
}

export function renderNextActions(
  actions: readonly string[],
  capabilities: TerminalCapabilities = getTerminalCapabilities(),
): string {
  return [colors(capabilities).bold("Next"), ...actions.map((action) => `  ${action}`)].join("\n");
}
