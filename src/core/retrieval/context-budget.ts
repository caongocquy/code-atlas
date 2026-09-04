import type { SearchResult } from "./code-search.service.js";
import { countTokens } from "../../infrastructure/embedding/transformers-tokenizer.client.js";
import { buildContext } from "./context.js";

const MAX_CONTEXT_TOKENS = 4_000;

export type ContextBudgetResult = {
  chunks: SearchResult[];
  usedTokens: number;
};

export type ContextBudgetDecision = {
  chunk: SearchResult;
  tokens: number;
  included: boolean;
  reason?: "token-budget";
};

export type DetailedContextBudgetResult = ContextBudgetResult & {
  decisions: ContextBudgetDecision[];
  budget: number;
};

export async function applyContextBudget(
  chunks: SearchResult[],
  maxTokens = MAX_CONTEXT_TOKENS,
  useModel = true,
): Promise<ContextBudgetResult> {
  const result = await applyContextBudgetDetailed(chunks, maxTokens, useModel);

  return {
    chunks: result.chunks,
    usedTokens: result.usedTokens,
  };
}

export async function applyContextBudgetDetailed(
  chunks: SearchResult[],
  maxTokens = MAX_CONTEXT_TOKENS,
  useModel = true,
): Promise<DetailedContextBudgetResult> {
  const selected: SearchResult[] = [];
  const decisions: ContextBudgetDecision[] = [];
  let usedTokens = 0;

  for (const chunk of chunks) {
    // ponytail: O(n²) render checks, candidate count is bounded by retrieval caps.
    const tokenCount = await countTokens(buildContext([...selected, chunk]), { useModel });

    if (usedTokens + tokenCount > maxTokens) {
      decisions.push({
        chunk,
        tokens: tokenCount,
        included: false,
        reason: "token-budget",
      });
      continue;
    }

    selected.push(chunk);
    usedTokens = tokenCount;
    decisions.push({
      chunk,
      tokens: tokenCount,
      included: true,
    });
  }

  return {
    chunks: selected,
    usedTokens,
    decisions,
    budget: maxTokens,
  };
}
