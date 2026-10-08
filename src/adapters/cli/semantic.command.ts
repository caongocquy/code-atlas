import path from "node:path";
import { cancel, isCancel, select, text } from "@clack/prompts";

import { createCliCommandReporter } from "./cli-command-reporter.js";
import { formatSummary } from "./cli-output.js";
import {
  cleanSemanticIndex,
  disableSemanticProvider,
  getSemanticStatus,
  setupSemanticProvider,
  testSemanticProvider,
  upgradeSemanticProvider,
} from "../../infrastructure/semantic/semantic-lifecycle.service.js";
import { DEFAULT_LOCAL_EMBEDDING_MODEL } from "../../infrastructure/semantic/transformers-local-embedding-provider.js";

type SetupFlags = {
  provider?: "builtin-local" | "openai-compatible";
  model?: string;
  revision?: string;
  baseUrl?: string;
  apiKeyEnv?: string;
};

export async function runSemanticCommand(args: string[], cwd = path.resolve(".")): Promise<void> {
  const action = args[0];
  if (!action || !["setup", "status", "test", "upgrade", "disable", "clean"].includes(action)) {
    throw new Error("Usage: code-atlas semantic <setup|status|test|upgrade|disable|clean> [path] [options]");
  }
  const parsed = parseSemanticArgs(args.slice(1));
  const repoPath = parsed.paths[0] ? path.resolve(cwd, parsed.paths[0]) : cwd;
  const reporter = createCliCommandReporter({ command: "semantic", json: parsed.json });
  let result: unknown;

  switch (action) {
    case "setup": {
      const provider = await providerConfig(parsed.flags, !parsed.json);
      if (!provider) return;
      result = await reporter.run("Provisioning and probing semantic provider", (progress) =>
        setupSemanticProvider(repoPath, provider, {
          onProgress: (event) => progress.update(event.status === "progress_total"
            ? `Model download ${Math.round(event.progress ?? 0)}%`
            : event.file ? `Model file ${event.file}` : "Loading local model"),
        }), "vector");
      break;
    }
    case "status": result = await getSemanticStatus(repoPath); break;
    case "test": result = await reporter.run("Testing semantic provider", () => testSemanticProvider(repoPath), "vector"); break;
    case "upgrade": result = await reporter.run("Upgrading managed local semantic model", (progress) =>
      upgradeSemanticProvider(repoPath, { onProgress: (event) => progress.update(event.status === "progress_total"
        ? `Model download ${Math.round(event.progress ?? 0)}%`
        : event.file ? `Model file ${event.file}` : "Loading candidate model") }), "vector"); break;
    case "disable": result = await disableSemanticProvider(repoPath); break;
    case "clean": result = await cleanSemanticIndex(repoPath); break;
  }

  if (parsed.json) reporter.output({ action, result });
  else {
    const value = result as Record<string, unknown>;
    if (value.status === "missing_env") {
      reporter.warning(`Missing ${String(value.env)}. Export it and rerun semantic setup.`);
      return;
    }
    if (value.status === "externally_managed") {
      reporter.warning(String(value.message));
      return;
    }
    const rows = Object.entries(value)
      .flatMap(([label, item]) => item && typeof item === "object" && !Array.isArray(item)
        ? Object.entries(item).filter(([, nested]) => ["string", "number", "boolean"].includes(typeof nested)).map(([key, nested]) => ({ label: `${label}.${key}`, value: String(nested), tone: "default" as const }))
        : item === null || ["string", "number", "boolean"].includes(typeof item)
          ? [{ label, value: String(item), tone: label === "status" ? "success" as const : "default" as const }]
          : []);
    reporter.success(formatSummary(`Semantic ${action}`, rows));
  }
}

function parseSemanticArgs(args: string[]): { paths: string[]; json: boolean; flags: SetupFlags } {
  const paths: string[] = [];
  const flags: SetupFlags = {};
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]!;
    if (arg === "--json") { json = true; continue; }
    const key = arg.slice(2);
    if (arg.startsWith("--") && ["provider", "model", "revision", "base-url", "api-key-env"].includes(key)) {
      const value = args[++index];
      if (!value || value.startsWith("--")) throw new Error(`${arg} requires a value.`);
      if (key === "provider") {
        if (value !== "builtin-local" && value !== "openai-compatible") throw new Error("--provider must be builtin-local or openai-compatible.");
        flags.provider = value;
      } else if (key === "model") flags.model = value;
      else if (key === "revision") flags.revision = value;
      else if (key === "base-url") flags.baseUrl = value;
      else flags.apiKeyEnv = value;
      continue;
    }
    if (arg.startsWith("-")) throw new Error(`Unsupported semantic option: ${arg}`);
    paths.push(arg);
  }
  if (paths.length > 1) throw new Error("Specify at most one repository path.");
  return { paths, json, flags };
}

async function providerConfig(flags: SetupFlags, allowPrompt = true) {
  let providerType = flags.provider;
  const modelDefault = DEFAULT_LOCAL_EMBEDDING_MODEL;
  if (!providerType) {
    if (!allowPrompt || !process.stdin.isTTY || !process.stdout.isTTY) {
      throw new Error("Choose a provider with --provider builtin-local or --provider openai-compatible.");
    }
    const choice = await select({
      message: "Choose a semantic provider",
      options: [
        { value: "builtin-local" as const, label: "Built-in local", hint: "Transformers.js + ONNX" },
        { value: "openai-compatible" as const, label: "OpenAI-compatible endpoint" },
      ],
    });
    if (isCancel(choice)) return cancelSemanticSetup();
    providerType = choice;

    if (providerType === "builtin-local") {
      const model = flags.model ?? await promptValue("Hugging Face model", modelDefault);
      if (model === undefined) return;
      flags.model = model;
      const revision = flags.revision ?? await promptValue("Model revision", "main");
      if (revision === undefined) return;
      flags.revision = revision;
    } else {
      const baseUrl = flags.baseUrl ?? await promptValue("OpenAI-compatible base URL");
      if (baseUrl === undefined) return;
      flags.baseUrl = baseUrl;
      const model = flags.model ?? await promptValue("Embedding model");
      if (model === undefined) return;
      flags.model = model;
      const apiKeyEnv = flags.apiKeyEnv ?? await promptValue(
        "API key environment variable (blank for no auth)",
        undefined,
        "Leave blank for no authentication",
      );
      if (apiKeyEnv === undefined) return;
      flags.apiKeyEnv = apiKeyEnv || undefined;
    }
  }

  if (providerType === "builtin-local") {
    return {
      type: "builtin-local" as const,
      ...(flags.model ? { model: flags.model } : {}),
      ...(flags.revision ? { revision: flags.revision } : {}),
    };
  }
  if (!flags.baseUrl || !flags.model) throw new Error("OpenAI-compatible setup requires --base-url and --model.");
  return {
    type: "openai-compatible" as const,
    baseUrl: flags.baseUrl,
    model: flags.model,
    ...(flags.apiKeyEnv ? { apiKeyEnv: flags.apiKeyEnv } : {}),
  };
}

async function promptValue(message: string, defaultValue?: string, placeholder?: string): Promise<string | undefined> {
  const promptPlaceholder = placeholder ?? defaultValue;
  const value = await text({
    message,
    ...(defaultValue === undefined ? {} : { defaultValue }),
    ...(promptPlaceholder === undefined ? {} : { placeholder: promptPlaceholder }),
  });
  return isCancel(value) ? cancelSemanticSetup() : value.trim();
}

function cancelSemanticSetup(): undefined {
  process.exitCode = 130;
  cancel("Semantic setup cancelled");
  return undefined;
}
