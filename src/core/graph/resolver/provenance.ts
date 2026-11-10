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

/**
 * Combine proof from multiple callsites represented by a single graph edge.
 * The edge's existing identity and version are immutable within a generation.
 * Evidence is deterministic, deduplicated and bounded by the existing MCP limit.
 */
export function mergeEdgeProvenance(edge: GraphEdge, incoming: EdgeResolutionProvenance): GraphEdge {
  const previous = edge.resolution;
  if (!previous) return withProvenance(edge, incoming);
  if (previous.resolutionVersion !== incoming.resolutionVersion
    || previous.sourceLogicalIdentity !== incoming.sourceLogicalIdentity
    || previous.targetLogicalIdentity !== incoming.targetLogicalIdentity) {
    throw new TypeError("cannot merge provenance across edge identities or resolution versions");
  }
  const combined = [...previous.evidence, ...incoming.evidence];
  const sorted = [...combined].sort(compareEvidence);
  const unique = [...new Map(sorted.map((item) => [
    JSON.stringify([item.kind, item.sourceUnit, item.startLine, item.endLine, item.evidenceId ?? ""]),
    item,
  ])).values()];
  return withProvenance(edge, {
    ...incoming,
    // A previously exact decision remains exact when later callsites are strong.
    confidence: previous.confidence === "exact" || incoming.confidence === "exact" ? "exact" : "strong",
    strategy: previous.strategy === incoming.strategy
      ? incoming.strategy : [previous.strategy, incoming.strategy].sort()[0]!,
    evidence: unique,
  });
}
