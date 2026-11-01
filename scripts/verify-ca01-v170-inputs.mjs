import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";

const [contractPath, baseRoot, candidateRoot, harnessRoot, frozenRoot, expectedContractSha] = process.argv.slice(2);
if (![contractPath, baseRoot, candidateRoot, harnessRoot, frozenRoot, expectedContractSha].every(Boolean)) {
  throw new Error("Usage: verify-ca01-v170-inputs.mjs <contract.json> <base-root> <candidate-root> <harness-root> <frozen-root> <expected-contract-sha256>");
}
const sha256 = value => createHash("sha256").update(value).digest("hex");
const contractBytes = readFileSync(contractPath);
assert.equal(sha256(contractBytes), expectedContractSha, "trusted common-harness contract digest mismatch");
const contract = JSON.parse(contractBytes);
const git = (root, ...args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();
const rootState = (root, expected, side) => {
  assert.equal(git(root, "rev-parse", "HEAD"), expected.commit, `${side} revision mismatch`);
  assert.equal(git(root, "rev-parse", "HEAD^{tree}"), expected.tree, `${side} tree mismatch`);
  const packageBytes = readFileSync(path.join(root, "package.json"));
  assert.equal(sha256(packageBytes), expected.packageJsonSha256, `${side} package metadata digest mismatch`);
  const pkg = JSON.parse(packageBytes);
  assert.equal(pkg.name, contract.dependencies.packageName, `${side} package name mismatch`);
  assert.equal(pkg.version, expected.packageVersion, `${side} package version mismatch`);
  assert.equal(sha256(readFileSync(path.join(root, "pnpm-lock.yaml"))), contract.dependencies.lockfileSha256, `${side} lockfile mismatch`);
  assert.equal(sha256(readFileSync(path.join(root, "scripts/parser-sources.json"))), contract.dependencies.parserSourcesSha256, `${side} parser input mismatch`);
  return pkg;
};

const basePackage = rootState(baseRoot, contract.base, "base");
const candidatePackage = rootState(candidateRoot, contract.candidate, "candidate");
const packageProjection = pkg => Object.fromEntries(Object.entries(pkg).filter(([key]) => key !== "version"));
assert.deepEqual(packageProjection(candidatePackage), packageProjection(basePackage), "package metadata changed outside root version");
for (const [side, root] of [["base", baseRoot], ["candidate", candidateRoot], ["frozen", frozenRoot]]) {
  assert.equal(sha256(readFileSync(path.join(root, "pnpm-lock.yaml"))), contract.dependencies.lockfileSha256, `${side} lockfile mismatch`);
  assert.equal(sha256(readFileSync(path.join(root, "scripts/parser-sources.json"))), contract.dependencies.parserSourcesSha256, `${side} parser input mismatch`);
}
assert.equal(sha256(readFileSync(path.join(candidateRoot, "scripts/compare-ca01-tests.mjs"))),
  contract.dependencies.strictComparatorSha256, "candidate comparator source does not match the reviewed contract");
assert.equal(sha256(readFileSync(path.join(harnessRoot, "scripts/ca01-v170-compare-ca01-tests.mjs"))),
  contract.dependencies.strictComparatorSha256, "controller comparator source does not match the reviewed candidate contract");
const parentLine = git(candidateRoot, "rev-list", "--parents", "-n", "1", contract.candidate.commit).split(" ");
assert.deepEqual(parentLine.slice(1), [contract.base.commit], "candidate must directly descend from the approved integration base");
const reviewedDiff = execFileSync("git", ["-C", candidateRoot, "diff", "--binary", contract.base.commit,
  contract.candidate.commit, "--", contract.source.path]);
assert.equal(sha256(reviewedDiff), contract.source.reviewedChangeDiffSha256, "test-source change is outside the reviewed contract");

process.stdout.write(JSON.stringify({
  base: { commit: contract.base.commit, tree: contract.base.tree, packageVersion: basePackage.version },
  candidate: { commit: contract.candidate.commit, tree: contract.candidate.tree, packageVersion: candidatePackage.version },
  lockfileSha256: contract.dependencies.lockfileSha256,
  parserSourcesSha256: contract.dependencies.parserSourcesSha256,
  strictComparatorSha256: contract.dependencies.strictComparatorSha256,
  reviewedTestSourceDiffSha256: contract.source.reviewedChangeDiffSha256,
  contractSha256: expectedContractSha,
}) + "\n");
