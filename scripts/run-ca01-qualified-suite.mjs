import { createHash } from "node:crypto";
import { closeSync, mkdirSync, openSync, readdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import process from "node:process";
import { execFileSync, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { ca01ReporterSpecifier, suiteProcessFailed } from "./ca01-test-reporter.mjs";
import { readPinnedPnpmVersion } from "./ca01-pnpm.mjs";

const [sourceRoot, outputPrefix, loaderRoot] = process.argv.slice(2);
if (![sourceRoot, outputPrefix, loaderRoot].every(Boolean)) {
  throw new Error("Usage: run-ca01-qualified-suite.mjs <source-root> <output-prefix> <common-loader-root>");
}

const sha256 = value => createHash("sha256").update(value).digest("hex");
function packageRoot(requireFromRoot, name) {
  let current = path.dirname(requireFromRoot.resolve(name));
  while (current !== path.dirname(current)) {
    const manifest = path.join(current, "package.json");
    try {
      if (JSON.parse(readFileSync(manifest, "utf8")).name === name) return { root: current, manifest };
    } catch { /* Continue up from an entry file to its owning package. */ }
    current = path.dirname(current);
  }
  throw new Error(`Cannot locate package root for ${name}`);
}

const requireFromLoader = createRequire(path.join(loaderRoot, "package.json"));
const loaderEntry = realpathSync(requireFromLoader.resolve("tsx/esm"));
const loaderUrl = pathToFileURL(loaderEntry).href;
const tsx = packageRoot(requireFromLoader, "tsx");
const tsxManifest = JSON.parse(readFileSync(tsx.manifest, "utf8"));
const loaderSha256 = sha256(readFileSync(loaderEntry));
const lockfileSha256 = sha256(readFileSync(path.join(loaderRoot, "pnpm-lock.yaml")));
const sourceManifest = JSON.parse(readFileSync(path.join(sourceRoot, "package.json"), "utf8"));
const pnpm = readPinnedPnpmVersion(sourceManifest.packageManager);
const pnpmVersion = pnpm.version;
const reporterUrl = ca01ReporterSpecifier(import.meta.url);
const files = readdirSync(path.join(sourceRoot, "test"))
  .filter(name => name.endsWith(".test.ts")).sort().map(name => path.join(sourceRoot, "test", name));
if (!files.length) throw new Error(`No test files found under ${sourceRoot}`);

mkdirSync(path.dirname(outputPrefix), { recursive: true });
const stdout = openSync(`${outputPrefix}.jsonl`, "w"), stderr = openSync(`${outputPrefix}.stderr`, "w");
const childEnv = { ...process.env };
for (const name of ["NODE_OPTIONS", "NODE_PATH", "NODE_V8_COVERAGE", "TSX_TSCONFIG_PATH"]) delete childEnv[name];
childEnv.CODE_ATLAS_EVAL_OFFLINE = "1";
let result;
try {
  result = spawnSync(process.execPath, ["--import", loaderUrl, "--test", "--test-concurrency=2",
    `--test-reporter=${reporterUrl}`, ...files], { cwd: sourceRoot, env: childEnv, stdio: ["ignore", stdout, stderr] });
} finally {
  closeSync(stdout); closeSync(stderr);
}

const events = readFileSync(`${outputPrefix}.jsonl`);
const processResult = {
  exitCode: result.status, signal: result.signal, error: result.error ? String(result.error) : null,
  node: process.version, platform: process.platform, arch: process.arch,
  pnpmVersion, pnpmExecutable: pnpm.executable, lockfileSha256,
  revision: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  tree: execFileSync("git", ["-C", sourceRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim(),
  loaderUrl, loaderSha256, tsxVersion: tsxManifest.version, reporterUrl, files: files.map(file => path.relative(sourceRoot, file).replaceAll("\\", "/")),
  eventsSha256: sha256(events), stderrSha256: sha256(readFileSync(`${outputPrefix}.stderr`)),
};
writeFileSync(`${outputPrefix}.process.json`, JSON.stringify(processResult, null, 2) + "\n");
if (suiteProcessFailed(result)) throw new Error(`Suite process failed; see ${outputPrefix}.process.json and .stderr`);
