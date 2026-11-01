import { createHash } from "node:crypto";
import { appendFileSync, readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { pathToFileURL } from "node:url";

const sha256 = value => createHash("sha256").update(value).digest("hex");

export function verifyApprovalEnvironment(environment) {
  if (environment?.name !== "ca01-v170-native-qualification") throw new Error("Required approval environment is missing or misnamed");
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
  if (reviewerRules[0].prevent_self_review !== true) throw new Error("Required reviewer rule must prevent self-review");
  const stable = value => Array.isArray(value) ? value.map(stable)
    : value && typeof value === "object" ? Object.fromEntries(Object.keys(value).sort().map(key => [key, stable(value[key])])) : value;
  const normalizedRules = rules.map(rule => rule?.type === "required_reviewers"
    ? { type: rule.type, reviewers, prevent_self_review: true }
    : stable(rule)).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const rulesSha256 = sha256(JSON.stringify({
    protection_rules: normalizedRules,
    deployment_branch_policy: stable(environment.deployment_branch_policy ?? null),
  }));
  return { reviewers, rulesSha256 };
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
  const [environmentFile, controllerRoot] = process.argv.slice(2);
  if (!environmentFile || !controllerRoot || !process.env.GITHUB_OUTPUT) {
    throw new Error("Usage: verify-ca01-v170-trust.mjs <environment-response.json> <controller-root>");
  }
  const environment = JSON.parse(readFileSync(environmentFile, "utf8"));
  const checkoutSha = execFileSync("git", ["-C", controllerRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const checkoutTree = execFileSync("git", ["-C", controllerRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
  const verified = verifyApprovalEnvironment(environment);
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
    `environment_rules_sha256=${verified.rulesSha256}\nenvironment_reviewers_json=${JSON.stringify(verified.reviewers)}\nworkflow_tree=${checkoutTree}\n`);
  process.stdout.write(`${JSON.stringify({ ...verified, ref: process.env.GITHUB_REF, protected: true, workflowSha: checkoutSha })}\n`);
}
