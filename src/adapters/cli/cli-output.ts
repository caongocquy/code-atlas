import { cliIcons, cliTheme, colorForKind } from "./cli-theme.js";
import type { ProgressKind } from "../../core/progress/progress.types.js";
import type { IndexPipelineResult } from "../../core/indexing/index-pipeline.service.js";
import type { RepositoryStatus } from "../../core/repository/repository-status.service.js";
import type { RepositoryInitResult } from "../../core/repository/repository-init.service.js";
import type { IntegrationChange, IntegrationStatus } from "../../core/integration/integration.types.js";
import type { HookStatus } from "../../core/integration/integration.types.js";

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

export function formatIndexResult(result: IndexPipelineResult): string {
  const title = result.operation === "index" ? "Index complete" : "Sync complete";
  const lines = [
    `${cliTheme.success(cliIcons.success)} ${cliTheme.success(title)}`,
    "",
    `Repository     ${result.repoPath}`,
    `Files          ${result.graph.files}`,
    `Symbols        ${result.graph.nodes}`,
    `Relationships  ${result.graph.edges}`,
    `Graph          ${capabilityStatus(result.graph.status)}`,
    `Lexical        ${capabilityStatus(result.lexical.status)}`,
    `Semantic       ${result.semantic ? capabilityStatus(result.semantic.status) : "- not configured"}`,
  ];

  if (result.operation === "sync") {
    lines.push(`Changes        ${formatIncrementalSync(
      result.changes.addedFiles.length,
      result.changes.changedFiles.length,
      result.changes.deletedFiles.length,
    )}`);
  }

  lines.push(`Duration       ${formatDuration(result.totalMs)}`);
  return lines.join("\n");
}

export function formatIndexFailure(operation: "index" | "sync", error: unknown): string {
  const action = operation === "index" ? "Index" : "Sync";
  const reason = error instanceof Error ? error.message : String(error);
  return [
    `${cliTheme.error(cliIcons.error)} ${cliTheme.error(`${action} failed`)}`,
    "",
    "Phase          indexing",
    `Reason         ${reason}`,
  ].join("\n");
}

export function formatCommandFailure(command: string, error: unknown): string {
  const reason = error instanceof Error ? error.message : String(error);
  return formatNotice(`${command} failed`, reason, "error");
}

export function formatRepositoryStatus(status: RepositoryStatus): string {
  const graph = status.graph.status === "ready"
    ? `✓ ready    ${status.graph.nodes} symbols · ${status.graph.edges} relationships`
    : `${statusMark(status.graph.status)} ${status.graph.status}`;
  const lexical = status.capabilities.lexical.state === "ready"
    ? `✓ ready    ${status.capabilities.lexical.indexedFiles} files`
    : status.capabilities.lexical.indexedFiles === 0 && status.capabilities.lexical.state === "stale"
      ? "○ not indexed"
    : `${statusMark(status.capabilities.lexical.state)} ${status.capabilities.lexical.state}`;
  const semantic = formatCapability(status.capabilities.semantic.state);
  const reranker = formatCapability(status.capabilities.reranker.state);

  return [
    "CodeAtlas Status",
    "",
    `Repository   ${status.repository.path}`,
    `Files        ${status.repository.sourceFiles}`,
    "",
    `Graph        ${graph}`,
    `Lexical      ${lexical}`,
    `Semantic     ${semantic}`,
    `Reranker     ${reranker}`,
    "",
    ...(status.graph.status === "ready" && status.capabilities.lexical.state === "ready"
      ? []
      : ["Run:", "  code-atlas index"]),
  ].join("\n");
}

export function formatInitResult(result: RepositoryInitResult): string {
  return [
    `${cliTheme.success(cliIcons.success)} ${cliTheme.success("CodeAtlas initialized")}`,
    "",
    `Repository   ${result.repoPath}`,
    `Git          ${result.gitRepository ? "detected" : "not detected"}`,
    "State        .codeatlas/",
    "Index        not built",
    "",
    "Next:",
    "  code-atlas index",
  ].join("\n");
}

export function formatIntegrationChange(change: IntegrationChange): string {
  const status = change.status;
  const connecting = change.operation === "install";
  const heading = connecting ? `Connecting CodeAtlas to ${change.displayName}...` : `Disconnecting CodeAtlas from ${change.displayName}...`;
  const lines = [heading, ""];
  if (connecting) {
    lines.push(
      `${check(status.codeAtlasMcpConfigured)} MCP configured`,
      `${check(status.strictGuidanceConfigured === true)} AGENTS.md guidance configured`,
      `${check(status.configurationValid)} Configuration valid`,
      "",
      `${change.displayName} is ready to use CodeAtlas.`,
    );
  } else {
    lines.push(`${status.codeAtlasMcpConfigured ? "! MCP still configured" : "✓ MCP disconnected"}`);
  }
  return lines.join("\n");
}

export function formatIntegrationStatuses(statuses: IntegrationStatus[]): string {
  return [
    "CodeAtlas Integrations",
    "",
    ...statuses.map((status) => `${statusMark(status.state)} ${status.displayName}  ${status.state}`),
  ].join("\n");
}

export function formatHookStatus(status: HookStatus): string {
  return [
    "CodeAtlas Hooks",
    "",
    `Repository   ${status.repoPath}`,
    ...Object.entries(status.hooks).map(([name, hook]) => `${hook.installed ? "✓" : "○"} ${name}  ${hook.installed ? "installed" : "not installed"}`),
    ...(status.warnings.length > 0 ? ["", ...status.warnings.map((warning) => `! ${warning}`)] : []),
  ].join("\n");
}

function capabilityStatus(status: string): string {
  return status === "indexed" || status === "current" ? "✓ ready" : `○ ${status}`;
}

function formatCapability(state: string): string {
  if (state === "not_configured") return "- not configured";
  if (state === "ready") return "✓ ready";
  return `${statusMark(state)} ${state}`;
}

function statusMark(state: string): string {
  if (state === "ready" || state === "installed" || state === "indexed" || state === "current") return "✓";
  if (state === "error" || state === "invalid_config" || state === "stale") return "!";
  if (state === "not_configured" || state === "unavailable") return "-";
  return "○";
}

function check(value: boolean): string {
  return value ? "✓" : "!";
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}
