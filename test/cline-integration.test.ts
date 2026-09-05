import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseJsonc } from "jsonc-parser";

import { ClineIntegration } from "../src/infrastructure/integration/cline.adapter.js";
import { clineConfigPath } from "../src/infrastructure/integration/config-paths.js";
import { resolveIntegrationEnvironment } from "../src/infrastructure/integration/integration-environment.js";

function launch() {
  return { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] };
}

async function fixture(): Promise<{ root: string; home: string; bin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-cline-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  const executable = path.join(bin, "cline");
  await writeFile(executable, "#!/bin/sh\n");
  await chmod(executable, 0o755);
  return { root, home, bin };
}

test("Cline uses its stable user MCP file and preserves settings and server metadata", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new ClineIntegration(environment);
    assert.deepEqual(integration.descriptor.scopes, ["user"]);
    const configPath = clineConfigPath(environment, "user");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      settings: { theme: "dark" },
      mcpServers: {
        other: { command: "other", args: ["serve"], disabled: true, autoApprove: ["safe"] },
      },
    }, null, 2));
    const options = { repoPath: root };

    const first = await integration.connect(options, launch());
    const config = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(first.changed, true);
    assert.equal((await integration.status(options)).state, "connected");
    assert.deepEqual(config.settings, { theme: "dark" });
    assert.deepEqual(config.mcpServers.other, { command: "other", args: ["serve"], disabled: true, autoApprove: ["safe"] });
    assert.deepEqual(config.mcpServers["code-atlas"], { ...launch(), disabled: false });
    assert.equal((await integration.connect(options, launch())).changed, false);
    await integration.disconnect(options);
    const disconnected = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(disconnected.mcpServers["code-atlas"], undefined);
    assert.deepEqual(disconnected.mcpServers.other, { command: "other", args: ["serve"], disabled: true, autoApprove: ["safe"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cline installation detection is independent from config and VS Code storage", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new ClineIntegration(environment);
    assert.deepEqual(await integration.detect({ repoPath: root }), { state: "installed", evidence: "cline executable found on PATH" });
    const internal = path.join(home, ".config", "Code", "User", "globalStorage", "saoudrizwan.claude-dev", "settings", "cline_mcp_settings.json");
    await mkdir(path.dirname(internal), { recursive: true });
    const internalContent = '{"mcpServers":{}}';
    await writeFile(internal, internalContent);
    assert.equal((await integration.status({ repoPath: root })).state, "disconnected");
    assert.equal((await integration.status({ repoPath: root })).configPath, clineConfigPath(environment, "user"));
    await integration.connect({ repoPath: root }, launch());
    assert.equal(await readFile(internal, "utf8"), internalContent);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cline maps disabled, stale, and malformed managed entries conservatively", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new ClineIntegration(environment);
    const configPath = clineConfigPath(environment, "user");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "code-atlas": { command: path.join(root, "missing-node"), args: [path.join(root, "missing-cli.js"), "mcp"], disabled: true },
      },
    }));
    assert.equal((await integration.status({ repoPath: root })).state, "stale");
    await writeFile(configPath, JSON.stringify({ mcpServers: { "code-atlas": { command: process.execPath, args: ["other"] , disabled: true } } }));
    assert.equal((await integration.status({ repoPath: root })).state, "invalid_config");
    await writeFile(configPath, JSON.stringify({ mcpServers: { "code-atlas": { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"], disabled: true } } }));
    assert.equal((await integration.status({ repoPath: root })).state, "disconnected");
    void bin;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cline upgrades legacy config and refuses unrelated code-atlas entries", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new ClineIntegration(environment);
    const configPath = clineConfigPath(environment, "user");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"], "autoApprove": ["search"] } } }');
    const options = { repoPath: root };
    assert.equal((await integration.status(options)).state, "connected");
    await integration.connect(options, launch());
    const upgraded = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(upgraded.mcpServers["code-atlas"], { ...launch(), disabled: false, autoApprove: ["search"] });

    await writeFile(configPath, '{ "mcpServers": { "code-atlas": { "command": "other", "args": ["serve"] } } }');
    await assert.rejects(() => integration.connect(options, launch()), /unrelated CodeAtlas-named Cline configuration/i);
    await integration.disconnect(options);
    const preserved = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(preserved.mcpServers["code-atlas"], { command: "other", args: ["serve"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
