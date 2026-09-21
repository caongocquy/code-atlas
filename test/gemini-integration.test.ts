import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseJsonc } from "jsonc-parser";

import { GeminiIntegration } from "../src/infrastructure/integration/gemini.adapter.js";
import { geminiConfigPath } from "../src/infrastructure/integration/config-paths.js";
import { resolveIntegrationEnvironment } from "../src/infrastructure/integration/integration-environment.js";

async function fixture(): Promise<{ root: string; home: string; bin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-gemini-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  await writeFile(path.join(bin, "gemini"), "#!/bin/sh\n");
  await chmod(path.join(bin, "gemini"), 0o755);
  return { root, home, bin };
}

function launch() {
  return { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] };
}

test("Gemini detects its executable independently from settings and uses project JSON settings", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new GeminiIntegration(environment);
    assert.equal((await integration.detect({ repoPath: root })).state, "installed");
    assert.equal(geminiConfigPath(environment, "project"), path.join(root, ".gemini", "settings.json"));
    assert.equal(geminiConfigPath(environment, "user"), path.join(home, ".gemini", "settings.json"));

    await mkdir(path.dirname(geminiConfigPath(environment, "project")), { recursive: true });
    await writeFile(geminiConfigPath(environment, "project"), JSON.stringify({
      theme: "dark",
      mcpServers: { other: { command: "other", args: ["serve"] } },
    }, null, 2));
    const options = { repoPath: root };
    const first = await integration.connect(options, launch());
    const configPath = geminiConfigPath(environment, "project");
    const config = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(first.changed, true);
    assert.equal((await integration.status(options)).state, "connected");
    assert.equal(config.theme, "dark");
    assert.deepEqual(config.mcpServers.other, { command: "other", args: ["serve"] });
    assert.deepEqual(config.mcpServers["code-atlas"], launch());
    assert.equal((await integration.connect(options, launch())).changed, false);
    await integration.disconnect(options);
    const disconnected = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(disconnected.mcpServers["code-atlas"], undefined);
    assert.deepEqual(disconnected.mcpServers.other, { command: "other", args: ["serve"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini does not claim or mutate external enablement state", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new GeminiIntegration(environment);
    assert.equal(integration.descriptor.supportsEnablement, false);
    const enablementPath = path.join(home, ".gemini", "mcp-server-enablement.json");
    await mkdir(path.dirname(enablementPath), { recursive: true });
    const enablement = JSON.stringify({ "other-server": { enabled: false } }, null, 2);
    await writeFile(enablementPath, enablement);

    await integration.connect({ repoPath: root }, launch());
    await integration.disconnect({ repoPath: root });

    assert.equal(await readFile(enablementPath, "utf8"), enablement);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini supports explicit user scope without reading the developer home", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new GeminiIntegration(environment);
    const options = { repoPath: root, scope: "user" as const };
    await integration.connect(options, launch());
    assert.equal(await access(geminiConfigPath(environment, "user")).then(() => true), true);
    assert.equal((await integration.status(options)).scope, "user");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini reports stale durable launches and invalid managed config separately", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new GeminiIntegration(environment);
    const configPath = geminiConfigPath(environment, "project");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "code-atlas": { command: path.join(root, "missing-node"), args: [path.join(root, "missing-cli.js"), "mcp"] },
      },
    }));
    assert.equal((await integration.status({ repoPath: root })).state, "stale");
    await writeFile(configPath, '{ "mcpServers": { "code-atlas": { "command": "other" } } }');
    assert.equal((await integration.status({ repoPath: root })).state, "invalid_config");
    assert.equal((await integration.detect({ repoPath: root })).state, "not_detected");
    void home;
    void bin;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Gemini recognizes legacy code-atlas mcp and reconnect upgrades it", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new GeminiIntegration(environment);
    const configPath = geminiConfigPath(environment, "project");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"] } } }');
    assert.equal((await integration.status({ repoPath: root })).state, "connected");
    await integration.connect({ repoPath: root }, launch());
    const config = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(config.mcpServers["code-atlas"], launch());
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
