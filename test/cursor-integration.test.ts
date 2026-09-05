import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { parse as parseJsonc } from "jsonc-parser";

import { CursorIntegration } from "../src/infrastructure/integration/cursor.adapter.js";
import { cursorConfigPath } from "../src/infrastructure/integration/config-paths.js";
import { resolveIntegrationEnvironment } from "../src/infrastructure/integration/integration-environment.js";

function launch() {
  return { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] };
}

async function fixture(): Promise<{ root: string; home: string }> {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-cursor-"));
  const home = path.join(root, "home");
  await mkdir(home, { recursive: true });
  return { root, home };
}

test("Cursor uses official project stdio settings and preserves unrelated servers", async () => {
  const { root, home } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new CursorIntegration(environment);
    const configPath = cursorConfigPath(environment, "project");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      editor: { theme: "dark" },
      mcpServers: { other: { type: "stdio", command: "other", args: ["serve"] } },
    }, null, 2));
    const options = { repoPath: root };

    const first = await integration.connect(options, launch());
    const config = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(first.changed, true);
    assert.equal((await integration.status(options)).state, "connected");
    assert.deepEqual(config.editor, { theme: "dark" });
    assert.deepEqual(config.mcpServers.other, { type: "stdio", command: "other", args: ["serve"] });
    assert.deepEqual(config.mcpServers["code-atlas"], { type: "stdio", ...launch() });
    assert.equal((await integration.connect(options, launch())).changed, false);
    await integration.disconnect(options);
    const disconnected = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.equal(disconnected.mcpServers["code-atlas"], undefined);
    assert.deepEqual(disconnected.mcpServers.other, { type: "stdio", command: "other", args: ["serve"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor supports explicit user scope and path precedence", async () => {
  const { root, home } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new CursorIntegration(environment);
    const options = { repoPath: root, scope: "user" as const };
    await integration.connect(options, launch());
    assert.equal((await integration.status(options)).scope, "user");
    assert.equal((await integration.status({ repoPath: root })).state, "disconnected");
    assert.match(cursorConfigPath(environment, "user"), /home[\\/]\.cursor[\\/]mcp\.json$/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor distinguishes detection from config and reports stale or invalid entries", async () => {
  const { root, home } = await fixture();
  try {
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const integration = new CursorIntegration(environment);
    const configPath = cursorConfigPath(environment, "project");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, JSON.stringify({
      mcpServers: {
        "code-atlas": { type: "stdio", command: path.join(root, "missing-node"), args: [path.join(root, "missing-cli.js"), "mcp"] },
      },
    }));
    assert.equal((await integration.detect({ repoPath: root })).state, "not_detected");
    assert.equal((await integration.status({ repoPath: root })).state, "stale");

    await writeFile(configPath, '{ "mcpServers": { "code-atlas": { "type": "stdio", "command": "other", "args": ["serve"] } } }');
    assert.equal((await integration.status({ repoPath: root })).state, "invalid_config");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor accepts the documented cursor-agent executable as installation evidence", async () => {
  const { root, home } = await fixture();
  try {
    const bin = path.join(root, "bin");
    await mkdir(bin);
    const executable = path.join(bin, "cursor-agent");
    await writeFile(executable, "#!/bin/sh\n");
    await chmod(executable, 0o755);
    const environment = resolveIntegrationEnvironment({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const detection = await new CursorIntegration(environment).detect({ repoPath: root });
    assert.deepEqual(detection, { state: "installed", evidence: "cursor-agent executable found on PATH" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Cursor recognizes macOS app evidence and legacy entries, without deleting unrelated code-atlas", async () => {
  const { root, home } = await fixture();
  try {
    await mkdir(path.join(home, "Applications", "Cursor.app"), { recursive: true });
    const environment = resolveIntegrationEnvironment({ platform: "darwin", cwd: root, home, env: { PATH: "" } });
    const integration = new CursorIntegration(environment);
    assert.equal((await integration.detect({ repoPath: root })).state, "installed");

    const configPath = cursorConfigPath(environment, "project");
    await mkdir(path.dirname(configPath), { recursive: true });
    await writeFile(configPath, '{ "mcpServers": { "code-atlas": { "command": "code-atlas", "args": ["mcp"] }, "other": { "type": "stdio", "command": "other", "args": ["serve"] } } }');
    const options = { repoPath: root };
    assert.equal((await integration.status(options)).state, "connected");
    await integration.connect(options, launch());
    const upgraded = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(upgraded.mcpServers["code-atlas"], { type: "stdio", ...launch() });

    await writeFile(configPath, '{ "mcpServers": { "code-atlas": { "type": "stdio", "command": "other", "args": ["serve"] }, "other": { "type": "stdio", "command": "other", "args": ["serve"] } } }');
    await integration.disconnect(options);
    const preserved = parseJsonc(await readFile(configPath, "utf8")) as Record<string, any>;
    assert.deepEqual(preserved.mcpServers["code-atlas"], { type: "stdio", command: "other", args: ["serve"] });
    assert.deepEqual(preserved.mcpServers.other, { type: "stdio", command: "other", args: ["serve"] });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
