import type { SourceRangeFact } from "../../facts/facts.types.js";
import type { EvidenceId } from "./types.js";
import type { SourceUnitIdentity, SymbolIdentity } from "./identities.js";

export type ScipBindingEvidence = {
  sourceUnit: SourceUnitIdentity;
  siteLocalId: string;
  target: SymbolIdentity;
  evidenceId: EvidenceId;
  range: SourceRangeFact;
};

export function scipBindingKey(sourceUnit: SourceUnitIdentity, siteLocalId: string): string {
  return JSON.stringify([sourceUnit.repositoryId, sourceUnit.relativePath, sourceUnit.language, siteLocalId]);
}
