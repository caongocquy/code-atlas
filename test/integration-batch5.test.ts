import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { runIntegrationCommand } from "../src/adapters/cli/integration.command.js";
import { createAgentIntegrationService } from "../src/infrastructure/integration/default-integrations.js";
import type { IntegrationStatus, IntegrationChange } from "../src/core/integration/integration.types.js";
import type { PickerStdin, PickerStdout } from "../src/adapters/cli/integration-picker.js";

const execFile = promisify(execFileCallback);
const cliPath = path.resolve("src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");

test("connect --all configures only detected integrations in registry order", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-batch5-all-"));
  const bin = path.join(root, "bin");
  try {
    await mkdir(bin);
    for (const id of ["codex", "opencode", "gemini", "cursor-agent", "cline", "windsurf"]) {
      await writeFile(path.join(bin, id), "#!/bin/sh\n");
      await chmod(path.join(bin, id), 0o755);
    }
    const code = path.join(bin, "code");
    await writeFile(code, "#!/bin/sh\nprintf 'zoocodeorganization.zoo-code\\n'\n");
    await chmod(code, 0o755);
    const result = await runCli(root, ["connect", "--all", "--json", "--no-guidance"], bin);
    const output = JSON.parse(result.stdout) as { results: Array<{ id: string }>; skipped: Array<{ id: string }> };
    assert.deepEqual(output.results.map(({ id }) => id), ["codex", "opencode", "gemini", "cursor", "cline", "windsurf", "zoo"]);
    assert.deepEqual(output.skipped.map(({ id }) => id), ["claude"]);
    assert.equal(await exists(path.join(root, ".codex-home", "config.toml")), true);
    assert.equal(await exists(path.join(root, ".xdg", "opencode", "opencode.json")), true);
    assert.equal(await exists(path.join(root, ".gemini", "settings.json")), true);
    assert.equal(await exists(path.join(root, ".cursor", "mcp.json")), true);
    assert.equal(await exists(path.join(root, ".cline", "mcp.json")), true);
    assert.equal(await exists(path.join(root, ".codeium", "windsurf", "mcp_config.json")), true);
    assert.equal(await exists(path.join(root, ".roo", "mcp.json")), true);
    assert.equal(await exists(path.join(root, ".mcp.json")), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disconnect --all removes managed entries and keeps unrelated client config", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-batch5-disconnect-"));
  const bin = path.join(root, "bin");
  try {
    await mkdir(bin);
    for (const id of ["codex", "opencode", "claude"]) {
      await writeFile(path.join(bin, id), "#!/bin/sh\n");
      await chmod(path.join(bin, id), 0o755);
    }
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({
      mcpServers: { other: { command: "other-client", args: ["serve"] } },
    }));
    await runCli(root, ["connect", "--all", "--json", "--no-guidance"], bin);
    await runCli(root, ["disconnect", "--all", "--json", "--no-guidance"], bin);
    const config = await readFile(path.join(root, ".mcp.json"), "utf8");
    assert.doesNotMatch(config, /code-atlas/);
    assert.match(config, /other-client/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("disconnect --all includes a managed disabled Cline entry", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-batch5-cline-disabled-"));
  const bin = path.join(root, "bin");
  try {
    await mkdir(bin);
    const cline = path.join(bin, "cline");
    await writeFile(cline, "#!/bin/sh\n");
    await chmod(cline, 0o755);
    const configPath = path.join(root, ".cline", "mcp.json");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "code-atlas": { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"], disabled: true },
      },
    }));
    const result = await runCli(root, ["disconnect", "--all", "--json", "--no-guidance"], bin);
    const output = JSON.parse(result.stdout) as { results: Array<{ id: string }> };
    assert.deepEqual(output.results.map(({ id }) => id), ["cline"]);
    assert.doesNotMatch(await readFile(configPath, "utf8"), /code-atlas/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("no-target JSON mode fails cleanly without opening a picker", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-batch5-json-"));
  try {
    await assert.rejects(
      () => runCli(root, ["connect", "--json"], ""),
      (error: unknown) => {
        const value = error as { stdout?: string; code?: number };
        assert.equal(value.code, 1);
        assert.deepEqual(JSON.parse(value.stdout ?? ""), {
          error: "An integration id is required in non-interactive mode; use an id, `--all`, or an interactive terminal.",
        });
        return true;
      },
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("batch execution continues after an individual integration failure", async () => {
  const statuses = ["codex", "opencode", "claude"].map((id) => ({
    id,
    displayName: id,
    installation: { state: "installed" as const },
    connection: { state: "disconnected" as const, managedConfigPresent: false, warnings: [] },
    state: "not_installed" as const,
    detected: true,
    configPath: "",
    scope: "project" as const,
    codeAtlasMcpConfigured: false,
    configurationValid: true,
    command: "code-atlas",
    args: ["mcp"],
    warnings: [],
  })) as IntegrationStatus[];
  const calls: string[] = [];
  const service = {
    list: async () => statuses,
    connect: async (id: string) => {
      calls.push(id);
      if (id === "opencode") throw new Error("test failure");
      return { id, displayName: id, operation: "connect" as const, changed: true, status: statuses[0].connection, strictGuidanceChanged: false };
    },
    reconcileGuidance: async () => false,
  } as ReturnType<typeof createAgentIntegrationService>;
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;
  try {
    await runIntegrationCommand(["connect", "--all", "--json", "--no-guidance"], "/repo", {
      createService: () => service,
    });
    assert.deepEqual(calls, ["codex", "opencode", "claude"]);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});

test("interactive connect passes only picker-selected integrations to the service", async () => {
  const statuses = ["codex", "opencode", "claude"].map((id, index) => ({
    id,
    displayName: id,
    installation: { state: index === 2 ? "not_detected" as const : "installed" as const },
    connection: {
      state: index === 0 ? "connected" as const : "disconnected" as const,
      managedConfigPresent: false,
      warnings: [],
    },
    state: "not_installed" as const,
    detected: index !== 2,
    configPath: "",
    scope: "project" as const,
    codeAtlasMcpConfigured: index === 0,
    configurationValid: true,
    command: "code-atlas",
    args: ["mcp"],
    warnings: [],
  })) as IntegrationStatus[];
  const connected: string[] = [];
  const service = {
    list: async () => statuses,
    connect: async (id: string): Promise<IntegrationChange> => {
      connected.push(id);
      return {
        id: id as IntegrationChange["id"],
        displayName: id,
        operation: "connect",
        changed: true,
        status: statuses[0].connection,
        strictGuidanceChanged: false,
      };
    },
    reconcileGuidance: async () => false,
  } as ReturnType<typeof createAgentIntegrationService>;
  const stdin = { isTTY: true } as PickerStdin;
  const stdout = { isTTY: true } as PickerStdout;
  const previousCi = process.env.CI;
  delete process.env.CI;
  try {
    await runIntegrationCommand(["connect", "--no-guidance"], "/repo", {
      createService: () => service,
      stdin,
      stdout,
      picker: async ({ rows }) => {
        assert.equal(rows[0].selected, false);
        assert.equal(rows[0].state, "connected");
        assert.equal(rows[2].selectable, false);
        return { kind: "confirmed", selected: ["opencode"] };
      },
    });
    assert.deepEqual(connected, ["opencode"]);
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
});

test("picker cancellation performs no integration or guidance writes", async () => {
  const statuses = [{
    id: "codex" as const,
    displayName: "Codex",
    installation: { state: "installed" as const },
    connection: { state: "disconnected" as const, managedConfigPresent: false, warnings: [] },
    state: "not_installed" as const,
    detected: true,
    configPath: "",
    scope: "user" as const,
    codeAtlasMcpConfigured: false,
    configurationValid: true,
    command: "code-atlas",
    args: ["mcp"],
    warnings: [],
  }];
  let writes = 0;
  const service = {
    list: async () => statuses,
    connect: async () => { writes += 1; throw new Error("must not connect"); },
    reconcileGuidance: async () => { writes += 1; return false; },
  } as ReturnType<typeof createAgentIntegrationService>;
  const previousCi = process.env.CI;
  delete process.env.CI;
  try {
    await runIntegrationCommand(["connect"], "/repo", {
      createService: () => service,
      stdin: { isTTY: true } as PickerStdin,
      stdout: { isTTY: true } as PickerStdout,
      picker: async () => ({ kind: "cancelled" }),
    });
    assert.equal(writes, 0);
  } finally {
    if (previousCi === undefined) delete process.env.CI;
    else process.env.CI = previousCi;
  }
});

test("disconnect keeps guidance while another managed integration remains", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-batch5-guidance-"));
  const bin = path.join(root, "bin");
  try {
    await mkdir(bin);
    for (const id of ["codex", "opencode"]) {
      await writeFile(path.join(bin, id), "#!/bin/sh\n");
      await chmod(path.join(bin, id), 0o755);
    }
    const service = createAgentIntegrationService({
      platform: "linux",
      cwd: root,
      home: root,
      env: {
        PATH: bin,
        CODEX_HOME: path.join(root, ".codex-home"),
        XDG_CONFIG_HOME: path.join(root, ".xdg"),
      },
    });
    const options = { repoPath: root };
    await service.connect("codex", options);
    await service.connect("opencode", options);
    const guidancePath = path.join(root, "AGENTS.md");
    assert.match(await readFile(guidancePath, "utf8"), /code-atlas:start/);
    await service.disconnect("codex", options);
    assert.match(await readFile(guidancePath, "utf8"), /code-atlas:start/);
    await service.disconnect("opencode", options);
    assert.doesNotMatch(await readFile(guidancePath, "utf8"), /code-atlas:start/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function runCli(root: string, args: string[], bin: string): Promise<{ stdout: string; stderr: string }> {
  return execFile(process.execPath, ["--import", tsxLoader, cliPath, ...args], {
    cwd: root,
    env: {
      ...process.env,
      PATH: bin,
      HOME: root,
      NODE_PATH: undefined,
      CODEX_HOME: path.join(root, ".codex-home"),
      XDG_CONFIG_HOME: path.join(root, ".xdg"),
      NO_COLOR: "1",
    },
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await readFile(filePath);
    return true;
  } catch {
    return false;
  }
}
