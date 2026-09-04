import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import { parse as parseToml } from "smol-toml";
import { parse as parseJsonc } from "jsonc-parser";

import { initializeRepository } from "../src/core/repository/repository-init.service.js";
import { createAgentIntegrationService } from "../src/infrastructure/integration/default-integrations.js";
import { resolveIntegrationEnvironment } from "../src/infrastructure/integration/integration-environment.js";
import { claudeConfigPath, codexConfigPath, openCodeConfigPath } from "../src/infrastructure/integration/config-paths.js";
import { GitHookService } from "../src/core/integration/git-hook.service.js";

const execFile = promisify(execFileCallback);

async function fixture(name: string): Promise<{ root: string; home: string; bin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), `code-atlas-phase-11-${name}-`));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  for (const command of ["codex", "opencode", "claude"]) {
    const commandPath = path.join(bin, command);
    await writeFile(commandPath, "#!/bin/sh\nexit 0\n");
    await chmod(commandPath, 0o755);
  }
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
      command: process.execPath,
      args: [path.resolve("dist/cli.js"), "mcp"],
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
    const updated = await readFile(configPath, "utf8");
    const parsed = parseJsonc(updated) as Record<string, any>;
    assert.equal(installed.status.state, "installed");
    assert.match(updated, /keep this comment/);
    assert.equal(parsed.provider.name, "local");
    assert.deepEqual(parsed.mcp["code-atlas"].command, ["code-atlas", "mcp"]);
    assert.equal((await integrations.install("opencode", options)).changed, false);

    const projectConfig = path.join(root, "opencode.jsonc");
    await writeFile(projectConfig, '{ "mcp": { "servers": { "other": { "type": "local", "command": ["other"] } } } }');
    const projectOptions = { repoPath: root, scope: "project" as const };
    await integrations.install("opencode", projectOptions);
    const project = parseJsonc(await readFile(projectConfig, "utf8")) as Record<string, any>;
    assert.deepEqual(project.mcp.servers["code-atlas"].command, ["code-atlas", "mcp"]);
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
    const parsed = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(parsed.mcpServers["code-atlas"], { command: "code-atlas", args: ["mcp"] });
    assert.deepEqual(parsed.mcpServers.other, { command: "other", args: [] });
    assert.equal((await integrations.install("claude", options)).changed, false);
    await integrations.uninstall("claude", options);
    assert.equal(parseJsonc(await readFile(configPath, "utf8")).mcpServers["code-atlas"], undefined);
    await assert.rejects(() => integrations.install("claude", { ...options, scope: "user" }), /project scope only/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

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
});
