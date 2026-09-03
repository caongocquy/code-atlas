import type { SearchResult } from "../services/code-search.js";
import { countTokens } from "../lib/tokenizer.js";
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

export function applyContextBudget(
  chunks: SearchResult[],
  maxTokens = MAX_CONTEXT_TOKENS,
): ContextBudgetResult {
  const result = applyContextBudgetDetailed(chunks, maxTokens);

  return {
    chunks: result.chunks,
    usedTokens: result.usedTokens,
  };
}

export function applyContextBudgetDetailed(
  chunks: SearchResult[],
  maxTokens = MAX_CONTEXT_TOKENS,
): DetailedContextBudgetResult {
  const selected: SearchResult[] = [];
  const decisions: ContextBudgetDecision[] = [];
  let usedTokens = 0;

  for (const chunk of chunks) {
    // ponytail: O(n²) render checks, candidate count is bounded by retrieval caps.
    const tokenCount = countTokens(buildContext([...selected, chunk]));

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
