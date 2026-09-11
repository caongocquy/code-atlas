import type { EvidenceRef, ReliabilityContribution } from "./reliability.types.js";

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
