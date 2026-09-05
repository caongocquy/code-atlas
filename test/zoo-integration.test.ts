import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseJsonc } from "jsonc-parser";

import { ZooIntegration } from "../src/infrastructure/integration/zoo.adapter.js";
import { zooConfigPath } from "../src/infrastructure/integration/config-paths.js";
import { resolveIntegrationEnvironment } from "../src/infrastructure/integration/integration-environment.js";

function launch() {
  return { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] };
}

async function fixture(): Promise<{ root: string; home: string; bin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-zoo-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  return { root, home, bin };
}

function installedZoo() {
  return { listExtensions: async () => ["zoocodeorganization.zoo-code"] };
}

test("Zoo uses project .roo/mcp.json, preserves data, and manages disabled state", async () => {
  const { root, home } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new ZooIntegration(environment, installedZoo());
    assert.deepEqual(integration.descriptor.scopes, ["project"]);
    assert.equal(zooConfigPath(environment), path.join(root, ".roo", "mcp.json"));
    const configPath = zooConfigPath(environment);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      settings: { theme: "dark" },
      mcpServers: { other: { command: "other", args: ["serve"], disabled: true, alwaysAllow: ["safe"] } },
    }, null, 2));
    const options = { repoPath: root };
    assert.equal((await integration.connect(options, launch())).changed, true);
    const config = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(config.settings, { theme: "dark" });
    assert.deepEqual(config.mcpServers.other, { command: "other", args: ["serve"], disabled: true, alwaysAllow: ["safe"] });
    assert.deepEqual(config.mcpServers["code-atlas"], { ...launch(), disabled: false });
    assert.equal((await integration.connect(options, launch())).changed, false);
    await integration.disconnect(options);
    const disconnected = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(disconnected.mcpServers["code-atlas"], undefined);
    assert.deepEqual(disconnected.mcpServers.other, { command: "other", args: ["serve"], disabled: true, alwaysAllow: ["safe"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Zoo detection uses the official extension evidence and ignores config existence", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const configPath = zooConfigPath(environment);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"mcpServers":{}}');
    assert.deepEqual(await new ZooIntegration(environment, { listExtensions: async () => [] }).detect({ repoPath: root }), {
      state: "not_detected",
      evidence: "Zoo Code extension not detected",
    });
    assert.deepEqual(await new ZooIntegration(environment, installedZoo()).detect({ repoPath: root }), {
      state: "installed",
      evidence: "Zoo Code extension zoocodeorganization.zoo-code found",
    });
    void bin;
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Zoo maps disabled, stale, malformed, and legacy entries safely", async () => {
  const { root, home } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new ZooIntegration(environment, installedZoo());
    const configPath = zooConfigPath(environment);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({ mcpServers: { "code-atlas": { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"], disabled: true } } }));
    assert.equal((await integration.status({ repoPath: root })).state, "disconnected");
    await writeFile(configPath, JSON.stringify({ mcpServers: { "code-atlas": { command: path.join(root, "missing-node"), args: [path.join(root, "missing-cli"), "mcp"], disabled: true } } }));
    assert.equal((await integration.status({ repoPath: root })).state, "stale");
    await writeFile(configPath, '{"mcpServers":{"code-atlas":{"command":"/usr/bin/node","args":["other"]}}}');
    assert.equal((await integration.status({ repoPath: root })).state, "invalid_config");
    await writeFile(configPath, '{"mcpServers":{"code-atlas":{"command":"code-atlas","args":["mcp"]}}}');
    assert.equal((await integration.status({ repoPath: root })).state, "connected");
    await integration.connect({ repoPath: root }, launch());
    assert.deepEqual((parseJsonc(await readFile(configPath, "utf8")) as any).mcpServers["code-atlas"], { ...launch(), disabled: false });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Zoo does not write VS Code globalStorage", async () => {
  const { root, home } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new ZooIntegration(environment, installedZoo());
    const internal = path.join(home, ".config", "Code", "User", "globalStorage", "zoocodeorganization.zoo-code", "mcp_settings.json");
    await mkdir(path.dirname(internal), { recursive: true });
    await writeFile(internal, '{"mcpServers":{}}');
    await integration.connect({ repoPath: root }, launch());
    assert.equal(await readFile(internal, "utf8"), '{"mcpServers":{}}');
    assert.equal((parseJsonc(await readFile(zooConfigPath(environment), "utf8")) as any).mcpServers["code-atlas"].disabled, false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
