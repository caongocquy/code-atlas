import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as upgrade from "../src/adapters/cli/upgrade.command.js";

const formula = "caongocquy/showdar/code-atlas";
const packageName = "@showdar2112/code-atlas";

function brewDependencies(options: { installed?: string; tap?: string; latest?: string; fail?: string } = {}) {
  const cellar = path.join(os.tmpdir(), "code-atlas-brew-fixture", "Cellar", "code-atlas");
  const calls: string[][] = [];
  const dependencies: upgrade.UpgradeCheckDependencies = {
    platform: "darwin",
    packageRoot: path.join(cellar, "1.6.2", "libexec", "node_modules", ...packageName.split("/")),
    realpath: async (value) => value,
    readFile: async (file) => {
      assert.equal(file, path.join(cellar, "1.6.2", "INSTALL_RECEIPT.json"));
      return JSON.stringify({ source: { tap: options.tap ?? "caongocquy/showdar" } });
    },
    execFile: async (file, args, execOptions) => {
      assert.equal(execOptions.shell, false);
      calls.push([file, ...args]);
      if (file === "npm" || file === "pnpm") throw new Error("Package manager must not handle a brew install");
      if (args[0] === "--cellar") return { stdout: cellar };
      if (args[0] === "info") return { stdout: JSON.stringify({ formulae: [{ full_name: formula, versions: { stable: options.latest ?? "1.6.3" } }] }) };
      if (args[0] === "update" || args[0] === "upgrade") {
        if (options.fail === args[0]) throw new Error("brew unavailable");
        return { stdout: "" };
      }
      if (args[0] === "--prefix") return { stdout: path.join(cellar, options.installed ?? "1.6.3") };
      if (args.at(-1) === "--version") return { stdout: options.installed ?? "1.6.3" };
      throw new Error(`Unexpected process: ${file} ${args.join(" ")}`);
    },
  };
  return { dependencies, calls, cellar };
}

test("brew check reads formula metadata without refreshing or installing", async () => {
  const { dependencies, calls } = brewDependencies();
  let output = "";
  await upgrade.runUpgradeCommand(["--check", "--json"], "1.6.2", dependencies, (value) => { output += value; });
  assert.deepEqual(JSON.parse(output), {
    currentVersion: "1.6.2", latestVersion: "1.6.3", manager: "brew",
    updateAvailable: true, upgraded: false, verifiedVersion: null,
  });
  assert.equal(calls.some(([, command]) => ["update", "upgrade", "install", "view"].includes(command!)), false);
});

test("brew upgrade refreshes its tap and verifies the newly installed CLI with its bundled Node", async () => {
  const { dependencies, calls, cellar } = brewDependencies();
  let output = "";
  await upgrade.runUpgradeCommand(["--json"], "1.6.2", dependencies, (value) => { output += value; });
  assert.equal(JSON.parse(output).upgraded, true);
  assert.equal(JSON.parse(output).verifiedVersion, "1.6.3");
  assert.ok(calls.findIndex(([, command]) => command === "update") < calls.findIndex(([, command]) => command === "info"));
  assert.deepEqual(calls.find(([, command]) => command === "upgrade"), ["brew", "upgrade", formula]);
  assert.deepEqual(calls.at(-1), [
    path.join(cellar, "1.6.3", "libexec", "runtime", "node"),
    path.join(cellar, "1.6.3", "libexec", "node_modules", ...packageName.split("/"), "dist", "cli.js"), "--version",
  ]);
});

test("brew refuses a different tap before updating it", async () => {
  const { dependencies, calls } = brewDependencies({ tap: "other/tap" });
  await assert.rejects(() => upgrade.runUpgradeCommand([], "1.6.2", dependencies, () => {}));
  assert.equal(calls.some(([, command]) => command === "update" || command === "upgrade"), false);
});

test("brew refuses to report success when the installed version differs", async () => {
  const { dependencies } = brewDependencies({ installed: "1.6.2" });
  await assert.rejects(() => upgrade.runUpgradeCommand([], "1.6.2", dependencies, () => {}), /expected 1\.6\.3.*found 1\.6\.2/);
});

test("brew skips installation when its formula is current", async () => {
  const { dependencies, calls } = brewDependencies({ latest: "1.6.2" });
  let output = "";
  await upgrade.runUpgradeCommand(["--json"], "1.6.2", dependencies, (value) => { output += value; });
  assert.equal(JSON.parse(output).upgraded, false);
  assert.equal(calls.some(([, command]) => command === "upgrade"), false);
});

test("brew rejects invalid version metadata before installation", async () => {
  const { dependencies, calls } = brewDependencies({ latest: "invalid" });
  await assert.rejects(() => upgrade.runUpgradeCommand([], "1.6.2", dependencies, () => {}), /strict SemVer/);
  assert.equal(calls.some(([, command]) => command === "upgrade"), false);
});

for (const fail of ["update", "upgrade"]) {
  test(`brew ${fail} failures do not emit success or run version verification`, async () => {
    const { dependencies, calls } = brewDependencies({ fail });
    let output = "";
    await assert.rejects(() => upgrade.runUpgradeCommand([], "1.6.2", dependencies, (value) => { output += value; }), /brew unavailable/);
    assert.equal(output, "");
    assert.equal(calls.some((args) => args.at(-1) === "--version"), false);
  });
}

test("Windows manager execution runs JavaScript through Node and preserves literal arguments", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-windows-manager-"));
  try {
    for (const [manager, script] of [["npm", "npm-cli.js"], ["pnpm", "pnpm.cjs"]]) {
      const directory = path.join(root, "node_modules", manager!, "bin");
      await mkdir(directory, { recursive: true });
      await writeFile(path.join(directory, script!), "console.log(JSON.stringify(process.argv.slice(2)))");
      await writeFile(path.join(root, `${manager}.cmd`), "exit /b 99");
      const args = ["view", "literal & echo unsafe", "version"];
      const result = await upgrade.execUpgradeProcess(manager!, args, "win32", { Path: root });
      assert.deepEqual(JSON.parse(result.stdout), args);
    }
    if (process.platform === "win32") {
      for (const manager of ["npm", "pnpm"]) {
        const result = await upgrade.execUpgradeProcess(manager, ["--version"]);
        assert.match(result.stdout.trim(), /^\d+\.\d+\.\d+/);
      }
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Windows rejects unsupported shims instead of invoking a shell", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "code-atlas-unsupported-shim-"));
  try {
    await writeFile(path.join(root, "npm.cmd"), "exit /b 99");
    await assert.rejects(() => upgrade.execUpgradeProcess("npm", ["view"], "win32", { PATH: root }), /Cannot find a shell-free npm entrypoint/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
