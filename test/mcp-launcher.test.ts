import assert from "node:assert/strict";
import { access } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isEphemeralMcpPath,
  resolveDurableMcpLaunch,
  validateConfiguredLaunch,
} from "../src/infrastructure/integration/mcp-launcher.js";

test("durable launcher is absolute, executable, and independent of PATH", async () => {
  const originalPath = process.env.PATH;
  process.env.PATH = "";
  try {
    const launch = await resolveDurableMcpLaunch();
    assert.equal(launch.command.startsWith("/"), true);
    assert.equal(launch.args.length, 2);
    assert.equal(launch.args[0]?.startsWith("/"), true);
    assert.equal(launch.args[1], "mcp");
    await access(launch.command);
    await access(launch.args[0]!);
    assert.equal(await validateConfiguredLaunch(launch), "valid");
  } finally {
    process.env.PATH = originalPath;
  }
});

test("persisted launch validation distinguishes stale and ephemeral paths", async () => {
  assert.equal(await validateConfiguredLaunch({ command: "/missing/node", args: ["/missing/cli.js", "mcp"] }), "stale");
  assert.equal(await validateConfiguredLaunch({ command: process.execPath, args: ["/missing/cli.js", "mcp"] }), "stale");
  assert.equal(await validateConfiguredLaunch({ command: "/tmp/node", args: ["/tmp/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/private/tmp/node", args: ["/private/tmp/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/usr/bin/node", args: ["/home/.npx/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/usr/bin/node", args: ["/home/npx/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/usr/bin/node", args: ["/home/pnpm/dlx/cli.js", "mcp"] }), "ephemeral");
  assert.equal(isEphemeralMcpPath("/home/.npx/_npx/cli.js"), true);
});

test("ephemeral detection follows macOS private temp-root canonicalization", () => {
  if (process.platform === "win32" || !tmpdir().startsWith("/var/")) return;
  assert.equal(isEphemeralMcpPath(path.join("/private", tmpdir().slice(1), "code-atlas", "dist", "cli.js")), true);
});
