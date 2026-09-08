import { symbolIdentityKey, type SymbolIdentity } from "./identities.js";
import type { ResolutionCandidate, ResolverInput } from "./decision.js";
import type { ResolutionSiteIdentity } from "./identities.js";
import type { ResolutionStrategyId, TypeRef } from "./types.js";

export const ORDERED_STRATEGIES: readonly ResolutionStrategyId[] = [
  "lexical-local", "imports-exports", "explicit-type", "constructor", "assignment", "parameter",
  "return", "alias", "inheritance", "receiver-member", "chained-call", "bounded-interprocedural",
];

function known(type: TypeRef | undefined): SymbolIdentity | undefined {
  return type?.kind === "known" ? type.symbol : undefined;
}

function candidates(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  if (!input.context.budget.consume("candidateExpansions")) return [];
  const batch = input.evidence;
  const result: ResolutionCandidate[] = [];
  const add = (target: SymbolIdentity | undefined, evidenceId: string, confidence: ResolutionCandidate["confidence"]) => {
    if (target) result.push({ target, strategy, confidence, evidenceIds: [evidenceId as never] });
  };
  switch (strategy) {
    case "lexical-local":
      for (const item of batch.bindings) add(known(item.declaredType), item.evidenceId, "strong");
      break;
    case "explicit-type":
      for (const item of batch.typeAnnotations) add(known(item.type), item.evidenceId, "exact");
      break;
    case "constructor":
      for (const item of batch.constructors) add(known(item.constructedType), item.evidenceId, "strong");
      break;
    case "assignment":
      for (const item of batch.assignments) add(known(item.sourceType), item.evidenceId, "strong");
      break;
    case "parameter":
      for (const item of batch.parameters) add(known(item.type), item.evidenceId, "strong");
      break;
    case "return":
      for (const item of batch.returns) add(known(item.type), item.evidenceId, "strong");
      break;
    case "alias":
      for (const item of batch.aliases) add(item.target && "qualifiedName" in item.target ? item.target : undefined, item.evidenceId, "strong");
      break;
    case "inheritance":
      for (const item of batch.inheritance) add(known(item.target), item.evidenceId, "strong");
      break;
    case "receiver-member":
      for (const item of batch.members) add(item.member, item.evidenceId, "strong");
      break;
    case "imports-exports":
    case "chained-call":
    case "bounded-interprocedural":
      break;
  }
  return [...new Map(result.map((candidate) => [symbolIdentityKey(candidate.target), candidate])).values()]
    .sort((left, right) => symbolIdentityKey(left.target).localeCompare(symbolIdentityKey(right.target)));
}

export function resolveStrategy(input: ResolverInput, site: ResolutionSiteIdentity, strategy: ResolutionStrategyId): readonly ResolutionCandidate[] {
  return candidates(input, site, strategy);
}
