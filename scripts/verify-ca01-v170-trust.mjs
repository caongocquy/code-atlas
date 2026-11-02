import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import process from "node:process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = value => createHash("sha256").update(value).digest("hex");

export function verifyRepositoryOwner(repository, expectedLogin) {
  const owner = repository?.owner;
  if (!owner || owner.type !== "User" || !Number.isSafeInteger(owner.id) || owner.id <= 0
    || typeof owner.login !== "string" || owner.login.toLowerCase() !== expectedLogin?.toLowerCase()) {
    throw new Error("Solo-owner qualification requires the authenticated repository owner account");
  }
  return { id: owner.id, login: owner.login };
}

export function verifyApprovalEnvironment(environment, { mode = "independent-review", ownerId, ownerLogin } = {}) {
  if (environment?.name !== "ca01-v170-native-qualification") throw new Error("Required approval environment is missing or misnamed");
  if (!Number.isSafeInteger(environment.id) || environment.id <= 0) throw new Error("Approval environment has no stable identity");
  const rules = environment?.protection_rules;
  if (!Array.isArray(rules)) throw new Error("Approval environment is missing protection rules");
  const reviewerRules = rules.filter(rule => rule?.type === "required_reviewers");
  if (reviewerRules.length !== 1 || !Array.isArray(reviewerRules[0].reviewers) || reviewerRules[0].reviewers.length === 0) {
    throw new Error("Environment must configure a required reviewer rule");
  }
  const reviewers = reviewerRules[0].reviewers.map(({ type, reviewer }) => {
    if (!["User", "Team"].includes(type) || !Number.isSafeInteger(reviewer?.id) || reviewer.id <= 0) {
      throw new Error("Invalid required reviewer identity");
    }
    return `${type}:${reviewer.id}`;
  }).sort();
  if (new Set(reviewers).size !== reviewers.length) throw new Error("Duplicate required reviewer");
  if (mode === "solo-owner-qualification") {
    if (!Number.isSafeInteger(ownerId) || ownerId <= 0 || typeof ownerLogin !== "string" || !ownerLogin
      || reviewers.length !== 1 || reviewers[0] !== `User:${ownerId}`) {
      throw new Error("Solo-owner approval must require the repository owner as its only reviewer");
    }
    if (reviewerRules[0].prevent_self_review !== false) throw new Error("Solo-owner approval must allow self-review");
  } else if (mode === "independent-review") {
    if (reviewerRules[0].prevent_self_review !== true) throw new Error("Required reviewer rule must prevent self-review");
  } else {
    throw new Error("Unsupported qualification approval mode");
  }
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const normalizedRules = rules.map(rule => rule?.type === "required_reviewers"
    ? { type: rule.type, reviewers, prevent_self_review: mode === "solo-owner-qualification" ? false : true }
    : stable(rule)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const rulesSha256 = sha256(JSON.stringify({
    protection_rules: normalizedRules,
    deployment_branch_policy: stable(environment.deployment_branch_policy ?? null),
  }));
  return { reviewers, rulesSha256, environmentId: environment.id, mode, ownerId, ownerLogin };
}

export function verifyOwnerApproval(approvalHistory, { runId, environmentId, environmentName, ownerId, ownerLogin }) {
  if (!/^[0-9]+$/.test(String(runId ?? "")) || !Number.isSafeInteger(environmentId) || environmentId <= 0
    || !Number.isSafeInteger(ownerId) || ownerId <= 0 || typeof ownerLogin !== "string" || !ownerLogin
    || !Array.isArray(approvalHistory)) throw new Error("Invalid owner-approval evidence or binding");
  const relevant = approvalHistory.filter(item => Array.isArray(item?.environments)
    && item.environments.filter(environment => environment?.id === environmentId && environment?.name === environmentName).length === 1);
  if (relevant.length !== 1) throw new Error("Expected one approval record for the qualification environment");
  const [approval] = relevant;
  if (approval.state !== "approved" || approval.user?.type !== "User" || approval.user?.id !== ownerId
    || approval.user?.login?.toLowerCase() !== ownerLogin.toLowerCase()) {
    throw new Error("Qualification environment approval was not granted by the repository owner");
  }
  return {
    schemaVersion: 1,
    mode: "solo-owner-qualification",
    classification: "owner-approved",
    runId: String(runId),
    environment: { id: environmentId, name: environmentName },
    owner: { id: ownerId, login: ownerLogin },
    reviewer: { id: approval.user.id, login: ownerLogin },
  };
}

export function verifyTrustedRun({ ref, refProtected, workflowSha, workflowTree, checkoutSha, checkoutTree, environmentName }) {
  if (ref !== "refs/heads/master" || refProtected !== true) throw new Error("Qualification must run on protected master");
  if (!/^[a-f0-9]{40}$/.test(workflowSha ?? "") || workflowSha !== checkoutSha
    || !/^[a-f0-9]{40}$/.test(workflowTree ?? "") || workflowTree !== checkoutTree) {
    throw new Error("Workflow revision does not match its checked out source");
  }
  if (environmentName !== "ca01-v170-native-qualification") throw new Error("Unexpected qualification approval environment");
  return true;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [environmentFile, controllerRoot, repositoryFile] = process.argv.slice(2);
  if (!environmentFile || !controllerRoot || !repositoryFile || !process.env.GITHUB_OUTPUT) {
    throw new Error("Usage: verify-ca01-v170-trust.mjs <environment-response.json> <controller-root> <repository-response.json>");
  }
  const environment = JSON.parse(readFileSync(environmentFile, "utf8"));
  const repository = JSON.parse(readFileSync(repositoryFile, "utf8"));
  const contract = JSON.parse(readFileSync(path.join(controllerRoot, "scripts/ca01-v170-common-harness.json"), "utf8"));
  const owner = verifyRepositoryOwner(repository, process.env.GITHUB_REPOSITORY_OWNER);
  const checkoutSha = execFileSync("git", ["-C", controllerRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const checkoutTree = execFileSync("git", ["-C", controllerRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const verified = verifyApprovalEnvironment(environment, { mode: contract.approval?.mode, ownerId: owner.id, ownerLogin: owner.login });
  verifyTrustedRun({
    ref: process.env.GITHUB_REF,
    refProtected: process.env.CA01_REF_PROTECTED === "true",
    workflowSha: process.env.GITHUB_SHA,
    workflowTree: checkoutTree,
    checkoutSha,
    checkoutTree,
    environmentName: "ca01-v170-native-qualification",
  });
  appendFileSync(process.env.GITHUB_OUTPUT,
    `environment_rules_sha256=${verified.rulesSha256}\nenvironment_reviewers_json=${JSON.stringify(verified.reviewers)}\nenvironment_id=${verified.environmentId}\napproval_mode=${verified.mode}\nrepository_owner_id=${owner.id}\nrepository_owner_login=${owner.login}\nworkflow_tree=${checkoutTree}\n`);
  process.stdout.write(`${JSON.stringify({ ...verified, ref: process.env.GITHUB_REF, protected: true, workflowSha: checkoutSha })}\n`);
}
