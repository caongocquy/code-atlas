import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseJsonc } from "jsonc-parser";

import { WindsurfIntegration } from "../src/infrastructure/integration/windsurf.adapter.js";
import { windsurfConfigPath } from "../src/infrastructure/integration/config-paths.js";
import { resolveIntegrationEnvironment } from "../src/infrastructure/integration/integration-environment.js";

function launch() {
  return { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] };
}

async function fixture(): Promise<{ root: string; home: string; bin: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-windsurf-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  await mkdir(home, { recursive: true });
  await mkdir(bin, { recursive: true });
  return { root, home, bin };
}

test("Windsurf uses its stable user MCP file and preserves unrelated data", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const integration = new WindsurfIntegration(environment);
    assert.deepEqual(integration.descriptor.scopes, ["user"]);
    assert.equal(integration.descriptor.supportsEnablement, false);
    const configPath = windsurfConfigPath(environment, "user");
    assert.equal(configPath, path.join(home, ".codeium", "windsurf", "mcp_config.json"));
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      settings: { theme: "dark" },
      mcpServers: { other: { command: "other", args: ["serve"], env: { KEEP: "yes" } } },
    }, null, 2));
    const options = { repoPath: root };

    const first = await integration.connect(options, launch());
    const config = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(first.changed, true);
    assert.deepEqual(config.settings, { theme: "dark" });
    assert.deepEqual(config.mcpServers.other, { command: "other", args: ["serve"], env: { KEEP: "yes" } });
    assert.deepEqual(config.mcpServers["code-atlas"], launch());
    assert.equal((await integration.connect(options, launch())).changed, false);
    await integration.disconnect(options);
    const disconnected = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(disconnected.mcpServers["code-atlas"], undefined);
    assert.deepEqual(disconnected.mcpServers.other, { command: "other", args: ["serve"], env: { KEEP: "yes" } });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windsurf detection does not infer installation from config", async () => {
  const { root, home, bin } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new WindsurfIntegration(environment);
    await mkdir(path.dirname(windsurfConfigPath(environment)), { recursive: true });
    await writeFile(windsurfConfigPath(environment), '{"mcpServers":{}}');
    assert.deepEqual(await integration.detect({ repoPath: root }), {
      state: "not_detected",
      evidence: "Windsurf application or executable not detected",
    });
    const executable = path.join(bin, "windsurf");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
    const detected = new WindsurfIntegration(resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } }));
    assert.deepEqual(await detected.detect({ repoPath: root }), {
      state: "installed",
      evidence: "windsurf executable found on PATH",
    });
    const appPath = path.join(home, "Applications", "Windsurf.app");
    await mkdir(appPath, { recursive: true });
    const appDetected = new WindsurfIntegration(resolveIntegrationEnvironment({ platform: "darwin", cwd: root, home, env: { PATH: "" } }));
    assert.deepEqual(await appDetected.detect({ repoPath: root }), {
      state: "installed",
      evidence: `Windsurf app found at ${appPath}`,
    });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windsurf recognizes legacy and durable ownership without deleting unrelated code-atlas", async () => {
  const { root, home } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new WindsurfIntegration(environment);
    const configPath = windsurfConfigPath(environment);
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{"mcpServers":{"code-atlas":{"command":"code-atlas","args":["mcp"]}}}');
    assert.equal((await integration.status({ repoPath: root })).state, "connected");
    await integration.connect({ repoPath: root }, launch());
    assert.deepEqual((parseJsonc(await readFile(configPath, "utf8")) as any).mcpServers["code-atlas"], launch());
    await writeFile(configPath, '{"mcpServers":{"code-atlas":{"command":"other","args":["serve"]}}}');
    assert.equal((await integration.status({ repoPath: root })).state, "invalid_config");
    await assert.rejects(() => integration.connect({ repoPath: root }, launch()), /unrelated CodeAtlas-named Windsurf/i);
    await integration.disconnect({ repoPath: root });
    assert.match(await readFile(configPath, "utf8"), /"command":"other"/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
