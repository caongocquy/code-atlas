import { cliIcons, cliTheme, colorForKind } from "./cli-theme.js";
import type { ProgressKind } from "../../core/progress/progress.types.js";
import type { IndexPipelineResult } from "../../core/indexing/index-pipeline.service.js";
import type { RepositoryStatus } from "../../core/repository/repository-status.service.js";
import type { RepositoryInitResult } from "../../core/repository/repository-init.service.js";
import type { IntegrationChange, IntegrationStatus, LegacyIntegrationChange } from "../../core/integration/integration.types.js";
import type { HookStatus } from "../../core/integration/integration.types.js";
import {
  getTerminalCapabilities,
  renderHeader,
  renderKeyValueRows,
  renderNextActions,
  renderResultBox,
  renderSection,
  renderStatusLine,
  type PresentationRow,
} from "./cli-presentation.js";

const DEFAULT_BAR_WIDTH = 20;

type SummaryValue = string | number;

export type SummaryRow = PresentationRow;

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
  const capabilities = getTerminalCapabilities();
  const repository: PresentationRow[] = [
    { label: "Repository", value: result.repoPath, tone: "muted" },
    { label: "Indexed files", value: result.graph.files },
    { label: "Symbols", value: result.graph.nodes },
    { label: "Relationships", value: result.graph.edges },
  ];
  const capabilityRows: PresentationRow[] = [
    { label: "Graph", value: capabilityStatus(result.graph.status) },
    { label: "Lexical", value: capabilityStatus(result.lexical.status) },
    { label: "Semantic", value: result.semantic ? capabilityStatus(result.semantic.status) : "- not configured", tone: "muted" },
  ];
  const sections = [
    renderHeader("CODEATLAS", "Local-first change intelligence", capabilities),
    renderSection("Repository", renderKeyValueRows(repository, capabilities), capabilities),
    renderSection("Capabilities", renderKeyValueRows(capabilityRows, capabilities), capabilities),
  ];

  if (result.operation === "sync") {
    sections.push(renderSection("Changes", [
      formatIncrementalSync(
        result.changes.addedFiles.length,
        result.changes.changedFiles.length,
        result.changes.deletedFiles.length,
      ),
      `Unchanged  ${result.graph.unchangedFiles}`,
    ], capabilities));
  }

  sections.push(renderResultBox(title, [`Duration  ${formatDuration(result.totalMs)}`], "success", capabilities));
  return sections.join("\n\n");
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
  const capabilities = getTerminalCapabilities();
  const graph = status.graph.status === "ready"
    ? `ready    ${status.graph.nodes} symbols · ${status.graph.edges} relationships`
    : formatCapability(status.graph.status);
  const lexical = status.capabilities.lexical.state === "ready"
    ? `ready    ${status.capabilities.lexical.indexedFiles} files`
    : status.capabilities.lexical.state;
  const complete = status.graph.status === "ready" && status.capabilities.lexical.state === "ready";
  return [
    renderHeader("CodeAtlas Status", undefined, capabilities),
    renderSection("Repository", renderKeyValueRows([
      { label: "Path", value: status.repository.path, tone: "muted" },
      { label: "Files", value: status.repository.sourceFiles },
    ], capabilities), capabilities),
    renderSection("Capabilities", [
      renderStatusLine("Graph", complete ? "ready" : status.graph.status, graph, capabilities),
      renderStatusLine("Lexical", status.capabilities.lexical.state, lexical, capabilities),
      renderStatusLine("Semantic", status.capabilities.semantic.state, formatCapability(status.capabilities.semantic.state), capabilities),
      renderStatusLine("Reranker", status.capabilities.reranker.state, formatCapability(status.capabilities.reranker.state), capabilities),
    ], capabilities),
    ...(complete ? [] : [renderNextActions(["code-atlas index"], capabilities)]),
  ].join("\n\n");
}

export function formatInitResult(
  result: RepositoryInitResult,
  status?: RepositoryStatus,
  indexed = false,
  guidanceChanged = false,
  indexResult?: Pick<IndexPipelineResult, "totalMs" | "graph">,
): string {
  const graph = status?.graph;
  const lexical = status?.capabilities.lexical;
  const capabilities = getTerminalCapabilities();
  const rows: PresentationRow[] = [
    { label: "Repository", value: result.repoPath, tone: "muted" },
    { label: "Git", value: result.gitRepository ? "detected" : "not detected" },
    { label: "State", value: ".codeatlas/" },
    { label: "Index", value: indexed ? "ready" : "skipped (--no-index)", tone: indexed ? "success" : "warning" },
  ];
  if (status) {
    rows.push(
      { label: "Source files", value: status.repository.sourceFiles },
      ...(indexed ? [{ label: "Indexed files", value: indexResult?.graph.files ?? graph?.indexedFiles ?? 0 }] : []),
      { label: "Symbols", value: graph?.nodes ?? 0 },
      { label: "Relationships", value: graph?.edges ?? 0 },
      { label: "Graph", value: capabilityStatus(graph?.status ?? "not_indexed") },
      { label: "Lexical", value: capabilityStatus(lexical?.state ?? "not_indexed") },
      { label: "Guidance", value: guidanceChanged ? "updated" : "current" },
    );
  }
  const sections = [
    renderHeader("CODEATLAS", "Local-first change intelligence", capabilities),
    renderSection("Repository", renderKeyValueRows(rows, capabilities), capabilities),
  ];
  if (indexResult) sections.push(renderSection("Result", `Duration  ${formatDuration(indexResult.totalMs)}`, capabilities));
  if (!indexed) sections.push(renderNextActions(["code-atlas index"], capabilities));
  sections.push(renderResultBox("CodeAtlas initialized", [], indexed ? "success" : "warning", capabilities));
  return sections.join("\n\n");
}

export function formatIntegrationChange(change: IntegrationChange | LegacyIntegrationChange): string {
  const capabilities = getTerminalCapabilities();
  const status = change.status;
  const connecting = change.operation === "install" || change.operation === "connect";
  const configured = "codeAtlasMcpConfigured" in status ? status.codeAtlasMcpConfigured : status.state === "connected";
  const valid = "configurationValid" in status ? status.configurationValid : status.state !== "invalid_config" && status.state !== "stale";
  const guidanceConfigured = "strictGuidanceConfigured" in status && status.strictGuidanceConfigured === true;
  const heading = connecting ? `Connecting CodeAtlas to ${change.displayName}...` : `Disconnecting CodeAtlas from ${change.displayName}...`;
  const lines = [renderHeader("CODEATLAS", heading, capabilities), ""];
  if (connecting) {
    lines.push(
      renderStatusLine("MCP", configured ? "ready" : "warning", "configured", capabilities),
      renderStatusLine("AGENTS.md", guidanceConfigured ? "ready" : "warning", "guidance configured", capabilities),
      renderStatusLine("Config", valid ? "ready" : "warning", "valid", capabilities),
      "",
      renderResultBox(`${change.displayName} is ready to use CodeAtlas`, [], "success", capabilities),
    );
  } else {
    lines.push(renderResultBox(configured ? "MCP still configured" : "MCP disconnected", [], configured ? "warning" : "success", capabilities));
  }
  return lines.join("\n");
}

export function formatIntegrationStatuses(statuses: IntegrationStatus[]): string {
  const capabilities = getTerminalCapabilities();
  return [
    renderHeader("CODEATLAS", "Integrations", capabilities),
    renderSection("Connections", statuses.map((status) => renderStatusLine(
      status.displayName,
      status.connection.state,
      status.connection.state,
      capabilities,
    ), capabilities), capabilities),
  ].join("\n\n");
}

export function formatIntegrationBatch(
  operation: "connected" | "disconnected",
  results: Array<{ displayName: string; ok: boolean; error?: string }>,
  skipped: Array<{ displayName: string; reason: string }>,
): string {
  const capabilities = getTerminalCapabilities();
  const lines = results.map((result) => result.ok
    ? renderStatusLine(result.displayName, "success", operation, capabilities)
    : renderStatusLine(result.displayName, "error", result.error ?? "Unknown error", capabilities));
  lines.push(...skipped.map((result) => renderStatusLine(result.displayName, "warning", `skipped (${result.reason})`, capabilities)));
  const successes = results.filter((result) => result.ok).length;
  const failures = results.length - successes;
  lines.push("", renderResultBox(`${successes} ${operation} · ${failures} failed`, [], failures === 0 ? "success" : "warning", capabilities));
  return lines.join("\n");
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
  return status === "ready" || status === "indexed" || status === "current" ? "✓ ready" : `○ ${status}`;
}

function formatCapability(state: string): string {
  if (state === "not_configured") return "- not configured";
  if (state === "not_indexed") return "○ not indexed";
  if (state === "ready") return "✓ ready";
  return `${statusMark(state)} ${state}`;
}

function statusMark(state: string): string {
  if (state === "ready" || state === "installed" || state === "indexed" || state === "current") return "✓";
  if (state === "error" || state === "invalid_config" || state === "stale") return "!";
  if (state === "not_configured" || state === "unavailable") return "-";
  return "○";
}

function formatDuration(milliseconds: number): string {
  return `${(milliseconds / 1000).toFixed(2)}s`;
}
