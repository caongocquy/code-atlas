import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  runUpgradeCommand,
  type UpgradeCheckDependencies,
} from "../src/adapters/cli/upgrade.command.js";

const packageName = "@showdar2112/code-atlas";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "code-atlas-upgrade-install-"));
test.after(() => rm(tempRoot, { recursive: true, force: true }));

type Call = { file: string; args: string[]; shell: false };

function globalPackage(root: string): string {
  return path.join(root, ...packageName.split("/"));
}

function fakeDependencies(options: {
  manager: "npm" | "pnpm" | null;
  latest?: string;
  installed?: string;
  installFailure?: string;
  verifyFailure?: string;
  packageRoot?: string;
  platform?: string;
}): { dependencies: UpgradeCheckDependencies; calls: Call[] } {
  const root = path.join(tempRoot, `${options.manager ?? "unsupported"}-global`);
  const packageRoot = options.packageRoot ?? globalPackage(root);
  const calls: Call[] = [];
  const dependencies: UpgradeCheckDependencies = {
    platform: options.platform ?? "darwin",
    packageRoot,
    execPath: process.execPath,
    realpath: async (value) => value,
    async execFile(file, args, execOptions) {
      assert.equal(execOptions.shell, false);
      calls.push({ file, args, shell: execOptions.shell });
      if (args[0] === "root" && args[1] === "-g") {
        if (file !== options.manager) throw new Error(`${file} unavailable`);
        return { stdout: root };
      }
      if (args[0] === "view") return { stdout: options.latest ?? "1.2.1" };
      if (args[0] === "install" || args[0] === "add") {
        if (options.installFailure) throw new Error(options.installFailure);
        return { stdout: "" };
      }
      if (args.at(-1) === "--version") {
        if (options.verifyFailure) throw new Error(options.verifyFailure);
        return { stdout: options.installed ?? options.latest ?? "1.2.1" };
      }
      throw new Error(`Unexpected process: ${file} ${args.join(" ")}`);
    },
  };
  return { dependencies, calls };
}

for (const manager of ["npm", "pnpm"] as const) {
  test(`upgrade installs and verifies the exact latest version with ${manager}`, async () => {
    const { dependencies, calls } = fakeDependencies({ manager, latest: "1.2.1" });
    let output = "";

    await runUpgradeCommand(["--json"], "1.2.0", dependencies, (value) => { output += value; });

    assert.deepEqual(JSON.parse(output), {
      currentVersion: "1.2.0",
      latestVersion: "1.2.1",
      updateAvailable: true,
      manager,
      upgraded: true,
      verifiedVersion: "1.2.1",
    });
    assert.deepEqual(calls.map(({ file, args }) => [file, ...args]), [
      ["npm", "root", "-g"],
      ["pnpm", "root", "-g"],
      [manager, "view", `${packageName}@latest`, "version"],
      [manager, manager === "npm" ? "install" : "add", "-g", `${packageName}@1.2.1`],
      [manager, "root", "-g"],
      [process.execPath, path.join(globalPackage(path.join(tempRoot, `${manager}-global`)), "dist", "cli.js"), "--version"],
    ]);
    assert.ok(calls.every((call) => call.shell === false));
  });
}

test("bare upgrade does not install or verify when already latest", async () => {
  const { dependencies, calls } = fakeDependencies({ manager: "npm", latest: "1.2.0" });
  let output = "";

  await runUpgradeCommand(["--json"], "1.2.0", dependencies, (value) => { output += value; });

  assert.equal(JSON.parse(output).upgraded, false);
  assert.equal(JSON.parse(output).verifiedVersion, null);
  assert.equal(calls.some(({ args }) => args[0] === "install" || args[0] === "add"), false);
  assert.equal(calls.some(({ args }) => args.at(-1) === "--version"), false);
});

test("upgrade reports install failures and does not claim success", async () => {
  const { dependencies, calls } = fakeDependencies({ manager: "npm", installFailure: "permission denied" });

  await assert.rejects(
    () => runUpgradeCommand([], "1.2.0", dependencies, () => {}),
    /Unable to install.*npm.*permission denied/i,
  );
  assert.equal(calls.some(({ args }) => args.at(-1) === "--version"), false);
});

test("upgrade rejects a post-install version mismatch", async () => {
  const { dependencies } = fakeDependencies({ manager: "pnpm", latest: "1.2.1", installed: "1.2.0" });

  await assert.rejects(
    () => runUpgradeCommand([], "1.2.0", dependencies, () => {}),
    /expected 1\.2\.1.*found 1\.2\.0/i,
  );
});

test("upgrade fails when the installed entrypoint cannot run", async () => {
  const { dependencies } = fakeDependencies({ manager: "npm", verifyFailure: "entrypoint missing" });

  await assert.rejects(
    () => runUpgradeCommand([], "1.2.0", dependencies, () => {}),
    /unable to run the installed CodeAtlas CLI.*entrypoint missing/i,
  );
});

test("unsupported and Windows installations fail closed before install", async () => {
  const unsupported = fakeDependencies({ manager: null });
  await assert.rejects(
    () => runUpgradeCommand([], "1.2.0", unsupported.dependencies, () => {}),
    /original installation method/i,
  );
  assert.equal(unsupported.calls.some(({ args }) => args[0] === "install" || args[0] === "add"), false);

  const windows = fakeDependencies({ manager: "npm", platform: "win32" });
  await assert.rejects(
    () => runUpgradeCommand([], "1.2.0", windows.dependencies, () => {}),
    /Windows.*automatic.*upgrade|Windows.*\.cmd/i,
  );
  assert.deepEqual(windows.calls, []);
});
