import type { EvidenceRef, ReliabilityContribution } from "./reliability.types.js";
import { canonicalPath } from "./reliability-identity.js";
import type { FrameworkEvidenceRef } from "../framework/framework.types.js";
import type { ResolutionEvidence } from "../graph/resolution.types.js";
import type { SourceRangeFact } from "../facts/facts.types.js";

function rangeKey(range: EvidenceRef["range"]): string {
  return range === undefined
    ? ""
    : JSON.stringify([range.startLine, range.endLine, range.startColumn ?? null, range.endColumn ?? null]);
}

function refKey(ref: EvidenceRef): string {
  return JSON.stringify([ref.origin, ref.sourcePath ?? null, ref.inputKey, ref.localId ?? null, rangeKey(ref.range), ref.ownerKey]);
}

export function normalizeEvidenceRefs(refs: readonly EvidenceRef[]): readonly EvidenceRef[] {
  const unique = new Map<string, EvidenceRef>();
  for (const ref of refs) unique.set(refKey(ref), ref);
  return [...unique.values()].sort((left, right) => refKey(left).localeCompare(refKey(right)));
}

export function fromFrameworkEvidenceRef(ref: FrameworkEvidenceRef, ownerKey: string): EvidenceRef {
  return {
    origin: "framework_inferred",
    sourcePath: canonicalPath(ref.relativePath),
    inputKey: ref.inputKey,
    ...(ref.localId === undefined ? {} : { localId: ref.localId }),
    ...(ref.range === undefined ? {} : { range: ref.range }),
    ownerKey,
  };
}

export function fromParsedFactRef(
  sourcePath: string,
  inputKey: string,
  range: SourceRangeFact | undefined,
  ownerKey: string,
): EvidenceRef {
  return {
    origin: "extracted",
    sourcePath: canonicalPath(sourcePath),
    inputKey,
    ...(range === undefined ? {} : { range }),
    ownerKey,
  };
}

export function fromResolutionEvidence(evidence: ResolutionEvidence, ownerKey: string): EvidenceRef {
  return {
    origin: "language_inferred",
    sourcePath: canonicalPath(evidence.source.file),
    inputKey: `resolution:${evidence.evidenceKind}:${evidence.resolutionMethod ?? "unknown"}`,
    range: { startLine: evidence.source.line, endLine: evidence.source.line },
    ownerKey,
  };
}

function contributionKey(value: ReliabilityContribution): string {
  return JSON.stringify([value.scope.scopeKey, value.outputKey, value.ownerKey]);
}

export function normalizeContributions(contributions: readonly ReliabilityContribution[]): readonly ReliabilityContribution[] {
  const unique = new Map<string, ReliabilityContribution>();
  for (const contribution of contributions) {
    unique.set(contributionKey(contribution), {
      ...contribution,
      evidence: normalizeEvidenceRefs(contribution.evidence),
      diagnostics: [...contribution.diagnostics].sort((left, right) => JSON.stringify(left).localeCompare(JSON.stringify(right))),
    });
  }
  return [...unique.values()].sort((left, right) => contributionKey(left).localeCompare(contributionKey(right)));
}
