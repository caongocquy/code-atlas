import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import { access, mkdtemp, rm } from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import test from "node:test";

import { runIntegrationConfigCommand } from "../src/adapters/cli/integration.command.js";
import { createIntegrationRegistry } from "../src/infrastructure/integration/default-integrations.js";
import { resolveDurableMcpLaunch } from "../src/infrastructure/integration/mcp-launcher.js";

const execFile = promisify(execFileCallback);
const cliPath = path.resolve("src/cli.ts");
const tsxLoader = createRequire(import.meta.url).resolve("tsx/esm");

test("integration config exports a durable JSON launch from any cwd", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "code-atlas-config-export-"));
  try {
    const env = { ...process.env, PATH: "/usr/bin:/bin", HOME: cwd };
    delete env.NODE_PATH;
    const result = await execFile(process.execPath, [
      "--import",
      tsxLoader,
      cliPath,
      "integration",
      "config",
      "--format",
      "json",
    ], { cwd, env });
    const launch = JSON.parse(result.stdout) as { command: string; args: string[] };

    assert.equal(result.stderr, "");
    assert.deepEqual(Object.keys(launch), ["command", "args"]);
    assert.equal(path.isAbsolute(launch.command), true);
    assert.equal(path.isAbsolute(launch.args[0] ?? ""), true);
    assert.deepEqual(launch.args.slice(1), ["mcp"]);
    await access(launch.command);
    await access(launch.args[0]!);
    await assert.rejects(() => access(path.join(cwd, ".codeatlas")));
    await assert.rejects(() => access(path.join(cwd, ".mcp.json")));
    await assert.rejects(() => access(path.join(cwd, ".codex-home")));
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("generic config export is discoverable but is not a registered integration", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "code-atlas-config-help-"));
  try {
    const env = { ...process.env, PATH: "/usr/bin:/bin", HOME: cwd };
    delete env.NODE_PATH;
    const result = await execFile(process.execPath, ["--import", tsxLoader, cliPath, "--help"], { cwd, env });
    assert.match(result.stdout, /integration config --format json/);
    assert.deepEqual(
      createIntegrationRegistry({ platform: "linux", cwd, home: cwd, env: { PATH: "/usr/bin:/bin" } })
        .list()
        .map(({ descriptor }) => descriptor.id),
      ["codex", "opencode", "claude"],
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("unsupported config format fails without partial stdout", async () => {
  const cwd = await mkdtemp(path.join(tmpdir(), "code-atlas-config-format-"));
  try {
    const env = { ...process.env, PATH: "/usr/bin:/bin", HOME: cwd };
    delete env.NODE_PATH;
    await assert.rejects(
      () => execFile(process.execPath, ["--import", tsxLoader, cliPath, "integration", "config", "--format", "toml"], { cwd, env }),
      (error: unknown) => {
        assert.equal(typeof error, "object");
        assert.equal((error as { stdout?: string }).stdout, "");
        assert.match((error as { stderr?: string }).stderr ?? "", /Usage: code-atlas integration config --format json/);
        return true;
      },
    );
  } finally {
    await rm(cwd, { recursive: true, force: true });
  }
});

test("config export preserves the shared ephemeral-install rejection", async () => {
  const ephemeralRoot = await mkdtemp(path.join(tmpdir(), "code-atlas-config-ephemeral-"));
  try {
    await assert.rejects(
      () => runIntegrationConfigCommand(
        ["config", "--format", "json"],
        () => resolveDurableMcpLaunch(pathToFileURL(path.join(ephemeralRoot, "dist", "infrastructure", "integration", "mcp-launcher.js")).href),
      ),
      /ephemeral installation.*install CodeAtlas durably/i,
    );
  } finally {
    await rm(ephemeralRoot, { recursive: true, force: true });
  }
});
