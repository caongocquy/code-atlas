import { note } from "@clack/prompts";
import { execFile as execFileCallback } from "node:child_process";
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { startCliPresentation } from "./cli-presentation.js";

const PACKAGE_NAME = "@showdar2112/code-atlas";
const BREW_FORMULA = "caongocquy/showdar/code-atlas";
const execFileAsync = promisify(execFileCallback);
const execOptions = { encoding: "utf8", shell: false, windowsHide: true } as const;

type PackageManager = "npm" | "pnpm" | "brew";
type ExecOptions = { encoding: "utf8"; shell: false; windowsHide: true };

export type UpgradeCheckDependencies = {
  platform: string;
  packageRoot: string;
  execPath?: string;
  realpath(path: string): Promise<string>;
  readFile?(path: string, encoding: "utf8"): Promise<string>;
  execFile(file: string, args: string[], options: ExecOptions): Promise<{ stdout: string }>;
};

type UpgradeCheckResult = {
  currentVersion: string;
  latestVersion: string;
  updateAvailable: boolean;
  manager: PackageManager | null;
  upgraded: boolean;
  verifiedVersion: string | null;
};

export async function execUpgradeProcess(
  file: string,
  args: string[],
  platform: string = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): Promise<{ stdout: string }> {
  if (platform === "win32" && (file === "npm" || file === "pnpm")) {
    const script = file === "npm" ? "npm-cli.js" : "pnpm.cjs";
    let entrypoint: string | undefined;
    for (const directory of (env.PATH ?? env.Path ?? "").split(";").filter(Boolean)) {
      const root = directory.replace(/^"|"$/g, "");
      for (const candidate of [
        path.join(root, `${file}.exe`),
        path.join(root, "node_modules", file, "bin", script),
        path.join(root, "node_modules", "corepack", "dist", `${file}.js`),
      ]) {
        try {
          if ((await stat(candidate)).isFile()) {
            entrypoint = await realpath(candidate);
            break;
          }
        } catch {
          // Only known executable/script entrypoints are eligible; never execute .cmd shims.
        }
      }
      if (entrypoint) break;
    }
    if (!entrypoint) throw new Error(`Cannot find a shell-free ${file} entrypoint on PATH. Use the original installation method to update CodeAtlas.`);
    if (entrypoint.toLowerCase().endsWith(".exe")) file = entrypoint;
    else {
      file = process.execPath;
      args = [entrypoint, ...args];
    }
  }
  const { stdout } = await execFileAsync(file, args, execOptions);
  return { stdout };
}

function systemDependencies(): UpgradeCheckDependencies {
  return {
    platform: process.platform,
    packageRoot: path.resolve(import.meta.dirname, "../../../"),
    execPath: process.execPath,
    realpath,
    readFile,
    execFile: (file, args) => execUpgradeProcess(file, args),
  };
}

async function detectInstallManager(dependencies: UpgradeCheckDependencies): Promise<PackageManager | null> {
  const currentRoot = await dependencies.realpath(dependencies.packageRoot);
  if (dependencies.platform === "darwin" && currentRoot.endsWith(path.join("libexec", "node_modules", ...PACKAGE_NAME.split("/")))) {
    const installation = path.resolve(currentRoot, "../../../..");
    try {
      const receipt = JSON.parse(await (dependencies.readFile ?? readFile)(path.join(installation, "INSTALL_RECEIPT.json"), "utf8"));
      if (receipt?.source?.tap === "caongocquy/showdar") {
        const { stdout } = await dependencies.execFile("brew", ["--cellar", BREW_FORMULA], execOptions);
        if (stdout.trim() && await dependencies.realpath(stdout.trim()) === path.dirname(installation)) return "brew";
      }
    } catch {
      // A matching package path alone does not establish Homebrew ownership.
    }
  }
  const matches: PackageManager[] = [];

  for (const manager of ["npm", "pnpm"] as const) {
    try {
      const { stdout } = await dependencies.execFile(manager, ["root", "-g"], execOptions);
      const globalRoot = stdout.trim();
      if (!globalRoot) continue;
      const managerRoot = await dependencies.realpath(globalRoot);
      const packageRoot = await dependencies.realpath(path.join(globalRoot, ...PACKAGE_NAME.split("/")));
      const relativeRoot = path.relative(managerRoot, packageRoot);
      if (!relativeRoot || relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) continue;
      if (packageRoot === currentRoot) matches.push(manager);
    } catch {
      // Missing managers and unrelated roots do not count as install sources.
    }
  }

  return matches.length === 1 ? matches[0]! : null;
}

async function verifyInstalledVersion(
  manager: PackageManager,
  targetVersion: string,
  dependencies: UpgradeCheckDependencies,
): Promise<string> {
  let entrypoint: string;
  let execPath = dependencies.execPath ?? process.execPath;
  if (manager === "brew") {
    const { stdout } = await dependencies.execFile("brew", ["--prefix", BREW_FORMULA], execOptions);
    if (!stdout.trim()) throw new Error("brew returned an empty installed prefix");
    const prefix = await dependencies.realpath(stdout.trim());
    entrypoint = path.join(prefix, "libexec", "node_modules", ...PACKAGE_NAME.split("/"), "dist", "cli.js");
    execPath = path.join(prefix, "libexec", "runtime", "node");
  } else {
    const { stdout } = await dependencies.execFile(manager, ["root", "-g"], execOptions);
    const globalRoot = stdout.trim();
    if (!globalRoot) throw new Error(`${manager} returned an empty global package root`);
    const managerRoot = await dependencies.realpath(globalRoot);
    const packageRoot = await dependencies.realpath(path.join(globalRoot, ...PACKAGE_NAME.split("/")));
    const relativeRoot = path.relative(managerRoot, packageRoot);
    if (!relativeRoot || relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) {
      throw new Error(`${manager} resolved CodeAtlas outside its global package root`);
    }
    entrypoint = path.join(packageRoot, "dist", "cli.js");
  }
  let installedVersion: string;
  try {
    const result = await dependencies.execFile(execPath, [entrypoint, "--version"], execOptions);
    installedVersion = result.stdout.trim();
  } catch (error) {
    throw new Error(`Unable to run the installed CodeAtlas CLI at ${entrypoint}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (installedVersion !== targetVersion) {
    throw new Error(`Upgrade verification failed: expected ${targetVersion}, found ${installedVersion || "no version output"}.`);
  }
  return installedVersion;
}

function parseSemVer(version: string): { core: bigint[]; prerelease: string[] } {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.exec(version);
  if (!match) throw new Error(`Invalid strict SemVer version: ${version}`);
  const prerelease = match[4]?.split(".") ?? [];
  if (prerelease.some((part) => /^\d+$/.test(part) && part.length > 1 && part.startsWith("0"))) {
    throw new Error(`Invalid strict SemVer version: ${version}`);
  }
  return { core: [BigInt(match[1]!), BigInt(match[2]!), BigInt(match[3]!)], prerelease };
}

export function compareSemVer(leftVersion: string, rightVersion: string): number {
  const left = parseSemVer(leftVersion);
  const right = parseSemVer(rightVersion);
  for (let i = 0; i < left.core.length; i += 1) {
    if (left.core[i]! !== right.core[i]!) return left.core[i]! < right.core[i]! ? -1 : 1;
  }
  if (!left.prerelease.length || !right.prerelease.length) {
    return left.prerelease.length === right.prerelease.length ? 0 : left.prerelease.length ? -1 : 1;
  }
  for (let i = 0; i < Math.max(left.prerelease.length, right.prerelease.length); i += 1) {
    const a = left.prerelease[i];
    const b = right.prerelease[i];
    if (a === undefined || b === undefined) return a === b ? 0 : a === undefined ? -1 : 1;
    const aNumeric = /^\d+$/.test(a);
    const bNumeric = /^\d+$/.test(b);
    if (aNumeric && bNumeric) {
      const aValue = BigInt(a);
      const bValue = BigInt(b);
      if (aValue !== bValue) return aValue < bValue ? -1 : 1;
    } else if (aNumeric !== bNumeric) {
      return aNumeric ? -1 : 1;
    } else if (a !== b) {
      return a < b ? -1 : 1;
    }
  }
  return 0;
}

async function getCheckResult(
  currentVersion: string,
  dependencies: UpgradeCheckDependencies,
  manager: PackageManager | null,
): Promise<UpgradeCheckResult> {
  const lookupManager = manager ?? "npm";
  let latestVersion: string;
  try {
    if (manager === "brew") {
      const { stdout } = await dependencies.execFile("brew", ["info", "--json=v2", BREW_FORMULA], execOptions);
      const info = JSON.parse(stdout);
      const formula = Array.isArray(info?.formulae) ? info.formulae.find((item: { full_name?: string }) => item?.full_name === BREW_FORMULA) : undefined;
      if (typeof formula?.versions?.stable !== "string") throw new Error("brew returned no stable version for the CodeAtlas formula");
      latestVersion = formula.versions.stable;
    } else {
      const { stdout } = await dependencies.execFile(lookupManager, ["view", `${PACKAGE_NAME}@latest`, "version"], execOptions);
      latestVersion = stdout.trim();
    }
  } catch (error) {
    throw new Error(
      `Unable to check for CodeAtlas updates using ${lookupManager}. ${manager === "brew" ? "Run `brew update` to refresh formula metadata, then retry." : "Check its configured registry and network connection, then retry."} (${error instanceof Error ? error.message : String(error)})`,
      { cause: error },
    );
  }

  return {
    currentVersion,
    latestVersion,
    updateAvailable: compareSemVer(currentVersion, latestVersion) < 0,
    manager,
    upgraded: false,
    verifiedVersion: null,
  };
}

function formatHumanResult(result: UpgradeCheckResult): string {
  const manager = result.manager ?? "unsupported install source";
  const nextAction = result.updateAvailable
    ? result.upgraded
      ? `Installed and verified CodeAtlas ${result.verifiedVersion}.`
      : result.manager
        ? "Run `code-atlas upgrade` to install this update."
        : "Automatic update is unavailable for this installation. Use the original installation method to update CodeAtlas; no package manager can be safely inferred."
    : "CodeAtlas is already up to date.";
  return [
    "CodeAtlas update check",
    `Current version: ${result.currentVersion}`,
    `Latest version: ${result.latestVersion}`,
    `Update available: ${result.updateAvailable ? "yes" : "no"}`,
    `Package manager: ${manager}`,
    `Next action: ${nextAction}`,
  ].join("\n");
}

export async function runUpgradeCommand(
  args: string[],
  currentVersion: string,
  dependencies: UpgradeCheckDependencies = systemDependencies(),
  write?: (text: string) => unknown,
): Promise<void> {
  const checkOnly = args.includes("--check");
  if (args.some((arg) => arg !== "--check" && arg !== "--json")) {
    throw new Error("Use `code-atlas upgrade [--check] [--json]`.");
  }
  if (!args.includes("--json") && !write) startCliPresentation("CLI updates");
  const manager = await detectInstallManager(dependencies);
  if (manager === "brew" && !checkOnly) {
    try {
      await dependencies.execFile("brew", ["update"], execOptions);
    } catch (error) {
      throw new Error(`Unable to refresh Homebrew updates. Run \`brew update\` and retry. (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
  }
  const result = await getCheckResult(currentVersion, dependencies, manager);
  if (!checkOnly && result.updateAvailable) {
    if (!result.manager) {
      throw new Error("Automatic update is unavailable for this installation. Use the original installation method to update CodeAtlas; no package manager can be safely inferred.");
    }
    const installCommand = result.manager === "npm" ? "install" : "add";
    try {
      await dependencies.execFile(result.manager, result.manager === "brew"
        ? ["upgrade", BREW_FORMULA]
        : [installCommand, "-g", `${PACKAGE_NAME}@${result.latestVersion}`], execOptions);
    } catch (error) {
      throw new Error(`Unable to install CodeAtlas ${result.latestVersion} using ${result.manager}. Check global package permissions and retry. (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    try {
      result.verifiedVersion = await verifyInstalledVersion(result.manager, result.latestVersion, dependencies);
    } catch (error) {
      throw new Error(`Unable to verify CodeAtlas ${result.latestVersion} using ${result.manager}. Confirm its global installation and retry. (${error instanceof Error ? error.message : String(error)})`, { cause: error });
    }
    result.upgraded = true;
  }
  if (write) {
    write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : `${formatHumanResult(result)}\n`);
  } else if (args.includes("--json")) {
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } else {
    note(formatHumanResult(result));
  }
}
