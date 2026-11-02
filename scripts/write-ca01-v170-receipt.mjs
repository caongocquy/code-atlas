import { createHash } from "node:crypto";
import { lstatSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { evidenceFiles } from "./aggregate-ca01-v170-receipts.mjs";
import { verifyOwnerApproval, verifyTrustedRun } from "./verify-ca01-v170-trust.mjs";

const [evidenceRoot] = process.argv.slice(2);
if (!evidenceRoot) throw new Error("Usage: write-ca01-v170-receipt.mjs <evidence-directory>");
const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
function listFiles(root, relative = "") {
  const files = [];
  for (const entry of readdirSync(path.join(root, relative), { withFileTypes: true })) {
    const name = path.posix.join(relative, entry.name);
    if (name === "receipt.json") continue;
    const file = path.join(root, ...name.split("/")), stat = lstatSync(file);
    if (stat.isSymbolicLink()) throw new Error(`Symlink in qualification evidence: ${name}`);
    if (stat.isDirectory()) files.push(...listFiles(root, name));
    else if (stat.isFile()) files.push(name);
    else throw new Error(`Unsupported qualification evidence: ${name}`);
  }
  return files.sort();
}
const contractPath = path.resolve("scripts/ca01-v170-common-harness.json");
const contractBytes = readFileSync(contractPath);
const contractSha256 = sha256(contractBytes);
if (contractSha256 !== process.env.CA01_CONTRACT_SHA256) throw new Error("Controller contract digest mismatch");
const contract = JSON.parse(contractBytes);
if (contract.approval?.mode !== "solo-owner-qualification" || contract.approval?.classification !== "owner-approved") {
  throw new Error("Controller contract does not declare solo-owner qualification");
}
const controllerRoot = process.cwd();
const workflowTree = execFileSync("git", ["-C", controllerRoot, "rev-parse", "HEAD^{tree}"], { encoding: "utf8" }).trim();
const workflowSha = execFileSync("git", ["-C", controllerRoot, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
verifyTrustedRun({ ref: process.env.GITHUB_REF, refProtected: process.env.CA01_REF_PROTECTED === "true",
  workflowSha: process.env.GITHUB_SHA, workflowTree, checkoutSha: workflowSha, checkoutTree: workflowTree,
  environmentName: "ca01-v170-native-qualification" });
if (process.env.CA01_ENVIRONMENT_APPROVED !== "true" || !/^[a-f0-9]{64}$/.test(process.env.CA01_ENVIRONMENT_RULES_SHA256 ?? "")) {
  throw new Error("Required approval environment was not verified");
}
const reviewers = JSON.parse(process.env.CA01_ENVIRONMENT_REVIEWERS_JSON ?? "null");
if (!Array.isArray(reviewers) || reviewers.length === 0 || reviewers.some(value => typeof value !== "string" || !value)) {
  throw new Error("Required environment reviewers are missing");
}
const ownerId = Number(process.env.CA01_REPOSITORY_OWNER_ID);
const environmentId = Number(process.env.CA01_ENVIRONMENT_ID);
const ownerLogin = process.env.CA01_REPOSITORY_OWNER_LOGIN;
if (process.env.CA01_APPROVAL_MODE !== contract.approval.mode || !Number.isSafeInteger(ownerId) || ownerId <= 0
  || !Number.isSafeInteger(environmentId) || environmentId <= 0 || !ownerLogin || !process.env.CA01_APPROVAL_HISTORY_PATH) {
  throw new Error("Solo-owner approval binding is missing or inconsistent");
}
const approvalHistoryBytes = readFileSync(process.env.CA01_APPROVAL_HISTORY_PATH, "utf8");
const ownerApproval = verifyOwnerApproval(JSON.parse(approvalHistoryBytes), {
  runId: process.env.GITHUB_RUN_ID, environmentId, environmentName: "ca01-v170-native-qualification", ownerId, ownerLogin,
});
writeFileSync(path.join(evidenceRoot, "owner-approval.json"), `${JSON.stringify(ownerApproval, null, 2)}\n`);
const tuple = { platform: process.env.CA01_PLATFORM, arch: process.env.CA01_ARCH, node: process.versions.node };
if (!contract.runtime.nodes.includes(tuple.node)
  || !contract.runtime.targets.some(target => target.platform === tuple.platform && target.arch === tuple.arch)) {
  throw new Error("Unsupported native qualification tuple");
}
const inventory = listFiles(evidenceRoot);
if (evidenceFiles.some(name => !inventory.includes(name))) throw new Error("Incomplete qualification evidence inventory");
const files = Object.fromEntries(inventory.map(name => [name, sha256(readFileSync(path.join(evidenceRoot, ...name.split("/"))))]));
const processes = Object.fromEntries(["baseline", "candidate", "frozen"].map(side => [
  side, JSON.parse(readFileSync(path.join(evidenceRoot, `${side}.process.json`), "utf8")),
]));
const receipt = {
  schemaVersion: 1,
  artifactName: `ca01-native-${tuple.platform}-${tuple.arch}-node${tuple.node}`,
  target: tuple,
  runId: process.env.GITHUB_RUN_ID,
  runAttempt: process.env.GITHUB_RUN_ATTEMPT,
  workflowRevision: workflowSha,
  workflowTree,
  ref: process.env.GITHUB_REF,
  refProtected: process.env.CA01_REF_PROTECTED === "true",
  approval: {
    mode: ownerApproval.mode,
    classification: ownerApproval.classification,
    ownerId: ownerApproval.owner.id,
    reviewerId: ownerApproval.reviewer.id,
  },
  environment: {
    name: "ca01-v170-native-qualification",
    id: environmentId,
    mode: contract.approval.mode,
    requiredReviewers: reviewers,
    preventSelfReview: false,
    approved: process.env.CA01_ENVIRONMENT_APPROVED === "true",
    rulesSha256: process.env.CA01_ENVIRONMENT_RULES_SHA256,
  },
  revisions: { base: contract.base, candidate: contract.candidate, frozen: contract.frozenTarget },
  contractSha256,
  processes,
  files,
};
writeFileSync(path.join(evidenceRoot, "receipt.json"), `${JSON.stringify(receipt, null, 2)}\n`);
process.stdout.write(`${JSON.stringify({ artifactName: receipt.artifactName, evidenceFiles: evidenceFiles.length, workflowRevision: workflowSha })}\n`);
