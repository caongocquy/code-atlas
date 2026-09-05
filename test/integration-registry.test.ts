import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { AgentIntegrationService } from "../src/core/integration/agent-integration.service.js";
import { IntegrationRegistry } from "../src/core/integration/integration-registry.js";
import type {
  IntegrationAdapter,
  IntegrationChange,
  IntegrationContext,
  IntegrationOptions,
} from "../src/core/integration/integration.types.js";
import { createAgentIntegrationService, createIntegrationRegistry } from "../src/infrastructure/integration/default-integrations.js";

const options: IntegrationOptions = { repoPath: "/repo" };

function adapter(id: "codex" | "opencode" | "claude"): IntegrationAdapter {
  const status = {
    state: "connected" as const,
    configPath: `/home/test/${id}.config`,
    scope: "user" as const,
    managedConfigPresent: true,
    warnings: [],
  };
  return {
    descriptor: {
      id,
      displayName: id,
      scopes: ["user"],
      configFormat: "json",
      supportsEnablement: false,
    },
    async detect(_context: IntegrationContext) {
      return { state: "installed" as const, evidence: `${id} executable` };
    },
    async status(_options: IntegrationOptions) {
      return status;
    },
    async connect(_options: IntegrationOptions): Promise<IntegrationChange> {
      return { id, displayName: id, operation: "connect", changed: true, status, strictGuidanceChanged: false };
    },
    async disconnect(_options: IntegrationOptions): Promise<IntegrationChange> {
      return { id, displayName: id, operation: "disconnect", changed: true, status: { ...status, state: "disconnected" }, strictGuidanceChanged: false };
    },
  };
}

test("IntegrationRegistry preserves deterministic order and supports lookup", () => {
  const codex = adapter("codex");
  const opencode = adapter("opencode");
  const registry = new IntegrationRegistry([codex, opencode]);

  assert.deepEqual(registry.list(), [codex, opencode]);
  assert.equal(registry.get("opencode"), opencode);
  assert.equal(registry.get("claude"), undefined);
  assert.equal(registry.has("codex"), true);
  assert.equal(registry.has("claude"), false);
});

test("IntegrationRegistry rejects duplicate ids", () => {
  assert.throws(() => new IntegrationRegistry([adapter("codex"), adapter("codex")]), /duplicate integration id.*codex/i);
});

test("default registry contains exactly the current integrations", () => {
  const ids = createIntegrationRegistry({
    platform: "linux",
    home: "/tmp/home",
    cwd: "/tmp/repo",
    env: { PATH: "/tmp/bin" },
  }).list().map((integration) => integration.descriptor.id);
  assert.deepEqual(ids, ["codex", "opencode", "claude", "gemini", "cursor", "cline", "windsurf", "zoo"]);
  assert.equal(ids.includes("mcp" as never), false);
  assert.equal(ids.includes("roo" as never), false);
});

test("service combines independent installation detection and connection status", async () => {
  const integration = adapter("codex");
  const service = new AgentIntegrationService(new IntegrationRegistry([integration]), {
    status: async () => false,
    install: async () => false,
    uninstall: async () => false,
  }, async () => ({ command: "/usr/bin/node", args: ["/repo/dist/cli.js", "mcp"] }));

  const status = await service.status("codex", options);
  assert.equal(status.installation.state, "installed");
  assert.equal(status.connection.state, "connected");
  assert.equal(status.id, "codex");
});

test("service gives an actionable error for an unknown integration", async () => {
  const service = new AgentIntegrationService(new IntegrationRegistry([adapter("codex")]), {
    status: async () => false,
    install: async () => false,
    uninstall: async () => false,
  }, async () => ({ command: "/usr/bin/node", args: ["/repo/dist/cli.js", "mcp"] }));

  await assert.rejects(() => service.status("claude", options), /Unknown integration id `claude`.*codex/i);
});

test("legacy service operations delegate to canonical connect and disconnect", async () => {
  const base = adapter("codex");
  let connects = 0;
  let disconnects = 0;
  const tracked: IntegrationAdapter = {
    ...base,
    async connect(connectOptions, launch) {
      connects += 1;
      return base.connect(connectOptions, launch);
    },
    async disconnect(disconnectOptions) {
      disconnects += 1;
      return base.disconnect(disconnectOptions);
    },
  };
  const service = new AgentIntegrationService(new IntegrationRegistry([tracked]), {
    status: async () => false,
    install: async () => false,
    uninstall: async () => false,
  }, async () => ({ command: "/usr/bin/node", args: ["/repo/dist/cli.js", "mcp"] }));

  await service.install("codex", options);
  await service.uninstall("codex", options);
  assert.equal(connects, 1);
  assert.equal(disconnects, 1);
});

test("real adapters keep installation detection independent from connection state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-registry-"));
  const home = path.join(root, "home");
  const bin = path.join(root, "bin");
  try {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await mkdir(bin, { recursive: true });
    await writeFile(path.join(bin, "codex"), "#!/bin/sh\nexit 0\n");
    await chmod(path.join(bin, "codex"), 0o755);
    await writeFile(path.join(home, ".codex", "config.toml"), '[mcp_servers.code-atlas]\ncommand = "code-atlas"\nargs = ["mcp"]\n');

    const service = createAgentIntegrationService({ platform: "linux", cwd: root, home, env: { PATH: bin } });
    const codex = await service.status("codex", { repoPath: root });
    assert.equal(codex.installation.state, "installed");
    assert.equal(codex.connection.state, "connected");

    const opencode = await service.status("opencode", { repoPath: root });
    assert.equal(opencode.installation.state, "not_detected");
    assert.equal(opencode.connection.state, "disconnected");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("malformed managed config is invalid without changing installation detection", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-registry-invalid-"));
  const home = path.join(root, "home");
  try {
    await mkdir(home, { recursive: true });
    await writeFile(path.join(root, ".mcp.json"), '{ "mcpServers": { "code-atlas": { "command": "wrong" } } }');
    const service = createAgentIntegrationService({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const status = await service.status("claude", { repoPath: root });
    assert.equal(status.installation.state, "not_detected");
    assert.equal(status.connection.state, "invalid_config");
    assert.equal(status.connection.managedConfigPresent, true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Codex stale launcher remains a connection state", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "code-atlas-registry-stale-"));
  const home = path.join(root, "home");
  try {
    await mkdir(path.join(home, ".codex"), { recursive: true });
    await writeFile(path.join(home, ".codex", "config.toml"), `[mcp_servers.code-atlas]\ncommand = "${path.join(root, "missing-node")}"\nargs = ["${path.join(root, "missing-cli.js")}", "mcp"]\n`);
    const service = createAgentIntegrationService({ platform: "linux", cwd: root, home, env: { PATH: "" } });
    const status = await service.status("codex", { repoPath: root });
    assert.equal(status.installation.state, "not_detected");
    assert.equal(status.connection.state, "stale");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
