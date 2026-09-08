import type { ResolutionDecision, ResolverInput } from "./decision.js";
import { uniqueTargetGate } from "./decision.js";
import type { ResolutionSiteIdentity } from "./identities.js";
import { ORDERED_STRATEGIES, resolveStrategy } from "./strategies.js";

export type {
  ResolutionCandidate,
  ResolutionDecision,
  ResolutionDecisionBase,
  ResolverInput,
} from "./decision.js";
export type { GenerationResolverContext } from "./generation-context.js";

export function resolveSite(input: ResolverInput, site: ResolutionSiteIdentity): ResolutionDecision {
  const attempted = [] as typeof ORDERED_STRATEGIES[number][];
  const candidates = [] as import("./decision.js").ResolutionCandidate[];
  for (const strategy of ORDERED_STRATEGIES) {
    attempted.push(strategy);
    input.context.diagnostics.add({ site, status: "attempted", strategy });
    candidates.push(...resolveStrategy(input, site, strategy));
  }
  return uniqueTargetGate(input, site, candidates, attempted);
}
