import path from "node:path";

import { promoteReviewedBaseline } from "./promote-baseline.js";
import { runRetrievalEval } from "./run.js";

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const command = args[0] === "promote" ? args.shift() : undefined;
  const root = process.cwd();
  if (command === "promote") {
    const confirmed = args.includes("--confirm-reviewed");
    await promoteReviewedBaseline({
      candidateJsonPath: path.resolve(root, args.find((arg) => arg.startsWith("--candidate-json="))?.split("=").slice(1).join("=") ?? "artifacts/retrieval-eval-candidate.json"),
      candidateMarkdownPath: path.resolve(root, args.find((arg) => arg.startsWith("--candidate-md="))?.split("=").slice(1).join("=") ?? "artifacts/retrieval-eval-candidate.md"),
      baselineJsonPath: path.resolve(root, "artifacts/retrieval-eval-baseline.json"),
      baselineMarkdownPath: path.resolve(root, "artifacts/retrieval-eval-baseline.md"),
      confirmReviewed: confirmed,
    });
    process.stdout.write("Reviewed retrieval baseline promoted.\n");
    return;
  }
  const result = await runRetrievalEval({
    repoRoot: root,
    outputDirectory: path.resolve(root, args.find((arg) => arg.startsWith("--output-dir="))?.split("=").slice(1).join("=") ?? "artifacts"),
    datasetPath: path.resolve(root, args.find((arg) => arg.startsWith("--dataset="))?.split("=").slice(1).join("=") ?? "eval/retrieval/dataset.json"),
  });
  process.stdout.write(`Candidate JSON: ${path.relative(root, result.jsonPath)}\nCandidate Markdown: ${path.relative(root, result.markdownPath)}\nDeterministic: ${result.report.determinism.passed ? "yes" : "no"}\n`);
  if (!result.report.determinism.passed) process.exitCode = 1;
}

main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
