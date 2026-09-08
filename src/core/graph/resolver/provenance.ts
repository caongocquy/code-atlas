import type {
  CompactEvidence,
  EdgeResolutionProvenance,
} from "../resolution.types.js";
import type { GraphEdge } from "../types.js";
import { isSymbolIdentityKey } from "./identities.js";

export type { CompactEvidence, EdgeResolutionProvenance } from "../resolution.types.js";

export const MAX_COMPACT_EVIDENCE = 8;

function isAcceptedConfidence(value: unknown): value is EdgeResolutionProvenance["confidence"] {
  return value === "exact" || value === "strong";
}

function validateEvidence(item: CompactEvidence): void {
  if (!item.kind || !item.sourceUnit || !Number.isInteger(item.startLine) || !Number.isInteger(item.endLine)) {
    throw new TypeError("invalid compact resolution evidence");
  }
}

export function compareEvidence(a: CompactEvidence, b: CompactEvidence): number {
  return a.sourceUnit.localeCompare(b.sourceUnit)
    || a.startLine - b.startLine
    || a.endLine - b.endLine
    || a.kind.localeCompare(b.kind)
    || (a.evidenceId ?? "").localeCompare(b.evidenceId ?? "");
}

export function withProvenance(edge: GraphEdge, provenance: EdgeResolutionProvenance): GraphEdge {
  if (!isAcceptedConfidence(provenance.confidence)) {
    throw new TypeError("accepted edge provenance cannot use weak confidence");
  }
  if (!provenance.strategy || !provenance.resolutionVersion || !provenance.sourceLogicalIdentity || !provenance.targetLogicalIdentity) {
    throw new TypeError("edge provenance requires strategy, version, and logical identities");
  }
  if (!isSymbolIdentityKey(provenance.sourceLogicalIdentity) || !isSymbolIdentityKey(provenance.targetLogicalIdentity)) {
    throw new TypeError("edge provenance requires canonical symbol identity keys");
  }
  for (const item of provenance.evidence) validateEvidence(item);

  return {
    ...edge,
    resolution: {
      ...provenance,
      evidence: [...provenance.evidence].sort(compareEvidence).slice(0, MAX_COMPACT_EVIDENCE),
    },
  };
}
