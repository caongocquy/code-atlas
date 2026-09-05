import path from "node:path";

import { createCliCommandReporter } from "./cli-command-reporter.js";
import {
  formatIntegrationBatch,
  formatIntegrationChange,
  formatIntegrationStatuses,
} from "./cli-output.js";
import {
  runIntegrationPicker,
  type IntegrationPickerRow,
  type PickerResult,
  type PickerStdin,
  type PickerStdout,
} from "./integration-picker.js";
import type {
  IntegrationId,
  IntegrationScope,
  IntegrationStatus,
  ResolveDurableMcpLaunch,
} from "../../core/integration/integration.types.js";
import { createAgentIntegrationService } from "../../infrastructure/integration/default-integrations.js";
import { resolveDurableMcpLaunch } from "../../infrastructure/integration/mcp-launcher.js";

type IntegrationService = ReturnType<typeof createAgentIntegrationService>;

export type IntegrationCommandDependencies = {
  createService?: (environment: { cwd: string }) => IntegrationService;
  picker?: (options: {
    title: string;
    rows: readonly IntegrationPickerRow[];
    stdin?: PickerStdin;
    stdout?: PickerStdout;
  }) => Promise<Exclude<PickerResult, { kind: "updated" }>>;
  stdin?: PickerStdin;
  stdout?: PickerStdout;
};

export async function runIntegrationCommand(
  args: string[],
  repoPath = path.resolve("."),
  dependencies: IntegrationCommandDependencies = {},
): Promise<void> {
  const positional = positionalArgs(args);
  const [firstArgument] = positional;
  if (firstArgument === "config") {
    await runIntegrationConfigCommand(args);
    return;
  }
  const reporter = createCliCommandReporter({ json: args.includes("--json") });
  const service = (dependencies.createService ?? createAgentIntegrationService)({ cwd: repoPath });
  const json = args.includes("--json");
  const noGuidance = args.includes("--no-guidance");
  let [action, requestedId] = positional;
  if (action === "integrations") action = "list";
  const scope = readScope(args);
  const strict = args.includes("--strict");
  const options = { repoPath, ...(scope ? { scope } : {}), strict, noGuidance };

  if (!action || action === "list" || action === "status") {
    const statuses = requestedId
      ? [await service.status(assertAgentId(requestedId, service), options)]
      : await service.list(options);
    if (json) reporter.output({ action: action ?? "list", integrations: statuses });
    else reporter.success(formatIntegrationStatuses(statuses));
    return;
  }

  const connecting = action === "connect" || action === "install";
  const disconnecting = action === "disconnect" || action === "uninstall";
  if (!connecting && !disconnecting) {
    throw new Error(`Usage: code-atlas connect|disconnect <${integrationIds(service)}> [--scope user|project] [--strict]`);
  }

  const all = args.includes("--all");
  if (all && requestedId) throw new Error("`--all` cannot be combined with an integration id.");
  if (all && !connecting && !disconnecting) throw new Error("`--all` is only supported for connect or disconnect.");
  if (all && (action === "install" || action === "uninstall")) {
    throw new Error("`--all` is only supported for connect or disconnect.");
  }

  if (connecting || disconnecting) {
    if (!requestedId && action !== "install" && action !== "uninstall") {
      const statuses = await service.list(options);
      const targets = all
        ? batchTargets(statuses, connecting)
        : await pickerTargets(action === "connect", statuses, dependencies, json);
      if (!targets) return;
      if (targets.length === 0) {
        if (all) {
          if (json) reporter.output({ action, results: [], skipped: statuses.map((status) => skip(status, "not eligible")) });
          else reporter.warning(`No integrations are eligible to ${connecting ? "connect" : "disconnect"}.`);
          return;
        }
        if (json) reporter.output({ action, results: [] });
        else reporter.success("No integrations selected.");
        return;
      }
      await runBatch(action, targets, statuses, service, options, reporter, json, all);
      return;
    }
  }

  if (!requestedId) throw new Error("An integration id is required.");
  const id = assertAgentId(requestedId, service);
  reporter.start(connecting ? `Connecting CodeAtlas to ${id}...` : `Disconnecting CodeAtlas from ${id}...`);
  const result = connecting
    ? await reporter.run(`Configuring ${id}`, () => service.connect(id, options))
    : await reporter.run(`Removing ${id} configuration`, () => service.disconnect(id, options));
  if (json) reporter.output({ action, result });
  else reporter.success(formatIntegrationChange(result));
}

type BatchTarget = { id: IntegrationId; displayName: string };

type BatchResult = {
  id: IntegrationId;
  displayName: string;
  ok: boolean;
  changed?: boolean;
  error?: string;
};

async function runBatch(
  action: string,
  targets: BatchTarget[],
  statuses: IntegrationStatus[],
  service: IntegrationService,
  options: ReturnType<typeof integrationOptions>,
  reporter: ReturnType<typeof createCliCommandReporter>,
  json: boolean,
  all: boolean,
): Promise<void> {
  const connecting = action === "connect";
  const results: BatchResult[] = [];
  reporter.start(connecting ? "Connecting CodeAtlas..." : "Disconnecting CodeAtlas...");
  for (const target of targets) {
    try {
      const result = connecting
        ? await reporter.run(`Configuring ${target.id}`, () => service.connect(target.id, { ...options, noGuidance: true }))
        : await reporter.run(`Removing ${target.id} configuration`, () => service.disconnect(target.id, { ...options, noGuidance: true }));
      results.push({ id: target.id, displayName: target.displayName, ok: true, changed: result.changed });
    } catch (error) {
      results.push({
        id: target.id,
        displayName: target.displayName,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  if (results.some((result) => result.ok)) {
    try {
      await service.reconcileGuidance(options);
    } catch (error) {
      results.push({
        id: "codex",
        displayName: "Guidance",
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const skipped = all
    ? statuses
      .filter((status) => !targets.some((target) => target.id === status.id))
      .map((status) => skip(status, connecting ? "not installed or safely configurable" : "no managed configuration"))
    : [];
  if (json) reporter.output({ action, results, skipped });
  else reporter.success(formatIntegrationBatch(connecting ? "connected" : "disconnected", results, skipped));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

async function pickerTargets(
  connecting: boolean,
  statuses: IntegrationStatus[],
  dependencies: IntegrationCommandDependencies,
  json: boolean,
): Promise<BatchTarget[] | undefined> {
  if (json || !isInteractiveTerminal(dependencies.stdin, dependencies.stdout)) {
    throw new Error("An integration id is required in non-interactive mode; use an id, `--all`, or an interactive terminal.");
  }
  const rows = statuses
    .filter((status) => connecting || managedCandidate(status))
    .map((status) => ({
      id: status.id,
      displayName: status.displayName,
      state: connecting ? displayState(status) : status.connection.state,
      selectable: connecting ? connectable(status) : managedCandidate(status),
      selected: !connecting && managedCandidate(status),
    }));
  const picker = dependencies.picker ?? runIntegrationPicker;
  const result = await picker({
    title: connecting ? "Connect CodeAtlas" : "Disconnect CodeAtlas",
    rows,
    stdin: dependencies.stdin,
    stdout: dependencies.stdout,
  });
  if (result.kind === "cancelled") {
    if (result.exitCode !== undefined) process.exitCode = result.exitCode;
    const reporter = createCliCommandReporter();
    reporter.success("Cancelled.");
    return undefined;
  }
  return result.selected.map((id) => {
    const status = statuses.find((candidate) => candidate.id === id);
    return { id, displayName: status?.displayName ?? id };
  });
}

function batchTargets(statuses: IntegrationStatus[], connecting: boolean): BatchTarget[] {
  return statuses
    .filter((status) => connecting ? connectable(status) : managedCandidate(status))
    .map(({ id, displayName }) => ({ id, displayName }));
}

function connectable(status: IntegrationStatus): boolean {
  return status.installation.state === "installed"
    && status.connection.state !== "stale"
    && status.connection.state !== "invalid_config";
}

function managedCandidate(status: IntegrationStatus): boolean {
  return status.connection.managedConfigPresent
    && (status.connection.state === "connected"
      || status.connection.state === "stale"
      || status.connection.state === "disconnected");
}

function displayState(status: IntegrationStatus): string {
  if (status.connection.state === "connected") return "connected";
  if (status.installation.state === "installed") return "installed";
  return status.installation.state.replace("_", " ");
}

function skip(status: IntegrationStatus, reason: string): { id: IntegrationId; displayName: string; reason: string } {
  return { id: status.id, displayName: status.displayName, reason };
}

function isInteractiveTerminal(stdin?: PickerStdin, stdout?: PickerStdout): boolean {
  return process.env.CI !== "true"
    && process.env.CI !== "1"
    && (stdin ?? process.stdin).isTTY === true
    && (stdout ?? process.stdout).isTTY === true;
}

function positionalArgs(args: string[]): string[] {
  const values: string[] = [];
  const valueOptions = new Set(["--scope", "--format"]);
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (arg.startsWith("--")) {
      if (valueOptions.has(arg)) index += 1;
      continue;
    }
    values.push(arg);
  }
  return values;
}

function integrationOptions(repoPath: string, scope: IntegrationScope | undefined, strict: boolean, noGuidance: boolean) {
  return { repoPath, ...(scope ? { scope } : {}), strict, noGuidance };
}

export async function runIntegrationConfigCommand(
  args: string[],
  resolveLaunch: ResolveDurableMcpLaunch = resolveDurableMcpLaunch,
): Promise<void> {
  const formatIndex = args.indexOf("--format");
  if (args[formatIndex + 1] !== "json") {
    throw new Error("Usage: code-atlas integration config --format json");
  }
  const reporter = createCliCommandReporter({ json: true });
  reporter.output(await resolveLaunch());
}

function readScope(args: string[]): IntegrationScope | undefined {
  const index = args.indexOf("--scope");
  if (index < 0) return undefined;
  const value = args[index + 1];
  if (value !== "user" && value !== "project") throw new Error("Scope must be `user` or `project`.");
  return value;
}

function assertAgentId(value: string, service: ReturnType<typeof createAgentIntegrationService>): IntegrationId {
  if (service.has(value)) return value as IntegrationId;
  throw new Error(`Unknown integration id \`${value}\`. Registered integrations: ${integrationIds(service)}.`);
}

function integrationIds(service: ReturnType<typeof createAgentIntegrationService>): string {
  return service.listDescriptors().map(({ id }) => id).join("|");
}
