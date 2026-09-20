import { execFile as execFileCallback } from "node:child_process";
import { realpath } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";

const PACKAGE_NAME = "@showdar2112/code-atlas";
const execFileAsync = promisify(execFileCallback);
const execOptions = { encoding: "utf8", shell: false, windowsHide: true } as const;

type PackageManager = "npm" | "pnpm";
type ExecOptions = { encoding: "utf8"; shell: false; windowsHide: true };

export type UpgradeCheckDependencies = {
  platform: string;
  packageRoot: string;
  execPath?: string;
  realpath(path: string): Promise<string>;
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

function systemDependencies(): UpgradeCheckDependencies {
  return {
    platform: process.platform,
    packageRoot: path.resolve(import.meta.dirname, "../../../"),
    execPath: process.execPath,
    realpath,
    async execFile(file, args) {
      const { stdout } = await execFileAsync(file, args, execOptions);
      return { stdout };
    },
  };
}

async function detectInstallManager(dependencies: UpgradeCheckDependencies): Promise<PackageManager | null> {
  if (dependencies.platform === "win32") return null;
  const currentRoot = await dependencies.realpath(dependencies.packageRoot);
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
  const { stdout } = await dependencies.execFile(manager, ["root", "-g"], execOptions);
  const globalRoot = stdout.trim();
  if (!globalRoot) throw new Error(`${manager} returned an empty global package root`);
  const managerRoot = await dependencies.realpath(globalRoot);
  const packageRoot = await dependencies.realpath(path.join(globalRoot, ...PACKAGE_NAME.split("/")));
  const relativeRoot = path.relative(managerRoot, packageRoot);
  if (!relativeRoot || relativeRoot === ".." || relativeRoot.startsWith(`..${path.sep}`) || path.isAbsolute(relativeRoot)) {
    throw new Error(`${manager} resolved CodeAtlas outside its global package root`);
  }

  const entrypoint = path.join(packageRoot, "dist", "cli.js");
  let installedVersion: string;
  try {
    const result = await dependencies.execFile(dependencies.execPath ?? process.execPath, [entrypoint, "--version"], execOptions);
    installedVersion = result.stdout.trim();
  } catch (error) {
    throw new Error(`Unable to run the installed CodeAtlas CLI at ${entrypoint}: ${error instanceof Error ? error.message : String(error)}`);
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
): Promise<UpgradeCheckResult> {
  if (dependencies.platform === "win32") {
    throw new Error(
      `Windows registry checks are unavailable because npm and pnpm use .cmd shims that this shell-free command cannot invoke. To check manually, run \`npm view ${PACKAGE_NAME}@latest version\` in a Windows terminal.`,
    );
  }
  const manager = await detectInstallManager(dependencies);
  const lookupManager = manager ?? "npm";
  let latestVersion: string;
  try {
    const { stdout } = await dependencies.execFile(lookupManager, ["view", `${PACKAGE_NAME}@latest`, "version"], execOptions);
    latestVersion = stdout.trim();
  } catch (error) {
    throw new Error(
      `Unable to check for CodeAtlas updates using ${lookupManager}. Check its configured registry and network connection, then retry. (${error instanceof Error ? error.message : String(error)})`,
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
  write: (text: string) => unknown = (text) => process.stdout.write(text),
): Promise<void> {
  const checkOnly = args.includes("--check");
  if (args.some((arg) => arg !== "--check" && arg !== "--json")) {
    throw new Error("Use `code-atlas upgrade [--check] [--json]`.");
  }
  if (dependencies.platform === "win32" && !checkOnly) {
    throw new Error("Automatic upgrade is unavailable on Windows because npm and pnpm use .cmd shims that this shell-free command cannot invoke. Use the original installation method to update CodeAtlas.");
  }
  const result = await getCheckResult(currentVersion, dependencies);
  if (!checkOnly && result.updateAvailable) {
    if (!result.manager) {
      throw new Error("Automatic update is unavailable for this installation. Use the original installation method to update CodeAtlas; no package manager can be safely inferred.");
    }
    const installCommand = result.manager === "npm" ? "install" : "add";
    try {
      await dependencies.execFile(result.manager, [installCommand, "-g", `${PACKAGE_NAME}@${result.latestVersion}`], execOptions);
    } catch (error) {
      throw new Error(`Unable to install CodeAtlas ${result.latestVersion} using ${result.manager}. Check global package permissions and retry. (${error instanceof Error ? error.message : String(error)})`);
    }
    try {
      result.verifiedVersion = await verifyInstalledVersion(result.manager, result.latestVersion, dependencies);
    } catch (error) {
      throw new Error(`Unable to verify CodeAtlas ${result.latestVersion} using ${result.manager}. Confirm its global installation and retry. (${error instanceof Error ? error.message : String(error)})`);
    }
    result.upgraded = true;
  }
  write(args.includes("--json") ? `${JSON.stringify(result, null, 2)}\n` : `${formatHumanResult(result)}\n`);
}
