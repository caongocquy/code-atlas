import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";

import { aggregateReceipts, evidenceFiles } from "../scripts/aggregate-ca01-v170-receipts.mjs";
import { verifyApprovalEnvironment, verifyOwnerApproval, verifyRepositoryOwner, verifyTrustedRun } from "../scripts/verify-ca01-v170-trust.mjs";

const sha256 = value => createHash("sha256").update(value).digest("hex");
const revisions = {
  base: { commit: "7520618fa68e378e6c480e8f6e2ce9c6ed73a476", tree: "7faeaf7c2abb75b3b92a6f27926415221216238f" },
  candidate: { commit: "0e49b3e1e50887b1e0fc800d26e8551ca6a22a38", tree: "30abfc47c051582979505e8f5f5f186a10a61d15" },
  frozen: { commit: "d2570bd789095d82442ff332beb36a5ddd998194", tree: "977b67ce7327efd4760fdb54cee941f93754f71a" },
};
const nodes = ["22.23.3", "24.21.0"];
const targets = [
  { platform: "darwin", arch: "arm64" }, { platform: "darwin", arch: "x64" },
  { platform: "linux", arch: "x64" }, { platform: "win32", arch: "x64" },
];
const frozenMissing = [
  [1060, "init indexes graph and lexical capabilities by default"],
  [1959, "init --no-index skips graph and lexical indexing"],
  [2809, "init preserves bootstrap when indexing fails and exits non-zero"],
  [3523, "init --no-index preserves an existing graph and lexical index"],
].map(([column, name]) => ({ file: "test/phase11k-closure.test.ts", line: 1, column, nesting: 0, name }));
const owner = { id: 123, login: "release-owner" };
const ownerUser = { ...owner, type: "User" };
const environmentId = 456;

function summary(overrides = {}) {
  return { tests: 1485, pass: 1436, fail: 49, cancelled: 0, skipped: 0, todo: 0, ...overrides };
}

function rawReport(counts) {
  const events = [];
  for (let index = 0; index < counts.pass; index++) events.push({ type: "test:pass", skip: false, todo: false, identity: { file: "test/pass.test.js", line: 1, column: index + 1, nesting: 0, name: `pass ${index}` } });
  for (let index = 0; index < counts.fail; index++) events.push({ type: "test:fail", skip: false, todo: false, identity: { file: "test/fail.test.js", line: 1, column: index + 1, nesting: 0, name: `fail ${index}` }, error: {} });
  for (let index = 0; index < counts.skipped; index++) events.push({ type: "test:pass", skip: "skipped", todo: false, identity: { file: "test/skip.test.js", line: 1, column: index + 1, nesting: 0, name: `skip ${index}` } });
  for (let index = 0; index < counts.todo; index++) events.push({ type: "test:pass", skip: false, todo: "todo", identity: { file: "test/todo.test.js", line: 1, column: index + 1, nesting: 0, name: `todo ${index}` } });
  for (let index = 0; index < counts.cancelled; index++) events.push({ type: "test:fail", skip: false, todo: false, identity: { file: "test/cancel.test.js", line: 1, column: index + 1, nesting: 0, name: `cancel ${index}` }, error: {} });
  events.push(...Object.entries(counts).map(([name, value]) => ({ type: "test:diagnostic", message: `${name} ${value}` })));
  return Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca01-v170-receipts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const cells = [];
  for (const target of targets) for (const node of nodes) cells.push({ ...target, node });
  for (const cell of cells) {
    const artifact = `ca01-native-${cell.platform}-${cell.arch}-node${cell.node}`;
    const dir = path.join(root, artifact);
    await mkdir(dir, { recursive: true });
    const processResults = {};
    const fileHashes = {};
    for (const side of ["baseline", "candidate", "frozen"]) {
      const stderr = Buffer.from("");
      const counts = side === "candidate" ? summary({ tests: 1504, pass: 1455, fail: 46, skipped: 3 }) : summary();
      const events = rawReport(counts);
      const processResult = {
        exitCode: 1, signal: null, error: null, node: `v${cell.node}`, platform: cell.platform, arch: cell.arch,
        revision: revisions[side === "baseline" ? "base" : side].commit,
        tree: revisions[side === "baseline" ? "base" : side].tree,
        loaderUrl: "file:///runner/node_modules/tsx/esm/index.mjs",
        loaderSha256: "2".repeat(64), tsxVersion: "4.23.13", pnpmVersion: "11.22.0",
        lockfileSha256: "3".repeat(64), eventsSha256: sha256(events), stderrSha256: sha256(stderr),
      };
      for (const [name, bytes] of [[`${side}.jsonl`, events], [`${side}.stderr`, stderr]]) {
        await writeFile(path.join(dir, name), bytes);
        fileHashes[name] = sha256(bytes);
      }
      await writeFile(path.join(dir, `${side}.process.json`), JSON.stringify(processResult) + "\n");
      fileHashes[`${side}.process.json`] = sha256(await import("node:fs/promises").then(fs => fs.readFile(path.join(dir, `${side}.process.json`))));
      processResults[side] = processResult;
    }
    const common = {
      differentialPass: true, strictGreen: { baseline: false, candidate: false },
      baseline: summary(), candidate: summary({ tests: 1504, pass: 1455, fail: 46, skipped: 3 }),
      addedFailures: [], changedFailures: [], missingTests: [], newSkips: [], changedSkips: [], newTodos: [],
      rawReports: { baselineSha256: processResults.baseline.eventsSha256, candidateSha256: processResults.candidate.eventsSha256 },
    };
    const frozen = {
      differentialPass: false, strictGreen: { baseline: false, candidate: false },
      baseline: summary(), candidate: summary({ tests: 1504, pass: 1455, fail: 46, skipped: 3 }),
      addedFailures: [], changedFailures: [], missingTests: frozenMissing, newSkips: [], changedSkips: [], newTodos: [],
    };
    for (const [name, report] of [["common-harness-comparison.json", common], ["frozen-strict-comparison.json", frozen]]) {
      const bytes = Buffer.from(JSON.stringify(report) + "\n");
      await writeFile(path.join(dir, name), bytes);
      fileHashes[name] = sha256(bytes);
    }
    for (const [name, contents] of [["common-harness.stdout", "common pass\n"], ["common-harness.stderr", ""],
      ["common-harness.exit", "0\n"], ["frozen-strict.stdout", "frozen retained\n"], ["frozen-strict.stderr", ""],
      ["frozen-strict.exit", "1\n"]]) {
      const bytes = Buffer.from(contents);
      await writeFile(path.join(dir, name), bytes);
      fileHashes[name] = sha256(bytes);
    }
    const receipt = {
      schemaVersion: 1, artifactName: artifact,
      target: { ...cell }, runId: "1001", runAttempt: "1", workflowRevision: "a".repeat(40), workflowTree: "b".repeat(40),
      ref: "refs/heads/master", refProtected: true,
      approval: { mode: "solo-owner-qualification", classification: "owner-approved", ownerId: owner.id, reviewerId: owner.id },
      environment: { name: "ca01-v170-native-qualification", id: environmentId, mode: "solo-owner-qualification", requiredReviewers: [`User:${owner.id}`], preventSelfReview: false, approved: true, rulesSha256: "4".repeat(64) },
      revisions, contractSha256: "5".repeat(64), processes: processResults, files: fileHashes,
    };
    const ownerApproval = {
      schemaVersion: 1, mode: "solo-owner-qualification", classification: "owner-approved", runId: "1001",
      environment: { id: environmentId, name: "ca01-v170-native-qualification" }, owner, reviewer: owner,
    };
    const ownerApprovalBytes = Buffer.from(JSON.stringify(ownerApproval, null, 2) + "\n");
    await writeFile(path.join(dir, "owner-approval.json"), ownerApprovalBytes);
    receipt.files["owner-approval.json"] = sha256(ownerApprovalBytes);
    await writeFile(path.join(dir, "receipt.json"), JSON.stringify(receipt, null, 2) + "\n");
  }
  return { root, cells, frozenMissing };
}

const expected = Object.freeze({
  runId: "1001", runAttempt: "1", workflowRevision: "a".repeat(40), workflowTree: "b".repeat(40),
  ref: "refs/heads/master", refProtected: true, environmentName: "ca01-v170-native-qualification",
  environmentRulesSha256: "4".repeat(64), environmentId, approvalMode: "solo-owner-qualification", ownerId: owner.id,
  ownerLogin: owner.login, contractSha256: "5".repeat(64), revisions,
  contract: { approval: { mode: "solo-owner-qualification", classification: "owner-approved" }, execution: { loaderSha256: "2".repeat(64), tsxVersion: "4.23.13" },
    dependencies: { pnpmVersion: "11.22.0", lockfileSha256: "3".repeat(64) } },
  preflightResult: "success", matrixResult: "success",
  controllerTestsResult: "success",
  approvalGateResult: "success",
});

test("aggregates exactly eight native receipts and preserves only the four frozen identity misses", async t => {
  const f = await fixture(t);
  const extraPath = path.join(f.root, "ca01-native-linux-x64-node22.23.3", "focused.tap");
  await writeFile(extraPath, "ok 1 - focused test\n");
  const receiptPath = path.join(path.dirname(extraPath), "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.files["focused.tap"] = sha256(await import("node:fs/promises").then(fs => fs.readFile(extraPath)));
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  const result = aggregateReceipts(f.root, expected);
  assert.equal(result.receipts, 8);
  assert.equal(result.trustVerified, true);
  assert.equal(result.qualificationPass, false);
  assert.equal(result.approvalClassification, "owner-approved");
  assert.deepEqual(result.separateAttestationGates, { G2: "BLOCKED", G3: "BLOCKED", D16: "BLOCKED" });
  assert.equal(result.cells.length, 8);
  assert.ok(result.cells.every(cell => cell.commonDifferentialPass));
  assert.deepEqual(result.frozenMissingIdentities, f.frozenMissing);
  assert.equal(result.frozenStrictOutcome, "EXPECTED_FAIL_WITH_FOUR_MISSING_IDENTITIES");
});

test("missing or extra native receipts fail closed", async t => {
  const f = await fixture(t);
  await rm(path.join(f.root, "ca01-native-win32-x64-node24.21.0"), { recursive: true });
  assert.throws(() => aggregateReceipts(f.root, expected), /exactly eight/);
  const extra = path.join(f.root, "unexpected"); await mkdir(extra);
  assert.throws(() => aggregateReceipts(f.root, expected), /exactly eight/);
});

test("duplicate platform/runtime tuple is rejected even with eight artifact names", async t => {
  const f = await fixture(t);
  const receiptPath = path.join(f.root, "ca01-native-linux-x64-node22.23.3", "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.target.platform = "darwin"; receipt.target.arch = "arm64";
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /tuple|artifact name/i);
});

test("digest, workflow, runtime, and approval mismatches are rejected", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "ca01-native-darwin-arm64-node22.23.3");
  const receiptPath = path.join(dir, "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.files["candidate.jsonl"] = "0".repeat(64);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /digest/i);
  receipt.files["candidate.jsonl"] = sha256(await import("node:fs/promises").then(fs => fs.readFile(path.join(dir, "candidate.jsonl"))));
  receipt.workflowRevision = "c".repeat(40);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /workflow revision/i);
  receipt.workflowRevision = expected.workflowRevision;
  receipt.environment.requiredReviewers = [];
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /reviewer/i);
});

test("owner approval classification and reviewer evidence cannot be relabeled or substituted", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "ca01-native-darwin-arm64-node22.23.3");
  const receiptPath = path.join(dir, "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.approval.classification = "independently-reviewed";
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /owner approval receipt mismatch/i);

  receipt.approval.classification = "owner-approved";
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  const approvalPath = path.join(dir, "owner-approval.json");
  const approval = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(approvalPath, "utf8")));
  approval.reviewer.id = 999;
  const approvalBytes = Buffer.from(JSON.stringify(approval, null, 2) + "\n");
  await writeFile(approvalPath, approvalBytes);
  receipt.files["owner-approval.json"] = sha256(approvalBytes);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /owner approval evidence mismatch/i);
});

test("unexpected frozen added, changed, skipped, todo, or missing identities block", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "ca01-native-darwin-arm64-node22.23.3");
  const reportPath = path.join(dir, "frozen-strict-comparison.json");
  const report = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(reportPath, "utf8")));
  report.addedFailures.push({ identity: { name: "new failure" } });
  await writeFile(reportPath, JSON.stringify(report) + "\n");
  const receiptPath = path.join(dir, "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.files["frozen-strict-comparison.json"] = sha256(await import("node:fs/promises").then(fs => fs.readFile(reportPath)));
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /frozen.*added|unexpected frozen/i);
});

test("an incomplete frozen summary or process evidence blocks", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "ca01-native-darwin-arm64-node22.23.3");
  const reportPath = path.join(dir, "frozen-strict-comparison.json");
  const report = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(reportPath, "utf8")));
  report.candidate.cancelled = 1;
  await writeFile(reportPath, JSON.stringify(report) + "\n");
  const receiptPath = path.join(dir, "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.files["frozen-strict-comparison.json"] = sha256(await import("node:fs/promises").then(fs => fs.readFile(reportPath)));
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /cancel|summary|counters|records/i);
});

test("raw event dispositions must match diagnostic counters even when all digests are refreshed", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "ca01-native-darwin-arm64-node22.23.3");
  const eventsPath = path.join(dir, "baseline.jsonl");
  const events = (await import("node:fs/promises").then(fs => fs.readFile(eventsPath, "utf8"))).trim().split("\n").map(JSON.parse);
  events[0].type = "test:fail";
  const eventsBytes = Buffer.from(events.map(event => JSON.stringify(event)).join("\n") + "\n");
  await writeFile(eventsPath, eventsBytes);

  const processPath = path.join(dir, "baseline.process.json");
  const processResult = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(processPath, "utf8")));
  processResult.eventsSha256 = sha256(eventsBytes);
  const processBytes = Buffer.from(JSON.stringify(processResult) + "\n");
  await writeFile(processPath, processBytes);

  const comparisonPath = path.join(dir, "common-harness-comparison.json");
  const comparison = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(comparisonPath, "utf8")));
  comparison.rawReports.baselineSha256 = processResult.eventsSha256;
  const comparisonBytes = Buffer.from(JSON.stringify(comparison) + "\n");
  await writeFile(comparisonPath, comparisonBytes);

  const receiptPath = path.join(dir, "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.processes.baseline = processResult;
  receipt.files["baseline.jsonl"] = sha256(eventsBytes);
  receipt.files["baseline.process.json"] = sha256(processBytes);
  receipt.files["common-harness-comparison.json"] = sha256(comparisonBytes);
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /raw suite records/i);
});

test("unexpected failure changes, skips, todos, and frozen identity drift all block", async t => {
  for (const [label, mutate] of [
    ["changed failure", report => report.changedFailures.push({ identity: frozenMissing[0] })],
    ["new skip", report => report.newSkips.push({ identity: frozenMissing[0] })],
    ["new todo", report => report.newTodos.push({ identity: frozenMissing[0] })],
    ["missing identity drift", report => { report.missingTests[0].column += 1; }],
  ]) await t.test(label, async child => {
    const f = await fixture(child);
    const dir = path.join(f.root, "ca01-native-darwin-arm64-node22.23.3");
    const reportPath = path.join(dir, "frozen-strict-comparison.json");
    const report = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(reportPath, "utf8")));
    mutate(report);
    await writeFile(reportPath, JSON.stringify(report) + "\n");
    const receiptPath = path.join(dir, "receipt.json");
    const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
    receipt.files["frozen-strict-comparison.json"] = sha256(await import("node:fs/promises").then(fs => fs.readFile(reportPath)));
    await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
    assert.throws(() => aggregateReceipts(f.root, expected), /frozen|identity/i);
  });
});

test("abnormal process termination remains blocking even with updated evidence hashes", async t => {
  const f = await fixture(t);
  const dir = path.join(f.root, "ca01-native-linux-x64-node22.23.3");
  const processPath = path.join(dir, "candidate.process.json");
  const processResult = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(processPath, "utf8")));
  processResult.signal = "SIGABRT";
  await writeFile(processPath, JSON.stringify(processResult) + "\n");
  const receiptPath = path.join(dir, "receipt.json");
  const receipt = JSON.parse(await import("node:fs/promises").then(fs => fs.readFile(receiptPath, "utf8")));
  receipt.processes.candidate = processResult;
  receipt.files["candidate.process.json"] = sha256(await import("node:fs/promises").then(fs => fs.readFile(processPath)));
  await writeFile(receiptPath, JSON.stringify(receipt, null, 2) + "\n");
  assert.throws(() => aggregateReceipts(f.root, expected), /process did not terminate/i);
});

test("approval environment must exist and have unique required reviewers", () => {
  const payload = { id: environmentId, name: "ca01-v170-native-qualification", protection_rules: [{ type: "required_reviewers", prevent_self_review: true,
    reviewers: [{ type: "User", reviewer: { id: 123, login: owner.login } }] }] };
  const verified = verifyApprovalEnvironment(payload);
  assert.deepEqual(verified.reviewers, ["User:123"]);
  assert.equal(verified.mode, "independent-review");
  assert.match(verified.rulesSha256, /^[a-f0-9]{64}$/);
  assert.notEqual(verifyApprovalEnvironment({ ...payload, protection_rules: [...payload.protection_rules, { type: "wait_timer", wait_timer: 30 }] }).rulesSha256,
    verified.rulesSha256, "all environment protection rules are bound into the approval metadata");
  assert.throws(() => verifyApprovalEnvironment({ id: environmentId, name: payload.name, protection_rules: [] }), /required reviewer/i);
  assert.throws(() => verifyApprovalEnvironment({ id: environmentId, name: payload.name, protection_rules: [{ type: "required_reviewers", reviewers: [] }] }), /required reviewer/i);
  assert.throws(() => verifyApprovalEnvironment({ id: environmentId, name: payload.name, protection_rules: [{ type: "required_reviewers", prevent_self_review: false,
    reviewers: [{ type: "User", reviewer: { id: 123 } }] }] }), /self-review/i);
  assert.throws(() => verifyApprovalEnvironment({ id: environmentId, name: payload.name, protection_rules: [{ type: "required_reviewers", reviewers: [
    { type: "User", reviewer: { id: 123 } }, { type: "User", reviewer: { id: 123 } },
  ] }] }), /duplicate/i);
});

test("solo-owner mode requires the repository owner as the only reviewer and permits self-review", () => {
  const payload = { id: environmentId, name: "ca01-v170-native-qualification", protection_rules: [{ type: "required_reviewers",
    prevent_self_review: false, reviewers: [{ type: "User", reviewer: owner }] }] };
  const verified = verifyApprovalEnvironment(payload, { mode: "solo-owner-qualification", ownerId: owner.id, ownerLogin: owner.login });
  assert.deepEqual(verified.reviewers, [`User:${owner.id}`]);
  assert.equal(verified.mode, "solo-owner-qualification");
  assert.equal(verified.environmentId, environmentId);
  const independentPayload = { ...payload, protection_rules: [{ ...payload.protection_rules[0], prevent_self_review: true }] };
  assert.notEqual(verified.rulesSha256, verifyApprovalEnvironment(independentPayload).rulesSha256);
  assert.throws(() => verifyApprovalEnvironment({ ...payload, protection_rules: [{ ...payload.protection_rules[0], reviewers: [{ type: "Team", reviewer: { id: owner.id } }] }] }, { mode: "solo-owner-qualification", ownerId: owner.id, ownerLogin: owner.login }), /only reviewer/i);
  assert.throws(() => verifyApprovalEnvironment({ ...payload, protection_rules: [{ ...payload.protection_rules[0], reviewers: [{ type: "User", reviewer: { id: 999, login: "other" } }] }] }, { mode: "solo-owner-qualification", ownerId: owner.id, ownerLogin: owner.login }), /only reviewer/i);
  assert.throws(() => verifyApprovalEnvironment(payload, { mode: "unknown", ownerId: owner.id, ownerLogin: owner.login }), /unsupported/i);
});

test("approval history must show one approved record for the exact environment and repository owner", () => {
  const approval = { state: "approved", user: ownerUser, environments: [{ id: environmentId, name: "ca01-v170-native-qualification" }] };
  const verified = verifyOwnerApproval([approval], { runId: "1001", environmentId, environmentName: "ca01-v170-native-qualification", ownerId: owner.id, ownerLogin: owner.login });
  assert.equal(verified.classification, "owner-approved");
  assert.equal(verified.mode, "solo-owner-qualification");
  assert.throws(() => verifyOwnerApproval([{ ...approval, user: { id: 999, login: "other" } }], { runId: "1001", environmentId, environmentName: "ca01-v170-native-qualification", ownerId: owner.id, ownerLogin: owner.login }), /repository owner/i);
  assert.throws(() => verifyOwnerApproval([{ ...approval, state: "rejected" }], { runId: "1001", environmentId, environmentName: "ca01-v170-native-qualification", ownerId: owner.id, ownerLogin: owner.login }), /repository owner/i);
  assert.throws(() => verifyOwnerApproval([approval, approval], { runId: "1001", environmentId, environmentName: "ca01-v170-native-qualification", ownerId: owner.id, ownerLogin: owner.login }), /one approval record/i);
  assert.throws(() => verifyOwnerApproval([{ ...approval, environments: [...approval.environments, ...approval.environments] }], { runId: "1001", environmentId, environmentName: "ca01-v170-native-qualification", ownerId: owner.id, ownerLogin: owner.login }), /one approval record/i);
  assert.throws(() => verifyOwnerApproval([{ ...approval, environments: [{ id: 999, name: "other" }] }], { runId: "1001", environmentId, environmentName: "ca01-v170-native-qualification", ownerId: owner.id, ownerLogin: owner.login }), /one approval record/i);
});

test("solo-owner identity must come from a user-owned repository", () => {
  assert.deepEqual(verifyRepositoryOwner({ owner: ownerUser }, owner.login), owner);
  assert.throws(() => verifyRepositoryOwner({ owner: { ...ownerUser, type: "Organization" } }, owner.login), /repository owner/i);
  assert.throws(() => verifyRepositoryOwner({ owner: ownerUser }, "different-owner"), /repository owner/i);
});

test("qualification trust requires the exact protected master controller revision", () => {
  const sha = "a".repeat(40);
  const trusted = { ref: "refs/heads/master", refProtected: true, workflowSha: sha, workflowTree: "b".repeat(40),
    checkoutSha: sha, checkoutTree: "b".repeat(40), environmentName: "ca01-v170-native-qualification" };
  assert.equal(verifyTrustedRun(trusted), true);
  assert.throws(() => verifyTrustedRun({ ...trusted, refProtected: false }), /protected master/i);
  assert.throws(() => verifyTrustedRun({ ...trusted, ref: "refs/heads/feature" }), /protected master/i);
  assert.throws(() => verifyTrustedRun({ ...trusted, checkoutSha: "c".repeat(40) }), /revision/i);
  assert.throws(() => verifyTrustedRun({ ...trusted, environmentName: "" }), /environment/i);
});

test("receipt writer binds every evidence file to protected-run metadata", async t => {
  const root = await mkdtemp(path.join(os.tmpdir(), "ca01-v170-writer-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  for (const name of evidenceFiles) await writeFile(path.join(root, name), "synthetic evidence\n");
  for (const side of ["baseline", "candidate", "frozen"]) {
    await writeFile(path.join(root, `${side}.process.json`), "{}\n");
  }
  const head = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const tree = execFileSync("git", ["rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const contractBytes = await readFile("scripts/ca01-v170-common-harness.json");
  const contractSha = sha256(contractBytes);
  const contract = JSON.parse(contractBytes);
  const approvalHistoryRoot = await mkdtemp(path.join(os.tmpdir(), "ca01-v170-approval-history-"));
  t.after(() => rm(approvalHistoryRoot, { recursive: true, force: true }));
  const approvalHistoryPath = path.join(approvalHistoryRoot, "approval-history.json");
  await writeFile(approvalHistoryPath, JSON.stringify([{ state: "approved", user: ownerUser, environments: [{ id: environmentId, name: "ca01-v170-native-qualification" }] }]));
  const reviewers = ["User:123"];
  const run = spawnSync(process.execPath, ["scripts/write-ca01-v170-receipt.mjs", root], { encoding: "utf8", env: {
    ...process.env, GITHUB_REF: "refs/heads/master", GITHUB_SHA: head, GITHUB_RUN_ID: "1001", GITHUB_RUN_ATTEMPT: "1",
    CA01_REF_PROTECTED: "true", CA01_CONTRACT_SHA256: contractSha, CA01_PLATFORM: process.platform,
    CA01_ARCH: process.arch, CA01_ENVIRONMENT_APPROVED: "true", CA01_ENVIRONMENT_RULES_SHA256: "4".repeat(64),
    CA01_ENVIRONMENT_REVIEWERS_JSON: JSON.stringify(reviewers),
    CA01_ENVIRONMENT_ID: String(environmentId), CA01_APPROVAL_MODE: contract.approval.mode,
    CA01_REPOSITORY_OWNER_ID: String(owner.id), CA01_REPOSITORY_OWNER_LOGIN: owner.login,
    CA01_APPROVAL_HISTORY_PATH: approvalHistoryPath,
  } });
  if (!contract.runtime.nodes.includes(process.versions.node)) {
    assert.notEqual(run.status, 0);
    assert.match(run.stderr, /Unsupported native qualification tuple/);
    return;
  }
  assert.equal(run.status, 0, run.stderr);
  const receipt = JSON.parse(await readFile(path.join(root, "receipt.json"), "utf8"));
  assert.equal(receipt.workflowRevision, head);
  assert.equal(receipt.workflowTree, tree);
  assert.equal(receipt.refProtected, true);
  assert.equal(receipt.environment.approved, true);
  assert.equal(receipt.approval.classification, "owner-approved");
  assert.equal(receipt.approval.mode, "solo-owner-qualification");
  assert.equal(receipt.approval.reviewerId, owner.id);
  assert.equal(JSON.parse(await readFile(path.join(root, "owner-approval.json"), "utf8")).classification, "owner-approved");
  assert.deepEqual(Object.keys(receipt.files).sort(), [...evidenceFiles].sort());
  assert.equal(receipt.artifactName, `ca01-native-${process.platform}-${process.arch}-node${process.versions.node}`);
});

test("native workflow passes trust through named step outputs and fails closed on mismatch", async () => {
  const workflow = await readFile(".github/workflows/v170-native-qualification.yml", "utf8");
  assert.doesNotMatch(workflow, /^\s+GITHUB_OUTPUT\s*:/m);
  assert.doesNotMatch(workflow, /trust-output/);
  for (const output of ["environment_rules_sha256", "environment_reviewers_json", "environment_id", "approval_mode",
    "repository_owner_id", "repository_owner_login", "workflow_tree"]) {
    assert.ok((workflow.match(new RegExp("steps\\.trust\\.outputs\\." + output, "g")) ?? []).length >= 2,
      `expected ${output} to bind verifier outputs to both consumers`);
  }
  for (const equality of [
    'test "$VERIFIED_RULES_SHA256" = "$EXPECTED_RULES_SHA256"',
    'test "$VERIFIED_APPROVAL_MODE" = solo-owner-qualification',
    'test "$VERIFIED_WORKFLOW_TREE" = "$EXPECTED_WORKFLOW_TREE"',
    'test "$CA01_LIVE_ENVIRONMENT_RULES_SHA256" = "$CA01_ENVIRONMENT_RULES_SHA256"',
    'test "$CA01_LIVE_ENVIRONMENT_REVIEWERS_JSON" = "$CA01_ENVIRONMENT_REVIEWERS_JSON"',
    'test "$CA01_LIVE_REPOSITORY_OWNER_ID" = "$CA01_REPOSITORY_OWNER_ID"',
  ]) assert.ok(workflow.includes(equality), `missing fail-closed comparison: ${equality}`);
});
