import type { ParsedFactsBlob } from "../../facts/facts.types.js";
import type { RepositoryIdentity } from "../../repository/repository-identity.js";
import type { BudgetLedger } from "./budgets.js";
import type { ResolverMemo } from "./memo.js";
import type {
  LanguageSemanticAdapter,
  ResolverTraceCollector,
  ResolverTraceEvent,
} from "./types.js";
import type { TypeEnvironment } from "./type-environment.js";

export type GenerationResolverContext = {
  generationId: string;
  repositoryIdentity: RepositoryIdentity;
  parsedFactsView: readonly ParsedFactsBlob[];
  languageRegistry: readonly LanguageSemanticAdapter[];
  typeEnvironment: TypeEnvironment;
  budget: BudgetLedger;
  memo: ResolverMemo;
  diagnostics: ResolverTraceCollector;
  resolutionVersion: string;
};

export function createGenerationResolverContext(
  input: Omit<GenerationResolverContext, "diagnostics"> & { diagnostics?: ResolverTraceCollector },
): GenerationResolverContext {
  const events: ResolverTraceEvent[] = [];
  return {
    ...input,
    diagnostics: input.diagnostics ?? {
      add: (event) => { events.push(event); },
      snapshot: () => [...events],
    },
  };
}
