import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { formatCommandHelp, formatRootHelp, isKnownCommand } from "../src/adapters/cli/cli-help.js";
import {
  compareSemVer,
  runUpgradeCommand,
  type UpgradeCheckDependencies,
} from "../src/adapters/cli/upgrade.command.js";

const packageName = "@showdar2112/code-atlas";
const tempRoot = await mkdtemp(path.join(os.tmpdir(), "code-atlas-upgrade-check-"));
test.after(() => rm(tempRoot, { recursive: true, force: true }));

type Call = { file: string; args: string[] };

function fakeDependencies(options: {
  platform?: string;
  packageRoot?: string;
  roots?: Partial<Record<"npm" | "pnpm", string>>;
  latest?: string;
  failure?: string;
  realPaths?: Record<string, string>;
} = {}) {
  const calls: Call[] = [];
  const realPaths = options.realPaths ?? {};
  const dependencies: UpgradeCheckDependencies = {
    platform: options.platform ?? "darwin",
    packageRoot: options.packageRoot ?? path.join(tempRoot, "running-package"),
    realpath: async (value) => realPaths[value] ?? value,
    execFile: async (file, args, execOptions) => {
      assert.equal(execOptions.shell, false);
      calls.push({ file, args });
      if (args[0] === "root") {
        const root = options.roots?.[file as "npm" | "pnpm"];
        if (!root) throw new Error(`${file} unavailable`);
        return { stdout: root };
      }
      if (args[0] === "view") {
        if (options.failure) throw new Error(options.failure);
        return { stdout: options.latest ?? "1.2.1" };
      }
      throw new Error(`Unexpected process: ${file} ${args.join(" ")}`);
    },
  };
  return { dependencies, calls };
}

function globalPackage(root: string): string {
  return path.join(root, ...packageName.split("/"));
}

test("upgrade check reports npm global registry result as stable JSON without installing", async () => {
  const npmRoot = path.join(tempRoot, "npm-global");
  const currentRoot = globalPackage(npmRoot);
  const { dependencies, calls } = fakeDependencies({
    packageRoot: currentRoot,
    roots: { npm: npmRoot },
    latest: "1.3.0",
  });
  let output = "";

  await runUpgradeCommand(["--check", "--json"], "1.2.0", dependencies, (value) => { output += value; });

  assert.deepEqual(JSON.parse(output), {
    currentVersion: "1.2.0",
    latestVersion: "1.3.0",
    updateAvailable: true,
    manager: "npm",
    upgraded: false,
    verifiedVersion: null,
  });
  assert.deepEqual(calls.map(({ file, args }) => [file, ...args]), [
    ["npm", "root", "-g"],
    ["pnpm", "root", "-g"],
    ["npm", "view", `${packageName}@latest`, "version"],
  ]);
  assert.equal(calls.some(({ args }) => args[0] === "install"), false);
});

test("upgrade check detects pnpm and reports an already-latest human result", async () => {
  const pnpmRoot = path.join(tempRoot, "pnpm-global");
  const pnpmPackagePath = globalPackage(pnpmRoot);
  const pnpmRealPackageRoot = path.join(pnpmRoot, ".pnpm", "code-atlas@1.2.0", "node_modules", ...packageName.split("/"));
  const { dependencies, calls } = fakeDependencies({
    packageRoot: pnpmRealPackageRoot,
    roots: { pnpm: pnpmRoot },
    latest: "1.2.0",
    realPaths: { [pnpmPackagePath]: pnpmRealPackageRoot },
  });
  let output = "";

  await runUpgradeCommand(["--check"], "1.2.0", dependencies, (value) => { output += value; });

  assert.match(output, /Current version: 1\.2\.0/);
  assert.match(output, /Latest version: 1\.2\.0/);
  assert.match(output, /Update available: no/);
  assert.match(output, /Package manager: pnpm/);
  assert.match(output, /already up to date/i);
  assert.equal(calls.some(({ file, args }) => file !== "pnpm" && args[0] === "view"), false);
});

test("upgrade check leaves local, linked, and ambiguous installs unsupported", async () => {
  const npmRoot = path.join(tempRoot, "other-npm-global");
  const localRoot = path.join(tempRoot, "local-install");
  const local = fakeDependencies({ packageRoot: localRoot, roots: { npm: npmRoot }, latest: "1.2.1" });
  let localOutput = "";
  await runUpgradeCommand(["--check", "--json"], "1.2.0", local.dependencies, (value) => { localOutput += value; });
  assert.equal(JSON.parse(localOutput).manager, null);
  let localHumanOutput = "";
  await runUpgradeCommand(["--check"], "1.2.0", local.dependencies, (value) => { localHumanOutput += value; });
  assert.match(localHumanOutput, /automatic update is unavailable/i);
  assert.match(localHumanOutput, /original.*installation method/i);
  assert.doesNotMatch(localHumanOutput, /npm install -g/);

  const linkedPackage = globalPackage(npmRoot);
  const linked = fakeDependencies({
    packageRoot: localRoot,
    roots: { npm: npmRoot },
    latest: "1.2.1",
    realPaths: { [linkedPackage]: localRoot },
  });
  let linkedOutput = "";
  await runUpgradeCommand(["--check", "--json"], "1.2.0", linked.dependencies, (value) => { linkedOutput += value; });
  assert.equal(JSON.parse(linkedOutput).manager, null);

  const pnpmRoot = path.join(tempRoot, "ambiguous-pnpm-global");
  const canonical = path.join(tempRoot, "shared-package");
  const ambiguous = fakeDependencies({
    packageRoot: canonical,
    roots: { npm: npmRoot, pnpm: pnpmRoot },
    latest: "1.2.1",
    realPaths: { [globalPackage(npmRoot)]: canonical, [globalPackage(pnpmRoot)]: canonical },
  });
  let ambiguousOutput = "";
  await runUpgradeCommand(["--check", "--json"], "1.2.0", ambiguous.dependencies, (value) => { ambiguousOutput += value; });
  assert.equal(JSON.parse(ambiguousOutput).manager, null);
  for (const calls of [local.calls, linked.calls, ambiguous.calls]) {
    assert.equal(calls.some(({ args }) => args[0] === "install"), false);
  }
});

test("Windows skips install-source detection and keeps check non-mutating", async () => {
  const { dependencies, calls } = fakeDependencies({ platform: "win32", latest: "1.2.1" });
  await assert.rejects(
    () => runUpgradeCommand(["--check", "--json"], "1.2.0", dependencies, () => {}),
    /Windows.*(?:\.cmd|shell).*manual.*npm view/i,
  );
  assert.deepEqual(calls, []);
});

test("strict SemVer comparison handles prerelease precedence and rejects invalid versions", () => {
  assert.equal(compareSemVer("1.2.0-beta.10", "1.2.0-beta.2"), 1);
  assert.equal(compareSemVer("1.2.0-beta.2", "1.2.0"), -1);
  assert.equal(compareSemVer("1.2.0+build.1", "1.2.0+build.2"), 0);
  assert.throws(() => compareSemVer("01.2.0", "1.2.0"), /strict SemVer/);
  assert.throws(() => compareSemVer("1.2.0", "1.2.0-01"), /strict SemVer/);
});

test("registry failures and invalid latest metadata return actionable errors without installation", async () => {
  const failed = fakeDependencies({ failure: "registry offline" });
  await assert.rejects(
    () => runUpgradeCommand(["--check"], "1.2.0", failed.dependencies, () => {}),
    /configured registry|network/i,
  );
  const invalid = fakeDependencies({ latest: "latest" });
  await assert.rejects(
    () => runUpgradeCommand(["--check"], "1.2.0", invalid.dependencies, () => {}),
    /strict SemVer/i,
  );
  assert.equal(failed.calls.some(({ args }) => args[0] === "install"), false);
  assert.equal(invalid.calls.some(({ args }) => args[0] === "install"), false);
});

test("upgrade command is listed, known, and has detailed check help", () => {
  assert.equal(isKnownCommand("upgrade"), true);
  assert.match(formatRootHelp(), /upgrade\s+Check for and install a CodeAtlas update/);
  assert.match(formatCommandHelp("upgrade"), /Usage: code-atlas upgrade --check/);
});
