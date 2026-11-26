import assert from "node:assert/strict";
import { access, chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { resolveDurableMcpLaunch, validateConfiguredLaunch } from "../src/infrastructure/integration/mcp-launcher.js";

test("durable launcher discovers the platform shim and emits a directly spawnable Windows launch", async () => {
  const root = await mkdtemp(path.join(process.cwd(), ".launcher-discovery-"));
  try {
    const shim = path.join(root, process.platform === "win32" ? "code-atlas.cmd" : "code-atlas");
    await writeFile(shim, process.platform === "win32" ? "@echo off\r\n" : "#!/bin/sh\n");
    await chmod(shim, 0o755);
    const launch = await resolveDurableMcpLaunch(undefined, { argv: [process.execPath], env: { PATH: root } });
    if (process.platform === "win32") {
      assert.deepEqual(launch, { command: process.execPath, args: [path.resolve("dist/cli.js"), "mcp"] });
      await access(launch.args[0]!);
      // Existing explicit batch configs remain recognized for shell-capable clients.
      assert.equal(await validateConfiguredLaunch({ command: shim, args: ["mcp"] }), "valid");
      const missing = pathToFileURL(path.join(root, "missing", "src", "infrastructure", "integration", "mcp-launcher.ts")).href;
      await assert.rejects(() => resolveDurableMcpLaunch(missing, { env: { CODE_ATLAS_CLI: shim } }), /installed Node executable and dist\/cli\.js/);
    } else {
      assert.deepEqual(launch, { command: shim, args: ["mcp"] });
    }
    assert.equal(await validateConfiguredLaunch(launch), "valid");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
