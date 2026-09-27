import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import { aggregateRankingMetrics, canonicalIdentity, matchesSelector } from "./metrics.js";
import { runRetrievalEval, type RetrievalEvalReport } from "./run.js";
import { RETRIEVAL_DATASET_VERSION, validateRetrievalDataset, validateRetrievalExtension, type RetrievalEvalCase, type RetrievalSelector } from "./types.js";

const EXTENSION_PATH = "eval/retrieval/b4b-extension.json";
const EXTENSION_HASH_PATH = "eval/retrieval/b4b-extension.sha256";

export type B4bCaseReport = {
  id: string;
  query: string;
  queryClass: string;
  fixture: string;
  semanticState: string;
  semanticLimitation: "no frozen semantic candidates in extension";
  graphExpansion: { added: number; relations: Record<string, number> };
  lexicalEvidence: Array<{ rank: number; effectiveRank: number; score: number; rankGroup?: string; identity: string }>;
  targetRanks: Array<{ role: "relevant" | "supporting"; identity: string; lexical: number | null; semantic: number | null; hybrid: number | null; graphOnly: number | null; final: number | null; taskContextFileRank: number | null; status: string }>;
  taskContextAdmission: { admittedRelevant: number; totalRelevant: number; admittedSupporting: number; totalSupporting: number; selectedItems: number; estimatedTokens: number; maxEstimatedTokens: number; budgetEfficiency: number };
  stages: Record<string, { ordered: string[]; candidates: RetrievalEvalReport["cases"][number]["stages"]["lexical"]["candidates"]; metrics: RetrievalEvalReport["cases"][number]["stages"]["lexical"]["metrics"] }>;
};

export type B4bReport = {
  schemaVersion: "b4b-report-v1";
  extensionId: string;
  extensionHash: string;
  caseCount: number;
  fixtureFamilies: string[];
  developmentOnly: true;
  semanticLimitation: "B4B has no frozen semantic vectors; empty semantic results do not assess semantic capability or justify a fusion conclusion.";
  deterministic: boolean;
  taskContextSummary: { admittedRelevant: number; totalRelevant: number; admittedSupporting: number; totalSupporting: number; selectedItems: number; estimatedTokens: number; budgetEfficiency: number; budgetOverflows: number };
  queryClassCounts: Record<string, number>;
  graphExpansionSummary: { added: number; relations: Record<string, number> };
  aggregates: Record<string, ReturnType<typeof aggregateRankingMetrics>>;
  cases: B4bCaseReport[];
};

export async function computeB4bExtensionHash(repoRoot: string, extensionBytes: Buffer, cases: readonly RetrievalEvalCase[]): Promise<string> {
  const hash = createHash("sha256").update("b4b-extension-v1\0").update(extensionBytes).update("\0");
  for (const fixture of [...new Set(cases.map((item) => item.fixture))].sort()) {
    const root = path.join(repoRoot, "eval/retrieval/fixtures", fixture);
    async function visit(directory: string): Promise<void> {
      for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) await visit(absolute);
        else if (entry.isFile()) hash.update(path.relative(root, absolute).split(path.sep).join("/")).update("\0").update(await readFile(absolute)).update("\0");
      }
    }
    hash.update(fixture).update("\0");
    await visit(root);
  }
  return hash.digest("hex");
}

function rankOf(candidates: readonly { identity: RetrievalEvalReport["cases"][number]["stages"]["lexical"]["candidates"][number]["identity"] }[], selector: RetrievalSelector): number | null {
  const index = candidates.findIndex((candidate) => matchesSelector(candidate.identity, selector));
  return index < 0 ? null : index + 1;
}

function contextFileRank(candidates: readonly { identity: RetrievalEvalReport["cases"][number]["stages"]["lexical"]["candidates"][number]["identity"] }[], selector: RetrievalSelector): number | null {
  if (selector.kind !== "symbol") return rankOf(candidates, selector);
  const index = candidates.findIndex((candidate) => candidate.identity.kind === "file" && candidate.identity.path.replaceAll("\\", "/").replace(/^\.\//, "") === selector.path.replaceAll("\\", "/").replace(/^\.\//, ""));
  return index < 0 ? null : index + 1;
}

function statusForTarget(ranks: { lexical: number | null; semantic: number | null; hybrid: number | null; graphOnly: number | null; hybridGraphExpansion: number | null; taskContext: number | null }): string {
  if (ranks.graphOnly !== null && ranks.lexical === null && ranks.semantic === null) return "graph recovery";
  if (ranks.lexical === null && ranks.semantic === null && ranks.graphOnly === null) return "candidate absent";
  if (ranks.lexical !== null && ranks.lexical > 5 && (ranks.hybrid === null || ranks.hybrid > 5)) return "lexical misorder";
  if (ranks.lexical !== null && ranks.lexical <= 5 && (ranks.hybrid === null || ranks.hybrid > 5) && ranks.semantic !== null) return "fusion displacement";
  return "already correct";
}

function candidates(measurement: RetrievalEvalReport["cases"][number]["stages"]["lexical"]): B4bCaseReport["stages"][string] {
  return { ordered: measurement.ordered, candidates: measurement.candidates, metrics: measurement.metrics };
}

function markdown(report: B4bReport): string {
  const fmt = (value: number | null | undefined): string => typeof value === "number" ? value.toFixed(4) : "n/a";
  const lines = [
    "# Phase16C-B4B Development Evidence", "",
    `- Extension: ${report.extensionId}`, `- Frozen extension hash: ${report.extensionHash}`,
    `- Development cases: ${report.caseCount}`, `- Fixture families: ${report.fixtureFamilies.join(", ")}`,
    `- Query classes: ${Object.entries(report.queryClassCounts).map(([queryClass, count]) => `${queryClass} ${count}`).join(", ")}`,
    `- Deterministic rerun: ${report.deterministic ? "PASS" : "FAIL"}`,
    `- Graph expansion candidates added: ${report.graphExpansionSummary.added}`,
    `- TaskContext admission: relevant ${report.taskContextSummary.admittedRelevant}/${report.taskContextSummary.totalRelevant}; supporting ${report.taskContextSummary.admittedSupporting}/${report.taskContextSummary.totalSupporting}; ${report.taskContextSummary.budgetOverflows} budget overflows; ${report.taskContextSummary.estimatedTokens} total estimated tokens`,
    `- Semantic limitation: ${report.semanticLimitation}`, "",
    "## B4B-only stage metrics", "", "| Stage | Hit@1 | Hit@3 | Hit@5 | MRR@5 | Recall@5 | Recall@10 | Judged noise |",
    "| --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: |",
  ];
  for (const [stage, metrics] of Object.entries(report.aggregates)) lines.push(`| ${stage} | ${fmt(metrics.hitAt1)} | ${fmt(metrics.hitAt3)} | ${fmt(metrics.hitAt5)} | ${fmt(metrics.mrrAt5)} | ${fmt(metrics.recallAt5)} | ${fmt(metrics.recallAt10)} | ${fmt(metrics.judgedNoiseRate)} |`);
  for (const item of report.cases) {
    lines.push("", `## ${item.id}`, "", `- ${item.query}`, `- Query class: ${item.queryClass}; fixture: ${item.fixture}; semantic state: ${item.semanticState}`, "", "| Target | Lexical | Semantic | Hybrid | Graph-only | Final hybrid + graph | TaskContext file rank | Classification |", "| --- | ---: | ---: | ---: | ---: | ---: | ---: | --- |");
    for (const target of item.targetRanks) lines.push(`| ${target.role}: ${target.identity} | ${target.lexical ?? "absent"} | ${target.semantic ?? "absent"} | ${target.hybrid ?? "absent"} | ${target.graphOnly ?? "absent"} | ${target.final ?? "absent"} | ${target.taskContextFileRank ?? "absent"} | ${target.status} |`);
    lines.push("", `TaskContext admission: relevant ${item.taskContextAdmission.admittedRelevant}/${item.taskContextAdmission.totalRelevant}; supporting ${item.taskContextAdmission.admittedSupporting}/${item.taskContextAdmission.totalSupporting}; selected ${item.taskContextAdmission.selectedItems} items / ${item.taskContextAdmission.estimatedTokens} of ${item.taskContextAdmission.maxEstimatedTokens} estimated tokens; efficiency ${fmt(item.taskContextAdmission.budgetEfficiency)} relevant coverage per 1,000 tokens.`);
    lines.push("", "Lexical production evidence:", "", "| Position | Effective rank | Score | Explicit tie group | Candidate |", "| ---: | ---: | ---: | --- | --- |");
    for (const candidate of item.lexicalEvidence) lines.push(`| ${candidate.rank} | ${candidate.effectiveRank} | ${candidate.score} | ${candidate.rankGroup ?? "none"} | ${candidate.identity} |`);
  }
  return `${lines.join("\n")}\n`;
}

export async function runB4bEval(input: { repoRoot: string; outputDirectory: string }): Promise<{ report: B4bReport; jsonPath: string; markdownPath: string }> {
  const repoRoot = path.resolve(input.repoRoot);
  const outputDirectory = path.resolve(input.outputDirectory);
  if (outputDirectory === repoRoot || outputDirectory.startsWith(`${repoRoot}${path.sep}`)) throw new Error("B4B reports must be written outside the repository");

  const extensionBytes = await readFile(path.join(repoRoot, EXTENSION_PATH));
  const extension = validateRetrievalExtension(JSON.parse(extensionBytes.toString("utf8")) as unknown);
  const actualHash = await computeB4bExtensionHash(repoRoot, extensionBytes, extension.cases);
  const recordedHash = (await readFile(path.join(repoRoot, EXTENSION_HASH_PATH), "utf8")).trim();
  if (actualHash !== recordedHash) throw new Error(`B4B extension hash mismatch: expected ${recordedHash}, got ${actualHash}`);

  const frozenDataset = JSON.parse(await readFile(path.join(repoRoot, "eval/retrieval/dataset.json"), "utf8")) as { semanticVectorFixtureId: string; cases: RetrievalEvalCase[] };
  if (extension.semanticVectorFixtureId !== frozenDataset.semanticVectorFixtureId) throw new Error("B4B extension semantic fixture identity must match the frozen dataset");
  const dataset = validateRetrievalDataset({ datasetVersion: RETRIEVAL_DATASET_VERSION, semanticVectorFixtureId: frozenDataset.semanticVectorFixtureId, cases: [...frozenDataset.cases, ...extension.cases] });

  await mkdir(outputDirectory, { recursive: true });
  const tempDirectory = await mkdtemp(path.join(os.tmpdir(), "code-atlas-b4b-input-"));
  const datasetPath = path.join(tempDirectory, "combined-input.json");
  try {
    await writeFile(datasetPath, `${JSON.stringify({ ...dataset, semanticVectorFixtureId: frozenDataset.semanticVectorFixtureId }, null, 2)}\n`);
    const { report: full } = await runRetrievalEval({ repoRoot, datasetPath, outputDirectory: tempDirectory, productionLexicalEvidence: true });
    const extensionIds = new Set(extension.cases.map((item) => item.id));
    const selected = full.cases.filter((item) => extensionIds.has(item.id));
    if (selected.length !== extension.cases.length) throw new Error("B4B report did not contain every frozen extension case");

    const cases: B4bCaseReport[] = selected.map((item) => {
      const sourceCase = extension.cases.find((candidate) => candidate.id === item.id)!;
      const lexical = item.profiles.enabled.lexical;
      const semantic = item.profiles.enabled.vector;
      const hybrid = item.profiles.enabled.hybrid;
      const graphOnly = item.profiles.enabled.graphOnly;
      const hybridGraph = item.profiles.enabled.hybridGraphExpansion;
      const taskContext = item.taskContext.subjects;
      const positiveSelectors = [
        ...sourceCase.relevant.map((selector) => ({ role: "relevant" as const, selector })),
        ...(sourceCase.supporting ?? []).map((selector) => ({ role: "supporting" as const, selector })),
      ];
      const targetRanks = positiveSelectors.map(({ role, selector }) => {
        const ranks = {
          lexical: rankOf(lexical.candidates, selector), semantic: rankOf(semantic.candidates, selector), hybrid: rankOf(hybrid.candidates, selector),
          graphOnly: rankOf(graphOnly.candidates, selector), final: rankOf(hybridGraph.candidates, selector), taskContext: contextFileRank(taskContext.candidates, selector),
        };
        const { taskContext: taskContextFileRank, ...retrievalRanks } = ranks;
        return { role, identity: canonicalIdentity(selector), ...retrievalRanks, taskContextFileRank, status: statusForTarget({ ...retrievalRanks, hybridGraphExpansion: ranks.final, taskContext: taskContextFileRank }) };
      });
      return {
        id: item.id, query: item.query, queryClass: item.queryClass, fixture: item.fixture, semanticState: item.profiles.enabled.semanticState,
        semanticLimitation: "no frozen semantic candidates in extension", graphExpansion: item.profiles.enabled.graphExpansion,
        lexicalEvidence: lexical.candidates.map((candidate, index) => ({ rank: candidate.candidatePosition ?? index + 1, effectiveRank: candidate.effectiveLexicalRank ?? index + 1, score: candidate.lexicalScore ?? 0, ...(candidate.lexicalRankGroup ? { rankGroup: candidate.lexicalRankGroup } : {}), identity: canonicalIdentity(candidate.identity) })),
        targetRanks,
        taskContextAdmission: { admittedRelevant: item.taskContext.admittedRelevantItems, totalRelevant: sourceCase.relevant.length, admittedSupporting: item.taskContext.admittedSupportingItems, totalSupporting: (sourceCase.supporting ?? []).length, selectedItems: item.taskContext.budget.selectedItems, estimatedTokens: item.taskContext.budget.estimatedTokens, maxEstimatedTokens: item.taskContext.budget.maxEstimatedTokens, budgetEfficiency: item.taskContext.budgetEfficiency },
        stages: { lexical: candidates(lexical), semantic: candidates(semantic), hybrid: candidates(hybrid), graphOnly: candidates(graphOnly), hybridGraphExpansion: candidates(hybridGraph) },
      };
    });
    const stageNames = ["lexical", "semantic", "hybrid", "graphOnly", "hybridGraphExpansion"] as const;
    const aggregates = Object.fromEntries(stageNames.map((stage) => [stage, aggregateRankingMetrics(selected.map((item) => {
      if (stage === "semantic") return item.profiles.enabled.vector.metrics;
      return item.profiles.enabled[stage].metrics;
    }))]));
    const result: B4bReport = {
      schemaVersion: "b4b-report-v1", extensionId: extension.extensionId, extensionHash: actualHash, caseCount: cases.length,
      fixtureFamilies: [...new Set(cases.map((item) => item.fixture))].sort(), developmentOnly: true,
      semanticLimitation: "B4B has no frozen semantic vectors; empty semantic results do not assess semantic capability or justify a fusion conclusion.",
      deterministic: full.determinism.passed,
      taskContextSummary: {
        admittedRelevant: cases.reduce((sum, item) => sum + item.taskContextAdmission.admittedRelevant, 0),
        totalRelevant: cases.reduce((sum, item) => sum + item.taskContextAdmission.totalRelevant, 0),
        admittedSupporting: cases.reduce((sum, item) => sum + item.taskContextAdmission.admittedSupporting, 0),
        totalSupporting: cases.reduce((sum, item) => sum + item.taskContextAdmission.totalSupporting, 0),
        selectedItems: cases.reduce((sum, item) => sum + item.taskContextAdmission.selectedItems, 0),
        estimatedTokens: cases.reduce((sum, item) => sum + item.taskContextAdmission.estimatedTokens, 0),
        budgetEfficiency: cases.length ? cases.reduce((sum, item) => sum + item.taskContextAdmission.budgetEfficiency, 0) / cases.length : 0,
        budgetOverflows: selected.filter((item) => item.taskContext.budget.budgetExceeded).length,
      },
      queryClassCounts: Object.fromEntries([...new Set(cases.map((item) => item.queryClass))].sort().map((queryClass) => [queryClass, cases.filter((item) => item.queryClass === queryClass).length])),
      graphExpansionSummary: cases.reduce((summary, item) => {
        summary.added += item.graphExpansion.added;
        for (const [relation, count] of Object.entries(item.graphExpansion.relations)) summary.relations[relation] = (summary.relations[relation] ?? 0) + count;
        return summary;
      }, { added: 0, relations: {} as Record<string, number> }),
      aggregates, cases,
    };
    const jsonPath = path.join(outputDirectory, "b4b-report.json");
    const markdownPath = path.join(outputDirectory, "b4b-report.md");
    await writeFile(jsonPath, `${JSON.stringify(result, null, 2)}\n`);
    await writeFile(markdownPath, markdown(result));
    return { report: result, jsonPath, markdownPath };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true });
  }
}
