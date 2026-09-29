import type { ResolutionDecision, ResolverInput } from "./decision.js";
import { uniqueTargetGate } from "./decision.js";
import type { ResolutionSiteIdentity } from "./identities.js";
import { ORDERED_STRATEGIES, resolveStrategy } from "./strategies.js";
import { scipBindingKey } from "./scip-evidence.js";
import type { ResolutionStrategyId } from "./types.js";

export type {
  ResolutionCandidate,
  ResolutionDecision,
  ResolutionDecisionBase,
  ResolverInput,
} from "./decision.js";
export type { GenerationResolverContext } from "./generation-context.js";

export function resolveSite(input: ResolverInput, site: ResolutionSiteIdentity): ResolutionDecision {
  const hasScipEvidence = input.context.scipEvidenceBySite?.has(scipBindingKey(site.sourceUnit, site.localId)) ?? false;
  const strategies: readonly ResolutionStrategyId[] = hasScipEvidence ? ["scip", ...ORDERED_STRATEGIES] : ORDERED_STRATEGIES;
  const attempted: ResolutionStrategyId[] = [];
  const candidates = [] as import("./decision.js").ResolutionCandidate[];
  for (const strategy of strategies) {
    attempted.push(strategy);
    input.context.diagnostics.add({ site, status: "attempted", strategy });
    candidates.push(...resolveStrategy(input, site, strategy));
  }
  return uniqueTargetGate(input, site, candidates, attempted);
}
