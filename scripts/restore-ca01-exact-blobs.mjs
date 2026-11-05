import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { execFileSync } from "node:child_process";

const sha256 = bytes => createHash("sha256").update(bytes).digest("hex");
const git = (root, args, options = {}) => execFileSync("git", ["-C", root, ...args], options);
function gitBlobSha(root, bytes) {
  return git(root, ["hash-object", "--no-filters", "--stdin"], { input: bytes, encoding: "utf8" }).trim();
}
function optionalConfig(root, name) {
  try { return git(root, ["config", "--show-origin", "--get", name], { encoding: "utf8" }).trim(); }
  catch { return null; }
}
function fileState(root, bytes) {
  return { bytes: bytes.length, sha256: sha256(bytes), gitBlob: gitBlobSha(root, bytes) };
}

export function restoreCa01ExactBlobs(roots, evidencePath) {
  if (!Array.isArray(roots) || roots.length === 0) throw new Error("At least one checkout root is required");
  const report = { schemaVersion: 1, files: [] };
  const save = () => {
    if (!evidencePath) return;
    const target = path.resolve(evidencePath);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, JSON.stringify(report, null, 2) + "\n");
  };
  try {
    for (const argument of roots) {
      const root = path.resolve(argument);
      const relativePath = "package.json";
      const entry = { root, path: relativePath };
      report.files.push(entry);
      const initial = readFileSync(path.join(root, relativePath));
      entry.before = fileState(root, initial);
      entry.attributes = git(root, ["check-attr", "--all", "--", relativePath], { encoding: "utf8" }).trim();
      entry.checkoutConfigBefore = {
        autocrlf: optionalConfig(root, "core.autocrlf"),
        eol: optionalConfig(root, "core.eol"),
      };

      git(root, ["config", "core.autocrlf", "false"]);
      git(root, ["config", "core.eol", "lf"]);
      git(root, ["checkout-index", "--force", "--all"]);
      entry.afterForcedCheckoutIndex = fileState(root, readFileSync(path.join(root, relativePath)));

      const blob = git(root, ["rev-parse", `HEAD:${relativePath}`], { encoding: "utf8" }).trim();
      const bytes = git(root, ["cat-file", "blob", blob]);
      if (gitBlobSha(root, bytes) !== blob) throw new Error(`Git blob read mismatch for ${root}/${relativePath}`);
      writeFileSync(path.join(root, relativePath), bytes);
      const restored = readFileSync(path.join(root, relativePath));
      entry.expectedGitBlob = blob;
      entry.afterRawBlobRestore = fileState(root, restored);
      if (entry.afterRawBlobRestore.gitBlob !== blob || !restored.equals(bytes)) {
        throw new Error(`Exact Git blob restoration failed for ${root}/${relativePath}`);
      }
    }
    save();
    return report;
  } catch (error) {
    report.error = error instanceof Error ? error.message : String(error);
    save();
    throw error;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [reportPath, ...roots] = process.argv.slice(2);
  if (!reportPath || roots.length === 0) throw new Error("Usage: restore-ca01-exact-blobs.mjs <evidence-report.json> <checkout-root>...");
  restoreCa01ExactBlobs(roots, reportPath);
}
