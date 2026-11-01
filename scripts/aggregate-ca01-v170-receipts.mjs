import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync } from "node:fs";
import process from "node:process";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const nodes = ["22.23.3", "24.21.0"];
const targets = [
  { platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" }, { platform: "win32", arch: "x64" },
];
export const evidenceFiles = [
  "baseline.jsonl", "baseline.process.json", "baseline.stderr",
  "candidate.jsonl", "candidate.process.json", "candidate.stderr",
  "frozen.jsonl", "frozen.process.json", "frozen.stderr",
  "common-harness.stdout", "common-harness.stderr", "common-harness.exit",
  "common-harness-comparison.json", "frozen-strict-comparison.json",
  "frozen-strict.stdout", "frozen-strict.stderr", "frozen-strict.exit",
];
const frozenMissing = [
  [1060, "init indexes graph and lexical capabilities by default"],
  [1959, "init --no-index skips graph and lexical indexing"],
  [2809, "init preserves bootstrap when indexing fails and exits non-zero"],
  [3523, "init --no-index preserves an existing graph and lexical index"],
].map(([column, name]) => ({ file: "test/phase11k-closure.test.ts", line: 1, column, nesting: 0, name }));
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const fail = message => { throw new Error(message); };
const exactKeys = (value, keys, label) => {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || Object.keys(value).sort().join("\0") !== [...keys].sort().join("\0")) fail(`Invalid ${label} shape`);
};
const equalJson = (actual, expected, label) => {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) fail(`${label} mismatch`);
};
const readJson = file => {
  try { return JSON.parse(readFileSync(file, "utf8")); }
  catch { return fail(`Missing or invalid JSON evidence: ${path.basename(file)}`); }
};
function listEvidenceFiles(root, relative = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (name === "receipt.json") continue;
    const file = path.join(root, ...name.split("/"));
    const stat = lstatSync(file);
    if (stat.isSymbolicLink()) fail(`Symlink in evidence: ${name}`);
    if (stat.isDirectory()) files.push(...listEvidenceFiles(root, name));
    else if (stat.isFile()) files.push(name);
    else fail(`Unsupported evidence entry: ${name}`);
  }
  return files.sort();
}

function rawSummary(file) {
  let events;
  try { events = readFileSync(file, "utf8").trim().split("\n").map(line => JSON.parse(line)); }
  catch { return fail(`Invalid raw report: ${path.basename(file)}`); }
  if (!events.length) fail(`Empty raw report: ${path.basename(file)}`);
  const records = events.filter(event => event?.type === "test:pass" || event?.type === "test:fail");
  const actual = { tests: records.length, pass: 0, fail: 0, cancelled: 0, skipped: 0, todo: 0 };
  for (const event of records) {
    const validFlag = value => typeof value === "boolean" || (typeof value === "string" && value.trim().length > 0);
    if (!event.identity?.file || !event.identity?.name || !validFlag(event.skip) || !validFlag(event.todo)
      || (event.skip && (event.todo || event.type !== "test:pass"))) fail(`Invalid raw test record: ${path.basename(file)}`);
    actual[event.skip ? "skipped" : event.todo ? "todo" : event.type === "test:pass" ? "pass" : "fail"]++;
  }
  const diagnostics = new Map();
  for (const event of events) {
    if (event?.type !== "test:diagnostic" || typeof event.message !== "string") continue;
    const match = /^(tests|pass|fail|cancelled|skipped|todo) (\d+)$/.exec(event.message);
    if (match) {
      if (diagnostics.has(match[1])) fail(`Duplicate ${match[1]} summary in ${path.basename(file)}`);
      diagnostics.set(match[1], Number(match[2]));
    }
  }
  if (diagnostics.size !== 6) fail(`Incomplete suite summary: ${path.basename(file)}`);
  const summary = Object.fromEntries(diagnostics);
  for (const key of ["tests", "pass", "fail", "cancelled", "skipped", "todo"]) {
    if (!Number.isSafeInteger(summary[key]) || summary[key] < 0) fail(`Invalid ${key} count`);
  }
  if (summary.tests !== records.length || Object.keys(actual).some(key => actual[key] !== summary[key]) || summary.cancelled !== 0) {
    fail(`Incomplete or inconsistent raw suite records: ${path.basename(file)}`);
  }
  return summary;
}

function validateProcess(process, side, target, revisions, contract) {
  exactKeys(process, ["exitCode", "signal", "error", "node", "platform", "arch", "revision", "tree",
    "loaderUrl", "loaderSha256", "tsxVersion", "pnpmVersion", "lockfileSha256", "eventsSha256", "stderrSha256"], `${side} process`);
  if (process.node !== `v${target.node}` || process.platform !== target.platform || process.arch !== target.arch) fail(`${side} runtime tuple mismatch`);
  const revision = revisions[side === "baseline" ? "base" : side];
  if (!revision || process.revision !== revision.commit || process.tree !== revision.tree) fail(`${side} revision mismatch`);
  if (process.error !== null || process.signal !== null || ![0, 1].includes(process.exitCode)) fail(`${side} process did not terminate normally`);
  if (!/^file:\/\//.test(process.loaderUrl ?? "") || pathToFileURL(fileURLToPath(process.loaderUrl)).href !== process.loaderUrl
    || process.loaderSha256 !== contract.execution.loaderSha256 || !/^[a-f0-9]{64}$/.test(process.loaderSha256)) fail(`${side} loader binding mismatch`);
  if (process.tsxVersion !== contract.execution.tsxVersion || process.pnpmVersion !== contract.dependencies.pnpmVersion
    || process.lockfileSha256 !== contract.dependencies.lockfileSha256) fail(`${side} toolchain binding mismatch`);
  for (const key of ["eventsSha256", "stderrSha256"]) if (!/^[a-f0-9]{64}$/.test(process[key] ?? "")) fail(`${side} missing ${key}`);
}

function checkReportSummary(report, baseline, candidate, label) {
  if (!report || !report.baseline || !report.candidate) fail(`Missing ${label} suite summaries`);
  equalJson(report.baseline, baseline, `${label} baseline counters`);
  equalJson(report.candidate, candidate, `${label} candidate counters`);
  if (report.baseline.cancelled !== 0 || report.candidate.cancelled !== 0) fail(`${label} report contains cancelled tests`);
}

function validateCell(dir, artifactName, expected) {
  const receiptPath = path.join(dir, "receipt.json");
  if (!lstatSync(dir).isDirectory() || lstatSync(dir).isSymbolicLink()) fail(`Invalid artifact directory: ${artifactName}`);
  const actualFiles = listEvidenceFiles(dir);
  const required = [...evidenceFiles].sort();
  if (required.some(name => !actualFiles.includes(name))) fail(`Incomplete ${artifactName} evidence inventory`);
  const receipt = readJson(receiptPath);
  exactKeys(receipt, ["schemaVersion", "artifactName", "target", "runId", "runAttempt", "workflowRevision", "workflowTree",
    "ref", "refProtected", "environment", "revisions", "contractSha256", "processes", "files"], `${artifactName} receipt`);
  if (receipt.schemaVersion !== 1 || receipt.artifactName !== artifactName) fail(`Invalid ${artifactName} receipt identity`);
  const target = { ...receipt.target };
  if (target.node !== expected.node || artifactName !== `ca01-native-${target.platform}-${target.arch}-node${target.node}`) fail(`Artifact name/tuple mismatch: ${artifactName}`);
  if (receipt.runId !== expected.runId || receipt.runAttempt !== expected.runAttempt) fail(`Run identity mismatch: ${artifactName}`);
  if (receipt.workflowRevision !== expected.workflowRevision || receipt.workflowTree !== expected.workflowTree) fail(`Workflow revision mismatch: ${artifactName}`);
  if (receipt.ref !== "refs/heads/master" || receipt.ref !== expected.ref || receipt.refProtected !== true || expected.refProtected !== true) fail(`Unprotected or unexpected qualification ref: ${artifactName}`);
  if (receipt.contractSha256 !== expected.contractSha256) fail(`Contract digest mismatch: ${artifactName}`);
  exactKeys(receipt.environment, ["name", "requiredReviewers", "approved", "rulesSha256"], `${artifactName} environment`);
  if (receipt.environment.name !== expected.environmentName || receipt.environment.approved !== true
    || !Array.isArray(receipt.environment.requiredReviewers) || receipt.environment.requiredReviewers.length === 0
    || receipt.environment.requiredReviewers.some(value => typeof value !== "string" || !value.trim())
    || receipt.environment.rulesSha256 !== expected.environmentRulesSha256) fail(`Required reviewer environment is not verified: ${artifactName}`);
  equalJson(receipt.revisions, expected.revisions, `${artifactName} source revisions`);
  exactKeys(receipt.target, ["platform", "arch", "node"], `${artifactName} tuple`);
  if (!receipt.files || typeof receipt.files !== "object" || Array.isArray(receipt.files)) fail(`Invalid ${artifactName} file hashes`);
  equalJson(Object.keys(receipt.files).sort(), actualFiles, `${artifactName} hashed file inventory`);
  exactKeys(receipt.processes, ["baseline", "candidate", "frozen"], `${artifactName} process inventory`);

  for (const name of actualFiles) {
    if (!/^[a-f0-9]{64}$/.test(receipt.files[name] ?? "")) fail(`Missing or malformed hash for ${name}`);
    if (path.posix.isAbsolute(name) || name.split("/").some(part => part === ".." || !part)) fail(`Unsafe evidence path: ${name}`);
    const file = path.join(dir, ...name.split("/"));
    const stat = lstatSync(file);
    if (!stat.isFile() || stat.isSymbolicLink()) fail(`Evidence file is not regular: ${name}`);
    if (sha256(readFileSync(file)) !== receipt.files[name]) fail(`Evidence digest mismatch: ${artifactName}/${name}`);
  }

  const processes = Object.fromEntries(["baseline", "candidate", "frozen"].map(side => {
    const process = readJson(path.join(dir, `${side}.process.json`));
    equalJson(process, receipt.processes[side], `${side} process receipt`);
    validateProcess(process, side, target, expected.revisions, expected.contract);
    if (sha256(readFileSync(path.join(dir, `${side}.jsonl`))) !== process.eventsSha256
      || sha256(readFileSync(path.join(dir, `${side}.stderr`))) !== process.stderrSha256) fail(`${side} process/report digest mismatch`);
    const summary = rawSummary(path.join(dir, `${side}.jsonl`));
    if ((process.exitCode === 0) !== (summary.fail === 0)) fail(`${side} process exit and suite counters disagree`);
    return [side, summary];
  }));

  const common = readJson(path.join(dir, "common-harness-comparison.json"));
  const strict = readJson(path.join(dir, "frozen-strict-comparison.json"));
  checkReportSummary(common, processes.baseline, processes.candidate, "common harness");
  checkReportSummary(strict, processes.frozen, processes.candidate, "frozen strict");
  if (!common.strictGreen || common.strictGreen.baseline !== (processes.baseline.fail === 0)
    || common.strictGreen.candidate !== (processes.candidate.fail === 0)
    || !strict.strictGreen || strict.strictGreen.baseline !== (processes.frozen.fail === 0)
    || strict.strictGreen.candidate !== (processes.candidate.fail === 0)) fail("Comparison strict-green flags disagree with suite counters");
  if (common.rawReports?.baselineSha256 !== receipt.processes.baseline.eventsSha256
    || common.rawReports?.candidateSha256 !== receipt.processes.candidate.eventsSha256) fail("Common comparison is not bound to raw reports");
  if (common.differentialPass !== true || common.addedFailures?.length !== 0 || common.changedFailures?.length !== 0
    || common.missingTests?.length !== 0 || common.newSkips?.length !== 0 || common.changedSkips?.length !== 0
    || common.newTodos?.length !== 0 || common.baseline.cancelled !== 0 || common.candidate.cancelled !== 0) {
    fail(`Common differential failed: ${artifactName}`);
  }
  if (strict.differentialPass !== false || strict.strictGreen?.baseline !== false || strict.strictGreen?.candidate !== false
    || strict.addedFailures?.length !== 0 || strict.changedFailures?.length !== 0 || strict.newSkips?.length !== 0
    || strict.changedSkips?.length !== 0 || strict.newTodos?.length !== 0 || strict.baseline.cancelled !== 0
    || strict.candidate.cancelled !== 0) fail(`Unexpected frozen strict outcome: ${artifactName}`);
  equalJson(strict.missingTests, frozenMissing, `Frozen historical missing identities (${artifactName})`);
  for (const [name, expectedExit] of [["common-harness.exit", "0"], ["frozen-strict.exit", "1"]]) {
    if (readFileSync(path.join(dir, name), "utf8").trim() !== expectedExit) fail(`${name} does not match its expected outcome`);
  }
  if (receipt.processes.frozen.exitCode !== 1 || receipt.processes.candidate.exitCode !== 1) fail(`Frozen strict process evidence mismatch: ${artifactName}`);
  return { artifactName, target, commonDifferentialPass: true, frozenDifferentialPass: false, frozenMissingIdentities: strict.missingTests };
}

export function aggregateReceipts(root, expected) {
  if (!expected || expected.ref !== "refs/heads/master" || expected.refProtected !== true
    || expected.environmentName !== "ca01-v170-native-qualification"
    || !/^[a-f0-9]{40}$/.test(expected.workflowRevision ?? "") || !/^[a-f0-9]{40}$/.test(expected.workflowTree ?? "")
    || !/^[a-f0-9]{64}$/.test(expected.contractSha256 ?? "") || !/^[a-f0-9]{64}$/.test(expected.environmentRulesSha256 ?? "")
    || !expected.runId || !expected.runAttempt || !expected.contract || !expected.revisions
    || expected.preflightResult !== "success" || expected.matrixResult !== "success"
    || expected.controllerTestsResult !== "success" || expected.approvalGateResult !== "success") {
    fail("Controller tests, trust preflight, approval gate, or native matrix did not succeed");
  }
  const artifacts = readdirSync(root).sort();
  const expectedNames = targets.flatMap(target => nodes.map(node => `ca01-native-${target.platform}-${target.arch}-node${node}`)).sort();
  equalJson(artifacts, expectedNames, "Native receipt inventory; exactly eight");
  const cells = artifacts.map(name => {
    const target = targets.find(item => name.startsWith(`ca01-native-${item.platform}-${item.arch}-`));
    const node = nodes.find(version => name.endsWith(`-node${version}`));
    if (!target || !node) fail(`Unsupported native cell artifact: ${name}`);
    return validateCell(path.join(root, name), name, { ...expected, target: { ...target, node }, node });
  });
  const tuples = new Set(cells.map(cell => JSON.stringify([cell.target.platform, cell.target.arch, cell.target.node])));
  if (tuples.size !== 8) fail("Duplicate or incomplete native platform/runtime tuples");
  return {
    receipts: cells.length,
    trustVerified: true,
    nativeCellsComplete: true,
    commonDifferentialPass: true,
    frozenStrictOutcome: "EXPECTED_FAIL_WITH_FOUR_MISSING_IDENTITIES",
    qualificationPass: false,
    cells,
    frozenMissingIdentities: frozenMissing,
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const evidenceRoot = process.argv[2];
  if (!evidenceRoot) throw new Error("Usage: aggregate-ca01-v170-receipts.mjs <receipt-directory>");
  const controllerRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const contractPath = path.join(controllerRoot, "scripts/ca01-v170-common-harness.json");
  const contractBytes = readFileSync(contractPath);
  const contractSha256 = sha256(contractBytes);
  if (contractSha256 !== process.env.CA01_CONTRACT_SHA256) fail("Controller contract digest mismatch");
  const contract = JSON.parse(contractBytes);
  const expected = {
    runId: process.env.GITHUB_RUN_ID, runAttempt: process.env.GITHUB_RUN_ATTEMPT,
    workflowRevision: process.env.GITHUB_SHA, workflowTree: process.env.CA01_WORKFLOW_TREE,
    ref: process.env.GITHUB_REF, refProtected: process.env.CA01_REF_PROTECTED === "true",
    environmentName: "ca01-v170-native-qualification", environmentRulesSha256: process.env.CA01_ENVIRONMENT_RULES_SHA256,
    contractSha256, contract, preflightResult: process.env.CA01_PREFLIGHT_RESULT, matrixResult: process.env.CA01_MATRIX_RESULT,
    controllerTestsResult: process.env.CA01_CONTROLLER_TESTS_RESULT,
    approvalGateResult: process.env.CA01_APPROVAL_GATE_RESULT,
    revisions: { base: contract.base, candidate: contract.candidate, frozen: contract.frozenTarget },
  };
  const result = aggregateReceipts(evidenceRoot, expected);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
}
