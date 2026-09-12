import assert from "node:assert/strict";
import { execFile as execFileCallback, spawn } from "node:child_process";
import { access, chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";

import { initializeRepository } from "../src/core/repository/repository-init.service.js";
import { AgentIntegrationService } from "../src/core/integration/agent-integration.service.js";
import { IntegrationRegistry } from "../src/core/integration/integration-registry.js";
import { ClaudeIntegration } from "../src/infrastructure/integration/claude.adapter.js";
import { ClineIntegration } from "../src/infrastructure/integration/cline.adapter.js";
import { CodexIntegration } from "../src/infrastructure/integration/codex.adapter.js";
import { CursorIntegration } from "../src/infrastructure/integration/cursor.adapter.js";
import { GeminiIntegration } from "../src/infrastructure/integration/gemini.adapter.js";
import { OpenCodeIntegration } from "../src/infrastructure/integration/opencode.adapter.js";
import { WindsurfIntegration } from "../src/infrastructure/integration/windsurf.adapter.js";
import { ZooIntegration } from "../src/infrastructure/integration/zoo.adapter.js";
import { createAgentIntegrationService } from "../src/infrastructure/integration/default-integrations.js";
import { resolveIntegrationEnvironment } from "../src/infrastructure/integration/integration-environment.js";
import { claudeConfigPath, clineConfigPath, codexConfigPath, geminiConfigPath, openCodeConfigPath, windsurfConfigPath, zooConfigPath } from "../src/infrastructure/integration/config-paths.js";
import { resolveDurableMcpLaunch } from "../src/infrastructure/integration/mcp-launcher.js";
import { GitHookService } from "../src/core/integration/git-hook.service.js";

const execFile = promisify(execFileCallback);

async function fixture(name: string): Promise<{ root: string; home: string; bin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), `code-atlas-phase-11-${name}-`));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const command of ["codex", "opencode", "claude", "cursor-agent", "cline", "windsurf"]) {
    const commandPath = path.join(bin, command);
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n");
    await chmod(commandPath, 0o755);
  }
  const code = path.join(bin, "code");
  await writeFile(code, "#!/bin/sh\nprintf 'zoocodeorganization.zoo-code\\n'\n");
  await chmod(code, 0o755);
  return { root, home, bin };
}

function service(root: string, home: string, bin: string) {
  return createAgentIntegrationService({
    cwd: root,
    home,
    env: { PATH: bin },
    platform: "linux",
  });
}

test("Codex integration preserves unrelated TOML and is idempotent", async () => {
  const { root, home, bin } = await fixture("codex");
  try {
    const codexHome = path.join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    const configPath = path.join(codexHome, "config.toml");
    await writeFile(configPath, 'model = "test-model"\n\n[mcp_servers.other]\ncommand = "other"\nargs = ["serve"]\n');
    const integrations = service(root, home, bin);
    const options = { repoPath: root };

    const first = await integrations.install("codex", options);
    const afterFirst = await readFile(configPath, "utf8");
    const second = await integrations.install("codex", options);
    assert.equal(first.changed, true);
    assert.equal(second.changed, false);
    assert.equal(afterFirst, await readFile(configPath, "utf8"));
    const parsed = parseToml(afterFirst) as Record<string, any>;
    assert.equal(parsed.model, "test-model");
    assert.deepEqual(parsed.mcp_servers.other, { command: "other", args: ["serve"] });
    assert.deepEqual(parsed.mcp_servers["code-atlas"], {
      command: (await resolveDurableMcpLaunch()).command,
      args: ["mcp"],
      enabled: true,
    });

    const status = await integrations.status("codex", options);
    assert.equal(status.state, "installed");
    const removed = await integrations.uninstall("codex", options);
    assert.equal(removed.status.state, "not_installed");
    const afterRemove = parseToml(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(afterRemove.mcp_servers["code-atlas"], undefined);
    assert.deepEqual(afterRemove.mcp_servers.other, { command: "other", args: ["serve"] });
    assert.equal((await integrations.uninstall("codex", options)).changed, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("OpenCode supports JSONC and both MCP config shapes", async () => {
  const { root, home, bin } = await fixture("opencode");
  try {
    const configRoot = path.join(home, ".config", "opencode");
    await mkdir(configRoot, { recursive: true });
    const configPath = path.join(configRoot, "opencode.json");
    const source = '{\n  // keep this comment\n  "provider": { "name": "local" },\n  "mcp": {\n    "other": { "type": "local", "command": ["other"] },\n  },\n}\n';
    await writeFile(configPath, source);
    const integrations = service(root, home, bin);
    const options = { repoPath: root, scope: "user" as const };
    const installed = await integrations.install("opencode", options);
    const launch = await resolveDurableMcpLaunch();
    const updated = await readFile(configPath, "utf8");
    const parsed = parseJsonc(updated) as Record<string, any>;
    assert.equal(installed.status.state, "installed");
    assert.match(updated, /keep this comment/);
    assert.equal(parsed.provider.name, "local");
    assert.deepEqual(parsed.mcp["code-atlas"].command, [launch.command, ...launch.args]);
    assert.equal((await integrations.install("opencode", options)).changed, false);

    const projectConfig = path.join(root, "opencode.jsonc");
    await writeFile(projectConfig, '{ "mcp": { "servers": { "other": { "type": "local", "command": ["other"] } } } }');
    const projectOptions = { repoPath: root, scope: "project" as const };
    await integrations.install("opencode", projectOptions);
    const project = parseJsonc(await readFile(projectConfig, "utf8")) as Record<string, any>;
    assert.deepEqual(project.mcp.servers["code-atlas"].command, [launch.command, ...launch.args]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Claude Code uses project .mcp.json and never touches user session config", async () => {
  const { root, home, bin } = await fixture("claude");
  try {
    const configPath = path.join(root, ".mcp.json");
    await writeFile(configPath, '{\n  "mcpServers": { "other": { "command": "other", "args": [] } }\n}\n');
    const integrations = service(root, home, bin);
    const options = { repoPath: root };
    await integrations.install("claude", options);
    const launch = await resolveDurableMcpLaunch();
    const parsed = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(parsed.mcpServers["code-atlas"], { command: launch.command, args: launch.args });
    assert.deepEqual(parsed.mcpServers.other, { command: "other", args: [] });
    assert.equal((await integrations.install("claude", options)).changed, false);
    await integrations.uninstall("claude", options);
    assert.equal(parseJsonc(await readFile(configPath, "utf8")).mcpServers["code-atlas"], undefined);
    await assert.rejects(() => integrations.install("claude", { ...options, scope: "user" }), /project scope only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("reconnect migrates managed node plus dist launchers to the installed CLI executable", async () => {
  const { root, home, bin } = await fixture("launcher-migration");
  try {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(path.join(home, ".config", "opencode"), { recursive: true });
    const old = { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] };
    await writeFile(path.join(home, ".codex", "config.toml"), `[mcp_servers.code-atlas]\ncommand = "${old.command}"\nargs = ["${old.args[0]}", "mcp"]\n`);
    await writeFile(path.join(home, ".config", "opencode", "opencode.json"), JSON.stringify({ mcp: { "code-atlas": { type: "local", command: [old.command, ...old.args] } } }));
    const integrations = service(root, home, bin);
    const launch = await resolveDurableMcpLaunch();

    assert.equal((await integrations.status("codex", { repoPath: root })).state, "installed");
    assert.equal((await integrations.status("opencode", { repoPath: root, scope: "user" })).state, "installed");
    await integrations.install("codex", { repoPath: root });
    await integrations.install("opencode", { repoPath: root, scope: "user" });
    const codex = parseToml(await readFile(path.join(home, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    const openCode = parseJsonc(await readFile(path.join(home, ".config", "opencode", "opencode.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(codex.mcp_servers["code-atlas"], { command: launch.command, args: ["mcp"], enabled: true });
    assert.deepEqual(openCode.mcp["code-atlas"].command, [launch.command, "mcp"]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("legacy integration entries upgrade to the durable launcher", async () => {
  const { root, home, bin } = await fixture("legacy-upgrade");
  try {
    const openCodeRoot = path.join(home, ".config", "opencode");
    await mkdir(openCodeRoot, { recursive: true });
    await writeFile(path.join(openCodeRoot, "opencode.json"), '{ "mcp": { "code-atlas": { "type": "local", "command": ["code-atlas", "mcp"] } } }');
    await writeFile(path.join(root, ".mcp.json"), '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"] } } }');
    await mkdir(path.join(root, ".gemini"), { recursive: true });
    await writeFile(path.join(root, ".gemini", "settings.json"), '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"] } } }');
    await mkdir(path.join(home, ".cline"), { recursive: true });
    await writeFile(path.join(home, ".cline", "mcp.json"), '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"] } } }');
    await mkdir(path.join(home, ".codeium", "windsurf"), { recursive: true });
    await writeFile(path.join(home, ".codeium", "windsurf", "mcp_config.json"), '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"] } } }');
    await mkdir(path.join(root, ".roo"), { recursive: true });
    await writeFile(path.join(root, ".roo", "mcp.json"), '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"] } } }');
    const integrations = service(root, home, bin);
    const launch = await resolveDurableMcpLaunch();

    await integrations.install("opencode", { repoPath: root, scope: "user" });
    await integrations.install("claude", { repoPath: root });
    await integrations.install("gemini", { repoPath: root });
    await integrations.install("cline", { repoPath: root });
    await integrations.install("windsurf", { repoPath: root });
    await integrations.install("zoo", { repoPath: root });
    const openCode = parseJsonc(await readFile(path.join(openCodeRoot, "opencode.json"), "utf8")) as Record<string, any>;
    const claude = parseJsonc(await readFile(path.join(root, ".mcp.json"), "utf8")) as Record<string, any>;
    const gemini = parseJsonc(await readFile(path.join(root, ".gemini", "settings.json"), "utf8")) as Record<string, any>;
    const cline = parseJsonc(await readFile(path.join(home, ".cline", "mcp.json"), "utf8")) as Record<string, any>;
    const windsurf = parseJsonc(await readFile(path.join(home, ".codeium", "windsurf", "mcp_config.json"), "utf8")) as Record<string, any>;
    const zoo = parseJsonc(await readFile(path.join(root, ".roo", "mcp.json"), "utf8")) as Record<string, any>;
    assert.deepEqual(openCode.mcp["code-atlas"].command, [launch.command, ...launch.args]);
    assert.deepEqual(claude.mcpServers["code-atlas"], { command: launch.command, args: launch.args });
    assert.deepEqual(gemini.mcpServers["code-atlas"], { command: launch.command, args: launch.args });
    assert.deepEqual(cline.mcpServers["code-atlas"], { command: launch.command, args: launch.args, disabled: false });
    assert.deepEqual(windsurf.mcpServers["code-atlas"], { command: launch.command, args: launch.args });
    assert.deepEqual(zoo.mcpServers["code-atlas"], { command: launch.command, args: launch.args, disabled: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all adapters persist a launcher usable by a fresh minimal-PATH process", async () => {
  const { root, home, bin } = await fixture("fresh-process");
  try {
    const integrations = service(root, home, bin);
    await integrations.install("codex", { repoPath: root, noGuidance: true });
    await integrations.install("opencode", { repoPath: root, scope: "user", noGuidance: true });
    await integrations.install("claude", { repoPath: root, noGuidance: true });
    await integrations.install("gemini", { repoPath: root, noGuidance: true });
    await integrations.install("cursor", { repoPath: root, noGuidance: true });
    await integrations.install("cline", { repoPath: root, noGuidance: true });
    await integrations.install("windsurf", { repoPath: root, noGuidance: true });
    await integrations.install("zoo", { repoPath: root, noGuidance: true });

    const codex = parseToml(await readFile(path.join(home, ".codex", "config.toml"), "utf8")) as Record<string, any>;
    const openCode = parseJsonc(await readFile(path.join(home, ".config", "opencode", "opencode.json"), "utf8")) as Record<string, any>;
    const claude = parseJsonc(await readFile(path.join(root, ".mcp.json"), "utf8")) as Record<string, any>;
    const gemini = parseJsonc(await readFile(path.join(root, ".gemini", "settings.json"), "utf8")) as Record<string, any>;
    const cursor = parseJsonc(await readFile(path.join(root, ".cursor", "mcp.json"), "utf8")) as Record<string, any>;
    const cline = parseJsonc(await readFile(path.join(home, ".cline", "mcp.json"), "utf8")) as Record<string, any>;
    const windsurf = parseJsonc(await readFile(path.join(home, ".codeium", "windsurf", "mcp_config.json"), "utf8")) as Record<string, any>;
    const zoo = parseJsonc(await readFile(path.join(root, ".roo", "mcp.json"), "utf8")) as Record<string, any>;
    const launches = [
      { command: codex.mcp_servers["code-atlas"].command, args: codex.mcp_servers["code-atlas"].args },
      { command: openCode.mcp["code-atlas"].command[0], args: openCode.mcp["code-atlas"].command.slice(1) },
      claude.mcpServers["code-atlas"],
      gemini.mcpServers["code-atlas"],
      { command: cursor.mcpServers["code-atlas"].command, args: cursor.mcpServers["code-atlas"].args },
      { command: cline.mcpServers["code-atlas"].command, args: cline.mcpServers["code-atlas"].args },
      windsurf.mcpServers["code-atlas"],
      { command: zoo.mcpServers["code-atlas"].command, args: zoo.mcpServers["code-atlas"].args },
    ];
    for (const launch of launches) await assertFreshMcpInitialize(launch.command, launch.args, root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("all adapters report missing persisted durable launchers as stale", async () => {
  const { root, home, bin } = await fixture("stale-launchers");
  try {
    const missing = { command: path.join(root, "missing-node"), args: [path.join(root, "missing-cli.js"), "mcp"] };
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), `[mcp_servers.code-atlas]\ncommand = "${missing.command}"\nargs = ["${missing.args[0]}", "mcp"]\n`);
    const openCodeRoot = path.join(home, ".config", "opencode");
    await mkdir(openCodeRoot, { recursive: true });
    await writeFile(path.join(openCodeRoot, "opencode.json"), JSON.stringify({ mcp: { "code-atlas": { type: "local", command: [missing.command, ...missing.args] } } }));
    await writeFile(path.join(root, ".mcp.json"), JSON.stringify({ mcpServers: { "code-atlas": missing } }));
    await mkdir(path.join(root, ".gemini"), { recursive: true });
    await writeFile(path.join(root, ".gemini", "settings.json"), JSON.stringify({ mcpServers: { "code-atlas": missing } }));
    await mkdir(path.join(root, ".cursor"), { recursive: true });
    await writeFile(path.join(root, ".cursor", "mcp.json"), JSON.stringify({ mcpServers: { "code-atlas": { type: "stdio", ...missing } } }));
    await mkdir(path.join(home, ".cline"), { recursive: true });
    await writeFile(path.join(home, ".cline", "mcp.json"), JSON.stringify({ mcpServers: { "code-atlas": missing } }));
    await mkdir(path.join(home, ".codeium", "windsurf"), { recursive: true });
    await writeFile(path.join(home, ".codeium", "windsurf", "mcp_config.json"), JSON.stringify({ mcpServers: { "code-atlas": missing } }));
    await mkdir(path.join(root, ".roo"), { recursive: true });
    await writeFile(path.join(root, ".roo", "mcp.json"), JSON.stringify({ mcpServers: { "code-atlas": { ...missing, disabled: false } } }));
    const integrations = service(root, home, bin);

    assert.equal((await integrations.status("codex", { repoPath: root })).connection.state, "stale");
    assert.equal((await integrations.status("opencode", { repoPath: root, scope: "user" })).connection.state, "stale");
    assert.equal((await integrations.status("claude", { repoPath: root })).connection.state, "stale");
    assert.equal((await integrations.status("gemini", { repoPath: root })).connection.state, "stale");
    assert.equal((await integrations.status("cursor", { repoPath: root })).connection.state, "stale");
    assert.equal((await integrations.status("cline", { repoPath: root })).connection.state, "stale");
    assert.equal((await integrations.status("windsurf", { repoPath: root })).connection.state, "stale");
    assert.equal((await integrations.status("zoo", { repoPath: root })).connection.state, "stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("ephemeral launcher resolution fails before any adapter writes config", async () => {
  const { root, home, bin } = await fixture("ephemeral-connect");
  const ephemeralRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-ephemeral-package-"));
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const service = new AgentIntegrationService(
      new IntegrationRegistry([
        new CodexIntegration(environment),
        new OpenCodeIntegration(environment),
        new ClaudeIntegration(environment),
        new GeminiIntegration(environment),
        new CursorIntegration(environment),
        new ClineIntegration(environment),
        new WindsurfIntegration(environment),
        new ZooIntegration(environment, { listExtensions: async () => ["zoocodeorganization.zoo-code"] }),
      ]),
      { status: async () => false, install: async () => false, uninstall: async () => false },
      () => resolveDurableMcpLaunch(pathToFileURL(path.join(ephemeralRoot, "dist", "infrastructure", "integration", "mcp-launcher.js")).href),
    );
    for (const [id, options] of [
      ["codex", { repoPath: root }],
      ["opencode", { repoPath: root, scope: "user" as const }],
      ["claude", { repoPath: root }],
      ["gemini", { repoPath: root }],
      ["cursor", { repoPath: root }],
      ["cline", { repoPath: root }],
      ["windsurf", { repoPath: root }],
      ["zoo", { repoPath: root }],
    ] as const) {
      await assert.rejects(() => service.connect(id, options), /installed durably.*ephemeral installation/i);
    }
    await assert.rejects(() => access(path.join(home, ".codex", "config.toml")));
    await assert.rejects(() => access(path.join(home, ".config", "opencode", "opencode.json")));
    await assert.rejects(() => access(path.join(root, ".mcp.json")));
    await assert.rejects(() => access(path.join(root, ".gemini", "settings.json")));
    await assert.rejects(() => access(path.join(root, ".cursor", "mcp.json")));
    await assert.rejects(() => access(path.join(home, ".cline", "mcp.json")));
    await assert.rejects(() => access(path.join(home, ".codeium", "windsurf", "mcp_config.json")));
    await assert.rejects(() => access(path.join(root, ".roo", "mcp.json")));
  } finally {
    await rm(ephemeralRoot, { recursive: true, force: true });
    await rm(root, { recursive: true, force: true });
  }
});

async function assertFreshMcpInitialize(command: string, args: string[], cwd: string): Promise<void> {
  const child = spawn(command, args, {
    cwd,
    env: { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: cwd },
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout += chunk; });
  child.stderr.on("data", (chunk) => { stderr += chunk; });
  const response = await new Promise<Record<string, any>>((resolve, reject) => {
    const timeout = setTimeout(() => {
      child.kill();
      reject(new Error(`MCP initialize timed out. stderr: ${stderr}`));
    }, 10_000);
    child.on("error", (error) => {
      clearTimeout(timeout);
      reject(error);
    });
    child.stdout.on("data", () => {
      const line = stdout.trim().split("\n").find(Boolean);
      if (!line) return;
      try {
        const parsed = JSON.parse(line) as Record<string, any>;
        clearTimeout(timeout);
        child.kill();
        resolve(parsed);
      } catch {
        // Wait for a complete JSON-RPC message.
      }
    });
    child.stdin.write(`${JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "initialize",
      params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "batch-2", version: "1" } },
    })}\n`);
  });
  assert.equal(response.result.serverInfo.name, "code-atlas");
  assert.ok(stdout.trim().split("\n").every((line) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  }));
}

test("malformed config is reported without overwrite and strict guidance preserves other blocks", async () => {
  const { root, home, bin } = await fixture("safety");
  try {
    const codexHome = path.join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    const configPath = path.join(codexHome, "config.toml");
    await writeFile(configPath, "mcp_servers = [\n");
    const integrations = service(root, home, bin);
    const before = await readFile(configPath, "utf8");
    const status = await integrations.status("codex", { repoPath: root });
    assert.equal(status.state, "invalid_config");
    await assert.rejects(() => integrations.install("codex", { repoPath: root }), /Malformed configuration/);
    assert.equal(await readFile(configPath, "utf8"), before);
    await writeFile(configPath, 'model = "test"\n');

    await writeFile(path.join(root, "AGENTS.md"), "# Local\n\n<!-- gitnexus:start -->\nkeep\n<!-- gitnexus:end -->\n");
    await integrations.install("codex", { repoPath: root, strict: true });
    const guided = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.match(guided, /code-atlas:start/);
    assert.match(guided, /gitnexus:start/);
    assert.equal((await integrations.install("codex", { repoPath: root, strict: true })).strictGuidanceChanged, false);
    await integrations.uninstall("codex", { repoPath: root, strict: true });
    const restored = await readFile(path.join(root, "AGENTS.md"), "utf8");
    assert.equal(restored, "# Local\n\n<!-- gitnexus:start -->\nkeep\n<!-- gitnexus:end -->\n");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("configuration writes refuse broken symlinks and unsupported scopes", async () => {
  const { root, home, bin } = await fixture("config-safety");
  try {
    const configRoot = path.join(home, ".codex");
    await mkdir(configRoot, { recursive: true });
    const configPath = path.join(configRoot, "config.toml");
    await symlink(path.join(configRoot, "missing.toml"), configPath);
    const integrations = service(root, home, bin);
    await assert.rejects(() => integrations.install("codex", { repoPath: root }), /broken symlink/);
    await assert.rejects(() => integrations.install("codex", { repoPath: root, scope: "project" }), /user scope only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("init is idempotent, protects generated state, and does not index", async () => {
  const { root } = await fixture("init");
  try {
    await execFile("git", ["init", "-q"], { cwd: root });
    const first = await initializeRepository(root);
    const second = await initializeRepository(root);
    assert.equal(first.gitRepository, true);
    assert.equal(first.rootGitignoreChanged, true);
    assert.equal(second.rootGitignoreChanged, false);
    assert.equal(await readFile(path.join(root, ".gitignore"), "utf8"), ".codeatlas/\n");
    assert.equal(await readFile(path.join(root, ".codeatlas", ".gitignore"), "utf8"), "*\n!.gitignore\n");
    const db = path.join(root, ".codeatlas", "atlas.db");
    await (await import("node:fs/promises")).access(db);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Git hooks compose safely, execute refresh, and uninstall only CodeAtlas content", async () => {
  const { root, bin } = await fixture("hooks");
  const originalPath = process.env.PATH;
  try {
    await execFile("git", ["init", "-q"], { cwd: root });
    const marker = path.join(root, "hook-ran");
    const fakeCodeAtlas = path.join(bin, "code-atlas");
    await writeFile(fakeCodeAtlas, `#!/bin/sh\nprintf '%s' "$1" > "${marker}"\nexit 0\n`);
    await chmod(fakeCodeAtlas, 0o755);
    process.env.PATH = `${bin}${path.delimiter}${originalPath ?? ""}`;
    const hooks = new GitHookService(root);
    const hookPath = path.join(root, ".git", "hooks", "post-commit");
    await writeFile(hookPath, "#!/bin/sh\nprintf original > hook-original\n");
    await chmod(hookPath, 0o755);
    const installed = await hooks.install({ hooks: ["post-commit"] });
    assert.equal(installed.hooks["post-commit"].installed, true);
    await execFile(hookPath, [], { cwd: root, env: process.env });
    assert.equal(await readFile(marker, "utf8"), "sync");
    assert.equal(await readFile(path.join(root, "hook-original"), "utf8"), "original");
    await hooks.uninstall({ hooks: ["post-commit"] });
    const restored = await readFile(hookPath, "utf8");
    assert.match(restored, /hook-original/);
    assert.doesNotMatch(restored, /code-atlas:start/);
    assert.equal((await hooks.status()).hooks["post-commit"].installed, false);
  } finally {
    process.env.PATH = originalPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("integration paths accept injected platform environments", () => {
  const environment = resolveIntegrationEnvironment({
    platform: "linux",
    home: "/tmp/fake-home",
    cwd: "/tmp/fake-repo",
    env: { PATH: "/tmp/fake-bin" },
  });
  assert.equal(environment.home, "/tmp/fake-home");
  assert.equal(environment.cwd, "/tmp/fake-repo");
  assert.equal(environment.platform, "linux");

  const windows = resolveIntegrationEnvironment({
    platform: "win32",
    home: "C:\\Users\\test",
    cwd: "C:\\work\\repo",
    env: { APPDATA: "C:\\Users\\test\\AppData\\Roaming", PATH: "C:\\bin" },
  });
  assert.equal(codexConfigPath(windows), "C:\\Users\\test\\.codex\\config.toml");
  assert.equal(openCodeConfigPath(windows), "C:\\Users\\test\\AppData\\Roaming\\opencode\\opencode.json");
  assert.equal(claudeConfigPath(windows), "C:\\work\\repo\\.mcp.json");
  assert.equal(geminiConfigPath(windows, "project"), "C:\\work\\repo\\.gemini\\settings.json");
  assert.equal(geminiConfigPath(windows, "user"), "C:\\Users\\test\\.gemini\\settings.json");
  assert.equal(clineConfigPath(windows), "C:\\Users\\test\\.cline\\mcp.json");
  assert.equal(windsurfConfigPath(windows), "C:\\Users\\test\\.codeium\\windsurf\\mcp_config.json");
  assert.equal(zooConfigPath(windows), "C:\\work\\repo\\.roo\\mcp.json");
});
