import assert from "node:assert/strict";
import { access, chmod, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  isEphemeralMcpPath,
  resolveDurableMcpLaunch,
  validateConfiguredLaunch,
} from "../src/infrastructure/integration/mcp-launcher.js";

test("durable launcher resolves the installed CodeAtlas executable", async () => {
  const root = path.join(process.cwd(), `.mcp-launcher-test-${process.pid}`);
  await mkdir(root, { recursive: true });
  const executable = path.join(root, "code-atlas");
  await writeFile(executable, "#!/usr/bin/env node\n");
  await chmod(executable, 0o755);
  try {
    const launch = await resolveDurableMcpLaunch(import.meta.url, {
      argv: [process.execPath, path.join(root, "dist", "cli.js")],
      env: { CODE_ATLAS_CLI: executable, PATH: "" },
    });
    assert.deepEqual(launch, { command: executable, args: ["mcp"] });
    await access(launch.command);
    assert.equal(await validateConfiguredLaunch(launch), "valid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("old node plus dist launcher remains valid and new launcher rejects missing executable", async () => {
  const oldLaunch = { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] };
  assert.equal(await validateConfiguredLaunch(oldLaunch), "valid");
  assert.equal(await validateConfiguredLaunch({ command: "/missing/code-atlas", args: ["mcp"] }), "stale");
});

test("persisted launch validation distinguishes stale and ephemeral paths", async () => {
  assert.equal(await validateConfiguredLaunch({ command: "/missing/node", args: ["/missing/cli.js", "mcp"] }), "stale");
  assert.equal(await validateConfiguredLaunch({ command: process.execPath, args: ["/missing/cli.js", "mcp"] }), "stale");
  assert.equal(await validateConfiguredLaunch({ command: "/tmp/node", args: ["/tmp/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/private/tmp/node", args: ["/private/tmp/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/usr/bin/node", args: ["/home/.npx/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/usr/bin/node", args: ["/home/npx/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/usr/bin/node", args: ["/home/pnpm/dlx/cli.js", "mcp"] }), "ephemeral");
  assert.equal(await validateConfiguredLaunch({ command: "/home/.npx/code-atlas", args: ["mcp"] }), "ephemeral");
  assert.equal(isEphemeralMcpPath("/home/.npx/_npx/cli.js"), true);
});

test("ephemeral detection follows macOS private temp-root canonicalization", () => {
  if (process.platform === "win32" || !tmpdir().startsWith("/var/")) return;
  assert.equal(isEphemeralMcpPath(path.join("/private", tmpdir().slice(1), "code-atlas", "dist", "cli.js")), true);
});
