import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { extractParsedFacts } from "../../src/core/facts/facts-extractor.js";
import { indexRepository } from "../../src/core/indexing/index-pipeline.service.js";
import { getRepositoryIdentity } from "../../src/core/repository/repository-identity.js";
import { AtlasStore } from "../../src/storage/atlas/atlas.store.js";

type CallEvidence = {
  from: string;
  to: string;
  targetFile: string;
  confidence: string | null;
  strategy: string | null;
};
type ReviewItem = {
  id: string;
  file: string;
  line: number;
  column: number;
  calleeText: string;
  sourceExcerpt: string;
  predictedTargets: CallEvidence[];
  review: { status: "pending"; expectedTargets: null; reviewer: null; notes: null };
};

function argument(name: string): string {
  const index = process.argv.indexOf(name);
  const value = process.argv[index + 1];
  if (index < 0 || !value || value.startsWith("--")) throw new Error("Missing " + name);
  return value;
}

const root = path.resolve(argument("--repo"));
const output = path.resolve(argument("--output"));
const sourceRepository = argument("--source");
const commitSha = argument("--commit");
assert.match(commitSha, /^[a-f0-9]{40}$/, "Repository must use pinned full commit hash");

function git(...args: string[]): string {
  const result = spawnSync("git", args, { cwd: root, encoding: "utf8", timeout: 30_000 });
  assert.equal(result.status, 0, result.stderr);
  return result.stdout.trim();
}
assert.equal(git("rev-parse", "HEAD"), commitSha, "Refuse to evaluate an unpinned revision");
assert.equal(git("status", "--porcelain", "--untracked-files=no"), "", "Source tree must be clean before indexing");

const tracked = git("ls-files", "-z").split("\0").filter(Boolean);
const accepted = tracked.filter((file) => /\.(?:ts|tsx|js|jsx)$/.test(file)
  && !file.endsWith(".d.ts")
  && !/(^|\/)(?:node_modules|dist|build|coverage)(\/|$)/.test(file));
assert.ok(accepted.length > 0, "No JavaScript/TypeScript files in selected repository");
const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

type RawSite = {
  file: string;
  line: number;
  column: number;
  calleeText: string;
  sourceExcerpt: string;
};
const sites: RawSite[] = [];
const parseDiagnostics: Array<{file: string; status: string; messages: string[]}> = [];
for (const file of accepted) {
  const source = await readFile(path.join(root, file), "utf8");
  const language = file.endsWith(".tsx") ? "tsx"
    : file.endsWith(".ts") ? "typescript" : "javascript";
  const outcome = extractParsedFacts({ source, language, filePath: file, contentHash: sha256(source) });
  if (outcome.kind !== "facts") {
    parseDiagnostics.push({ file, status: outcome.kind, messages: ["Extraction returned no facts"] });
    continue;
  }
  const facts = outcome.facts;
  if (facts.parseStatus !== "complete" || facts.parserDiagnostics.length > 0) {
    parseDiagnostics.push({ file, status: facts.parseStatus, messages: facts.parserDiagnostics });
  }
  const lines = source.split("\n");
  for (const site of facts.callSites) {
    sites.push({
      file,
      line: site.range.startLine,
      column: site.range.startColumn ?? 0,
      calleeText: site.calleeText,
      sourceExcerpt: (lines[site.range.startLine - 1] ?? "").trim().slice(0, 180),
    });
  }
}
const outcome = await indexRepository(root, { skipGit: true });
assert.equal(outcome.kind, "published", JSON.stringify(outcome));
const store = new AtlasStore(path.join(root, ".codeatlas", "atlas.db"), { readOnly: true });
let graph;
try { graph = store.loadGraph(getRepositoryIdentity(root).id); }
finally { store.close(); }
const nodes = new Map(graph.nodes.map((node) => [node.id, node]));
const predictions = new Map<string, CallEvidence[]>();
for (const edge of graph.edges.filter((item) => item.type === "calls")) {
  const from = nodes.get(edge.from), to = nodes.get(edge.to);
  if (!from || !to) continue;
  for (const evidence of edge.resolution?.evidence ?? []) {
    const key = `${evidence.sourceUnit}:${evidence.startLine}`;
    const matches = predictions.get(key) ?? [];
    matches.push({
      from: from.qualifiedName ?? from.name,
      to: to.qualifiedName ?? to.name,
      targetFile: to.file,
      confidence: edge.resolution?.confidence ?? null,
      strategy: edge.resolution?.strategy ?? null,
    });
    predictions.set(key, matches);
  }
}
const byLine = new Map<string, number>();
for (const item of sites) {
  const key = `${item.file}:${item.line}`;
  byLine.set(key, (byLine.get(key) ?? 0) + 1);
}
const entries: ReviewItem[] = sites.map((site) => {
  const key = `${site.file}:${site.line}`;
  return {
    id: sha256([site.file, site.line, site.column, site.calleeText].join("|")).slice(0, 20),
    ...site,
    // Line-level provenance is ambiguous with multiple callsites per line.
    predictedTargets: (byLine.get(key) ?? 0) === 1
      ? [...new Map((predictions.get(key) ?? []).map((candidate) => [JSON.stringify(candidate), candidate])).values()]
        .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)))
      : [],
    review: { status: "pending", expectedTargets: null, reviewer: null, notes: null },
  };
}).sort((a, b) => a.file.localeCompare(b.file) || a.line - b.line || a.column - b.column || a.id.localeCompare(b.id));
const ambiguousSites = entries.filter((site) => (byLine.get(`${site.file}:${site.line}`) ?? 0) > 1).length;
const packet = {
  schemaVersion: "ca02-realworld-review-v1",
  provenance: { sourceRepository, commitSha, includedFiles: accepted, extractor: "Code Atlas HEAD" },
  summary: {
    fileCount: accepted.length,
    callsites: entries.length,
    predictedCallsites: entries.filter((site) => site.predictedTargets.length > 0).length,
    ambiguousSameLineCallsites: ambiguousSites,
    parseDiagnosticFiles: parseDiagnostics.length,
    reviewCompleted: 0,
    metrics: null,
    status: "review_required",
  },
  parseDiagnostics,
  sites: entries,
  methodology: "Reviewer must inspect source and resolve every callsite independently. A single line with multiple sites is unscored until site-level provenance can be attributed. No TP/FP/FN or precision/recall before adjudication.",
};
// Keep the full census for source-level recall auditing, but provide a bounded
// review subset so reviewers do not need to annotate thousands of callsites.
const sampleLimit = 160;
const selected = new Set<string>();
const select = (item: ReviewItem) => { if (selected.size < sampleLimit) selected.add(item.id); };
for (const site of entries.filter((item) => item.predictedTargets.length > 0)) select(site);
for (const file of accepted) {
  const first = entries.find((item) => item.file === file);
  if (first) select(first);
}
for (const item of [...entries].sort((a, b) =>
  sha256(commitSha + ":" + a.id).localeCompare(sha256(commitSha + ":" + b.id)))) select(item);
const sampled = entries.filter((item) => selected.has(item.id));
const reviewPacket = {
  ...packet,
  selection: {
    method: "deterministic_nonprobability_stratified",
    seed: commitSha,
    populationCallsites: entries.length,
    sampleCallsites: sampled.length,
    includesEveryAvailablePrediction: entries.filter((item) => item.predictedTargets.length > 0)
      .every((item) => selected.has(item.id)),
    description: "Prioritize predicted sites, then at least one site per source file, then deterministic hash ordering. Scores on this sample are NOT population-wide precision/recall.",
  },
  sites: sampled,
  summary: { ...packet.summary, reviewSampleCallsites: sampled.length },
};
const censusOutput = output.replace(/\.json$/, "-full-census.json");
await mkdir(path.dirname(output), { recursive: true });
await writeFile(output, JSON.stringify(reviewPacket, null, 2) + "\n");
await writeFile(censusOutput, JSON.stringify(packet, null, 2) + "\n");
process.stdout.write("CA02_REALWORLD_REVIEW " + JSON.stringify({
  sourceRepository, commitSha, ...reviewPacket.summary, selection: reviewPacket.selection,
}) + "\n");
