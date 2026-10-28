import { readdirSync, mkdirSync, openSync, closeSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { spawnSync } from "node:child_process";
import { ca01ReporterSpecifier, suiteProcessFailed } from "./ca01-test-reporter.mjs";

const prefix = process.argv[2];
if (!prefix) throw new Error("Usage: node run-ca01-suite.mjs <evidence-prefix>");
mkdirSync(path.dirname(prefix), { recursive: true });
const files = readdirSync("test").filter(name => name.endsWith(".test.ts")).sort().map(name => path.join("test", name));
if (!files.length) throw new Error("No test files found");
const out = openSync(`${prefix}.jsonl`, "w"), err = openSync(`${prefix}.stderr`, "w");
let result;
try {
  result = spawnSync(process.execPath, ["--import", "tsx/esm", "--test", "--test-concurrency=2",
    `--test-reporter=${ca01ReporterSpecifier(import.meta.url)}`, ...files],
  { cwd: process.cwd(), stdio: ["ignore", out, err] });
} finally { closeSync(out); closeSync(err); }
writeFileSync(`${prefix}.process.json`, JSON.stringify({ exitCode: result.status, signal: result.signal,
  error: result.error ? String(result.error) : null, node: process.version, platform: process.platform, arch: process.arch, files }, null, 2) + "\n");
if (suiteProcessFailed(result)) throw new Error("Suite process failed; see process evidence");
// Test exit 1 is evidence, not a waiver: the comparator enforces both suites below.
