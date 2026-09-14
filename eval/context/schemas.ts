import path from "node:path";

import { z } from "zod";

import { LANGUAGE_CONFIGS } from "../../src/core/graph/parsers/languages.js";
import { BASELINE_VERSION, CORPUS_VERSION, POLICY_VERSION, type CorpusManifest, type GoldenBaseline, type QualityPolicy } from "./types.js";

const syntheticClasses = ["exact-target", "relationship/change", "incomplete/ambiguity"] as const;
const deliveryModes = ["full", "unchanged", "delta", "rehydrate", "error"] as const;
const selectedItemsFormula = "baselineSelectedItems + max(3, baselineSelectedItems)";

function isCanonicalRelativePath(value: string): boolean {
  if (!value || path.posix.isAbsolute(value) || value.includes("\\")) return false;
  const parts = value.split("/");
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..") && path.posix.normalize(value) === value;
}

function unique(values: readonly { [key: string]: string }[], key: string): boolean {
  return new Set(values.map((value) => value[key])).size === values.length;
}

const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._/-]*$/, "must be a stable identifier");
const canonicalPath = z.string().refine(isCanonicalRelativePath, "must be a canonical repository-relative path");
const language = z.string().refine((value) => LANGUAGE_CONFIGS.map(({ language }) => language).includes(value as (typeof LANGUAGE_CONFIGS)[number]["language"]), "must be a production supported language");
const nonNegative = z.number().finite().nonnegative();

const contextSubject = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: canonicalPath }).strict(),
  z.object({ kind: z.literal("symbol"), path: canonicalPath, symbolId: z.string().min(1), selectorVersion: z.string().min(1) }).strict(),
]);

const taskContextAnchor = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("file"), path: canonicalPath }).strict(),
  z.object({ kind: z.literal("symbol"), path: canonicalPath.optional(), name: z.string().min(1) }).strict(),
]);

const scenarioPrimitive = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("start") }).strict(),
  z.object({ kind: z.literal("refresh"), expectedModeSequence: z.array(z.enum(deliveryModes)).optional() }).strict(),
  z.object({ kind: z.literal("mutate"), files: z.record(canonicalPath, z.string()) }).strict(),
  z.object({ kind: z.literal("restart") }).strict(),
]);

const lifecycleScenario = z.object({
  primitives: z.array(scenarioPrimitive).min(1),
  expectedModes: z.array(z.enum(deliveryModes)),
}).strict();

const correctnessTruth = z.object({
  requiredSubjects: z.array(contextSubject),
  supportingSubjects: z.array(contextSubject),
  forbiddenRequiredSubjects: z.array(contextSubject),
}).strict();

const evalCase = z.object({
  caseId: identifier,
  kind: z.enum(["synthetic", "snapshot"]),
  language,
  syntheticClass: z.enum(syntheticClasses).optional(),
  workspaceRef: canonicalPath,
  task: z.string().trim().min(1),
  anchors: z.array(taskContextAnchor),
  changedPaths: z.array(canonicalPath),
  lifecycle: lifecycleScenario.optional(),
  truth: correctnessTruth,
}).strict().superRefine((value, context) => {
  if (value.kind === "synthetic" && !value.syntheticClass) context.addIssue({ code: z.ZodIssueCode.custom, path: ["syntheticClass"], message: "synthetic cases require syntheticClass" });
  if (value.kind === "snapshot" && value.syntheticClass) context.addIssue({ code: z.ZodIssueCode.custom, path: ["syntheticClass"], message: "snapshot cases cannot declare syntheticClass" });
});

const snapshotProvenance = z.object({
  snapshotId: identifier,
  sourceRepository: z.string().trim().min(1),
  sourceCommitSha: z.string().regex(/^[0-9a-f]{40}(?:[0-9a-f]{24})?$/i, "must be a full git commit SHA"),
  license: z.string().trim().min(1),
  licenseNoticeRequired: z.boolean(),
  includedPaths: z.array(canonicalPath).min(1),
  language,
  inclusionReason: z.string().trim().min(1),
  licenseNoticePath: canonicalPath.optional(),
}).strict().superRefine((value, context) => {
  if (!unique(value.includedPaths.map((includedPath) => ({ includedPath })), "includedPath")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["includedPaths"], message: "included paths must be unique" });
  if (value.licenseNoticeRequired && !value.licenseNoticePath) context.addIssue({ code: z.ZodIssueCode.custom, path: ["licenseNoticePath"], message: "a required license notice needs a path" });
});

const corpusManifest = z.object({
  corpusVersion: z.literal(CORPUS_VERSION),
  cases: z.array(evalCase),
  snapshots: z.array(snapshotProvenance),
}).strict().superRefine((value, context) => {
  if (!unique(value.cases, "caseId")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["cases"], message: "case IDs must be unique" });
  if (!unique(value.snapshots, "snapshotId")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["snapshots"], message: "snapshot IDs must be unique" });
});

const qualityAggregate = z.object({
  maxEstimatedTokensIncreasePct: nonNegative,
  maxReturnedBytesIncreasePct: nonNegative,
  maxSelectedItemsIncreasePct: nonNegative,
  maxRequiredHitRateDecreasePp: nonNegative,
  maxSupportingHitRateDecreasePp: nonNegative,
}).strict();

const qualityCatastrophic = z.object({
  maxEstimatedTokensMultiplier: nonNegative,
  maxReturnedBytesMultiplier: nonNegative,
  selectedItemsFormula: z.literal(selectedItemsFormula),
  requiredTargetsMayDisappear: z.boolean(),
}).strict();

const baselineEntry = z.object({
  caseId: identifier,
  selectedItems: nonNegative.int(),
  estimatedTokens: nonNegative.int(),
  returnedBytes: nonNegative.int(),
  requiredHitRate: nonNegative.max(1),
  supportingHitRate: nonNegative.max(1),
  qualityOverrides: z.object({
    aggregate: qualityAggregate.partial().optional(),
    catastrophic: qualityCatastrophic.partial().optional(),
  }).strict().optional(),
}).strict();

const goldenBaseline = z.object({
  corpusVersion: z.literal(CORPUS_VERSION),
  baselineVersion: z.literal(BASELINE_VERSION),
  policyVersion: z.literal(POLICY_VERSION),
  entries: z.array(baselineEntry),
}).strict().superRefine((value, context) => {
  if (!unique(value.entries, "caseId")) context.addIssue({ code: z.ZodIssueCode.custom, path: ["entries"], message: "baseline case IDs must be unique" });
});

const qualityPolicy = z.object({
  policyVersion: z.literal(POLICY_VERSION),
  aggregate: qualityAggregate,
  catastrophic: qualityCatastrophic,
}).strict();

export function parseCorpusManifest(raw: unknown): CorpusManifest {
  return corpusManifest.parse(raw) as CorpusManifest;
}

export function parseGoldenBaseline(raw: unknown): GoldenBaseline {
  return goldenBaseline.parse(raw) as GoldenBaseline;
}

export function parseQualityPolicy(raw: unknown): QualityPolicy {
  return qualityPolicy.parse(raw) as QualityPolicy;
}
